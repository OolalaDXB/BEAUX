-- =====================================================================
-- BEAU PH — every provider attempt is cancelled, not only the last one
--
-- A request can open several provider attempts (a Stripe Checkout Session
-- per `attach_attempt`); a new attempt marks the previous one `superseded`
-- in BEAU PH, but the session stayed OPEN at the provider:
--   - while the request is open, the payer could pay both sessions — the
--     second is refused (`ignored:already_paid`) and needs a manual refund;
--   - once the request is cancelled or expired, only the LAST reference was
--     queued for cancellation (`provider_cancellations` had one row per
--     request), so a late payment on an older session was refused
--     (`rejected:illegal_transition:cancelled->paid`) — the same manual refund.
--
-- Now:
--   - a new attempt queues the cancellation of every superseded attempt of
--     the same request whose reference differs from the new one (a resumed
--     session that keeps its reference is never cancelled);
--   - closing a request (cancelled | expired) queues every distinct reference
--     its attempts and the request ever carried;
--   - `provider_cancellations` holds one row per (request, reference).
-- The queue is drained by `drainCancellations()` (core/cancellations.ts).
-- =====================================================================

alter table beau_ph.provider_cancellations drop constraint provider_cancellations_request_id_key;
alter table beau_ph.provider_cancellations
  add constraint provider_cancellations_request_reference_key unique (request_id, provider_reference);

-- One queue writer: pending when the rail can cancel and the attempt exists at
-- the provider, otherwise skipped with the reason (kept, so the trail is whole).
create or replace function beau_ph.enqueue_provider_cancellation(p_request_id uuid, p_reference text, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_merchant text; v_provider text; v_supports boolean; v_ref text := coalesce(p_reference, '');
begin
  select m.key, r.provider_key into v_merchant, v_provider
    from beau_ph.payment_requests r join beau_ph.merchants m on m.id = r.merchant_id
   where r.id = p_request_id;
  if not found then return; end if;
  select p.supports_cancel into v_supports from beau_ph.providers p where p.key = v_provider;

  insert into beau_ph.provider_cancellations (request_id, merchant_key, provider_key, provider_reference, reason, status, last_error, settled_at)
  values (p_request_id, v_merchant, v_provider, v_ref, p_reason,
          case when coalesce(v_supports, false) and v_ref <> '' then 'pending' else 'skipped' end,
          case when not coalesce(v_supports, false) then 'rail has no cancel'
               when v_ref = ''                     then 'never created at the provider'
               else null end,
          case when coalesce(v_supports, false) and v_ref <> '' then null else now() end)
  on conflict (request_id, provider_reference) do nothing;   -- a reference is cancelled once
end $$;

-- A request closes: every reference it ever had at the provider.
create or replace function beau_ph.queue_provider_cancellation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ref text; v_any boolean := false;
begin
  if new.status not in ('cancelled','expired') or old.status = new.status then return new; end if;

  for v_ref in
    select distinct ref from (
      select coalesce(new.provider_reference, '') as ref
      union all
      select coalesce(a.provider_reference, '') from beau_ph.payment_attempts a where a.request_id = new.id
    ) refs where ref <> ''
  loop
    perform beau_ph.enqueue_provider_cancellation(new.id, v_ref, new.status);
    v_any := true;
  end loop;

  -- never opened at the provider: one skipped row, as before
  if not v_any then perform beau_ph.enqueue_provider_cancellation(new.id, '', new.status); end if;
  return new;
end $$;

-- A new attempt: the superseded ones are cancelled at the provider, unless they
-- carry the very reference the new attempt reuses (a resumed session).
create or replace function beau_ph.queue_superseded_attempt_cancellation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ref text;
begin
  for v_ref in
    select distinct a.provider_reference from beau_ph.payment_attempts a
     where a.request_id = new.request_id and a.id <> new.id and a.status = 'superseded'
       and coalesce(a.provider_reference, '') <> '' and a.provider_reference <> coalesce(new.provider_reference, '')
  loop
    perform beau_ph.enqueue_provider_cancellation(new.request_id, v_ref, 'superseded');
  end loop;
  return new;
end $$;

create trigger payment_attempts_queue_superseded_cancellation
  after insert on beau_ph.payment_attempts
  for each row execute function beau_ph.queue_superseded_attempt_cancellation();

revoke all on function beau_ph.enqueue_provider_cancellation(uuid, text, text) from public;
revoke all on function beau_ph.queue_superseded_attempt_cancellation() from public;
grant execute on function beau_ph.enqueue_provider_cancellation(uuid, text, text) to service_role;

insert into beau_ph.schema_versions (version) values ('0004_cancel_every_attempt') on conflict do nothing;
