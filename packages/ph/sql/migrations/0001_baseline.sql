-- =====================================================================
-- BEAU PH — 0001 baseline.
--
-- The whole `beau_ph` schema as it runs in production on 30 September 2026
-- (first host: Coach Gari), in one file: 19 tables, 69 functions, their
-- constraints, indexes, triggers and grants, and the reference data every
-- install needs (the provider catalogue, provider capabilities, FX sources
-- and FX currencies). Merchant rows are NOT here: a merchant is created by
-- its host.
--
-- Provenance: rebuilt from the Coach Gari migrations that created and then
-- changed the schema (20260920 … 20261074), dumped with pg_dump, and checked
-- against production by fingerprint — columns, constraints, indexes and
-- triggers identical; functions identical once comments are ignored; the
-- reference rows identical to production's (three notes are production's
-- wording, which the migration files had drifted from).
--
-- Install once, into a database that has never had `beau_ph`. A database that
-- already runs it (Coach Gari) is not re-installed: it is marked as being at
-- this version in beau_ph.schema_versions. See packages/ph/sql/README.md.
--
-- Requires: PostgreSQL 15+, the Supabase roles (anon, authenticated,
-- service_role). Uses pg_net for the FX refresh and pg_cron to schedule it;
-- both optional at install time (the schedule is skipped without them).
-- =====================================================================

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: beau_ph; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA beau_ph;


