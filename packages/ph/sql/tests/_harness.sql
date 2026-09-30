-- =====================================================================
-- Test harness — the Supabase-provided surface, on an empty Postgres
--
-- WHY THIS FILE EXISTS. The database suites (RLS, permissions, booking,
-- payments, collaborations, BEAU PH) have always been run by hand against the
-- live schema in a rolled-back transaction, because the only database this
-- project has is production and handing GitHub Actions a production credential
-- is a worse trade than the coverage is worth. This file removes that trade:
-- it builds, from nothing, the part of a Supabase project that the migrations
-- assume already exists, so the whole schema can be replayed into a throwaway
-- Postgres and the suites can run on every push.
--
-- WHAT IT IS NOT. It is not a Supabase emulator and does not pretend to be.
-- It provides exactly what the migrations in this repository touch — nothing
-- speculative — and each stub is documented with what it does and does not
-- reproduce. Two rules keep it honest:
--
--   1. IT MUST NEVER BE MORE RESTRICTIVE THAN PRODUCTION. Most of these suites
--      prove things NEGATIVELY: anon cannot read this, a coach cannot reach
--      finance. On a bare Postgres a new table has no privileges for anon at
--      all, so every one of those assertions would pass for the wrong reason
--      and vouch for nothing. Supabase's default privileges on schema public
--      are therefore reproduced below, verbatim in effect: the harness grants
--      anon and authenticated everything Supabase grants them, and the suites
--      then have to prove the schema takes it away.
--
--   2. IT MUST NEVER REACH THE NETWORK. pg_net is replaced by a recorder: a
--      call returns a request id and stores the request, and no response ever
--      arrives. Code that posts to an Edge Function therefore runs its real
--      path in CI and delivers nothing, which is what a test run should do.
--
-- Run as a superuser, before the migrations. See scripts/db-ci.sh.
-- =====================================================================

-- ---------- 1. roles ----------
-- Supabase creates these at project creation. anon and authenticated are the
-- two PostgREST personas the suites switch between; service_role is the key the
-- Edge Functions hold. None of them may create objects.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin noinherit bypassrls; end if;
end $$;

-- postgres is a member of all three so a suite can `set local role` into a
-- persona and back. This is exactly how it works on Supabase.
grant anon, authenticated, service_role to postgres;

-- ---------- 2. extensions ----------
-- On Supabase, extensions live in their own schema and the migrations call them
-- fully qualified (extensions.digest, extensions.gen_random_bytes,
-- extensions.pgp_sym_encrypt/decrypt) because every function sets
-- search_path = ''. pgcrypto has to be in the same place here.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- gen_random_uuid() is in pg_catalog from Postgres 13 on, so nothing to do.

-- ---------- 3. schema public, with Supabase's default privileges ----------
-- This is rule 1 above. Supabase grants usage on public to the three roles and
-- sets default privileges so that every table, sequence and function created by
-- the migration role is readable and callable by them. Reproduce it, so the
-- suites are proving the schema's own revokes and RLS rather than proving that
-- a bare Postgres grants nothing.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;

-- ---------- 4. auth ----------
-- GoTrue owns this schema in production. The migrations use four things from
-- it: auth.jwt(), auth.role(), auth.uid() and the existence of auth.users.
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

/* The claims PostgREST sets per request. Both spellings exist in the wild and
   Supabase's own definition coalesces them; keep that. */
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim',  true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt() ->> 'role')::text
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), auth.jwt() ->> 'sub')::uuid
$$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''), auth.jwt() ->> 'email')::text
$$;

/* auth.users: only its existence and its email column are used, by
   public.admin_grant, to refuse creating an app record for someone who has no
   identity. The harness leaves it EMPTY on purpose — cg0025 asserts that a
   grant to an unknown address is refused, and that assertion is only worth
   anything against an empty table. */
create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique,
  created_at timestamptz not null default now()
);
revoke all on auth.users from anon, authenticated;

-- ---------- 5. storage ----------
-- Two objects are touched: the private bucket the enquiry attachments live in,
-- and RLS policies on storage.objects. Only the columns the policies read are
-- reproduced (bucket_id above all); the Storage API itself has no equivalent
-- here and none is needed, because nothing in SQL uploads or downloads a file.
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  owner              uuid,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);
create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
/* Supabase grants the browser roles full table privileges on storage.objects and
   lets RLS do the deciding — including for anon, which is why the suites can ask
   "how many enquiry files does anon see?" and expect 0 rather than an error.
   Granting less here would turn those checks into vacuous ones (rule 1). */
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;

-- ---------- 6. vault ----------
-- Supabase Vault keeps a secret encrypted at rest and exposes it through the
-- decrypted_secrets view. The suites never read a secret's VALUE: what they
-- care about is that a clear key is stored only here and that only its SHA-256
-- lands in public.outbox_keys. So this stub stores the secret as given — there
-- is no key management in a throwaway database to protect it from — and keeps
-- the interface identical: create_secret / update_secret / decrypted_secrets.
create schema if not exists vault;
create table if not exists vault.secrets (
  id          uuid primary key default gen_random_uuid(),
  name        text unique,
  description text not null default '',
  secret      text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create or replace view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, created_at, updated_at from vault.secrets;

create or replace function vault.create_secret(new_secret text, new_name text default null,
                                               new_description text default '', new_key_id uuid default null)
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into vault.secrets (name, description, secret) values (new_name, coalesce(new_description, ''), new_secret)
  returning id into v;
  return v;
end $$;

create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
                                               new_description text default null, new_key_id uuid default null)
returns void language plpgsql as $$
begin
  update vault.secrets
     set secret      = coalesce(new_secret, secret),
         name        = coalesce(new_name, name),
         description = coalesce(new_description, description),
         updated_at  = now()
   where id = secret_id;
end $$;

-- The vault is never reachable from a browser role, here as in production.
revoke all on schema vault from anon, authenticated;
revoke all on all tables in schema vault from anon, authenticated;

-- ---------- 7. net (pg_net) — a recorder, never a client ----------
-- Rule 2 above. The *_kick() functions read a key from the vault and post it to
-- an Edge Function. In CI that real path should run — it is where a missing key
-- or a wrong header would show up — and then deliver nothing. So http_post and
-- http_get record the request and return an id, and no row is ever written to
-- _http_response, which every caller already handles as "not answered yet".
--
-- The recorded request is deliberately kept: a suite can assert that a kick
-- fired, and that no secret was put somewhere it should not be.
create schema if not exists net;
create table if not exists net.sent_requests (
  id      bigserial primary key,
  method  text not null,
  url     text not null,
  body    jsonb,
  params  jsonb,
  headers jsonb,
  sent_at timestamptz not null default now()
);
create table if not exists net._http_response (
  id          bigint primary key,
  status_code int,
  content     text,
  headers     jsonb,
  timed_out   boolean,
  error_msg   text,
  created     timestamptz not null default now()
);

create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                         headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
                                         timeout_milliseconds int default 5000)
returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into net.sent_requests (method, url, body, params, headers) values ('POST', url, body, params, headers)
  returning id into v;
  return v;
end $$;

create or replace function net.http_get(url text, params jsonb default '{}'::jsonb,
                                        headers jsonb default '{}'::jsonb,
                                        timeout_milliseconds int default 5000)
returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into net.sent_requests (method, url, body, params, headers) values ('GET', url, null, params, headers)
  returning id into v;
  return v;
end $$;

revoke all on schema net from anon, authenticated;

-- ---------- 8. pg_cron: absent, on purpose ----------
-- Every scheduling block in the migrations is already guarded by
--   if exists (select 1 from pg_extension where extname = 'pg_cron')
-- because pg_cron is not guaranteed on every Supabase tier. Not providing it
-- here exercises that guard, and keeps the harness from running background
-- jobs against a database a test is in the middle of using. What the schedules
-- CALL is tested directly by the suites, which is the part that can break.

-- ---------- 9. sanity ----------
-- If any of the above silently failed, fail now rather than three hundred
-- migrations later with an error that points at the wrong line.
do $$
begin
  if to_regprocedure('auth.uid()') is null then raise exception 'harness: auth.uid() missing'; end if;
  if to_regprocedure('extensions.digest(text, text)') is null then raise exception 'harness: pgcrypto not in schema extensions'; end if;
  if to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then raise exception 'harness: net.http_post missing'; end if;
  if to_regclass('vault.decrypted_secrets') is null then raise exception 'harness: vault.decrypted_secrets missing'; end if;
  if to_regclass('storage.objects') is null then raise exception 'harness: storage.objects missing'; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then raise exception 'harness: role authenticated missing'; end if;
  raise notice 'harness ready';
end $$;