--
-- Name: array_is_subset(text[], text[]); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.array_is_subset(p_child text[], p_parent text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  -- null parent = the provider has no restriction; null child = nothing to check
  select p_child is null or p_parent is null or p_child <@ p_parent
$$;


--
-- Name: attach_attempt(uuid, text, text, timestamp with time zone, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.attach_attempt(p_request_id uuid, p_provider_reference text, p_redirect_url text, p_expires_at timestamp with time zone, p_merchant_key text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r beau_ph.payment_requests%rowtype; a beau_ph.payment_attempts%rowtype; v_n int;
begin
  if not beau_ph.owned_by(p_request_id, p_merchant_key) then raise exception 'request not found' using errcode = 'P0002'; end if;
  select * into r from beau_ph.payment_requests where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode = 'P0002'; end if;
  if r.status not in ('created','pending','requires_action') then raise exception 'request not open' using errcode = 'P0003'; end if;
  update beau_ph.payment_attempts set status = 'superseded' where request_id = r.id and status = 'open';
  select coalesce(max(pa.n), 0) + 1 into v_n from beau_ph.payment_attempts pa where pa.request_id = r.id;
  insert into beau_ph.payment_attempts (request_id, n, provider_reference, redirect_url, expires_at)
  values (r.id, v_n, p_provider_reference, p_redirect_url, p_expires_at) returning * into a;
  perform beau_ph.record_event(r.id, 'requires_action', 'system', null, null, null, null, 'attempt_open', p_provider_reference, null,
                               jsonb_build_object('attempt', a.n, 'expires_at', p_expires_at));
  update beau_ph.payment_requests set expires_at = coalesce(p_expires_at, expires_at) where id = r.id;
  select * into r from beau_ph.payment_requests where id = r.id;
  return beau_ph.request_json(r);
end $$;


--
-- Name: audit_diff(uuid, text, text, text, jsonb, jsonb); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.audit_diff(p_merchant_id uuid, p_area text, p_entity text, p_actor text, p_old jsonb, p_new jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare k text; n int := 0; ov jsonb; nv jsonb; sub text;
begin
  for k in select distinct key from (select jsonb_object_keys(coalesce(p_old, '{}'::jsonb)) key union select jsonb_object_keys(coalesce(p_new, '{}'::jsonb))) x loop
    ov := p_old -> k; nv := p_new -> k;
    if ov is distinct from nv then
      if jsonb_typeof(coalesce(ov, nv)) = 'object' and (ov is null or jsonb_typeof(ov) = 'object') and (nv is null or jsonb_typeof(nv) = 'object') then
        for sub in select distinct key from (select jsonb_object_keys(coalesce(ov, '{}'::jsonb)) key union select jsonb_object_keys(coalesce(nv, '{}'::jsonb))) y loop
          if (ov -> sub) is distinct from (nv -> sub) then
            insert into beau_ph.config_audit (merchant_id, area, entity, actor, field, old_value, new_value)
            values (p_merchant_id, p_area, p_entity, coalesce(p_actor, 'system'), k || '.' || sub, ov -> sub, nv -> sub);
            n := n + 1;
          end if;
        end loop;
      else
        insert into beau_ph.config_audit (merchant_id, area, entity, actor, field, old_value, new_value)
        values (p_merchant_id, p_area, p_entity, coalesce(p_actor, 'system'), k, ov, nv);
        n := n + 1;
      end if;
    end if;
  end loop;
  return n;
end $$;


--
-- Name: cancel_request(uuid, text, text, text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.cancel_request(p_request_id uuid, p_actor text DEFAULT 'system'::text, p_actor_id text DEFAULT NULL::text, p_reason text DEFAULT NULL::text, p_merchant_key text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r beau_ph.payment_requests%rowtype;
begin
  if not beau_ph.owned_by(p_request_id, p_merchant_key) then raise exception 'request not found' using errcode = 'P0002'; end if;
  select * into r from beau_ph.payment_requests where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode = 'P0002'; end if;
  if r.status in ('paid','refunded') then raise exception 'already paid' using errcode = 'P0003'; end if;
  if r.status in ('cancelled','expired','failed') then return beau_ph.request_json(r); end if;   -- idempotent
  perform beau_ph.record_event(r.id, 'cancelled', coalesce(p_actor, 'system'), p_actor_id, null, null, null, 'cancelled', null, null,
                               jsonb_build_object('reason', p_reason));
  select * into r from beau_ph.payment_requests where id = r.id;
  return beau_ph.request_json(r);
end $$;


--
-- Name: cancel_requests_for(text, text, text, text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.cancel_requests_for(p_merchant_key text, p_external_reference text, p_actor text DEFAULT 'system'::text, p_actor_id text DEFAULT NULL::text, p_reason text DEFAULT NULL::text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_count int := 0; rid uuid;
begin
  for rid in select r.id from beau_ph.payment_requests r join beau_ph.merchants m on m.id = r.merchant_id
              where m.key = p_merchant_key and r.external_reference = p_external_reference and r.status in ('created','pending','requires_action') loop
    perform beau_ph.cancel_request(rid, p_actor, p_actor_id, p_reason);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;


--
-- Name: cancellation_mark(uuid, boolean, text, boolean); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.cancellation_mark(p_id uuid, p_ok boolean, p_error text DEFAULT NULL::text, p_skip boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare c beau_ph.provider_cancellations%rowtype;
begin
  select * into c from beau_ph.provider_cancellations where id = p_id for update;
  if not found then raise exception 'cancellation not found' using errcode = 'P0002'; end if;
  if c.status <> 'pending' then return to_jsonb(c); end if;

  if p_ok then
    update beau_ph.provider_cancellations
       set status = 'done', attempts = attempts + 1, last_error = null, settled_at = now(), updated_at = now()
     where id = c.id returning * into c;
  elsif p_skip then
    update beau_ph.provider_cancellations
       set status = 'skipped', attempts = attempts + 1, last_error = left(coalesce(p_error, 'skipped'), 300), settled_at = now(), updated_at = now()
     where id = c.id returning * into c;
  else
    update beau_ph.provider_cancellations
       set attempts = attempts + 1, last_error = left(coalesce(p_error, 'unknown error'), 300),
           status = case when attempts + 1 >= 5 then 'failed' else 'pending' end,
           settled_at = case when attempts + 1 >= 5 then now() else null end, updated_at = now()
     where id = c.id returning * into c;
  end if;
  return to_jsonb(c);
end $$;


--
-- Name: cancellations_due(integer); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.cancellations_due(p_limit integer DEFAULT 20) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'merchant', c.merchant_key, 'provider', c.provider_key,
           'provider_reference', c.provider_reference, 'attempts', c.attempts,
           'mode', m.mode) order by c.created_at), '[]'::jsonb)
    from beau_ph.provider_cancellations c
    join beau_ph.merchants m on m.key = c.merchant_key
   where c.status = 'pending' and c.attempts < 5
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;


--
-- Name: capabilities_json(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.capabilities_json(p_provider text) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object('capability', c.capability, 'readiness', c.readiness, 'confirmation', c.confirmation, 'handoff', c.handoff,
                                               'platforms', to_jsonb(c.platforms), 'initiated_by', c.initiated_by, 'in_person', beau_ph.is_in_person(c.capability), 'notes', c.notes)
                            order by c.capability), '[]'::jsonb)
    from beau_ph.provider_capabilities c where c.provider_key = p_provider
$$;


--
-- Name: config_audit_list(text, integer); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.config_audit_list(p_merchant_key text, p_limit integer DEFAULT 100) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object('area', a.area, 'entity', a.entity, 'actor', a.actor, 'changed_at', a.changed_at, 'field', a.field,
                                               'old_value', a.old_value, 'new_value', a.new_value) order by a.changed_at desc), '[]'::jsonb)
    from (select ca.* from beau_ph.config_audit ca left join beau_ph.merchants m on m.id = ca.merchant_id
           where ca.merchant_id is null or m.key = p_merchant_key
           order by ca.changed_at desc limit greatest(1, least(coalesce(p_limit, 100), 500))) a
$$;


--
-- Name: confirm_manual(uuid, text, integer, text, text, timestamp with time zone, text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.confirm_manual(p_request_id uuid, p_operator text, p_amount integer, p_currency text, p_reference text DEFAULT NULL::text, p_paid_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_note text DEFAULT NULL::text, p_merchant_key text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r beau_ph.payment_requests%rowtype; pv beau_ph.providers%rowtype; cap beau_ph.provider_capabilities%rowtype;
  pe_id uuid; ev beau_ph.payment_events%rowtype; m beau_ph.merchants%rowtype; v_conf text; v_ready text; v_handoff boolean;
begin
  if coalesce(p_operator, '') = '' then raise exception 'operator identity required' using errcode = '42501'; end if;
  if not beau_ph.owned_by(p_request_id, p_merchant_key) then raise exception 'request not found' using errcode = 'P0002'; end if;
  select * into r from beau_ph.payment_requests where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode = 'P0002'; end if;
  select * into pv from beau_ph.providers where key = r.provider_key;
  select * into cap from beau_ph.provider_capabilities where provider_key = r.provider_key and capability = r.capability;
  v_conf := coalesce(cap.confirmation, pv.confirmation); v_ready := coalesce(cap.readiness, pv.readiness); v_handoff := coalesce(cap.handoff, false);
  if v_conf <> 'operator' then raise exception 'provider % (%) is not operator-confirmed', r.provider_key, coalesce(r.capability, '-') using errcode = 'P0003'; end if;
  if v_ready <> 'available' then raise exception 'provider % (%) is %', r.provider_key, coalesce(r.capability, '-'), v_ready using errcode = 'P0003'; end if;
  if r.status in ('paid','refunded') then raise exception 'already paid' using errcode = 'P0003'; end if;
  if r.status not in ('created','pending','requires_action') then raise exception 'request not open' using errcode = 'P0003'; end if;
  if p_amount is null or p_amount <> r.amount or upper(coalesce(p_currency, '')) <> r.currency then
    raise exception 'received amount/currency differ from the request (% %)', r.amount, r.currency using errcode = 'P0003';
  end if;
  if v_handoff and coalesce(btrim(p_reference), '') = '' then
    raise exception 'the provider app receipt / transaction reference is required for a % handoff', r.capability using errcode = '22023';
  end if;
  select * into m from beau_ph.merchants where id = r.merchant_id;
  insert into beau_ph.provider_events (provider_key, provider_event_id, event_type, payload, request_id, outcome, processed_at)
  values (r.provider_key, 'operator:' || gen_random_uuid()::text, 'operator.confirmed',
          jsonb_build_object('operator', p_operator, 'amount', p_amount, 'currency', upper(p_currency), 'reference', p_reference,
                             'paid_at', coalesce(p_paid_at, now()), 'note', p_note, 'capability', r.capability, 'handoff', v_handoff), r.id, 'normalized', now())
  returning id into pe_id;
  ev := beau_ph.record_event(r.id, 'paid', 'operator', p_operator, pe_id, p_amount, upper(p_currency), 'confirmed_by_operator', null, nullif(btrim(p_reference), ''),
                             jsonb_build_object('reference', p_reference, 'paid_at', coalesce(p_paid_at, now()), 'note', p_note, 'capability', r.capability,
                                                'verification', case when v_handoff then 'operator_attested_provider_receipt' else 'operator_attested' end));
  if p_paid_at is not null then update beau_ph.payment_requests set paid_at = p_paid_at where id = r.id; end if;
  return jsonb_build_object('ok', true, 'outcome', 'normalized', 'request_id', r.id, 'payment_event_id', ev.id, 'from', ev.from_status, 'to', 'paid',
                            'provider', r.provider_key, 'capability', r.capability, 'external_reference', r.external_reference, 'public_reference', r.public_reference,
                            'merchant', m.key, 'amount', r.amount, 'currency', r.currency, 'paid_at', coalesce(p_paid_at, now()));
end $$;


--
-- Name: create_request(text, text, text, text, integer, text, text, timestamp with time zone, jsonb, jsonb, text, text, text, text, integer, text, uuid); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.create_request(p_merchant_key text, p_provider text, p_external_reference text, p_public_reference text, p_amount integer, p_currency text, p_country text DEFAULT NULL::text, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_metadata jsonb DEFAULT '{}'::jsonb, p_runtime jsonb DEFAULT '{}'::jsonb, p_capability text DEFAULT NULL::text, p_platform text DEFAULT NULL::text, p_initiated_by text DEFAULT NULL::text, p_intent text DEFAULT NULL::text, p_pricing_amount integer DEFAULT NULL::integer, p_pricing_currency text DEFAULT NULL::text, p_fx_quote_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare m beau_ph.merchants%rowtype; pv beau_ph.providers%rowtype; r beau_ph.payment_requests%rowtype;
  mm beau_ph.merchant_methods%rowtype; cap beau_ph.provider_capabilities%rowtype; elig jsonb; ctry text; v_cap text; v_init text; v_status text; ins jsonb;
  v_intent text; lim jsonb; v_pricing_amount int; v_pricing_currency text;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  select * into pv from beau_ph.providers where key = p_provider;
  if not found then raise exception 'unknown provider' using errcode = 'P0002'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount required' using errcode = '22023'; end if;
  if coalesce(p_currency, '') !~ '^[A-Z]{3}$' then raise exception 'currency required (ISO 4217)' using errcode = '22023'; end if;
  if coalesce(p_external_reference, '') = '' then raise exception 'external reference required' using errcode = '22023'; end if;
  if coalesce(p_public_reference, '') = '' then raise exception 'public reference required' using errcode = '22023'; end if;
  if not beau_ph.is_platform(p_platform) then raise exception 'unknown platform %', p_platform using errcode = '22023'; end if;
  v_intent := coalesce(p_intent, case p_metadata ->> 'reason' when 'booking' then 'service' when 'session_pack' then 'package' when 'support' then 'support' else null end);
  if v_intent is not null and not beau_ph.is_intent(v_intent) then raise exception 'unknown intent %', v_intent using errcode = '22023'; end if;
  ctry := coalesce(nullif(upper(p_country), ''), m.country);
  v_cap := coalesce(p_capability, case pv.kind when 'online' then 'online_checkout'
                                               when 'manual' then case p_provider when 'bank_transfer' then 'bank_transfer' else 'manual_instructions' end
                                               else 'crypto' end);
  if not beau_ph.is_capability(v_cap) then raise exception 'unknown capability %', v_cap using errcode = '22023'; end if;
  v_init := coalesce(p_initiated_by, case when pv.kind = 'manual' or beau_ph.is_in_person(v_cap) then 'merchant' else 'customer' end);

  -- pricing origin: a payment in another currency than the commercial price needs a server-side FX quote
  v_pricing_currency := nullif(upper(p_pricing_currency), ''); v_pricing_amount := p_pricing_amount;
  if v_pricing_currency is not null and v_pricing_currency <> p_currency and p_fx_quote_id is null then
    raise exception 'an FX quote is required to pay % in %', v_pricing_currency, p_currency using errcode = 'P0003';
  end if;
  if v_pricing_currency is null or v_pricing_currency = p_currency then v_pricing_currency := p_currency; v_pricing_amount := p_amount; end if;

  if exists (select 1 from beau_ph.payment_requests where merchant_id = m.id and external_reference = p_external_reference and status in ('paid','refunded')) then
    raise exception 'already paid' using errcode = 'P0003';
  end if;
  select * into r from beau_ph.payment_requests
   where merchant_id = m.id and provider_key = p_provider and external_reference = p_external_reference
     and status in ('created','pending','requires_action');
  if found then
    if r.amount <> p_amount or r.currency <> p_currency then
      raise exception 'a live request for % exists with a different amount/currency', p_external_reference using errcode = 'P0003';
    end if;
    if r.capability is distinct from v_cap then
      raise exception 'a live % request for % exists (capability %)', p_provider, p_external_reference, r.capability using errcode = 'P0003';
    end if;
    return beau_ph.request_json(r);
  end if;

  select c into elig
    from jsonb_array_elements(beau_ph.method_matrix(p_merchant_key, ctry, p_currency, p_runtime, p_platform, v_init, v_intent)) e,
         jsonb_array_elements(e -> 'capabilities') c
   where e ->> 'provider' = p_provider and c ->> 'capability' = v_cap;
  if not coalesce((elig ->> 'eligible')::boolean, false) then
    raise exception 'provider % capability % not available: %', p_provider, v_cap, coalesce(elig ->> 'reason', 'no_capability') using errcode = 'P0003';
  end if;
  select * into mm  from beau_ph.merchant_methods where merchant_id = m.id and provider_key = p_provider;
  select * into cap from beau_ph.provider_capabilities where provider_key = p_provider and capability = v_cap;

  -- merchant limits for this currency (minor units)
  lim := coalesce(mm.limits -> p_currency, '{}'::jsonb);
  if (lim ->> 'min') is not null and p_amount < (lim ->> 'min')::int then raise exception 'amount below the % minimum for %', p_currency, p_provider using errcode = 'P0003'; end if;
  if (lim ->> 'max') is not null and p_amount > (lim ->> 'max')::int then raise exception 'amount above the % maximum for %', p_currency, p_provider using errcode = 'P0003'; end if;

  if cap.confirmation = 'operator' then
    v_status := 'pending';
    ins := coalesce(mm.instructions, '{}'::jsonb)
        || jsonb_build_object('reference', p_public_reference, 'amount', p_amount, 'currency', p_currency, 'settlement_currency', mm.currency, 'capability', v_cap)
        || case when cap.handoff then jsonb_build_object('handoff', true, 'handoff_app', mm.settings ->> 'handoff_app', 'handoff_url', mm.settings ->> 'handoff_url') else '{}'::jsonb end;
  else
    v_status := 'created'; ins := '{}'::jsonb;
  end if;

  insert into beau_ph.payment_requests (merchant_id, provider_key, capability, channel, initiated_by, platform, intent,
                                        external_reference, public_reference, amount, currency, customer_country,
                                        pricing_amount, pricing_currency, fx_quote_id,
                                        status, instructions, metadata, expires_at)
  values (m.id, p_provider, v_cap, case when beau_ph.is_in_person(v_cap) then 'in_person' else 'online' end, v_init, p_platform, v_intent,
          p_external_reference, p_public_reference, p_amount, p_currency, ctry,
          v_pricing_amount, v_pricing_currency, p_fx_quote_id,
          v_status, jsonb_strip_nulls(ins), coalesce(p_metadata, '{}'::jsonb), p_expires_at)
  returning * into r;
  -- the quote is consumed by exactly this request; a mismatch, an expired or a foreign quote is refused inside
  if p_fx_quote_id is not null then
    perform beau_ph.fx_quote_consume(p_fx_quote_id, m.id, r.id, p_amount, p_currency, v_pricing_amount, v_pricing_currency);
  end if;
  insert into beau_ph.payment_events (request_id, from_status, to_status, amount, currency, actor, evidence)
  values (r.id, null, r.status, r.amount, r.currency, 'system',
          jsonb_build_object('created', true, 'kind', pv.kind, 'capability', v_cap, 'channel', r.channel, 'intent', v_intent,
                             'pricing_amount', v_pricing_amount, 'pricing_currency', v_pricing_currency, 'fx_quote_id', p_fx_quote_id));
  return beau_ph.request_json(r);
end $_$;


--
-- Name: currency_exponent(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.currency_exponent(p_currency text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case upper(coalesce(p_currency, ''))
           when 'JPY' then 0 when 'HUF' then 0 when 'TWD' then 0
           when 'BHD' then 3 when 'IQD' then 3 when 'JOD' then 3 when 'KWD' then 3
           when 'LYD' then 3 when 'OMR' then 3 when 'TND' then 3
           else 2
         end
$$;


--
-- Name: eligible_capabilities(text, text, text, jsonb, text, text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.eligible_capabilities(p_merchant_key text, p_country text DEFAULT NULL::text, p_currency text DEFAULT NULL::text, p_runtime jsonb DEFAULT '{}'::jsonb, p_platform text DEFAULT NULL::text, p_initiated_by text DEFAULT 'merchant'::text, p_intent text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'provider', e ->> 'provider', 'display_name', e ->> 'display_name', 'capability', c ->> 'capability',
           'confirmation', c ->> 'confirmation', 'handoff', (c ->> 'handoff')::boolean, 'in_person', (c ->> 'in_person')::boolean,
           'settlement_currency', e ->> 'settlement_currency', 'instructions', e -> 'instructions', 'settings', e -> 'settings')), '[]'::jsonb)
    from jsonb_array_elements(beau_ph.method_matrix(p_merchant_key, p_country, p_currency, p_runtime, p_platform, p_initiated_by, p_intent)) e,
         jsonb_array_elements(e -> 'capabilities') c
   where (c ->> 'eligible')::boolean
$$;


--
-- Name: eligible_currencies(text, text, jsonb, text, text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.eligible_currencies(p_merchant_key text, p_country text DEFAULT NULL::text, p_runtime jsonb DEFAULT '{}'::jsonb, p_platform text DEFAULT NULL::text, p_initiated_by text DEFAULT 'customer'::text, p_intent text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m beau_ph.merchants%rowtype; c text; res jsonb := '[]'::jsonb; provs jsonb;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  for c in select distinct x from beau_ph.merchant_methods mm, unnest(mm.currencies) x where mm.merchant_id = m.id and mm.enabled and mm.listed order by x loop
    provs := (select coalesce(jsonb_agg(e ->> 'provider'), '[]'::jsonb)
                from jsonb_array_elements(beau_ph.eligible_methods(p_merchant_key, p_country, c, p_runtime, p_platform, p_initiated_by, p_intent)) e);
    if jsonb_array_length(provs) > 0 then res := res || jsonb_build_object('currency', c, 'providers', provs); end if;
  end loop;
  return res;
end $$;


--
-- Name: eligible_methods(text, text, text, jsonb, text, text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.eligible_methods(p_merchant_key text, p_country text DEFAULT NULL::text, p_currency text DEFAULT NULL::text, p_runtime jsonb DEFAULT '{}'::jsonb, p_platform text DEFAULT NULL::text, p_initiated_by text DEFAULT 'customer'::text, p_intent text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(e), '[]'::jsonb)
    from jsonb_array_elements(beau_ph.method_matrix(p_merchant_key, p_country, p_currency, p_runtime, p_platform, p_initiated_by, p_intent)) e
   where (e ->> 'eligible')::boolean
$$;


--
-- Name: expire_request(uuid, text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.expire_request(p_request_id uuid, p_reason text DEFAULT 'expired'::text, p_merchant_key text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r beau_ph.payment_requests%rowtype;
begin
  if not beau_ph.owned_by(p_request_id, p_merchant_key) then raise exception 'request not found' using errcode = 'P0002'; end if;
  select * into r from beau_ph.payment_requests where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode = 'P0002'; end if;
  if r.status in ('paid','refunded') then raise exception 'already paid' using errcode = 'P0003'; end if;
  if r.status in ('cancelled','expired','failed') then return beau_ph.request_json(r); end if;
  perform beau_ph.record_event(r.id, 'expired', 'system', null, null, null, null, 'expired', null, null, jsonb_build_object('reason', p_reason));
  select * into r from beau_ph.payment_requests where id = r.id;
  return beau_ph.request_json(r);
end $$;


--
-- Name: fx_currency_exponent(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_currency_exponent(p text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case when p in ('JPY','KRW','CLP','VND','XAF','XOF','UGX','RWF','ISK','PYG','KMF','GNF','DJF','BIF','VUV','XPF') then 0 else 2 end
$$;


--
-- Name: fx_currency_set(text, jsonb, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_currency_set(p_currency text, p jsonb, p_actor text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare cur beau_ph.fx_currencies%rowtype; nxt beau_ph.fx_currencies%rowtype; c text := upper(p_currency); src beau_ph.fx_sources%rowtype;
begin
  if not beau_ph.is_iso_currency(c) or c = 'EUR' then raise exception 'ISO currency other than the EUR base required' using errcode = '22023'; end if;
  select * into cur from beau_ph.fx_currencies where currency = c;
  if p ? 'source_key' and p ->> 'source_key' is not null then
    select * into src from beau_ph.fx_sources where key = p ->> 'source_key';
    if not found then raise exception 'unknown source' using errcode = '22023'; end if;
    if src.kind = 'peg' and coalesce(nullif(upper(p ->> 'peg_currency'), ''), cur.peg_currency) is null then raise exception 'a peg needs peg_currency and peg_rate' using errcode = '22023'; end if;
  end if;
  insert into beau_ph.fx_currencies (currency, enabled, source_key, peg_currency, peg_rate, notes, updated_by)
  values (c, coalesce((p ->> 'enabled')::boolean, cur.enabled, false), case when p ? 'source_key' then p ->> 'source_key' else cur.source_key end,
          case when p ? 'peg_currency' then nullif(upper(p ->> 'peg_currency'), '') else cur.peg_currency end,
          case when p ? 'peg_rate' then (p ->> 'peg_rate')::numeric else cur.peg_rate end,
          case when p ? 'notes' then p ->> 'notes' else cur.notes end, p_actor)
  on conflict (currency) do update set enabled = excluded.enabled, source_key = excluded.source_key, peg_currency = excluded.peg_currency, peg_rate = excluded.peg_rate,
    notes = excluded.notes, updated_by = excluded.updated_by, updated_at = now()
  returning * into nxt;
  perform beau_ph.audit_diff(null, 'fx_currency', c, p_actor,
                             case when cur.currency is null then '{}'::jsonb else to_jsonb(cur) - 'updated_at' - 'updated_by' end, to_jsonb(nxt) - 'updated_at' - 'updated_by');
  return to_jsonb(nxt);
end $$;


--
-- Name: fx_currency_status(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_currency_status(p_ccy text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare c beau_ph.fx_currencies%rowtype; r record; age numeric; s beau_ph.fx_sources%rowtype;
begin
  select * into c from beau_ph.fx_currencies where currency = upper(p_ccy);
  select * into s from beau_ph.fx_sources where key = c.source_key;
  select * into r from beau_ph.fx_rate_on(upper(p_ccy), current_date);
  age := case when r.fetched_at is null then null else round(extract(epoch from (now() - r.fetched_at)) / 3600, 2) end;
  return jsonb_build_object('currency', upper(p_ccy), 'enabled', coalesce(c.enabled, upper(p_ccy) = 'EUR'), 'source', coalesce(c.source_key, case when upper(p_ccy) = 'EUR' then 'base' end),
                            'source_kind', s.kind, 'peg_currency', c.peg_currency, 'peg_rate', c.peg_rate, 'notes', c.notes,
                            'rate', r.rate, 'rate_date', r.rate_date, 'rate_source', r.source, 'fetched_at', r.fetched_at, 'age_hours', age,
                            'freshness', beau_ph.fx_freshness(age));
end $$;


--
-- Name: fx_freshness(numeric); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_freshness(p_age_hours numeric) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case when p_age_hours is null then 'missing' when p_age_hours <= 36 then 'fresh' when p_age_hours <= 72 then 'acceptable' else 'stale' end
$$;


--
-- Name: fx_ingest_rate(text, numeric, date, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_ingest_rate(p_quote text, p_rate numeric, p_rate_date date, p_source text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare last_rate numeric; why text;
begin
  select r.rate into last_rate from beau_ph.fx_rates r where r.base_currency = 'EUR' and r.quote_currency = upper(p_quote) order by r.rate_date desc limit 1;
  why := beau_ph.fx_validate_rate(p_rate, last_rate);
  if why is not null then return jsonb_build_object('currency', upper(p_quote), 'accepted', false, 'reason', why, 'rate', p_rate, 'source', p_source); end if;
  insert into beau_ph.fx_rates (base_currency, quote_currency, rate, rate_date, source, fetched_at)
  values ('EUR', upper(p_quote), p_rate, p_rate_date, p_source, now())
  on conflict (base_currency, quote_currency, rate_date) do update set rate = excluded.rate, source = excluded.source, fetched_at = now();
  return jsonb_build_object('currency', upper(p_quote), 'accepted', true, 'rate', p_rate, 'rate_date', p_rate_date, 'source', p_source);
end $$;


--
-- Name: fx_overview(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_overview(p_merchant_key text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m beau_ph.merchants%rowtype; f beau_ph.merchant_fx%rowtype; ccy_rows jsonb; last_run beau_ph.fx_refresh_runs%rowtype;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  select * into f from beau_ph.merchant_fx where merchant_id = m.id;
  select * into last_run from beau_ph.fx_refresh_runs where status <> 'requested' order by requested_at desc limit 1;
  ccy_rows := (select coalesce(jsonb_agg(beau_ph.fx_currency_status(c.currency) order by (not c.enabled), c.currency), '[]'::jsonb) from beau_ph.fx_currencies c);
  return jsonb_build_object(
    'base_currency', 'EUR',
    'settings', case when f.merchant_id is null then null else beau_ph.merchant_fx_json(f) end,
    'health', jsonb_build_object(
      'last_refresh_at', last_run.finished_at, 'last_refresh_status', last_run.status, 'last_rate_date', last_run.rate_date,
      'in_progress', exists (select 1 from beau_ph.fx_refresh_runs where status = 'requested'),
      'fresh',      (select count(*) from jsonb_array_elements(ccy_rows) r where (r ->> 'enabled')::boolean and r ->> 'freshness' = 'fresh'),
      'acceptable', (select count(*) from jsonb_array_elements(ccy_rows) r where (r ->> 'enabled')::boolean and r ->> 'freshness' = 'acceptable'),
      'stale',      (select count(*) from jsonb_array_elements(ccy_rows) r where (r ->> 'enabled')::boolean and r ->> 'freshness' = 'stale'),
      'missing',    (select count(*) from jsonb_array_elements(ccy_rows) r where (r ->> 'enabled')::boolean and r ->> 'freshness' = 'missing'),
      'rejected',   coalesce(last_run.details -> 'skipped', '[]'::jsonb), 'source_errors', coalesce(last_run.details -> 'source_errors', '{}'::jsonb)),
    'currencies', ccy_rows,
    'sources', (select coalesce(jsonb_agg(to_jsonb(s) order by s.sort), '[]'::jsonb) from beau_ph.fx_sources s),
    'runs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'requested_at', r.requested_at, 'requested_by', r.requested_by, 'status', r.status, 'rate_date', r.rate_date,
                                                          'currencies_updated', r.currencies_updated, 'currencies_skipped', r.currencies_skipped, 'finished_at', r.finished_at,
                                                          'source_errors', r.details -> 'source_errors', 'skipped', r.details -> 'skipped') order by r.requested_at desc), '[]'::jsonb)
               from (select * from beau_ph.fx_refresh_runs order by requested_at desc limit 8) r),
    'quotes', jsonb_build_object(
      'active',       (select count(*) from beau_ph.fx_quotes q where q.merchant_id = m.id and q.status = 'active' and q.expires_at >= now()),
      'consumed_30d', (select count(*) from beau_ph.fx_quotes q where q.merchant_id = m.id and q.status = 'consumed' and q.consumed_at > now() - interval '30 days')));
end $$;


--
-- Name: fx_quote(text, integer, text, text, boolean); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_quote(p_merchant_key text, p_pricing_amount integer, p_pricing_currency text, p_payment_currency text, p_preview boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m beau_ph.merchants%rowtype; f beau_ph.merchant_fx%rowtype; rf record; rt record; age numeric; fresh text;
  pc text := upper(p_pricing_currency); yc text := upper(p_payment_currency); major numeric; amt int; ref numeric; cust numeric; q beau_ph.fx_quotes%rowtype;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  if p_pricing_amount is null or p_pricing_amount <= 0 then raise exception 'amount required' using errcode = '22023'; end if;
  if not beau_ph.is_iso_currency(pc) or not beau_ph.is_iso_currency(yc) then raise exception 'ISO currencies required' using errcode = '22023'; end if;
  if pc = yc then
    return jsonb_build_object('same_currency', true, 'pricing_amount', p_pricing_amount, 'pricing_currency', pc, 'payment_amount', p_pricing_amount, 'payment_currency', yc);
  end if;
  select * into f from beau_ph.merchant_fx where merchant_id = m.id;
  if not found or not f.enabled then raise exception 'fx_disabled: this merchant does not offer other payment currencies' using errcode = 'P0003'; end if;
  if not exists (select 1 from beau_ph.fx_currencies where currency = yc and enabled) and yc <> 'EUR' then
    raise exception 'fx_currency_disabled: % is not an enabled FX currency', yc using errcode = 'P0003';
  end if;
  select * into rf from beau_ph.fx_rate_on(pc, current_date);
  select * into rt from beau_ph.fx_rate_on(yc, current_date);
  if rf.rate is null or rt.rate is null then raise exception 'fx_rate_missing: no rate for % or %', pc, yc using errcode = 'P0003'; end if;
  age := round(extract(epoch from (now() - least(rf.fetched_at, rt.fetched_at))) / 3600, 2);
  fresh := beau_ph.fx_freshness(age);
  if fresh not in ('fresh','acceptable') or age > f.max_age_hours then
    raise exception 'fx_rate_stale: the reference rate is % hours old', age using errcode = 'P0003';
  end if;
  -- pivot through EUR (Maisons formula), then the merchant adjustment; one rounding, in the payment currency's minor unit
  major := p_pricing_amount::numeric / power(10, beau_ph.fx_currency_exponent(pc));
  ref := rt.rate / rf.rate;
  cust := ref * (1 + f.adjustment_bps::numeric / 10000);
  amt := round(major * cust * power(10, beau_ph.fx_currency_exponent(yc)))::int;
  if amt <= 0 then raise exception 'fx_amount_invalid' using errcode = 'P0003'; end if;
  if p_preview then
    return jsonb_build_object('same_currency', false, 'preview', true, 'pricing_amount', p_pricing_amount, 'pricing_currency', pc,
                              'payment_amount', amt, 'payment_currency', yc, 'reference_rate', round(ref, 6), 'customer_rate', round(cust, 6),
                              'merchant_adjustment_bps', f.adjustment_bps, 'rate_date', least(rf.rate_date, rt.rate_date), 'freshness', fresh, 'age_hours', age,
                              'source', rf.source || ' / ' || rt.source, 'quote_ttl_minutes', f.quote_ttl_minutes);
  end if;
  insert into beau_ph.fx_quotes (merchant_id, pricing_currency, pricing_amount, payment_currency, payment_amount, rate_from, rate_to, rate_date_from, rate_date_to,
                                 source_from, source_to, reference_rate, provider_rate, merchant_adjustment_bps, customer_rate, freshness, age_hours, expires_at)
  values (m.id, pc, p_pricing_amount, yc, amt, rf.rate, rt.rate, rf.rate_date, rt.rate_date, rf.source, rt.source, ref, null, f.adjustment_bps, cust, fresh, age,
          now() + make_interval(mins => f.quote_ttl_minutes))
  returning * into q;
  return beau_ph.fx_quote_json(q);
end $$;


--
-- Name: fx_quote_consume(uuid, uuid, uuid, integer, text, integer, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_quote_consume(p_quote_id uuid, p_merchant_id uuid, p_request_id uuid, p_amount integer, p_currency text, p_pricing_amount integer, p_pricing_currency text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare q beau_ph.fx_quotes%rowtype;
begin
  select * into q from beau_ph.fx_quotes where id = p_quote_id for update;
  if not found or q.merchant_id <> p_merchant_id then raise exception 'fx_quote_invalid' using errcode = 'P0003'; end if;
  if q.status <> 'active' then raise exception 'fx_quote_%', q.status using errcode = 'P0003'; end if;
  if q.expires_at < now() then
    update beau_ph.fx_quotes set status = 'expired' where id = q.id;
    raise exception 'fx_quote_expired: request a new quote' using errcode = 'P0003';
  end if;
  if q.payment_amount <> p_amount or q.payment_currency <> upper(p_currency) or q.pricing_amount <> p_pricing_amount or q.pricing_currency <> upper(p_pricing_currency) then
    raise exception 'fx_quote_mismatch: the request does not match the quote' using errcode = 'P0003';
  end if;
  update beau_ph.fx_quotes set status = 'consumed', request_id = p_request_id, consumed_at = now() where id = q.id returning * into q;
  return beau_ph.fx_quote_json(q);
end $$;


--
-- Name: is_iso_currency(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.is_iso_currency(p text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$ select p ~ '^[A-Z]{3}$' $_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: fx_quotes; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.fx_quotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    merchant_id uuid NOT NULL,
    pricing_currency text NOT NULL,
    pricing_amount integer NOT NULL,
    payment_currency text NOT NULL,
    payment_amount integer NOT NULL,
    rate_from numeric(18,8) NOT NULL,
    rate_to numeric(18,8) NOT NULL,
    rate_date_from date NOT NULL,
    rate_date_to date NOT NULL,
    source_from text NOT NULL,
    source_to text NOT NULL,
    reference_rate numeric(20,10) NOT NULL,
    provider_rate numeric(20,10),
    merchant_adjustment_bps integer DEFAULT 0 NOT NULL,
    customer_rate numeric(20,10) NOT NULL,
    freshness text NOT NULL,
    age_hours numeric(8,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    request_id uuid,
    consumed_at timestamp with time zone,
    CONSTRAINT fx_quotes_freshness_check CHECK ((freshness = ANY (ARRAY['fresh'::text, 'acceptable'::text]))),
    CONSTRAINT fx_quotes_payment_amount_check CHECK ((payment_amount > 0)),
    CONSTRAINT fx_quotes_payment_currency_check CHECK (beau_ph.is_iso_currency(payment_currency)),
    CONSTRAINT fx_quotes_pricing_amount_check CHECK ((pricing_amount > 0)),
    CONSTRAINT fx_quotes_pricing_currency_check CHECK (beau_ph.is_iso_currency(pricing_currency)),
    CONSTRAINT fx_quotes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'consumed'::text, 'expired'::text])))
);


--
-- Name: fx_quote_json(beau_ph.fx_quotes); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_quote_json(q beau_ph.fx_quotes) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object('id', q.id, 'same_currency', false, 'preview', false, 'pricing_amount', q.pricing_amount, 'pricing_currency', q.pricing_currency,
                            'payment_amount', q.payment_amount, 'payment_currency', q.payment_currency, 'reference_rate', round(q.reference_rate, 6),
                            'provider_rate', q.provider_rate, 'merchant_adjustment_bps', q.merchant_adjustment_bps, 'customer_rate', round(q.customer_rate, 6),
                            'rate_date', least(q.rate_date_from, q.rate_date_to), 'source', q.source_from || ' / ' || q.source_to, 'freshness', q.freshness, 'age_hours', q.age_hours,
                            'created_at', q.created_at, 'expires_at', q.expires_at,
                            'status', case when q.status = 'active' and q.expires_at < now() then 'expired' else q.status end, 'request_id', q.request_id)
$$;


--
-- Name: fx_quotes_guard(); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_quotes_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then raise exception 'fx quotes are never deleted' using errcode = 'P0003'; end if;
  if (to_jsonb(new) - 'status' - 'request_id' - 'consumed_at') is distinct from (to_jsonb(old) - 'status' - 'request_id' - 'consumed_at') then
    raise exception 'fx quote is immutable' using errcode = 'P0003';
  end if;
  if old.status <> 'active' and new.status is distinct from old.status then
    raise exception 'fx quote already %', old.status using errcode = 'P0003';
  end if;
  return new;
end $$;


--
-- Name: fx_rate_on(text, date); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_rate_on(p_ccy text, p_date date DEFAULT CURRENT_DATE) RETURNS TABLE(rate numeric, rate_date date, source text, fetched_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select 1::numeric, p_date, 'base'::text, now() where upper(p_ccy) = 'EUR'
  union all
  (select r.rate, r.rate_date, r.source, r.fetched_at
     from beau_ph.fx_rates r
    where upper(p_ccy) <> 'EUR' and r.base_currency = 'EUR' and r.quote_currency = upper(p_ccy) and r.rate_date <= p_date
    order by r.rate_date desc limit 1)
$$;


--
-- Name: fx_refresh_collect(); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_refresh_collect() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare run beau_ph.fx_refresh_runs%rowtype; s beau_ph.fx_sources%rowtype; k text; req bigint; resp record; body jsonb; d date;
  accepted jsonb; skipped jsonb; errors jsonb; c beau_ph.fx_currencies%rowtype; res jsonb; gel_per_eur numeric; q numeric; item jsonb; summary jsonb := '[]'::jsonb;
  pending boolean; usd record; last_date date;
begin
  for run in select * from beau_ph.fx_refresh_runs where status = 'requested' order by requested_at loop
    accepted := '[]'::jsonb; skipped := '[]'::jsonb; errors := '{}'::jsonb; pending := false; last_date := null;
    for k in select jsonb_object_keys(run.http) loop
      select * into s from beau_ph.fx_sources where key = k;
      if jsonb_typeof(run.http -> k) <> 'number' then errors := errors || jsonb_build_object(k, run.http -> k ->> 'error'); continue; end if;
      req := (run.http ->> k)::bigint;
      select r.status_code, r.content, r.timed_out, r.error_msg into resp from net._http_response r where r.id = req;
      if resp is null or resp.status_code is null and resp.error_msg is null and not coalesce(resp.timed_out, false) then
        if run.requested_at > now() - interval '10 minutes' then pending := true; continue; end if;
        errors := errors || jsonb_build_object(k, 'no response within 10 minutes'); continue;
      end if;
      if coalesce(resp.timed_out, false) or resp.error_msg is not null or resp.status_code <> 200 then
        errors := errors || jsonb_build_object(k, coalesce(resp.error_msg, 'http ' || coalesce(resp.status_code::text, 'timeout'))); continue;
      end if;
      begin body := resp.content::jsonb; exception when others then errors := errors || jsonb_build_object(k, 'invalid json'); continue; end;
      if s.kind = 'frankfurter' then
        d := (body ->> 'date')::date;
        for c in select * from beau_ph.fx_currencies where enabled and source_key = s.key loop
          q := (body -> 'rates' ->> c.currency)::numeric;
          res := beau_ph.fx_ingest_rate(c.currency, q, d, s.key);
          if (res ->> 'accepted')::boolean then accepted := accepted || res; else skipped := skipped || res; end if;
        end loop;
        last_date := coalesce(greatest(last_date, d), d);
      elsif s.kind = 'nbg' then
        item := case when jsonb_typeof(body) = 'array' then body -> 0 else body end;
        d := left(item ->> 'date', 10)::date;
        select (x ->> 'rate')::numeric / nullif((x ->> 'quantity')::numeric, 0) into gel_per_eur from jsonb_array_elements(item -> 'currencies') x where x ->> 'code' = 'EUR';
        for c in select * from beau_ph.fx_currencies where enabled and source_key = s.key loop
          if c.currency = 'GEL' then q := gel_per_eur;
          else select gel_per_eur / nullif((x ->> 'rate')::numeric / nullif((x ->> 'quantity')::numeric, 0), 0) into q from jsonb_array_elements(item -> 'currencies') x where x ->> 'code' = c.currency;
          end if;
          res := beau_ph.fx_ingest_rate(c.currency, q, d, s.key);
          if (res ->> 'accepted')::boolean then accepted := accepted || res; else skipped := skipped || res; end if;
        end loop;
        last_date := coalesce(greatest(last_date, d), d);
      end if;
    end loop;
    if pending then continue; end if;
    -- pegs: derived from the peg currency's rate of the same day (never from a stale one)
    for c in select fc.* from beau_ph.fx_currencies fc join beau_ph.fx_sources fs on fs.key = fc.source_key where fc.enabled and fs.enabled and fs.kind = 'peg' loop
      select * into usd from beau_ph.fx_rate_on(c.peg_currency, current_date);
      if usd.rate is null or c.peg_rate is null or usd.rate_date < current_date - 7 then
        skipped := skipped || jsonb_build_object('currency', c.currency, 'accepted', false, 'reason', 'peg_base_missing');
      else
        res := beau_ph.fx_ingest_rate(c.currency, usd.rate * c.peg_rate, usd.rate_date, c.source_key || '(' || c.peg_currency || ')');
        if (res ->> 'accepted')::boolean then accepted := accepted || res; else skipped := skipped || res; end if;
      end if;
    end loop;
    update beau_ph.fx_refresh_runs set
      status = case when jsonb_array_length(accepted) = 0 then 'failed' when jsonb_array_length(skipped) > 0 or errors <> '{}'::jsonb then 'partial' else 'success' end,
      rate_date = last_date, currencies_updated = jsonb_array_length(accepted), currencies_skipped = jsonb_array_length(skipped),
      details = jsonb_build_object('accepted', accepted, 'skipped', skipped, 'source_errors', errors), finished_at = now()
     where id = run.id;
    summary := summary || jsonb_build_object('run', run.id, 'accepted', jsonb_array_length(accepted), 'skipped', jsonb_array_length(skipped), 'errors', errors);
  end loop;
  -- lifecycle of quotes (allowed by the guard)
  update beau_ph.fx_quotes set status = 'expired' where status = 'active' and expires_at < now();
  return summary;
end $$;


--
-- Name: fx_refresh_start(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_refresh_start(p_actor text DEFAULT 'cron'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare run_id uuid; s beau_ph.fx_sources%rowtype; ccys text; req bigint; v_http jsonb := '{}'::jsonb; url text;
begin
  if exists (select 1 from beau_ph.fx_refresh_runs where status = 'requested' and requested_at > now() - interval '10 minutes') then
    raise exception 'a refresh is already in progress' using errcode = 'P0003';
  end if;
  insert into beau_ph.fx_refresh_runs (requested_by) values (coalesce(p_actor, 'cron')) returning id into run_id;
  for s in select * from beau_ph.fx_sources where enabled and kind in ('frankfurter','nbg') order by sort loop
    select string_agg(currency, ',' order by currency) into ccys from beau_ph.fx_currencies where enabled and source_key = s.key;
    if ccys is null then continue; end if;
    url := case s.kind when 'frankfurter' then s.url || '?base=EUR&to=' || ccys
                       when 'nbg' then s.url || '?date=' || to_char(current_date, 'YYYY-MM-DD') end;
    begin
      req := net.http_get(url, '{}'::jsonb, '{"accept":"application/json"}'::jsonb, 8000);
      v_http := v_http || jsonb_build_object(s.key, req);
    exception when others then
      v_http := v_http || jsonb_build_object(s.key, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  update beau_ph.fx_refresh_runs set http = v_http where id = run_id;
  if v_http = '{}'::jsonb then
    update beau_ph.fx_refresh_runs set status = 'failed', finished_at = now(), details = '{"error":"no enabled source with enabled currencies"}'::jsonb where id = run_id;
  end if;
  return run_id;
end $$;


--
-- Name: fx_validate_rate(numeric, numeric); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.fx_validate_rate(p_rate numeric, p_last numeric) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case when p_rate is null then 'not_numeric'
              when p_rate <= 0 then 'non_positive'
              when p_last is not null and p_last > 0 and abs(p_rate - p_last) / p_last > 0.20 then 'variation_' || round(abs(p_rate - p_last) / p_last * 100, 1) || 'pct'
              else null end
$$;


--
-- Name: get_request(uuid, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.get_request(p_request_id uuid, p_merchant_key text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select beau_ph.request_json(r) from beau_ph.payment_requests r
   where r.id = p_request_id and beau_ph.owned_by(r.id, p_merchant_key)
$$;


--
-- Name: ingest_provider_event(text, text, text, jsonb, jsonb); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.ingest_provider_event(p_provider text, p_provider_event_id text, p_event_type text, p_payload jsonb, p_normalized jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare pv beau_ph.providers%rowtype; pe beau_ph.provider_events%rowtype; pe_id uuid; r beau_ph.payment_requests%rowtype; m beau_ph.merchants%rowtype;
  cap beau_ph.provider_capabilities%rowtype;
  ev beau_ph.payment_events%rowtype; v_to text; v_amount int; v_currency text; v_outcome text; existing_ev uuid; v_live boolean;
begin
  select * into pv from beau_ph.providers where key = p_provider;
  if not found then raise exception 'unknown provider' using errcode = 'P0002'; end if;
  if coalesce(p_provider_event_id, '') = '' or coalesce(p_event_type, '') = '' then raise exception 'malformed event' using errcode = '22023'; end if;

  insert into beau_ph.provider_events (provider_key, provider_event_id, event_type, payload)
  values (p_provider, p_provider_event_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider_key, provider_event_id) do nothing returning id into pe_id;
  if pe_id is null then
    select * into pe from beau_ph.provider_events where provider_key = p_provider and provider_event_id = p_provider_event_id;
    select id into existing_ev from beau_ph.payment_events where provider_event_id = pe.id;
    return jsonb_build_object('ok', true, 'duplicate', true, 'outcome', pe.outcome, 'provider_event_id', pe.id,
                              'request_id', pe.request_id, 'payment_event_id', existing_ev);
  end if;

  if pv.confirmation <> 'provider_event' then
    v_outcome := 'rejected:' || case when pv.kind = 'manual' then 'manual_provider_requires_operator' else 'provider_cannot_confirm' end;
  elsif pv.readiness <> 'available' then
    v_outcome := 'rejected:provider_' || pv.readiness;
  elsif p_normalized ? 'ignore' then
    v_outcome := 'ignored:' || (p_normalized ->> 'ignore');
  end if;
  if v_outcome is not null then
    update beau_ph.provider_events set outcome = v_outcome, processed_at = now() where id = pe_id;
    return jsonb_build_object('ok', false, 'duplicate', false, 'outcome', v_outcome, 'provider_event_id', pe_id);
  end if;

  if (p_normalized ->> 'request_id') is not null then
    select * into r from beau_ph.payment_requests where id = (p_normalized ->> 'request_id')::uuid and provider_key = p_provider;
  end if;
  if r.id is null and (p_normalized ->> 'provider_reference') is not null then
    select * into r from beau_ph.payment_requests where provider_key = p_provider and provider_reference = p_normalized ->> 'provider_reference';
  end if;
  if r.id is null and (p_normalized ->> 'payment_reference') is not null then
    select * into r from beau_ph.payment_requests where provider_key = p_provider and payment_reference = p_normalized ->> 'payment_reference';
  end if;
  if r.id is null and (p_normalized ->> 'external_reference') is not null then
    select pr.* into r from beau_ph.payment_requests pr
      join beau_ph.merchants mm on mm.id = pr.merchant_id
     where pr.provider_key = p_provider and pr.external_reference = p_normalized ->> 'external_reference'
       and (p_normalized ->> 'merchant' is null or mm.key = p_normalized ->> 'merchant')
     order by case when pr.status in ('created','pending','requires_action') then 0 else 1 end, pr.created_at desc limit 1;
  end if;
  if r.id is null then
    update beau_ph.provider_events set outcome = 'no_request', processed_at = now() where id = pe_id;
    return jsonb_build_object('ok', false, 'duplicate', false, 'outcome', 'no_request', 'provider_event_id', pe_id);
  end if;
  select * into m from beau_ph.merchants where id = r.merchant_id;
  select * into cap from beau_ph.provider_capabilities where provider_key = r.provider_key and capability = r.capability;

  v_to := p_normalized ->> 'status'; v_amount := (p_normalized ->> 'amount')::int; v_currency := upper(p_normalized ->> 'currency');
  v_live := (p_normalized -> 'evidence' ->> 'livemode')::boolean;      -- null when the provider carries no mode (manual rails)
  if cap.capability is not null and cap.confirmation <> 'provider_event' then
    v_outcome := 'rejected:capability_requires_operator';
  elsif cap.capability is not null and cap.readiness <> 'available' then
    v_outcome := 'rejected:capability_' || cap.readiness;
  elsif not exists (select 1 from beau_ph.merchant_methods where merchant_id = r.merchant_id and provider_key = p_provider and enabled) then
    v_outcome := 'rejected:provider_disabled';
  elsif v_live is not null and v_live <> (m.mode = 'live') then
    v_outcome := 'rejected:mode_mismatch';                                -- both directions: test↔live never cross
  elsif v_to = 'paid' and (v_amount is null or v_amount <> r.amount or v_currency is null or v_currency <> r.currency) then
    v_outcome := 'rejected:amount_mismatch';
  elsif v_to = 'paid' and r.status in ('paid','refunded') then
    v_outcome := 'ignored:already_paid';
  elsif v_to = 'refunded' and coalesce((p_normalized ->> 'refund_amount')::int, r.amount) < r.amount then
    v_to := 'evidence';
  end if;
  if v_outcome is not null then
    update beau_ph.provider_events set request_id = r.id, outcome = v_outcome, processed_at = now() where id = pe_id;
    return jsonb_build_object('ok', false, 'duplicate', false, 'outcome', v_outcome, 'provider_event_id', pe_id, 'request_id', r.id,
                              'status', r.status, 'external_reference', r.external_reference, 'public_reference', r.public_reference, 'merchant', m.key);
  end if;
  if v_to = 'evidence' or v_to is null then v_to := r.status; end if;
  if not beau_ph.transition_allowed(r.status, v_to) then
    v_outcome := 'rejected:illegal_transition:' || r.status || '->' || v_to;
    update beau_ph.provider_events set request_id = r.id, outcome = v_outcome, processed_at = now() where id = pe_id;
    return jsonb_build_object('ok', false, 'duplicate', false, 'outcome', v_outcome, 'provider_event_id', pe_id, 'request_id', r.id, 'status', r.status);
  end if;

  ev := beau_ph.record_event(r.id, v_to, 'provider', null, pe_id, v_amount, v_currency, p_normalized ->> 'provider_status',
                             p_normalized ->> 'provider_reference', p_normalized ->> 'payment_reference', coalesce(p_normalized -> 'evidence', '{}'::jsonb));
  v_outcome := case when ev.from_status = ev.to_status then 'evidence' else 'normalized' end;
  update beau_ph.provider_events set request_id = r.id, outcome = v_outcome, processed_at = now() where id = pe_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'outcome', v_outcome, 'provider_event_id', pe_id, 'request_id', r.id,
                            'payment_event_id', ev.id, 'from', ev.from_status, 'to', ev.to_status,
                            'external_reference', r.external_reference, 'public_reference', r.public_reference, 'merchant', m.key,
                            'amount', r.amount, 'currency', r.currency);
end $$;


--
-- Name: ingest_stripe_event(jsonb); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.ingest_stripe_event(p_event jsonb) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select beau_ph.ingest_provider_event('stripe', p_event ->> 'id', p_event ->> 'type', p_event, beau_ph.normalize_stripe_event(p_event))
$$;


--
-- Name: intents_valid(text[]); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.intents_valid(p text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p is null or not exists (select 1 from unnest(p) i where not beau_ph.is_intent(i))
$$;


--
-- Name: is_capability(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.is_capability(p text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p in ('online_checkout','payment_link','manual_instructions','wallet','bank_transfer','mobile_money',
               'softpos','card_present','tap_to_pay','qr','crypto','cash','p2p_transfer')
$$;


--
-- Name: is_in_person(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.is_in_person(p text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p in ('softpos','card_present','tap_to_pay','cash')
$$;


--
-- Name: is_intent(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.is_intent(p text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p in ('service','package','support','other','personal')
$$;


--
-- Name: is_iso_country(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.is_iso_country(p text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$ select p ~ '^[A-Z]{2}$' $_$;


--
-- Name: is_platform(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.is_platform(p text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p is null or p in ('web','ios_pwa','android_pwa','ios_app','android_app')
$$;


--
-- Name: is_reconciled(uuid); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.is_reconciled(p_payment_event_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (select 1 from beau_ph.reconciliations where payment_event_id = p_payment_event_id)
$$;


--
-- Name: mark_reconciled(uuid, text, text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.mark_reconciled(p_payment_event_id uuid, p_host_reference text, p_note text DEFAULT NULL::text, p_merchant_key text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare rid uuid; ex beau_ph.reconciliations%rowtype; v_req uuid;
begin
  select request_id into v_req from beau_ph.payment_events where id = p_payment_event_id;
  if v_req is null or not beau_ph.owned_by(v_req, p_merchant_key) then raise exception 'payment event not found' using errcode = 'P0002'; end if;
  insert into beau_ph.reconciliations (payment_event_id, request_id, merchant_id, host_reference, note)
  select ev.id, ev.request_id, r.merchant_id, p_host_reference, p_note
    from beau_ph.payment_events ev join beau_ph.payment_requests r on r.id = ev.request_id
   where ev.id = p_payment_event_id
  on conflict (payment_event_id) do nothing returning id into rid;
  if rid is null then
    select * into ex from beau_ph.reconciliations where payment_event_id = p_payment_event_id;
    return jsonb_build_object('ok', true, 'duplicate', true, 'id', ex.id, 'host_reference', ex.host_reference, 'reconciled_at', ex.reconciled_at);
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'id', rid, 'host_reference', p_host_reference);
end $$;


--
-- Name: merchant_fx; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.merchant_fx (
    merchant_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    reporting_currency text,
    adjustment_bps integer DEFAULT 0 NOT NULL,
    quote_ttl_minutes integer DEFAULT 15 NOT NULL,
    max_age_hours integer DEFAULT 72 NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT merchant_fx_adjustment_bps_check CHECK (((adjustment_bps >= '-1000'::integer) AND (adjustment_bps <= 1000))),
    CONSTRAINT merchant_fx_max_age_hours_check CHECK (((max_age_hours >= 1) AND (max_age_hours <= 720))),
    CONSTRAINT merchant_fx_quote_ttl_minutes_check CHECK (((quote_ttl_minutes >= 1) AND (quote_ttl_minutes <= 120))),
    CONSTRAINT merchant_fx_reporting_currency_check CHECK (((reporting_currency IS NULL) OR beau_ph.is_iso_currency(reporting_currency)))
);


--
-- Name: merchant_fx_json(beau_ph.merchant_fx); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.merchant_fx_json(f beau_ph.merchant_fx) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object('enabled', f.enabled, 'reporting_currency', f.reporting_currency, 'adjustment_bps', f.adjustment_bps,
                            'quote_ttl_minutes', f.quote_ttl_minutes, 'max_age_hours', f.max_age_hours, 'updated_by', f.updated_by, 'updated_at', f.updated_at)
$$;


--
-- Name: merchant_fx_set(text, jsonb, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.merchant_fx_set(p_merchant_key text, p jsonb, p_actor text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m beau_ph.merchants%rowtype; cur beau_ph.merchant_fx%rowtype; nxt beau_ph.merchant_fx%rowtype;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  select * into cur from beau_ph.merchant_fx where merchant_id = m.id;
  insert into beau_ph.merchant_fx (merchant_id, enabled, reporting_currency, adjustment_bps, quote_ttl_minutes, max_age_hours, updated_by)
  values (m.id, coalesce((p ->> 'enabled')::boolean, cur.enabled, false),
          coalesce(nullif(upper(p ->> 'reporting_currency'), ''), cur.reporting_currency, m.default_currency),
          coalesce((p ->> 'adjustment_bps')::int, cur.adjustment_bps, 0), coalesce((p ->> 'quote_ttl_minutes')::int, cur.quote_ttl_minutes, 15),
          coalesce((p ->> 'max_age_hours')::int, cur.max_age_hours, 72), p_actor)
  on conflict (merchant_id) do update set enabled = excluded.enabled, reporting_currency = excluded.reporting_currency, adjustment_bps = excluded.adjustment_bps,
    quote_ttl_minutes = excluded.quote_ttl_minutes, max_age_hours = excluded.max_age_hours, updated_by = excluded.updated_by, updated_at = now()
  returning * into nxt;
  perform beau_ph.audit_diff(m.id, 'merchant_fx', m.key, p_actor,
                             case when cur.merchant_id is null then '{}'::jsonb else beau_ph.merchant_fx_json(cur) - 'updated_at' - 'updated_by' end,
                             beau_ph.merchant_fx_json(nxt) - 'updated_at' - 'updated_by');
  return beau_ph.merchant_fx_json(nxt);
end $$;


--
-- Name: merchant_method_configure(text, text, jsonb, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.merchant_method_configure(p_merchant_key text, p_provider text, p jsonb, p_actor text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m beau_ph.merchants%rowtype; pv beau_ph.providers%rowtype; cur beau_ph.merchant_methods%rowtype; nxt beau_ph.merchant_methods%rowtype;
  v_countries text[]; v_currencies text[]; v_intents text[]; v_caps text[]; v_limits jsonb; v_ins jsonb; v_set jsonb; v_settle jsonb; k text; d beau_ph.settlement_destinations%rowtype;
  old_json jsonb; new_json jsonb;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  select * into pv from beau_ph.providers where key = p_provider;
  if not found then raise exception 'unknown provider' using errcode = '22023'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'configuration object required' using errcode = '22023'; end if;
  select * into cur from beau_ph.merchant_methods where merchant_id = m.id and provider_key = p_provider;
  old_json := case when cur.id is null then null else beau_ph.merchant_method_json(cur) end;

  -- arrays: absent = keep; null = clear; values normalised to upper case and validated
  v_countries  := case when p ? 'countries'  then (select array_agg(distinct upper(btrim(e))) from jsonb_array_elements_text(nullif(p -> 'countries',  'null'::jsonb)) e) else cur.countries  end;
  v_currencies := case when p ? 'currencies' then (select array_agg(distinct upper(btrim(e))) from jsonb_array_elements_text(nullif(p -> 'currencies', 'null'::jsonb)) e) else cur.currencies end;
  v_intents    := case when p ? 'intents'    then (select array_agg(distinct lower(btrim(e))) from jsonb_array_elements_text(nullif(p -> 'intents',    'null'::jsonb)) e) else cur.intents    end;
  v_caps       := case when p ? 'capabilities' then (select array_agg(distinct lower(btrim(e))) from jsonb_array_elements_text(nullif(p -> 'capabilities', 'null'::jsonb)) e) else cur.capabilities end;
  if v_countries  is not null and exists (select 1 from unnest(v_countries)  c where not beau_ph.is_iso_country(c))  then raise exception 'countries must be ISO 3166-1 alpha-2 codes' using errcode = '22023'; end if;
  if v_currencies is not null and exists (select 1 from unnest(v_currencies) c where not beau_ph.is_iso_currency(c)) then raise exception 'currencies must be ISO 4217 codes' using errcode = '22023'; end if;
  if v_intents    is not null and exists (select 1 from unnest(v_intents)    i where not beau_ph.is_intent(i))       then raise exception 'unknown intent' using errcode = '22023'; end if;
  if v_caps is not null and exists (select 1 from unnest(v_caps) c where not exists (select 1 from beau_ph.provider_capabilities pc where pc.provider_key = p_provider and pc.capability = c)) then
    raise exception 'capability not offered by provider %', p_provider using errcode = '22023';
  end if;
  -- a merchant can narrow a provider, never broaden it
  if not beau_ph.array_is_subset(v_countries,  pv.countries)  then raise exception 'countries outside provider % coverage', p_provider using errcode = 'P0003'; end if;
  if not beau_ph.array_is_subset(v_currencies, pv.currencies) then raise exception 'currencies outside provider % coverage', p_provider using errcode = 'P0003'; end if;
  if not beau_ph.array_is_subset(v_intents,    pv.intents)    then raise exception 'intents outside provider % support', p_provider using errcode = 'P0003'; end if;

  v_limits := case when p ? 'limits' then coalesce(p -> 'limits', '{}'::jsonb) else coalesce(cur.limits, '{}'::jsonb) end;
  if jsonb_typeof(v_limits) <> 'object' then raise exception 'limits must be an object keyed by currency' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(v_limits) loop
    if not beau_ph.is_iso_currency(k) then raise exception 'limits keyed by ISO currency' using errcode = '22023'; end if;
    if (v_limits -> k ->> 'min') is not null and (v_limits -> k ->> 'min')::numeric < 0 then raise exception 'minimum must be >= 0' using errcode = '22023'; end if;
    if (v_limits -> k ->> 'max') is not null and (v_limits -> k ->> 'min') is not null and (v_limits -> k ->> 'max')::numeric < (v_limits -> k ->> 'min')::numeric then
      raise exception 'maximum below minimum for %', k using errcode = '22023';
    end if;
  end loop;
  v_ins := case when p ? 'instructions' then coalesce(p -> 'instructions', '{}'::jsonb) else coalesce(cur.instructions, '{}'::jsonb) end;
  v_set := case when p ? 'settings'     then coalesce(p -> 'settings',     '{}'::jsonb) else coalesce(cur.settings,     '{}'::jsonb) end;
  if not beau_ph.no_secret_keys(v_ins) or not beau_ph.no_secret_keys(v_set) or not beau_ph.no_secret_keys(v_limits) then
    raise exception 'secrets are never stored in merchant configuration' using errcode = '22023';
  end if;

  insert into beau_ph.merchant_methods (merchant_id, provider_key, enabled, listed, currency, countries, currencies, intents, capabilities, limits, instructions, settings, updated_by)
  values (m.id, p_provider,
          coalesce((p ->> 'enabled')::boolean, cur.enabled, false),
          coalesce((p ->> 'listed')::boolean, cur.listed, true),
          case when p ? 'currency' then nullif(upper(p ->> 'currency'), '') else cur.currency end,
          v_countries, v_currencies, v_intents, v_caps, v_limits, jsonb_strip_nulls(v_ins), jsonb_strip_nulls(v_set), p_actor)
  on conflict (merchant_id, provider_key) do update set
    enabled = excluded.enabled, listed = excluded.listed, currency = excluded.currency, countries = excluded.countries, currencies = excluded.currencies,
    intents = excluded.intents, capabilities = excluded.capabilities, limits = excluded.limits, instructions = excluded.instructions, settings = excluded.settings,
    updated_by = excluded.updated_by, updated_at = now()
  returning * into nxt;

  -- settlement mapping: {currency: destination key}; a destination must belong to the merchant and be in that currency
  if p ? 'settlement' then
    v_settle := coalesce(p -> 'settlement', '{}'::jsonb);
    delete from beau_ph.method_settlements where merchant_method_id = nxt.id;
    for k in select jsonb_object_keys(v_settle) loop
      if v_settle ->> k is null or v_settle ->> k = '' then continue; end if;
      select * into d from beau_ph.settlement_destinations where merchant_id = m.id and key = v_settle ->> k;
      if not found then raise exception 'unknown settlement destination %', v_settle ->> k using errcode = '22023'; end if;
      if d.currency <> upper(k) then raise exception 'destination % settles %, not %', d.key, d.currency, k using errcode = '22023'; end if;
      insert into beau_ph.method_settlements (merchant_method_id, currency, destination_id) values (nxt.id, upper(k), d.id);
    end loop;
  end if;

  new_json := beau_ph.merchant_method_json(nxt);
  perform beau_ph.audit_diff(m.id, 'merchant_method', p_provider, p_actor,
                             coalesce(old_json, '{}'::jsonb) - 'updated_at' - 'updated_by' - 'created_at' - 'id',
                             new_json - 'updated_at' - 'updated_by' - 'created_at' - 'id');
  return new_json;
end $$;


--
-- Name: merchant_method_get(text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.merchant_method_get(p_merchant_key text, p_provider text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m beau_ph.merchants%rowtype; pv beau_ph.providers%rowtype; mm beau_ph.merchant_methods%rowtype;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  select * into pv from beau_ph.providers where key = p_provider;
  if not found then raise exception 'unknown provider' using errcode = 'P0002'; end if;
  select * into mm from beau_ph.merchant_methods where merchant_id = m.id and provider_key = p_provider;
  return jsonb_build_object(
    'provider', jsonb_build_object('key', pv.key, 'display_name', pv.display_name, 'kind', pv.kind, 'channel_label', pv.channel_label, 'readiness', pv.readiness,
                                   'confirmation', pv.confirmation, 'countries', to_jsonb(pv.countries), 'currencies', to_jsonb(pv.currencies), 'intents', to_jsonb(pv.intents),
                                   'secrets', to_jsonb(pv.secrets), 'config_schema', pv.config_schema, 'onboarding', pv.onboarding, 'notes', pv.notes,
                                   'capabilities', beau_ph.capabilities_json(pv.key)),
    'method', case when mm.id is null then null else beau_ph.merchant_method_json(mm) end,
    'destinations', beau_ph.settlement_destinations_list(p_merchant_key),
    'intents', jsonb_build_array('service','package','support','other'));
end $$;


--
-- Name: no_secret_keys(jsonb); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.no_secret_keys(p jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p is null
      or not (p::text ~* '"(secret|api_?key|private_?key|password|passkey|access_?token|client_?secret|signing_?secret|webhook_?secret)"\s*:'
              or p::text ~ '(sk|rk)_(live|test)_[A-Za-z0-9]{8,}'
              or p::text ~ 'whsec_[A-Za-z0-9]{8,}')
$$;


--
-- Name: merchant_methods; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.merchant_methods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    merchant_id uuid NOT NULL,
    provider_key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    currency text,
    countries text[],
    instructions jsonb DEFAULT '{}'::jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    capabilities text[],
    currencies text[],
    intents text[],
    limits jsonb DEFAULT '{}'::jsonb NOT NULL,
    listed boolean DEFAULT true NOT NULL,
    CONSTRAINT merchant_methods_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT merchant_methods_instructions_check CHECK (beau_ph.no_secret_keys(instructions)),
    CONSTRAINT merchant_methods_intents_check CHECK (beau_ph.intents_valid(intents)),
    CONSTRAINT merchant_methods_limits_check CHECK (beau_ph.no_secret_keys(limits)),
    CONSTRAINT merchant_methods_settings_check CHECK (beau_ph.no_secret_keys(settings))
);


--
-- Name: merchant_method_json(beau_ph.merchant_methods); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.merchant_method_json(mm beau_ph.merchant_methods) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object('id', mm.id, 'provider', mm.provider_key, 'enabled', mm.enabled, 'listed', mm.listed, 'currency', mm.currency,
                            'countries', to_jsonb(mm.countries), 'currencies', to_jsonb(mm.currencies), 'intents', to_jsonb(mm.intents),
                            'capabilities', to_jsonb(mm.capabilities), 'limits', mm.limits, 'instructions', mm.instructions, 'settings', mm.settings,
                            'settlement', (select coalesce(jsonb_object_agg(ms.currency, d.key), '{}'::jsonb)
                                             from beau_ph.method_settlements ms join beau_ph.settlement_destinations d on d.id = ms.destination_id
                                            where ms.merchant_method_id = mm.id),
                            'updated_by', mm.updated_by, 'updated_at', mm.updated_at, 'created_at', mm.created_at)
$$;


--
-- Name: merchant_method_remove(text, text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.merchant_method_remove(p_merchant_key text, p_provider text, p_actor text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m beau_ph.merchants%rowtype; cur beau_ph.merchant_methods%rowtype; n int;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  select * into cur from beau_ph.merchant_methods where merchant_id = m.id and provider_key = p_provider;
  if not found then raise exception 'method not configured' using errcode = 'P0002'; end if;
  select count(*) into n from beau_ph.payment_requests where merchant_id = m.id and provider_key = p_provider;
  if n > 0 then
    return beau_ph.merchant_method_configure(p_merchant_key, p_provider, '{"enabled":false,"listed":false}'::jsonb, p_actor) || jsonb_build_object('removed', 'unlisted', 'history', n);
  end if;
  perform beau_ph.audit_diff(m.id, 'merchant_method', p_provider, p_actor, beau_ph.merchant_method_json(cur) - 'updated_at' - 'updated_by' - 'created_at' - 'id', '{}'::jsonb);
  delete from beau_ph.merchant_methods where id = cur.id;
  return jsonb_build_object('provider', p_provider, 'removed', 'deleted', 'history', 0);
end $$;


--
-- Name: merchant_method_set(text, text, boolean, text, jsonb, jsonb, text[], text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.merchant_method_set(p_merchant_key text, p_provider text, p_enabled boolean, p_currency text, p_instructions jsonb, p_settings jsonb, p_countries text[], p_updated_by text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m beau_ph.merchants%rowtype; pv beau_ph.providers%rowtype; cur beau_ph.merchant_methods%rowtype; cfg jsonb;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  select * into pv from beau_ph.providers where key = p_provider;
  if not found then raise exception 'unknown provider' using errcode = '22023'; end if;
  select * into cur from beau_ph.merchant_methods where merchant_id = m.id and provider_key = p_provider;
  cfg := jsonb_build_object('enabled', coalesce(p_enabled, false), 'currency', nullif(upper(p_currency), ''),
                            'instructions', coalesce(p_instructions, '{}'::jsonb), 'settings', coalesce(p_settings, '{}'::jsonb));
  if p_countries is not null then cfg := cfg || jsonb_build_object('countries', to_jsonb(p_countries));
  elsif cur.id is null then cfg := cfg || jsonb_build_object('countries', to_jsonb(coalesce(pv.countries, array[m.country]))); end if;
  if cur.id is null then
    if pv.currencies is not null then cfg := cfg || jsonb_build_object('currencies', to_jsonb(pv.currencies));
    elsif nullif(upper(p_currency), '') is not null then cfg := cfg || jsonb_build_object('currencies', to_jsonb(array[upper(p_currency)])); end if;
  end if;
  return beau_ph.merchant_method_configure(p_merchant_key, p_provider, cfg, p_updated_by) - 'settlement';
end $$;


--
-- Name: merchant_methods_summary(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.merchant_methods_summary(p_merchant_key text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'provider', mm.provider_key, 'display_name', p.display_name, 'channel_label', p.channel_label, 'kind', p.kind, 'readiness', p.readiness,
      'enabled', mm.enabled, 'countries', to_jsonb(mm.countries), 'currencies', to_jsonb(mm.currencies), 'intents', to_jsonb(mm.intents),
      'health', case when mm.countries is null or mm.currencies is null then 'needs_configuration' else 'configured' end,
      'hint', (select string_agg('•••• ' || right(mm.instructions ->> (s ->> 'key'), 4), ' ')
                 from jsonb_array_elements(p.config_schema) s where (s ->> 'mask')::boolean and coalesce(mm.instructions ->> (s ->> 'key'), '') <> ''),
      'history', (select count(*) from beau_ph.payment_requests r where r.merchant_id = mm.merchant_id and r.provider_key = mm.provider_key),
      'updated_at', mm.updated_at, 'updated_by', mm.updated_by) order by p.sort, p.key), '[]'::jsonb)
    from beau_ph.merchant_methods mm join beau_ph.merchants m on m.id = mm.merchant_id join beau_ph.providers p on p.key = mm.provider_key
   where m.key = p_merchant_key and mm.listed
$$;


--
-- Name: method_matrix(text, text, text, jsonb, text, text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.method_matrix(p_merchant_key text, p_country text DEFAULT NULL::text, p_currency text DEFAULT NULL::text, p_runtime jsonb DEFAULT '{}'::jsonb, p_platform text DEFAULT NULL::text, p_initiated_by text DEFAULT 'customer'::text, p_intent text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m beau_ph.merchants%rowtype; ctry text; cur text; res jsonb := '[]'::jsonb; r record; c record;
  caps jsonb; cap_why text; any_ok boolean; first_conf text; first_cap text; prov_why text; health text; struct_why text;
  n_caps int; n_placeholder int; n_dead int;
  rt jsonb; configured boolean; rmode text; init text := coalesce(p_initiated_by, 'customer');
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  if not beau_ph.is_platform(p_platform) then raise exception 'unknown platform %', p_platform using errcode = '22023'; end if;
  if init not in ('customer','merchant') then raise exception 'initiated_by must be customer or merchant' using errcode = '22023'; end if;
  if p_intent is not null and not beau_ph.is_intent(p_intent) then raise exception 'unknown intent %', p_intent using errcode = '22023'; end if;
  ctry := coalesce(nullif(upper(p_country), ''), m.country);
  cur  := coalesce(nullif(upper(p_currency), ''), m.default_currency);
  for r in
    select p.*, mm.id as mm_id, mm.enabled as m_enabled, mm.listed as m_listed, mm.countries as m_countries, mm.currencies as m_currencies,
           mm.intents as m_intents, mm.currency as m_currency, mm.limits as m_limits,
           mm.instructions as m_instructions, mm.settings as m_settings, mm.capabilities as m_caps
      from beau_ph.providers p
      left join beau_ph.merchant_methods mm on mm.provider_key = p.key and mm.merchant_id = m.id
     order by p.sort, p.key
  loop
    rt := coalesce(p_runtime -> r.key, '{}'::jsonb);
    configured := coalesce((rt ->> 'configured')::boolean, false); rmode := rt ->> 'mode';
    health := case when r.mm_id is null then 'not_added'
                   when r.m_countries is null or r.m_currencies is null then 'needs_configuration'
                   else 'configured' end;
    prov_why := case when r.mm_id is null or not r.m_enabled or not r.m_listed                  then 'disabled'
                     when health = 'needs_configuration'                                         then 'needs_configuration'
                     when r.countries  is not null and not (ctry = any(r.countries))             then 'country'
                     when not (ctry = any(r.m_countries))                                        then 'country'
                     when r.currencies is not null and not (cur = any(r.currencies))             then 'currency'
                     when not (cur = any(r.m_currencies))                                        then 'currency'
                     when p_intent is not null and r.intents   is not null and not (p_intent = any(r.intents))   then 'intent'
                     when p_intent is not null and r.m_intents is not null and not (p_intent = any(r.m_intents)) then 'intent'
                     else null end;
    select count(*), count(*) filter (where pc.readiness = 'placeholder'), count(*) filter (where pc.readiness <> 'available')
      into n_caps, n_placeholder, n_dead from beau_ph.provider_capabilities pc where pc.provider_key = r.key;
    struct_why := case when n_caps > 0 and n_placeholder = n_caps then 'coming_soon'
                       when n_caps > 0 and n_dead = n_caps then 'not_configured' else null end;
    caps := '[]'::jsonb; any_ok := false; first_conf := null; first_cap := null;
    for c in select * from beau_ph.provider_capabilities pc where pc.provider_key = r.key
              order by case pc.capability when 'online_checkout' then 1 when 'manual_instructions' then 2 when 'bank_transfer' then 3 when 'mobile_money' then 4
                                          when 'qr' then 5 when 'wallet' then 6 when 'payment_link' then 7 when 'softpos' then 8 when 'card_present' then 9
                                          when 'tap_to_pay' then 10 when 'p2p_transfer' then 11 else 12 end
    loop
      cap_why := case
        when c.readiness = 'placeholder'                                                      then 'coming_soon'
        when c.readiness = 'not_configured'                                                   then 'not_configured'
        when prov_why is not null                                                             then prov_why
        when r.m_caps is not null and not (c.capability = any(r.m_caps))                      then 'disabled'
        -- a capability may serve only some intents; an unknown intent is not one of them
        when c.intents is not null and (p_intent is null or not (p_intent = any(c.intents)))  then 'intent'
        when c.initiated_by <> 'any' and c.initiated_by <> init                               then 'initiator'
        when c.platforms is not null and (p_platform is null or not (p_platform = any(c.platforms))) then 'platform'
        when c.confirmation = 'provider_event' and not c.handoff and r.readiness <> 'available' then 'provider_' || r.readiness
        when c.confirmation = 'provider_event' and not c.handoff and not configured           then 'runtime_not_configured'
        when c.confirmation = 'provider_event' and not c.handoff and rmode is not null and rmode <> m.mode then 'mode_mismatch'
        else null end;
      if cap_why is null and not any_ok then any_ok := true; first_conf := c.confirmation; first_cap := c.capability; end if;
      caps := caps || jsonb_build_object('capability', c.capability, 'readiness', c.readiness, 'confirmation', c.confirmation, 'handoff', c.handoff,
                                         'platforms', to_jsonb(c.platforms), 'initiated_by', c.initiated_by, 'intents', to_jsonb(c.intents),
                                         'in_person', beau_ph.is_in_person(c.capability),
                                         'eligible', cap_why is null, 'reason', cap_why);
    end loop;
    res := res || jsonb_build_object(
      'provider', r.key, 'display_name', r.display_name, 'kind', r.kind, 'channel_label', r.channel_label,
      'confirmation', coalesce(first_conf, r.confirmation), 'capability', first_cap,
      'readiness', r.readiness, 'enabled', coalesce(r.m_enabled, false) and coalesce(r.m_listed, false), 'health', health, 'eligible', any_ok,
      'reason', case when any_ok then null else coalesce(struct_why, prov_why, (select e ->> 'reason' from jsonb_array_elements(caps) e limit 1), 'no_capability') end,
      'countries', to_jsonb(r.m_countries), 'currencies', to_jsonb(r.m_currencies), 'intents', to_jsonb(r.m_intents),
      'provider_countries', to_jsonb(r.countries), 'provider_currencies', to_jsonb(r.currencies), 'provider_intents', to_jsonb(r.intents),
      'settlement_currency', r.m_currency, 'limits', case when any_ok then coalesce(r.m_limits -> cur, '{}'::jsonb) else null end,
      'instructions', case when any_ok then coalesce(r.m_instructions, '{}'::jsonb) else null end,
      'settings',     case when any_ok then coalesce(r.m_settings, '{}'::jsonb) else null end,
      'capabilities', caps);
  end loop;
  return res;
end $$;


--
-- Name: normalize_paypal_event(jsonb); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.normalize_paypal_event(p_event jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $_$
declare t text := p_event ->> 'event_type';
        res jsonb := p_event -> 'resource';
        v_currency text; v_amount int; v_order text; v_capture text; v_request text; v_invoice text;
        v_status text; v_refund int;
begin
  if res is null then return jsonb_build_object('ignore', 'no_resource'); end if;

  v_capture  := res ->> 'id';
  v_order    := coalesce(res #>> '{supplementary_data,related_ids,order_id}',
                         case when t like 'CHECKOUT.ORDER.%' then res ->> 'id' else null end);
  v_request  := nullif(res ->> 'custom_id', '');
  v_invoice  := nullif(res ->> 'invoice_id', '');
  v_currency := upper(coalesce(res #>> '{amount,currency_code}', res #>> '{seller_receivable_breakdown,gross_amount,currency_code}'));
  v_amount   := beau_ph.paypal_minor(coalesce(res #>> '{amount,value}', res #>> '{seller_receivable_breakdown,gross_amount,value}'), v_currency);

  v_status := case t
    when 'PAYMENT.CAPTURE.COMPLETED' then 'paid'
    when 'PAYMENT.CAPTURE.DENIED'    then 'failed'
    when 'PAYMENT.CAPTURE.REVERSED'  then 'refunded'
    when 'PAYMENT.CAPTURE.REFUNDED'  then 'refunded'
    when 'CHECKOUT.ORDER.APPROVED'   then 'requires_action'
    when 'CHECKOUT.ORDER.COMPLETED'  then 'evidence'
    else null end;
  if v_status is null then return jsonb_build_object('ignore', 'unhandled:' || coalesce(t, 'null')); end if;

  -- a partial refund is evidence, not a state change; ingest already handles that
  if v_status = 'refunded' then v_refund := v_amount; end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'request_id',         case when v_request ~ '^[0-9a-f-]{36}$' then v_request else null end,
    'provider_reference', v_order,
    'payment_reference',  v_capture,
    'external_reference', case when v_invoice is null then null else regexp_replace(v_invoice, '-[0-9]+$', '') end,
    'status',             v_status,
    'amount',             v_amount,
    'currency',           v_currency,
    'refund_amount',      v_refund,
    'provider_status',    t,
    'evidence', jsonb_build_object(
      'livemode',   (p_event ->> 'beau_ph_livemode')::boolean,
      'event_type', t,
      'order_id',   v_order,
      'capture_id', v_capture,
      'invoice_id', v_invoice,
      'seller_fee', res #>> '{seller_receivable_breakdown,paypal_fee,value}',
      'net_amount', res #>> '{seller_receivable_breakdown,net_amount,value}')));
end $_$;


--
-- Name: normalize_stripe_event(jsonb); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.normalize_stripe_event(p_event jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare t text := p_event ->> 'type'; obj jsonb := p_event -> 'data' -> 'object'; enrich jsonb := coalesce(p_event -> '_enrich', '{}'::jsonb);
begin
  if t = 'checkout.session.completed' then
    if coalesce(obj ->> 'payment_status', '') <> 'paid' then return jsonb_build_object('ignore', 'payment_status ' || coalesce(obj ->> 'payment_status', 'null')); end if;
    return jsonb_build_object('status', 'paid',
      'provider_reference', obj ->> 'id', 'external_reference', obj ->> 'client_reference_id',
      'amount', (obj ->> 'amount_total')::int, 'currency', upper(obj ->> 'currency'),
      'provider_status', obj ->> 'payment_status', 'payment_reference', obj ->> 'payment_intent',
      'evidence', jsonb_build_object('payment_intent', obj ->> 'payment_intent', 'checkout_session', obj ->> 'id',
                                     'charge_id', enrich ->> 'charge_id', 'balance_transaction_id', enrich ->> 'balance_transaction_id',
                                     'fee_amount', (enrich ->> 'fee_amount')::int, 'livemode', coalesce((p_event ->> 'livemode')::boolean, false)));
  elsif t = 'checkout.session.expired' then
    return jsonb_build_object('status', 'expired', 'provider_reference', obj ->> 'id', 'provider_status', 'expired',
      'evidence', jsonb_build_object('checkout_session', obj ->> 'id', 'livemode', coalesce((p_event ->> 'livemode')::boolean, false)));
  elsif t in ('refund.created', 'refund.updated') then
    return jsonb_build_object('status', case when obj ->> 'status' = 'succeeded' then 'refunded' else 'evidence' end,
      'payment_reference', obj ->> 'payment_intent', 'refund_amount', (obj ->> 'amount')::int, 'currency', upper(obj ->> 'currency'),
      'provider_status', 'refund.' || coalesce(obj ->> 'status', 'unknown'),
      'evidence', jsonb_build_object('refund_id', obj ->> 'id', 'amount', (obj ->> 'amount')::int, 'status', obj ->> 'status', 'reason', obj ->> 'reason',
                                     'livemode', coalesce((p_event ->> 'livemode')::boolean, false)));
  elsif t like 'charge.dispute.%' then
    return jsonb_build_object('status', 'evidence', 'payment_reference', obj ->> 'payment_intent', 'provider_status', 'dispute.' || coalesce(obj ->> 'status', 'unknown'),
      'evidence', jsonb_build_object('dispute_id', obj ->> 'id', 'charge', obj ->> 'charge', 'amount', (obj ->> 'amount')::int, 'status', obj ->> 'status',
                                     'reason', obj ->> 'reason', 'livemode', coalesce((p_event ->> 'livemode')::boolean, false)));
  end if;
  return jsonb_build_object('ignore', 'unhandled type ' || coalesce(t, 'null'));
end $$;


--
-- Name: owned_by(uuid, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.owned_by(p_request_id uuid, p_merchant_key text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select p_merchant_key is null
      or exists (select 1 from beau_ph.payment_requests r join beau_ph.merchants m on m.id = r.merchant_id
                  where r.id = p_request_id and m.key = p_merchant_key)
$$;


--
-- Name: paypal_minor(text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.paypal_minor(p_value text, p_currency text) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare e int := beau_ph.currency_exponent(p_currency); n numeric;
begin
  if p_value is null or btrim(p_value) = '' then return null; end if;
  if e = 3 then return null; end if;                    -- PayPal cannot quote these; never round one into existence
  begin n := p_value::numeric; exception when others then return null; end;
  return round(n * power(10, e))::int;
end $$;


--
-- Name: process_paypal_event(jsonb); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.process_paypal_event(p_event jsonb) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select beau_ph.ingest_provider_event('paypal', p_event ->> 'id', p_event ->> 'event_type',
                                       p_event, beau_ph.normalize_paypal_event(p_event))
$$;


--
-- Name: queue_provider_cancellation(); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.queue_provider_cancellation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_merchant text; v_supports boolean;
begin
  if new.status not in ('cancelled','expired') or old.status = new.status then return new; end if;

  select m.key into v_merchant from beau_ph.merchants m where m.id = new.merchant_id;
  select p.supports_cancel into v_supports from beau_ph.providers p where p.key = new.provider_key;

  insert into beau_ph.provider_cancellations (request_id, merchant_key, provider_key, provider_reference, reason, status, last_error, settled_at)
  values (new.id, v_merchant, new.provider_key, coalesce(new.provider_reference, ''), new.status,
          case when coalesce(v_supports, false) and coalesce(new.provider_reference, '') <> '' then 'pending' else 'skipped' end,
          case when not coalesce(v_supports, false)                then 'rail has no cancel'
               when coalesce(new.provider_reference, '') = ''      then 'never created at the provider'
               else null end,
          case when coalesce(v_supports, false) and coalesce(new.provider_reference, '') <> '' then null else now() end)
  on conflict (request_id) do nothing;   -- a request is closed once; a second close is not a second cancellation
  return new;
end $$;


--
-- Name: rail_events(text, text, integer); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.rail_events(p_merchant_key text, p_provider text, p_limit integer DEFAULT 30) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.provider_event_id, 'type', e.event_type, 'outcome', e.outcome, 'received_at', e.received_at,
                                               'processed_at', e.processed_at, 'public_reference', r.public_reference) order by e.received_at desc), '[]'::jsonb)
    from (select * from beau_ph.provider_events pe
           where pe.provider_key = p_provider
             and (pe.request_id is null or exists (select 1 from beau_ph.payment_requests r join beau_ph.merchants m on m.id = r.merchant_id where r.id = pe.request_id and m.key = p_merchant_key))
           order by pe.received_at desc limit greatest(1, least(coalesce(p_limit, 30), 200))) e
    left join beau_ph.payment_requests r on r.id = e.request_id
$$;


--
-- Name: rails_overview(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.rails_overview(p_merchant_key text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m beau_ph.merchants%rowtype;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'merchant', jsonb_build_object('key', m.key, 'name', m.name, 'country', m.country, 'default_currency', m.default_currency, 'mode', m.mode),
    'rails', (select coalesce(jsonb_agg(jsonb_build_object(
      'provider', p.key, 'display_name', p.display_name, 'kind', p.kind, 'channel_label', p.channel_label, 'confirmation', p.confirmation, 'readiness', p.readiness,
      'provider_countries', to_jsonb(p.countries), 'provider_currencies', to_jsonb(p.currencies), 'provider_intents', to_jsonb(p.intents),
      'secrets', to_jsonb(p.secrets), 'onboarding', p.onboarding, 'notes', p.notes, 'capabilities', beau_ph.capabilities_json(p.key),
      'merchant', case when mm.id is null then null else jsonb_build_object(
          'enabled', mm.enabled, 'listed', mm.listed, 'countries', to_jsonb(mm.countries), 'currencies', to_jsonb(mm.currencies), 'intents', to_jsonb(mm.intents),
          'settlement_currency', mm.currency, 'limits', mm.limits, 'updated_at', mm.updated_at, 'updated_by', mm.updated_by,
          'health', case when mm.countries is null or mm.currencies is null then 'needs_configuration' else 'configured' end) end,
      'activity', jsonb_build_object(
          'requests', (select count(*) from beau_ph.payment_requests r where r.merchant_id = m.id and r.provider_key = p.key),
          'paid',     (select count(*) from beau_ph.payment_requests r where r.merchant_id = m.id and r.provider_key = p.key and r.status in ('paid','refunded')),
          'last_paid_at', (select max(r.paid_at) from beau_ph.payment_requests r where r.merchant_id = m.id and r.provider_key = p.key),
          'last_event_at', (select max(e.received_at) from beau_ph.provider_events e where e.provider_key = p.key),
          'last_event_outcome', (select e.outcome from beau_ph.provider_events e where e.provider_key = p.key order by e.received_at desc limit 1)))
      order by p.sort, p.key), '[]'::jsonb) from beau_ph.providers p left join beau_ph.merchant_methods mm on mm.provider_key = p.key and mm.merchant_id = m.id));
end $$;


--
-- Name: payment_events; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.payment_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    provider_event_id uuid,
    from_status text,
    to_status text NOT NULL,
    amount integer,
    currency text,
    provider_status text,
    provider_reference text,
    actor text NOT NULL,
    actor_id text,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_events_actor_check CHECK ((actor = ANY (ARRAY['provider'::text, 'operator'::text, 'system'::text]))),
    CONSTRAINT payment_events_evidence_check CHECK (beau_ph.no_secret_keys(evidence))
);


--
-- Name: record_event(uuid, text, text, text, uuid, integer, text, text, text, text, jsonb); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.record_event(p_request_id uuid, p_to text, p_actor text, p_actor_id text, p_provider_event_id uuid, p_amount integer, p_currency text, p_provider_status text, p_provider_reference text, p_payment_reference text, p_evidence jsonb) RETURNS beau_ph.payment_events
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r beau_ph.payment_requests%rowtype; ev beau_ph.payment_events%rowtype; sib uuid;
begin
  select * into r from beau_ph.payment_requests where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode = 'P0002'; end if;
  if not beau_ph.transition_allowed(r.status, p_to) then
    raise exception 'illegal transition % -> %', r.status, p_to using errcode = 'P0003';
  end if;
  insert into beau_ph.payment_events (request_id, provider_event_id, from_status, to_status, amount, currency, provider_status,
                                      provider_reference, actor, actor_id, evidence)
  values (r.id, p_provider_event_id, r.status, p_to, p_amount, p_currency, p_provider_status,
          coalesce(p_payment_reference, p_provider_reference), p_actor, p_actor_id, coalesce(p_evidence, '{}'::jsonb))
  returning * into ev;
  update beau_ph.payment_requests set
    status = p_to,
    paid_at = case when p_to = 'paid' then coalesce(paid_at, now()) else paid_at end,
    provider_reference = coalesce(p_provider_reference, provider_reference),
    payment_reference  = coalesce(p_payment_reference, payment_reference),
    updated_at = now()
  where id = r.id;
  if p_to in ('paid','expired','cancelled','failed') then
    update beau_ph.payment_attempts set status = case when p_to = 'paid' then 'completed' else p_to end
     where request_id = r.id and status = 'open';
  end if;
  if p_to = 'paid' then
    -- the order is settled: other live requests (other rails) for the same external order can no longer be paid
    for sib in select pr.id from beau_ph.payment_requests pr
                where pr.merchant_id = r.merchant_id and pr.external_reference = r.external_reference and pr.id <> r.id
                  and pr.status in ('created','pending','requires_action') loop
      perform beau_ph.cancel_request(sib, 'system', null, 'settled via ' || r.provider_key);
    end loop;
  end if;
  return ev;
end $$;


--
-- Name: request_events(uuid, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.request_events(p_request_id uuid, p_merchant_key text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', ev.id, 'from', ev.from_status, 'to', ev.to_status, 'amount', ev.amount, 'currency', ev.currency,
           'provider_status', ev.provider_status, 'provider_reference', ev.provider_reference, 'actor', ev.actor, 'actor_id', ev.actor_id,
           'evidence', ev.evidence, 'reconciled', exists (select 1 from beau_ph.reconciliations rc where rc.payment_event_id = ev.id),
           'created_at', ev.created_at) order by ev.created_at), '[]'::jsonb)
    from beau_ph.payment_events ev
   where ev.request_id = p_request_id and beau_ph.owned_by(p_request_id, p_merchant_key)
$$;


--
-- Name: payment_requests; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.payment_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    merchant_id uuid NOT NULL,
    provider_key text NOT NULL,
    external_reference text NOT NULL,
    public_reference text NOT NULL,
    amount integer NOT NULL,
    currency text NOT NULL,
    customer_country text,
    status text DEFAULT 'created'::text NOT NULL,
    provider_reference text,
    payment_reference text,
    instructions jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    paid_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    capability text,
    channel text DEFAULT 'online'::text NOT NULL,
    initiated_by text DEFAULT 'customer'::text NOT NULL,
    platform text,
    intent text,
    pricing_amount integer,
    pricing_currency text,
    fx_quote_id uuid,
    CONSTRAINT payment_requests_amount_check CHECK ((amount > 0)),
    CONSTRAINT payment_requests_capability_check CHECK (beau_ph.is_capability(capability)),
    CONSTRAINT payment_requests_channel_check CHECK ((channel = ANY (ARRAY['online'::text, 'in_person'::text]))),
    CONSTRAINT payment_requests_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT payment_requests_customer_country_check CHECK ((customer_country ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT payment_requests_initiated_by_check CHECK ((initiated_by = ANY (ARRAY['customer'::text, 'merchant'::text]))),
    CONSTRAINT payment_requests_instructions_check CHECK (beau_ph.no_secret_keys(instructions)),
    CONSTRAINT payment_requests_intent_check CHECK (((intent IS NULL) OR beau_ph.is_intent(intent))),
    CONSTRAINT payment_requests_metadata_check CHECK (beau_ph.no_secret_keys(metadata)),
    CONSTRAINT payment_requests_platform_check CHECK (beau_ph.is_platform(platform)),
    CONSTRAINT payment_requests_pricing_amount_check CHECK (((pricing_amount IS NULL) OR (pricing_amount > 0))),
    CONSTRAINT payment_requests_pricing_currency_check CHECK (((pricing_currency IS NULL) OR beau_ph.is_iso_currency(pricing_currency))),
    CONSTRAINT payment_requests_public_reference_check CHECK (((public_reference !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) AND ((length(public_reference) >= 3) AND (length(public_reference) <= 40)))),
    CONSTRAINT payment_requests_status_check CHECK ((status = ANY (ARRAY['created'::text, 'pending'::text, 'requires_action'::text, 'paid'::text, 'failed'::text, 'expired'::text, 'cancelled'::text, 'refunded'::text])))
);


--
-- Name: request_json(beau_ph.payment_requests); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.request_json(r beau_ph.payment_requests) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    'id', r.id, 'merchant_id', r.merchant_id, 'provider', r.provider_key,
    'capability', r.capability, 'channel', r.channel, 'initiated_by', r.initiated_by, 'platform', r.platform, 'intent', r.intent,
    'external_reference', r.external_reference, 'public_reference', r.public_reference,
    'amount', r.amount, 'currency', r.currency, 'customer_country', r.customer_country,
    'pricing_amount', r.pricing_amount, 'pricing_currency', r.pricing_currency, 'fx_quote_id', r.fx_quote_id,
    'status', r.status, 'provider_reference', r.provider_reference, 'payment_reference', r.payment_reference,
    'instructions', r.instructions, 'metadata', r.metadata,
    'paid_at', r.paid_at, 'expires_at', r.expires_at, 'created_at', r.created_at,
    'attempts', (select count(*) from beau_ph.payment_attempts a where a.request_id = r.id),
    'attempt', (select jsonb_build_object('n', a.n, 'provider_reference', a.provider_reference, 'redirect_url', a.redirect_url,
                                          'expires_at', a.expires_at, 'status', a.status)
                  from beau_ph.payment_attempts a where a.request_id = r.id and a.status = 'open'
                 order by a.created_at desc limit 1))
$$;


--
-- Name: requests_for(text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.requests_for(p_merchant_key text, p_external_reference text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(beau_ph.request_json(r) order by r.created_at desc), '[]'::jsonb)
    from beau_ph.payment_requests r join beau_ph.merchants m on m.id = r.merchant_id
   where m.key = p_merchant_key and r.external_reference = p_external_reference
$$;


--
-- Name: settlement_destinations; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.settlement_destinations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    merchant_id uuid NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    kind text NOT NULL,
    currency text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_destinations_currency_check CHECK (beau_ph.is_iso_currency(currency)),
    CONSTRAINT settlement_destinations_details_check CHECK (beau_ph.no_secret_keys(details)),
    CONSTRAINT settlement_destinations_key_check CHECK ((key ~ '^[a-z][a-z0-9_]{1,40}$'::text)),
    CONSTRAINT settlement_destinations_kind_check CHECK ((kind = ANY (ARRAY['bank_account'::text, 'psp_balance'::text, 'wallet'::text, 'other'::text])))
);


--
-- Name: settlement_destination_json(beau_ph.settlement_destinations); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.settlement_destination_json(d beau_ph.settlement_destinations) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object('id', d.id, 'key', d.key, 'label', d.label, 'kind', d.kind, 'currency', d.currency, 'details', d.details, 'active', d.active,
                            'updated_by', d.updated_by, 'updated_at', d.updated_at,
                            'used_by', (select coalesce(jsonb_agg(distinct mm.provider_key), '[]'::jsonb) from beau_ph.method_settlements ms join beau_ph.merchant_methods mm on mm.id = ms.merchant_method_id where ms.destination_id = d.id))
$$;


--
-- Name: settlement_destination_remove(text, text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.settlement_destination_remove(p_merchant_key text, p_key text, p_actor text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m beau_ph.merchants%rowtype; cur beau_ph.settlement_destinations%rowtype;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  select * into cur from beau_ph.settlement_destinations where merchant_id = m.id and key = p_key;
  if not found then raise exception 'unknown destination' using errcode = 'P0002'; end if;
  if exists (select 1 from beau_ph.method_settlements where destination_id = cur.id) then
    -- still mapped: deactivate, never orphan a rail's settlement
    return beau_ph.settlement_destination_set(p_merchant_key, jsonb_build_object('key', p_key, 'active', false), p_actor) || '{"removed":"deactivated"}'::jsonb;
  end if;
  perform beau_ph.audit_diff(m.id, 'settlement_destination', p_key, p_actor, beau_ph.settlement_destination_json(cur) - 'updated_at' - 'updated_by' - 'id' - 'used_by', '{}'::jsonb);
  delete from beau_ph.settlement_destinations where id = cur.id;
  return jsonb_build_object('key', p_key, 'removed', 'deleted');
end $$;


--
-- Name: settlement_destination_set(text, jsonb, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.settlement_destination_set(p_merchant_key text, p jsonb, p_actor text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare m beau_ph.merchants%rowtype; cur beau_ph.settlement_destinations%rowtype; nxt beau_ph.settlement_destinations%rowtype; k text;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  k := lower(btrim(p ->> 'key'));
  if k !~ '^[a-z][a-z0-9_]{1,40}$' then raise exception 'destination key: lower-case letters, digits, underscore' using errcode = '22023'; end if;
  if not beau_ph.no_secret_keys(p -> 'details') then raise exception 'secrets are never stored in a settlement destination' using errcode = '22023'; end if;
  select * into cur from beau_ph.settlement_destinations where merchant_id = m.id and key = k;
  insert into beau_ph.settlement_destinations (merchant_id, key, label, kind, currency, details, active, updated_by)
  values (m.id, k, coalesce(nullif(btrim(p ->> 'label'), ''), cur.label, k), coalesce(p ->> 'kind', cur.kind, 'bank_account'),
          coalesce(nullif(upper(p ->> 'currency'), ''), cur.currency), coalesce(p -> 'details', cur.details, '{}'::jsonb), coalesce((p ->> 'active')::boolean, cur.active, true), p_actor)
  on conflict (merchant_id, key) do update set label = excluded.label, kind = excluded.kind, currency = excluded.currency, details = excluded.details,
    active = excluded.active, updated_by = excluded.updated_by, updated_at = now()
  returning * into nxt;
  perform beau_ph.audit_diff(m.id, 'settlement_destination', k, p_actor,
                             case when cur.id is null then '{}'::jsonb else beau_ph.settlement_destination_json(cur) - 'updated_at' - 'updated_by' - 'id' - 'used_by' end,
                             beau_ph.settlement_destination_json(nxt) - 'updated_at' - 'updated_by' - 'id' - 'used_by');
  return beau_ph.settlement_destination_json(nxt);
end $_$;


--
-- Name: settlement_destinations_list(text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.settlement_destinations_list(p_merchant_key text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(beau_ph.settlement_destination_json(d) order by d.currency, d.key), '[]'::jsonb)
    from beau_ph.settlement_destinations d join beau_ph.merchants m on m.id = d.merchant_id where m.key = p_merchant_key
$$;


--
-- Name: transition_allowed(text, text); Type: FUNCTION; Schema: beau_ph; Owner: -
--

CREATE FUNCTION beau_ph.transition_allowed(p_from text, p_to text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p_from = p_to or (p_from, p_to) in (
    ('created','pending'), ('created','requires_action'), ('created','paid'), ('created','failed'), ('created','expired'), ('created','cancelled'),
    ('pending','requires_action'), ('pending','paid'), ('pending','failed'), ('pending','expired'), ('pending','cancelled'),
    ('requires_action','pending'), ('requires_action','paid'), ('requires_action','failed'), ('requires_action','expired'), ('requires_action','cancelled'),
    ('paid','refunded'))
$$;


--
-- Name: config_audit; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.config_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    merchant_id uuid,
    area text NOT NULL,
    entity text NOT NULL,
    actor text NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    field text NOT NULL,
    old_value jsonb,
    new_value jsonb,
    CONSTRAINT config_audit_area_check CHECK ((area = ANY (ARRAY['merchant_method'::text, 'settlement_destination'::text, 'merchant_fx'::text, 'fx_currency'::text, 'fx_source'::text]))),
    CONSTRAINT config_audit_new_value_check CHECK (beau_ph.no_secret_keys(new_value)),
    CONSTRAINT config_audit_old_value_check CHECK (beau_ph.no_secret_keys(old_value))
);


--
-- Name: fx_currencies; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.fx_currencies (
    currency text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    source_key text,
    peg_currency text,
    peg_rate numeric(18,8),
    notes text,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fx_currencies_check CHECK (((NOT enabled) OR (source_key IS NOT NULL))),
    CONSTRAINT fx_currencies_currency_check CHECK (beau_ph.is_iso_currency(currency)),
    CONSTRAINT fx_currencies_peg_currency_check CHECK (((peg_currency IS NULL) OR beau_ph.is_iso_currency(peg_currency))),
    CONSTRAINT fx_currencies_peg_rate_check CHECK (((peg_rate IS NULL) OR (peg_rate > (0)::numeric)))
);


--
-- Name: fx_rates; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.fx_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    base_currency text DEFAULT 'EUR'::text NOT NULL,
    quote_currency text NOT NULL,
    rate numeric(18,8) NOT NULL,
    rate_date date NOT NULL,
    source text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fx_rates_base_currency_check CHECK (beau_ph.is_iso_currency(base_currency)),
    CONSTRAINT fx_rates_quote_currency_check CHECK (beau_ph.is_iso_currency(quote_currency)),
    CONSTRAINT fx_rates_rate_check CHECK ((rate > (0)::numeric))
);


--
-- Name: fx_refresh_runs; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.fx_refresh_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    requested_by text DEFAULT 'cron'::text NOT NULL,
    status text DEFAULT 'requested'::text NOT NULL,
    http jsonb DEFAULT '{}'::jsonb NOT NULL,
    rate_date date,
    currencies_updated integer DEFAULT 0 NOT NULL,
    currencies_skipped integer DEFAULT 0 NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT fx_refresh_runs_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'success'::text, 'partial'::text, 'failed'::text])))
);


--
-- Name: fx_sources; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.fx_sources (
    key text NOT NULL,
    kind text NOT NULL,
    url text,
    enabled boolean DEFAULT true NOT NULL,
    sort integer DEFAULT 100 NOT NULL,
    notes text,
    CONSTRAINT fx_sources_key_check CHECK ((key ~ '^[a-z][a-z0-9_]{1,30}$'::text)),
    CONSTRAINT fx_sources_kind_check CHECK ((kind = ANY (ARRAY['frankfurter'::text, 'nbg'::text, 'peg'::text])))
);


--
-- Name: merchants; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.merchants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    country text NOT NULL,
    default_currency text NOT NULL,
    mode text DEFAULT 'test'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT merchants_country_check CHECK ((country ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT merchants_default_currency_check CHECK ((default_currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT merchants_key_check CHECK ((key ~ '^[a-z][a-z0-9_]{1,40}$'::text)),
    CONSTRAINT merchants_mode_check CHECK ((mode = ANY (ARRAY['test'::text, 'live'::text])))
);


--
-- Name: method_settlements; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.method_settlements (
    merchant_method_id uuid NOT NULL,
    currency text NOT NULL,
    destination_id uuid NOT NULL,
    CONSTRAINT method_settlements_currency_check CHECK (beau_ph.is_iso_currency(currency))
);


--
-- Name: payment_attempts; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.payment_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    n integer NOT NULL,
    provider_reference text,
    redirect_url text,
    expires_at timestamp with time zone,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_attempts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'superseded'::text, 'completed'::text, 'expired'::text, 'cancelled'::text])))
);


--
-- Name: provider_cancellations; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.provider_cancellations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    merchant_key text NOT NULL,
    provider_key text NOT NULL,
    provider_reference text NOT NULL,
    reason text,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT provider_cancellations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'skipped'::text, 'failed'::text])))
);


--
-- Name: provider_capabilities; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.provider_capabilities (
    provider_key text NOT NULL,
    capability text NOT NULL,
    readiness text NOT NULL,
    confirmation text NOT NULL,
    platforms text[],
    initiated_by text DEFAULT 'any'::text NOT NULL,
    handoff boolean DEFAULT false NOT NULL,
    notes text,
    intents text[],
    CONSTRAINT provider_capabilities_capability_check CHECK (beau_ph.is_capability(capability)),
    CONSTRAINT provider_capabilities_confirmation_check CHECK ((confirmation = ANY (ARRAY['provider_event'::text, 'operator'::text, 'unavailable'::text]))),
    CONSTRAINT provider_capabilities_initiated_by_check CHECK ((initiated_by = ANY (ARRAY['customer'::text, 'merchant'::text, 'any'::text]))),
    CONSTRAINT provider_capabilities_readiness_check CHECK ((readiness = ANY (ARRAY['available'::text, 'not_configured'::text, 'placeholder'::text])))
);


--
-- Name: provider_events; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.provider_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_key text NOT NULL,
    provider_event_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    request_id uuid,
    outcome text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: providers; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.providers (
    key text NOT NULL,
    display_name text NOT NULL,
    kind text NOT NULL,
    confirmation text NOT NULL,
    countries text[],
    currencies text[],
    readiness text NOT NULL,
    sort integer DEFAULT 100 NOT NULL,
    notes text,
    channel_label text,
    intents text[],
    secrets text[] DEFAULT '{}'::text[] NOT NULL,
    config_schema jsonb DEFAULT '[]'::jsonb NOT NULL,
    onboarding text,
    supports_cancel boolean DEFAULT false NOT NULL,
    CONSTRAINT providers_config_schema_check CHECK (beau_ph.no_secret_keys(config_schema)),
    CONSTRAINT providers_confirmation_check CHECK ((confirmation = ANY (ARRAY['provider_event'::text, 'operator'::text, 'unavailable'::text]))),
    CONSTRAINT providers_key_check CHECK ((key = ANY (ARRAY['stripe'::text, 'aani'::text, 'bank_transfer'::text, 'cash'::text, 'paynow'::text, 'mpesa'::text, 'ozow'::text, 'payshap'::text, 'beau_wallet'::text, 'network_international'::text, 'magnati'::text, 'adyen'::text, 'wise'::text, 'paypal'::text]))),
    CONSTRAINT providers_kind_check CHECK ((kind = ANY (ARRAY['online'::text, 'manual'::text, 'crypto'::text]))),
    CONSTRAINT providers_readiness_check CHECK ((readiness = ANY (ARRAY['available'::text, 'not_configured'::text, 'placeholder'::text])))
);


--
-- Name: reconciliations; Type: TABLE; Schema: beau_ph; Owner: -
--

CREATE TABLE beau_ph.reconciliations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payment_event_id uuid NOT NULL,
    request_id uuid NOT NULL,
    merchant_id uuid NOT NULL,
    host_reference text NOT NULL,
    note text,
    reconciled_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: config_audit config_audit_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.config_audit
    ADD CONSTRAINT config_audit_pkey PRIMARY KEY (id);


--
-- Name: fx_currencies fx_currencies_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.fx_currencies
    ADD CONSTRAINT fx_currencies_pkey PRIMARY KEY (currency);


--
-- Name: fx_quotes fx_quotes_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.fx_quotes
    ADD CONSTRAINT fx_quotes_pkey PRIMARY KEY (id);


--
-- Name: fx_rates fx_rates_base_currency_quote_currency_rate_date_key; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.fx_rates
    ADD CONSTRAINT fx_rates_base_currency_quote_currency_rate_date_key UNIQUE (base_currency, quote_currency, rate_date);


--
-- Name: fx_rates fx_rates_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.fx_rates
    ADD CONSTRAINT fx_rates_pkey PRIMARY KEY (id);


--
-- Name: fx_refresh_runs fx_refresh_runs_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.fx_refresh_runs
    ADD CONSTRAINT fx_refresh_runs_pkey PRIMARY KEY (id);


--
-- Name: fx_sources fx_sources_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.fx_sources
    ADD CONSTRAINT fx_sources_pkey PRIMARY KEY (key);


--
-- Name: merchant_fx merchant_fx_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.merchant_fx
    ADD CONSTRAINT merchant_fx_pkey PRIMARY KEY (merchant_id);


--
-- Name: merchant_methods merchant_methods_merchant_id_provider_key_key; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.merchant_methods
    ADD CONSTRAINT merchant_methods_merchant_id_provider_key_key UNIQUE (merchant_id, provider_key);


--
-- Name: merchant_methods merchant_methods_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.merchant_methods
    ADD CONSTRAINT merchant_methods_pkey PRIMARY KEY (id);


--
-- Name: merchants merchants_key_key; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.merchants
    ADD CONSTRAINT merchants_key_key UNIQUE (key);


--
-- Name: merchants merchants_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.merchants
    ADD CONSTRAINT merchants_pkey PRIMARY KEY (id);


--
-- Name: method_settlements method_settlements_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.method_settlements
    ADD CONSTRAINT method_settlements_pkey PRIMARY KEY (merchant_method_id, currency);


--
-- Name: payment_attempts payment_attempts_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.payment_attempts
    ADD CONSTRAINT payment_attempts_pkey PRIMARY KEY (id);


--
-- Name: payment_attempts payment_attempts_request_id_n_key; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.payment_attempts
    ADD CONSTRAINT payment_attempts_request_id_n_key UNIQUE (request_id, n);


--
-- Name: payment_events payment_events_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (id);


--
-- Name: payment_requests payment_requests_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.payment_requests
    ADD CONSTRAINT payment_requests_pkey PRIMARY KEY (id);


--
-- Name: provider_cancellations provider_cancellations_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.provider_cancellations
    ADD CONSTRAINT provider_cancellations_pkey PRIMARY KEY (id);


--
-- Name: provider_cancellations provider_cancellations_request_id_key; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.provider_cancellations
    ADD CONSTRAINT provider_cancellations_request_id_key UNIQUE (request_id);


--
-- Name: provider_capabilities provider_capabilities_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.provider_capabilities
    ADD CONSTRAINT provider_capabilities_pkey PRIMARY KEY (provider_key, capability);


--
-- Name: provider_events provider_events_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.provider_events
    ADD CONSTRAINT provider_events_pkey PRIMARY KEY (id);


--
-- Name: provider_events provider_events_provider_key_provider_event_id_key; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.provider_events
    ADD CONSTRAINT provider_events_provider_key_provider_event_id_key UNIQUE (provider_key, provider_event_id);


--
-- Name: providers providers_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.providers
    ADD CONSTRAINT providers_pkey PRIMARY KEY (key);


--
-- Name: reconciliations reconciliations_payment_event_id_key; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.reconciliations
    ADD CONSTRAINT reconciliations_payment_event_id_key UNIQUE (payment_event_id);


--
-- Name: reconciliations reconciliations_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.reconciliations
    ADD CONSTRAINT reconciliations_pkey PRIMARY KEY (id);


--
-- Name: settlement_destinations settlement_destinations_merchant_id_key_key; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.settlement_destinations
    ADD CONSTRAINT settlement_destinations_merchant_id_key_key UNIQUE (merchant_id, key);


--
-- Name: settlement_destinations settlement_destinations_pkey; Type: CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.settlement_destinations
    ADD CONSTRAINT settlement_destinations_pkey PRIMARY KEY (id);


--
-- Name: config_audit_merchant_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX config_audit_merchant_idx ON beau_ph.config_audit USING btree (merchant_id, changed_at DESC);


--
-- Name: fx_currencies_source_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX fx_currencies_source_idx ON beau_ph.fx_currencies USING btree (source_key);


--
-- Name: fx_quotes_merchant_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX fx_quotes_merchant_idx ON beau_ph.fx_quotes USING btree (merchant_id, created_at DESC);


--
-- Name: fx_rates_lookup_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX fx_rates_lookup_idx ON beau_ph.fx_rates USING btree (base_currency, quote_currency, rate_date DESC);


--
-- Name: fx_refresh_runs_open_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX fx_refresh_runs_open_idx ON beau_ph.fx_refresh_runs USING btree (requested_at DESC) WHERE (status = 'requested'::text);


--
-- Name: merchant_methods_provider_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX merchant_methods_provider_idx ON beau_ph.merchant_methods USING btree (provider_key);


--
-- Name: method_settlements_destination_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX method_settlements_destination_idx ON beau_ph.method_settlements USING btree (destination_id);


--
-- Name: payment_events_provider_event_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE UNIQUE INDEX payment_events_provider_event_idx ON beau_ph.payment_events USING btree (provider_event_id) WHERE (provider_event_id IS NOT NULL);


--
-- Name: payment_events_request_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX payment_events_request_idx ON beau_ph.payment_events USING btree (request_id, created_at);


--
-- Name: payment_requests_live_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE UNIQUE INDEX payment_requests_live_idx ON beau_ph.payment_requests USING btree (merchant_id, provider_key, external_reference) WHERE (status = ANY (ARRAY['created'::text, 'pending'::text, 'requires_action'::text]));


--
-- Name: payment_requests_paid_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE UNIQUE INDEX payment_requests_paid_idx ON beau_ph.payment_requests USING btree (merchant_id, external_reference) WHERE (status = ANY (ARRAY['paid'::text, 'refunded'::text]));


--
-- Name: payment_requests_payment_ref_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX payment_requests_payment_ref_idx ON beau_ph.payment_requests USING btree (provider_key, payment_reference);


--
-- Name: payment_requests_provider_ref_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX payment_requests_provider_ref_idx ON beau_ph.payment_requests USING btree (provider_key, provider_reference);


--
-- Name: provider_cancellations_pending_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX provider_cancellations_pending_idx ON beau_ph.provider_cancellations USING btree (created_at) WHERE (status = 'pending'::text);


--
-- Name: provider_events_request_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX provider_events_request_idx ON beau_ph.provider_events USING btree (request_id);


--
-- Name: reconciliations_merchant_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX reconciliations_merchant_idx ON beau_ph.reconciliations USING btree (merchant_id);


--
-- Name: reconciliations_request_idx; Type: INDEX; Schema: beau_ph; Owner: -
--

CREATE INDEX reconciliations_request_idx ON beau_ph.reconciliations USING btree (request_id);


--
-- Name: fx_quotes fx_quotes_guard; Type: TRIGGER; Schema: beau_ph; Owner: -
--

CREATE TRIGGER fx_quotes_guard BEFORE DELETE OR UPDATE ON beau_ph.fx_quotes FOR EACH ROW EXECUTE FUNCTION beau_ph.fx_quotes_guard();


--
-- Name: payment_requests payment_requests_queue_cancellation; Type: TRIGGER; Schema: beau_ph; Owner: -
--

CREATE TRIGGER payment_requests_queue_cancellation AFTER UPDATE OF status ON beau_ph.payment_requests FOR EACH ROW EXECUTE FUNCTION beau_ph.queue_provider_cancellation();


--
-- Name: config_audit config_audit_merchant_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.config_audit
    ADD CONSTRAINT config_audit_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES beau_ph.merchants(id) ON DELETE CASCADE;


--
-- Name: fx_currencies fx_currencies_source_key_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.fx_currencies
    ADD CONSTRAINT fx_currencies_source_key_fkey FOREIGN KEY (source_key) REFERENCES beau_ph.fx_sources(key);


--
-- Name: fx_quotes fx_quotes_merchant_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.fx_quotes
    ADD CONSTRAINT fx_quotes_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES beau_ph.merchants(id);


--
-- Name: merchant_fx merchant_fx_merchant_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.merchant_fx
    ADD CONSTRAINT merchant_fx_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES beau_ph.merchants(id) ON DELETE CASCADE;


--
-- Name: merchant_methods merchant_methods_merchant_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.merchant_methods
    ADD CONSTRAINT merchant_methods_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES beau_ph.merchants(id) ON DELETE CASCADE;


--
-- Name: merchant_methods merchant_methods_provider_key_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.merchant_methods
    ADD CONSTRAINT merchant_methods_provider_key_fkey FOREIGN KEY (provider_key) REFERENCES beau_ph.providers(key);


--
-- Name: method_settlements method_settlements_destination_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.method_settlements
    ADD CONSTRAINT method_settlements_destination_id_fkey FOREIGN KEY (destination_id) REFERENCES beau_ph.settlement_destinations(id) ON DELETE CASCADE;


--
-- Name: method_settlements method_settlements_merchant_method_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.method_settlements
    ADD CONSTRAINT method_settlements_merchant_method_id_fkey FOREIGN KEY (merchant_method_id) REFERENCES beau_ph.merchant_methods(id) ON DELETE CASCADE;


--
-- Name: payment_attempts payment_attempts_request_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.payment_attempts
    ADD CONSTRAINT payment_attempts_request_id_fkey FOREIGN KEY (request_id) REFERENCES beau_ph.payment_requests(id) ON DELETE CASCADE;


--
-- Name: payment_events payment_events_provider_event_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.payment_events
    ADD CONSTRAINT payment_events_provider_event_id_fkey FOREIGN KEY (provider_event_id) REFERENCES beau_ph.provider_events(id);


--
-- Name: payment_events payment_events_request_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.payment_events
    ADD CONSTRAINT payment_events_request_id_fkey FOREIGN KEY (request_id) REFERENCES beau_ph.payment_requests(id) ON DELETE CASCADE;


--
-- Name: payment_requests payment_requests_merchant_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.payment_requests
    ADD CONSTRAINT payment_requests_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES beau_ph.merchants(id);


--
-- Name: payment_requests payment_requests_provider_key_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.payment_requests
    ADD CONSTRAINT payment_requests_provider_key_fkey FOREIGN KEY (provider_key) REFERENCES beau_ph.providers(key);


--
-- Name: provider_cancellations provider_cancellations_request_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.provider_cancellations
    ADD CONSTRAINT provider_cancellations_request_id_fkey FOREIGN KEY (request_id) REFERENCES beau_ph.payment_requests(id) ON DELETE CASCADE;


--
-- Name: provider_capabilities provider_capabilities_provider_key_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.provider_capabilities
    ADD CONSTRAINT provider_capabilities_provider_key_fkey FOREIGN KEY (provider_key) REFERENCES beau_ph.providers(key) ON DELETE CASCADE;


--
-- Name: provider_events provider_events_provider_key_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.provider_events
    ADD CONSTRAINT provider_events_provider_key_fkey FOREIGN KEY (provider_key) REFERENCES beau_ph.providers(key);


--
-- Name: provider_events provider_events_request_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.provider_events
    ADD CONSTRAINT provider_events_request_id_fkey FOREIGN KEY (request_id) REFERENCES beau_ph.payment_requests(id);


--
-- Name: reconciliations reconciliations_merchant_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.reconciliations
    ADD CONSTRAINT reconciliations_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES beau_ph.merchants(id);


--
-- Name: reconciliations reconciliations_payment_event_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.reconciliations
    ADD CONSTRAINT reconciliations_payment_event_id_fkey FOREIGN KEY (payment_event_id) REFERENCES beau_ph.payment_events(id);


--
-- Name: reconciliations reconciliations_request_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.reconciliations
    ADD CONSTRAINT reconciliations_request_id_fkey FOREIGN KEY (request_id) REFERENCES beau_ph.payment_requests(id);


--
-- Name: settlement_destinations settlement_destinations_merchant_id_fkey; Type: FK CONSTRAINT; Schema: beau_ph; Owner: -
--

ALTER TABLE ONLY beau_ph.settlement_destinations
    ADD CONSTRAINT settlement_destinations_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES beau_ph.merchants(id) ON DELETE CASCADE;


--
-- Name: config_audit; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.config_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: fx_currencies; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.fx_currencies ENABLE ROW LEVEL SECURITY;

--
-- Name: fx_quotes; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.fx_quotes ENABLE ROW LEVEL SECURITY;

--
-- Name: fx_rates; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.fx_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: fx_refresh_runs; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.fx_refresh_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: fx_sources; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.fx_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: merchant_fx; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.merchant_fx ENABLE ROW LEVEL SECURITY;

--
-- Name: merchant_methods; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.merchant_methods ENABLE ROW LEVEL SECURITY;

--
-- Name: merchants; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.merchants ENABLE ROW LEVEL SECURITY;

--
-- Name: method_settlements; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.method_settlements ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_attempts; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.payment_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_events; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.payment_events ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_requests; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.payment_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_cancellations; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.provider_cancellations ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_capabilities; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.provider_capabilities ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_events; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.provider_events ENABLE ROW LEVEL SECURITY;

--
-- Name: providers; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.providers ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliations; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.reconciliations ENABLE ROW LEVEL SECURITY;

--
-- Name: settlement_destinations; Type: ROW SECURITY; Schema: beau_ph; Owner: -
--

ALTER TABLE beau_ph.settlement_destinations ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA beau_ph; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA beau_ph TO service_role;


--
-- Name: FUNCTION attach_attempt(p_request_id uuid, p_provider_reference text, p_redirect_url text, p_expires_at timestamp with time zone, p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.attach_attempt(p_request_id uuid, p_provider_reference text, p_redirect_url text, p_expires_at timestamp with time zone, p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.attach_attempt(p_request_id uuid, p_provider_reference text, p_redirect_url text, p_expires_at timestamp with time zone, p_merchant_key text) TO service_role;


--
-- Name: FUNCTION audit_diff(p_merchant_id uuid, p_area text, p_entity text, p_actor text, p_old jsonb, p_new jsonb); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.audit_diff(p_merchant_id uuid, p_area text, p_entity text, p_actor text, p_old jsonb, p_new jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.audit_diff(p_merchant_id uuid, p_area text, p_entity text, p_actor text, p_old jsonb, p_new jsonb) TO service_role;


--
-- Name: FUNCTION cancel_request(p_request_id uuid, p_actor text, p_actor_id text, p_reason text, p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.cancel_request(p_request_id uuid, p_actor text, p_actor_id text, p_reason text, p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.cancel_request(p_request_id uuid, p_actor text, p_actor_id text, p_reason text, p_merchant_key text) TO service_role;


--
-- Name: FUNCTION cancel_requests_for(p_merchant_key text, p_external_reference text, p_actor text, p_actor_id text, p_reason text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.cancel_requests_for(p_merchant_key text, p_external_reference text, p_actor text, p_actor_id text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.cancel_requests_for(p_merchant_key text, p_external_reference text, p_actor text, p_actor_id text, p_reason text) TO service_role;


--
-- Name: FUNCTION cancellation_mark(p_id uuid, p_ok boolean, p_error text, p_skip boolean); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.cancellation_mark(p_id uuid, p_ok boolean, p_error text, p_skip boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.cancellation_mark(p_id uuid, p_ok boolean, p_error text, p_skip boolean) TO service_role;


--
-- Name: FUNCTION cancellations_due(p_limit integer); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.cancellations_due(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.cancellations_due(p_limit integer) TO service_role;


--
-- Name: FUNCTION capabilities_json(p_provider text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.capabilities_json(p_provider text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.capabilities_json(p_provider text) TO service_role;


--
-- Name: FUNCTION config_audit_list(p_merchant_key text, p_limit integer); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.config_audit_list(p_merchant_key text, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.config_audit_list(p_merchant_key text, p_limit integer) TO service_role;


--
-- Name: FUNCTION confirm_manual(p_request_id uuid, p_operator text, p_amount integer, p_currency text, p_reference text, p_paid_at timestamp with time zone, p_note text, p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.confirm_manual(p_request_id uuid, p_operator text, p_amount integer, p_currency text, p_reference text, p_paid_at timestamp with time zone, p_note text, p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.confirm_manual(p_request_id uuid, p_operator text, p_amount integer, p_currency text, p_reference text, p_paid_at timestamp with time zone, p_note text, p_merchant_key text) TO service_role;


--
-- Name: FUNCTION create_request(p_merchant_key text, p_provider text, p_external_reference text, p_public_reference text, p_amount integer, p_currency text, p_country text, p_expires_at timestamp with time zone, p_metadata jsonb, p_runtime jsonb, p_capability text, p_platform text, p_initiated_by text, p_intent text, p_pricing_amount integer, p_pricing_currency text, p_fx_quote_id uuid); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.create_request(p_merchant_key text, p_provider text, p_external_reference text, p_public_reference text, p_amount integer, p_currency text, p_country text, p_expires_at timestamp with time zone, p_metadata jsonb, p_runtime jsonb, p_capability text, p_platform text, p_initiated_by text, p_intent text, p_pricing_amount integer, p_pricing_currency text, p_fx_quote_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.create_request(p_merchant_key text, p_provider text, p_external_reference text, p_public_reference text, p_amount integer, p_currency text, p_country text, p_expires_at timestamp with time zone, p_metadata jsonb, p_runtime jsonb, p_capability text, p_platform text, p_initiated_by text, p_intent text, p_pricing_amount integer, p_pricing_currency text, p_fx_quote_id uuid) TO service_role;


--
-- Name: FUNCTION currency_exponent(p_currency text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.currency_exponent(p_currency text) FROM PUBLIC;


--
-- Name: FUNCTION eligible_capabilities(p_merchant_key text, p_country text, p_currency text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.eligible_capabilities(p_merchant_key text, p_country text, p_currency text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.eligible_capabilities(p_merchant_key text, p_country text, p_currency text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text) TO service_role;


--
-- Name: FUNCTION eligible_currencies(p_merchant_key text, p_country text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.eligible_currencies(p_merchant_key text, p_country text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.eligible_currencies(p_merchant_key text, p_country text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text) TO service_role;


--
-- Name: FUNCTION eligible_methods(p_merchant_key text, p_country text, p_currency text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.eligible_methods(p_merchant_key text, p_country text, p_currency text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.eligible_methods(p_merchant_key text, p_country text, p_currency text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text) TO service_role;


--
-- Name: FUNCTION expire_request(p_request_id uuid, p_reason text, p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.expire_request(p_request_id uuid, p_reason text, p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.expire_request(p_request_id uuid, p_reason text, p_merchant_key text) TO service_role;


--
-- Name: FUNCTION fx_currency_exponent(p text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_currency_exponent(p text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_currency_exponent(p text) TO service_role;


--
-- Name: FUNCTION fx_currency_set(p_currency text, p jsonb, p_actor text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_currency_set(p_currency text, p jsonb, p_actor text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_currency_set(p_currency text, p jsonb, p_actor text) TO service_role;


--
-- Name: FUNCTION fx_currency_status(p_ccy text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_currency_status(p_ccy text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_currency_status(p_ccy text) TO service_role;


--
-- Name: FUNCTION fx_freshness(p_age_hours numeric); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_freshness(p_age_hours numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_freshness(p_age_hours numeric) TO service_role;


--
-- Name: FUNCTION fx_ingest_rate(p_quote text, p_rate numeric, p_rate_date date, p_source text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_ingest_rate(p_quote text, p_rate numeric, p_rate_date date, p_source text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_ingest_rate(p_quote text, p_rate numeric, p_rate_date date, p_source text) TO service_role;


--
-- Name: FUNCTION fx_overview(p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_overview(p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_overview(p_merchant_key text) TO service_role;


--
-- Name: FUNCTION fx_quote(p_merchant_key text, p_pricing_amount integer, p_pricing_currency text, p_payment_currency text, p_preview boolean); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_quote(p_merchant_key text, p_pricing_amount integer, p_pricing_currency text, p_payment_currency text, p_preview boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_quote(p_merchant_key text, p_pricing_amount integer, p_pricing_currency text, p_payment_currency text, p_preview boolean) TO service_role;


--
-- Name: FUNCTION fx_quote_consume(p_quote_id uuid, p_merchant_id uuid, p_request_id uuid, p_amount integer, p_currency text, p_pricing_amount integer, p_pricing_currency text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_quote_consume(p_quote_id uuid, p_merchant_id uuid, p_request_id uuid, p_amount integer, p_currency text, p_pricing_amount integer, p_pricing_currency text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_quote_consume(p_quote_id uuid, p_merchant_id uuid, p_request_id uuid, p_amount integer, p_currency text, p_pricing_amount integer, p_pricing_currency text) TO service_role;


--
-- Name: FUNCTION fx_quote_json(q beau_ph.fx_quotes); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_quote_json(q beau_ph.fx_quotes) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_quote_json(q beau_ph.fx_quotes) TO service_role;


--
-- Name: FUNCTION fx_quotes_guard(); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_quotes_guard() FROM PUBLIC;


--
-- Name: FUNCTION fx_rate_on(p_ccy text, p_date date); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_rate_on(p_ccy text, p_date date) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_rate_on(p_ccy text, p_date date) TO service_role;


--
-- Name: FUNCTION fx_refresh_collect(); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_refresh_collect() FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_refresh_collect() TO service_role;


--
-- Name: FUNCTION fx_refresh_start(p_actor text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_refresh_start(p_actor text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_refresh_start(p_actor text) TO service_role;


--
-- Name: FUNCTION fx_validate_rate(p_rate numeric, p_last numeric); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.fx_validate_rate(p_rate numeric, p_last numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.fx_validate_rate(p_rate numeric, p_last numeric) TO service_role;


--
-- Name: FUNCTION get_request(p_request_id uuid, p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.get_request(p_request_id uuid, p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.get_request(p_request_id uuid, p_merchant_key text) TO service_role;


--
-- Name: FUNCTION ingest_provider_event(p_provider text, p_provider_event_id text, p_event_type text, p_payload jsonb, p_normalized jsonb); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.ingest_provider_event(p_provider text, p_provider_event_id text, p_event_type text, p_payload jsonb, p_normalized jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.ingest_provider_event(p_provider text, p_provider_event_id text, p_event_type text, p_payload jsonb, p_normalized jsonb) TO service_role;


--
-- Name: FUNCTION ingest_stripe_event(p_event jsonb); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.ingest_stripe_event(p_event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.ingest_stripe_event(p_event jsonb) TO service_role;


--
-- Name: FUNCTION is_capability(p text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.is_capability(p text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.is_capability(p text) TO service_role;


--
-- Name: FUNCTION is_in_person(p text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.is_in_person(p text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.is_in_person(p text) TO service_role;


--
-- Name: FUNCTION is_platform(p text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.is_platform(p text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.is_platform(p text) TO service_role;


--
-- Name: FUNCTION is_reconciled(p_payment_event_id uuid); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.is_reconciled(p_payment_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.is_reconciled(p_payment_event_id uuid) TO service_role;


--
-- Name: FUNCTION mark_reconciled(p_payment_event_id uuid, p_host_reference text, p_note text, p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.mark_reconciled(p_payment_event_id uuid, p_host_reference text, p_note text, p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.mark_reconciled(p_payment_event_id uuid, p_host_reference text, p_note text, p_merchant_key text) TO service_role;


--
-- Name: FUNCTION merchant_fx_json(f beau_ph.merchant_fx); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.merchant_fx_json(f beau_ph.merchant_fx) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.merchant_fx_json(f beau_ph.merchant_fx) TO service_role;


--
-- Name: FUNCTION merchant_fx_set(p_merchant_key text, p jsonb, p_actor text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.merchant_fx_set(p_merchant_key text, p jsonb, p_actor text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.merchant_fx_set(p_merchant_key text, p jsonb, p_actor text) TO service_role;


--
-- Name: FUNCTION merchant_method_configure(p_merchant_key text, p_provider text, p jsonb, p_actor text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.merchant_method_configure(p_merchant_key text, p_provider text, p jsonb, p_actor text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.merchant_method_configure(p_merchant_key text, p_provider text, p jsonb, p_actor text) TO service_role;


--
-- Name: FUNCTION merchant_method_get(p_merchant_key text, p_provider text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.merchant_method_get(p_merchant_key text, p_provider text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.merchant_method_get(p_merchant_key text, p_provider text) TO service_role;


--
-- Name: FUNCTION no_secret_keys(p jsonb); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.no_secret_keys(p jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.no_secret_keys(p jsonb) TO service_role;


--
-- Name: FUNCTION merchant_method_remove(p_merchant_key text, p_provider text, p_actor text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.merchant_method_remove(p_merchant_key text, p_provider text, p_actor text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.merchant_method_remove(p_merchant_key text, p_provider text, p_actor text) TO service_role;


--
-- Name: FUNCTION merchant_method_set(p_merchant_key text, p_provider text, p_enabled boolean, p_currency text, p_instructions jsonb, p_settings jsonb, p_countries text[], p_updated_by text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.merchant_method_set(p_merchant_key text, p_provider text, p_enabled boolean, p_currency text, p_instructions jsonb, p_settings jsonb, p_countries text[], p_updated_by text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.merchant_method_set(p_merchant_key text, p_provider text, p_enabled boolean, p_currency text, p_instructions jsonb, p_settings jsonb, p_countries text[], p_updated_by text) TO service_role;


--
-- Name: FUNCTION merchant_methods_summary(p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.merchant_methods_summary(p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.merchant_methods_summary(p_merchant_key text) TO service_role;


--
-- Name: FUNCTION method_matrix(p_merchant_key text, p_country text, p_currency text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.method_matrix(p_merchant_key text, p_country text, p_currency text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.method_matrix(p_merchant_key text, p_country text, p_currency text, p_runtime jsonb, p_platform text, p_initiated_by text, p_intent text) TO service_role;


--
-- Name: FUNCTION normalize_paypal_event(p_event jsonb); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.normalize_paypal_event(p_event jsonb) FROM PUBLIC;


--
-- Name: FUNCTION normalize_stripe_event(p_event jsonb); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.normalize_stripe_event(p_event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.normalize_stripe_event(p_event jsonb) TO service_role;


--
-- Name: FUNCTION owned_by(p_request_id uuid, p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.owned_by(p_request_id uuid, p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.owned_by(p_request_id uuid, p_merchant_key text) TO service_role;


--
-- Name: FUNCTION paypal_minor(p_value text, p_currency text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.paypal_minor(p_value text, p_currency text) FROM PUBLIC;


--
-- Name: FUNCTION process_paypal_event(p_event jsonb); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.process_paypal_event(p_event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.process_paypal_event(p_event jsonb) TO service_role;


--
-- Name: FUNCTION queue_provider_cancellation(); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.queue_provider_cancellation() FROM PUBLIC;


--
-- Name: FUNCTION rail_events(p_merchant_key text, p_provider text, p_limit integer); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.rail_events(p_merchant_key text, p_provider text, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.rail_events(p_merchant_key text, p_provider text, p_limit integer) TO service_role;


--
-- Name: FUNCTION rails_overview(p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.rails_overview(p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.rails_overview(p_merchant_key text) TO service_role;


--
-- Name: FUNCTION record_event(p_request_id uuid, p_to text, p_actor text, p_actor_id text, p_provider_event_id uuid, p_amount integer, p_currency text, p_provider_status text, p_provider_reference text, p_payment_reference text, p_evidence jsonb); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.record_event(p_request_id uuid, p_to text, p_actor text, p_actor_id text, p_provider_event_id uuid, p_amount integer, p_currency text, p_provider_status text, p_provider_reference text, p_payment_reference text, p_evidence jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.record_event(p_request_id uuid, p_to text, p_actor text, p_actor_id text, p_provider_event_id uuid, p_amount integer, p_currency text, p_provider_status text, p_provider_reference text, p_payment_reference text, p_evidence jsonb) TO service_role;


--
-- Name: FUNCTION request_events(p_request_id uuid, p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.request_events(p_request_id uuid, p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.request_events(p_request_id uuid, p_merchant_key text) TO service_role;


--
-- Name: FUNCTION request_json(r beau_ph.payment_requests); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.request_json(r beau_ph.payment_requests) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.request_json(r beau_ph.payment_requests) TO service_role;


--
-- Name: FUNCTION requests_for(p_merchant_key text, p_external_reference text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.requests_for(p_merchant_key text, p_external_reference text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.requests_for(p_merchant_key text, p_external_reference text) TO service_role;


--
-- Name: FUNCTION settlement_destination_remove(p_merchant_key text, p_key text, p_actor text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.settlement_destination_remove(p_merchant_key text, p_key text, p_actor text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.settlement_destination_remove(p_merchant_key text, p_key text, p_actor text) TO service_role;


--
-- Name: FUNCTION settlement_destination_set(p_merchant_key text, p jsonb, p_actor text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.settlement_destination_set(p_merchant_key text, p jsonb, p_actor text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.settlement_destination_set(p_merchant_key text, p jsonb, p_actor text) TO service_role;


--
-- Name: FUNCTION settlement_destinations_list(p_merchant_key text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.settlement_destinations_list(p_merchant_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.settlement_destinations_list(p_merchant_key text) TO service_role;


--
-- Name: FUNCTION transition_allowed(p_from text, p_to text); Type: ACL; Schema: beau_ph; Owner: -
--

REVOKE ALL ON FUNCTION beau_ph.transition_allowed(p_from text, p_to text) FROM PUBLIC;
GRANT ALL ON FUNCTION beau_ph.transition_allowed(p_from text, p_to text) TO service_role;


--
-- PostgreSQL database dump complete
--



--
-- Reference data (production values)
--
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)


--
-- Data for Name: fx_sources; Type: TABLE DATA; Schema: beau_ph; Owner: -
--

INSERT INTO beau_ph.fx_sources (key, kind, url, enabled, sort, notes) VALUES ('frankfurter', 'frankfurter', 'https://api.frankfurter.app/latest', true, 10, 'ECB reference rates (business days). EUR base.');
INSERT INTO beau_ph.fx_sources (key, kind, url, enabled, sort, notes) VALUES ('usd_peg', 'peg', NULL, true, 20, 'Currencies pegged to USD, derived from the USD rate of the same day.');
INSERT INTO beau_ph.fx_sources (key, kind, url, enabled, sort, notes) VALUES ('nbg', 'nbg', 'https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/', false, 30, 'National Bank of Georgia official rates (GEL, RUB). Disabled until a merchant needs GEL.');


--
-- Data for Name: fx_currencies; Type: TABLE DATA; Schema: beau_ph; Owner: -
--

INSERT INTO beau_ph.fx_currencies (currency, enabled, source_key, peg_currency, peg_rate, notes, updated_by, updated_at) VALUES ('USD', true, 'frankfurter', NULL, NULL, 'ECB', NULL, '2026-09-30 09:37:00.276236+00');
INSERT INTO beau_ph.fx_currencies (currency, enabled, source_key, peg_currency, peg_rate, notes, updated_by, updated_at) VALUES ('GBP', true, 'frankfurter', NULL, NULL, 'ECB', NULL, '2026-09-30 09:37:00.276236+00');
INSERT INTO beau_ph.fx_currencies (currency, enabled, source_key, peg_currency, peg_rate, notes, updated_by, updated_at) VALUES ('ZAR', true, 'frankfurter', NULL, NULL, 'ECB', NULL, '2026-09-30 09:37:00.276236+00');
INSERT INTO beau_ph.fx_currencies (currency, enabled, source_key, peg_currency, peg_rate, notes, updated_by, updated_at) VALUES ('CHF', false, 'frankfurter', NULL, NULL, 'ECB', NULL, '2026-09-30 09:37:00.276236+00');
INSERT INTO beau_ph.fx_currencies (currency, enabled, source_key, peg_currency, peg_rate, notes, updated_by, updated_at) VALUES ('AED', true, 'usd_peg', 'USD', 3.67250000, 'AED is pegged to USD at 3.6725', NULL, '2026-09-30 09:37:00.276236+00');
INSERT INTO beau_ph.fx_currencies (currency, enabled, source_key, peg_currency, peg_rate, notes, updated_by, updated_at) VALUES ('SAR', false, 'usd_peg', 'USD', 3.75000000, 'SAR is pegged to USD at 3.75', NULL, '2026-09-30 09:37:00.276236+00');
INSERT INTO beau_ph.fx_currencies (currency, enabled, source_key, peg_currency, peg_rate, notes, updated_by, updated_at) VALUES ('QAR', false, 'usd_peg', 'USD', 3.64000000, 'QAR is pegged to USD at 3.64', NULL, '2026-09-30 09:37:00.276236+00');
INSERT INTO beau_ph.fx_currencies (currency, enabled, source_key, peg_currency, peg_rate, notes, updated_by, updated_at) VALUES ('GEL', false, 'nbg', NULL, NULL, 'NBG official rate', NULL, '2026-09-30 09:37:00.276236+00');
INSERT INTO beau_ph.fx_currencies (currency, enabled, source_key, peg_currency, peg_rate, notes, updated_by, updated_at) VALUES ('RUB', false, 'nbg', NULL, NULL, 'NBG official rate', NULL, '2026-09-30 09:37:00.276236+00');
INSERT INTO beau_ph.fx_currencies (currency, enabled, source_key, peg_currency, peg_rate, notes, updated_by, updated_at) VALUES ('KES', false, NULL, NULL, NULL, 'No configured source. Add one before enabling.', NULL, '2026-09-30 09:37:00.276236+00');


--
-- Data for Name: providers; Type: TABLE DATA; Schema: beau_ph; Owner: -
--

INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('beau_wallet', 'BEAU Wallet', 'crypto', 'unavailable', NULL, NULL, 'placeholder', 80, 'Future stablecoin-capable crypto rail. Placeholder: cannot create or confirm a payment; no static wallet address; no client-submitted tx hash.', 'Wallet', NULL, '{}', '[]', 'Reserved. No onboarding path yet.', false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('stripe', 'Card (Stripe)', 'online', 'provider_event', NULL, NULL, 'available', 10, 'Hosted Checkout; a payment is confirmed only by a signature-verified webhook. Mode follows PAYMENTS_MODE (test | live) and must match the merchant mode.', 'Online · Card', NULL, '{STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,STRIPE_PUBLISHABLE_KEY}', '[]', 'Stripe account (Oolala), secret + publishable keys and the webhook signing secret set as deployment secrets; PAYMENTS_MODE declares test or live.', true);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('aani', 'Aani (UAE instant payment)', 'manual', 'operator', '{AE}', '{AED}', 'available', 20, 'V1: static instructions (registered mobile number); an authorised operator confirms receipt. No Aani API / deep link / request-to-pay is used.', 'Manual · Instant payment (UAE)', NULL, '{}', '[{"key": "proxy_type", "type": "select", "label": "Proxy type", "store": "instructions", "public": true, "options": ["mobile", "email", "merchant", "qr"]}, {"key": "proxy_value", "mask": true, "type": "text", "label": "Aani value (machine)", "store": "instructions", "public": true, "placeholder": "+9715XXXXXXXX"}, {"key": "display_value", "type": "text", "label": "Display value", "store": "instructions", "public": true, "placeholder": "+971 5X XXX XXXX"}, {"key": "instructions", "type": "textarea", "label": "Instructions shown to the client", "store": "instructions", "public": true}, {"key": "qr_url", "type": "url", "label": "QR image link (optional)", "store": "instructions", "public": true}]', 'No API. Register the Aani proxy (mobile, email or merchant id) the client pays; an authorised operator confirms receipt.', false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('bank_transfer', 'Bank transfer', 'manual', 'operator', NULL, NULL, 'available', 30, 'Account holder / IBAN / BIC-SWIFT / bank name instructions; an authorised operator confirms receipt.', 'Manual · Bank transfer', NULL, '{}', '[{"key": "account_holder", "type": "text", "label": "Account holder", "store": "instructions", "public": true}, {"key": "iban", "mask": true, "type": "text", "label": "IBAN", "store": "instructions", "public": true}, {"key": "bic", "type": "text", "label": "BIC / SWIFT", "store": "instructions", "public": true}, {"key": "bank_name", "type": "text", "label": "Bank name", "store": "instructions", "public": true}, {"key": "instructions", "type": "textarea", "label": "Instructions shown to the client", "store": "instructions", "public": true}]', 'No API. Enter the account the client transfers to; an authorised operator confirms receipt.', false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('paynow', 'Paynow (Zimbabwe)', 'online', 'provider_event', '{ZW}', '{USD,ZWG}', 'not_configured', 40, 'Adapter boundary only. Needs Paynow merchant onboarding (integration id + key) before it can act.', 'Online · Redirect / mobile money', NULL, '{PAYNOW_INTEGRATION_ID,PAYNOW_INTEGRATION_KEY}', '[]', 'Paynow merchant onboarding (integration id + key), then the adapter can act.', false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('mpesa', 'M-PESA (Kenya)', 'online', 'provider_event', '{KE}', '{KES}', 'not_configured', 50, 'Adapter boundary only. Needs Safaricom Daraja onboarding (consumer key/secret, shortcode, passkey).', 'Online · Mobile money', NULL, '{MPESA_CONSUMER_KEY,MPESA_CONSUMER_SECRET,MPESA_SHORTCODE,MPESA_PASSKEY}', '[]', 'Safaricom Daraja onboarding (consumer key / secret, shortcode, passkey).', false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('ozow', 'Ozow (South Africa)', 'online', 'provider_event', '{ZA}', '{ZAR}', 'not_configured', 60, 'Adapter boundary only. Needs Ozow merchant onboarding (site code, private key, API key).', 'Online · Instant EFT', NULL, '{OZOW_SITE_CODE,OZOW_PRIVATE_KEY,OZOW_API_KEY}', '[]', 'Ozow merchant onboarding (site code, private key, API key).', false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('payshap', 'PayShap (South Africa)', 'online', 'provider_event', '{ZA}', '{ZAR}', 'not_configured', 70, 'Adapter boundary only. Needs a sponsoring bank/PSP exposing PayShap request-to-pay.', 'Online · QR / request to pay', NULL, '{PAYSHAP_SPONSOR_CLIENT_ID,PAYSHAP_SPONSOR_CLIENT_SECRET}', '[]', 'Needs a sponsoring bank before any PayShap request can be issued.', false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('network_international', 'Network International (N-Genius)', 'online', 'provider_event', '{AE}', '{AED}', 'not_configured', 90, 'UAE acquirer. Apple Tap to Pay on iPhone launch partner (Dec 2024) through the N-Genius One app. Provider-level readiness = N-Genius API/online integration — not onboarded. SoftPOS handoff is a capability (see provider_capabilities).', 'In person · Tap to Pay app', NULL, '{NGENIUS_API_KEY,NGENIUS_OUTLET_ID}', '[{"key": "handoff_app", "type": "text", "label": "App name", "store": "settings", "placeholder": "N-Genius One"}, {"key": "handoff_url", "type": "url", "label": "App link (optional)", "store": "settings", "placeholder": "app scheme or https:// link"}]', 'V0 handoff needs only the N-Genius One app on the merchant phone. API keys are for the future online / terminal integration.', false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('magnati', 'Magnati (SwipeX)', 'online', 'provider_event', '{AE}', '{AED}', 'not_configured', 91, 'UAE acquirer (FAB group). Apple Tap to Pay on iPhone launch partner (Dec 2024) through the SwipeX app, digital onboarding. Provider-level readiness = API integration — not onboarded.', 'In person · Tap to Pay app', NULL, '{MAGNATI_MERCHANT_KEY,MAGNATI_API_SECRET}', '[{"key": "handoff_app", "type": "text", "label": "App name", "store": "settings", "placeholder": "SwipeX"}, {"key": "handoff_url", "type": "url", "label": "App link (optional)", "store": "settings", "placeholder": "app scheme or https:// link"}]', 'V0 handoff needs only the SwipeX app on the merchant phone. Keys are for the future online / terminal integration.', false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('adyen', 'Adyen', 'online', 'provider_event', NULL, NULL, 'not_configured', 92, 'Global PSP. Apple Tap to Pay on iPhone launch partner in the UAE (Dec 2024) via the Adyen POS Mobile SDK / Terminal API — SDK-based, no standalone handoff app. Not onboarded.', 'In person · SDK', NULL, '{ADYEN_API_KEY,ADYEN_MERCHANT_ACCOUNT,ADYEN_HMAC_KEY}', '[{"key": "handoff_app", "type": "text", "label": "App name", "store": "settings"}, {"key": "handoff_url", "type": "url", "label": "App link (optional)", "store": "settings"}]', 'Adyen account plus an Adyen-built app; no standalone handoff app exists.', false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('wise', 'Wise (local transfer)', 'manual', 'operator', NULL, NULL, 'available', 35, 'Local account details from a Wise Business account (AED, EUR, GBP, USD) so the payer sends a local transfer rather than an international wire; an authorised operator confirms receipt. No Wise API call is made: Wise has no acceptance API, only payouts and balance reads. Business account only.', NULL, NULL, '{}', '[]', NULL, false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('cash', 'Cash', 'manual', 'operator', NULL, NULL, 'available', 35, 'Cash handed over in person; an authorised operator records the receipt (amount, currency, date). The amount is the request amount in the request currency — never converted.', 'In person · Cash', NULL, '{}', '[{"key": "instructions", "type": "textarea", "label": "Instructions shown to the client", "store": "instructions", "public": true}]', 'No API. Enable the rail and scope its markets; optionally add a note for the client. An authorised operator records each cash receipt; nothing is ever confirmed automatically.', false);
INSERT INTO beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel) VALUES ('paypal', 'PayPal', 'online', 'provider_event', NULL, NULL, 'available', 15, 'Orders v2, intent CAPTURE, confirmed only by a signature-verified webhook. Commercial order, never friends and family. Falls back to instructions when the API is not configured. Business account only.', NULL, NULL, '{}', '[]', NULL, false);


--
-- Data for Name: provider_capabilities; Type: TABLE DATA; Schema: beau_ph; Owner: -
--

INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('stripe', 'payment_link', 'not_configured', 'provider_event', NULL, 'merchant', false, 'Stripe Payment Links — not implemented.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('aani', 'manual_instructions', 'available', 'operator', NULL, 'any', false, 'Static Aani instructions; an authorised operator confirms receipt.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('bank_transfer', 'bank_transfer', 'available', 'operator', NULL, 'any', false, 'Account holder / IBAN / BIC; an authorised operator confirms receipt.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('bank_transfer', 'manual_instructions', 'available', 'operator', NULL, 'any', false, 'Same rail, instruction form.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('paynow', 'online_checkout', 'not_configured', 'provider_event', NULL, 'customer', false, 'Paynow hosted redirect — not onboarded.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('paynow', 'mobile_money', 'not_configured', 'provider_event', NULL, 'customer', false, 'EcoCash / OneMoney via Paynow Express — not onboarded.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('mpesa', 'mobile_money', 'not_configured', 'provider_event', NULL, 'customer', false, 'Lipa na M-PESA STK push — not onboarded.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('ozow', 'online_checkout', 'not_configured', 'provider_event', NULL, 'customer', false, 'Ozow instant EFT — not onboarded.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('payshap', 'qr', 'not_configured', 'provider_event', NULL, 'customer', false, 'PayShap QR / ShapID request-to-pay — needs a sponsoring bank.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('payshap', 'bank_transfer', 'not_configured', 'provider_event', NULL, 'customer', false, 'PayShap rapid payment — needs a sponsoring bank.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('beau_wallet', 'crypto', 'placeholder', 'unavailable', NULL, 'customer', false, 'Future stablecoin-capable rail — placeholder.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('beau_wallet', 'wallet', 'placeholder', 'unavailable', NULL, 'customer', false, 'BEAU Wallet — placeholder.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('beau_wallet', 'qr', 'placeholder', 'unavailable', NULL, 'customer', false, 'Wallet QR — placeholder.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('network_international', 'softpos', 'available', 'operator', NULL, 'merchant', true, 'V0 handoff: the merchant takes the contactless tap in the N-Genius One app (Apple Tap to Pay on iPhone, iPhone XS+); an authorised operator attests the app receipt / RRN. No card or PIN data ever reaches BEAU PH.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('network_international', 'tap_to_pay', 'placeholder', 'provider_event', '{ios_app}', 'merchant', false, 'Native Tap to Pay on iPhone through the PSP SDK inside a future BEAU PH Merchant iOS app (Apple entitlement, PSP-certified configuration, webhook/API verification). ios_app only.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('network_international', 'card_present', 'not_configured', 'provider_event', NULL, 'merchant', false, 'N-Genius POS terminal with API reconciliation — not onboarded.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('network_international', 'online_checkout', 'not_configured', 'provider_event', NULL, 'customer', false, 'N-Genius Online — not onboarded.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('magnati', 'softpos', 'available', 'operator', NULL, 'merchant', true, 'V0 handoff: the merchant takes the tap in the SwipeX app (Apple Tap to Pay on iPhone); an authorised operator attests the app receipt / transaction reference.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('magnati', 'tap_to_pay', 'placeholder', 'provider_event', '{ios_app}', 'merchant', false, 'Native Tap to Pay on iPhone via the Magnati SDK inside a future BEAU PH Merchant iOS app. ios_app only.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('magnati', 'card_present', 'not_configured', 'provider_event', NULL, 'merchant', false, 'Magnati terminal / Tap to Phone (Android) with API reconciliation — not onboarded.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('magnati', 'online_checkout', 'not_configured', 'provider_event', NULL, 'customer', false, 'Magnati online gateway — not onboarded.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('adyen', 'softpos', 'not_configured', 'operator', NULL, 'merchant', true, 'Adyen is SDK-based: no standalone handoff app for a small merchant. Needs an Adyen account + an Adyen-built app before any handoff.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('adyen', 'tap_to_pay', 'placeholder', 'provider_event', '{ios_app}', 'merchant', false, 'Native via the Adyen POS Mobile SDK inside a future BEAU PH Merchant iOS app. ios_app only.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('adyen', 'card_present', 'not_configured', 'provider_event', NULL, 'merchant', false, 'Adyen terminals / Terminal API — not onboarded.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('adyen', 'online_checkout', 'not_configured', 'provider_event', NULL, 'customer', false, 'Adyen Checkout — not onboarded.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('stripe', 'online_checkout', 'available', 'provider_event', NULL, 'customer', false, 'Hosted Checkout; confirmed by a signature-verified webhook. Mode follows PAYMENTS_MODE.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('cash', 'cash', 'available', 'operator', NULL, 'any', false, 'Cash in person; an authorised operator records the receipt. Offered to the client as an option and to the merchant under Collect in person.', NULL);
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('paypal', 'p2p_transfer', 'available', 'operator', NULL, 'any', false, 'PayPal personal transfer (friends and family). Non-commercial requests only: the intent must be personal, and the merchant must opt in. No Orders v2 order and no webhook exists for this, so an authorised operator confirms receipt. Sending a commercial payment this way breaches PayPal terms and removes protection for both sides.', '{personal}');
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('wise', 'p2p_transfer', 'available', 'operator', NULL, 'any', false, 'Wise personal transfer between individuals. Non-commercial requests only. An authorised operator confirms receipt; Wise reports nothing back.', '{personal}');
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('wise', 'bank_transfer', 'available', 'operator', NULL, 'any', false, 'Wise Business local account details; an authorised operator confirms receipt.', '{service,package,support,other}');
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('wise', 'manual_instructions', 'available', 'operator', NULL, 'any', false, 'Same rail, instruction form.', '{service,package,support,other}');
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('paypal', 'online_checkout', 'available', 'provider_event', NULL, 'customer', false, 'Orders v2 CAPTURE; the payer approves on PayPal and a verified webhook confirms.', '{service,package,support,other}');
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('paypal', 'wallet', 'available', 'provider_event', NULL, 'customer', false, 'The payer settles from their PayPal balance or a card on their account; it is the same order either way.', '{service,package,support,other}');
INSERT INTO beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents) VALUES ('paypal', 'manual_instructions', 'available', 'operator', NULL, 'any', false, 'Fallback when the API is not configured: pay the business account with the reference; an operator confirms.', '{service,package,support,other}');


--
-- PostgreSQL database dump complete
--



-- ---------- version ledger: BEAU PH keeps its own, apart from any host's ----------
create table if not exists beau_ph.schema_versions (
  version    text primary key,
  applied_at timestamptz not null default now(),
  note       text
);
alter table beau_ph.schema_versions enable row level security;
revoke all on beau_ph.schema_versions from public, anon, authenticated;
grant select on beau_ph.schema_versions to service_role;
insert into beau_ph.schema_versions (version, note) values ('0001_baseline', 'fresh install') on conflict (version) do nothing;

-- ---------- FX schedule: daily refresh after the ECB publication; minute collector ----------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net') then
    begin perform cron.unschedule('beau-ph-fx-refresh'); exception when others then null; end;
    begin perform cron.unschedule('beau-ph-fx-collect'); exception when others then null; end;
    perform cron.schedule('beau-ph-fx-refresh', '5 6 * * *', $cron$select beau_ph.fx_refresh_start('cron')$cron$);
    perform cron.schedule('beau-ph-fx-collect', '* * * * *', $cron$select beau_ph.fx_refresh_collect()$cron$);
  end if;
end $$;
