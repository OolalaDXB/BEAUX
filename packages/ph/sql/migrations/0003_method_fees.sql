-- =====================================================================
-- BEAU PH — fees, per payment method
--
-- A payment method can cost something (a card: the PSP's percentage, plus a
-- fixed amount) and a merchant decides who carries it: the payer (the fee
-- is added to what they pay) or the merchant (it is a cost, the payer pays
-- the price). Until now each host kept that by itself — Coach Gari a single
-- "card fee" setting, Sillon `payment_methods.fee_percent / fee_fixed`,
-- Maisons `property_payment_method_settings.fee_percent / fee_fixed /
-- fee_payer`. It belongs here, next to the method.
--
--   providers.default_fees     what a merchant gets when it sets nothing:
--                              0 % · no fixed amount · carried by the merchant
--   merchant_methods.fees      the merchant's own; NULL = the provider default
--   shape                      {"percent": 0..20, "fixed": {"AED": 100, …},
--                               "payer": "payer" | "merchant"}
--                              fixed amounts are in minor units, one per
--                              currency, and never converted: a currency with
--                              no fixed amount has none.
--   beau_ph.method_fee(...)    THE calculation: the fee on an amount, and how
--                              much of it the payer is charged. Hosts call it;
--                              none recomputes it.
--   beau_ph.merchant_method_set_fees(...)  the only writer, audited.
--
-- Charging a consumer for paying by card is forbidden in the EU and the UK
-- (PSD2 art. 62(4); in France, Code monétaire et financier L112-12). BEAU PH
-- does not know who the payer is: a host serving consumers there keeps
-- "payer" = "merchant", or applies it to business clients only (Sillon).
-- =====================================================================

create or replace function beau_ph.fees_valid(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p is null or (
        jsonb_typeof(p) = 'object'
    and not exists (select 1 from jsonb_object_keys(p) k where k not in ('percent', 'fixed', 'payer'))
    and (not p ? 'percent' or (jsonb_typeof(p -> 'percent') = 'number' and (p ->> 'percent')::numeric between 0 and 20))
    and (not p ? 'payer' or p ->> 'payer' in ('payer', 'merchant'))
    and (not p ? 'fixed' or (jsonb_typeof(p -> 'fixed') = 'object'
         and not exists (select 1 from jsonb_each(p -> 'fixed') f
                          where f.key !~ '^[A-Z]{3}$' or jsonb_typeof(f.value) <> 'number'
                             or (f.value #>> '{}')::numeric < 0 or (f.value #>> '{}')::numeric <> trunc((f.value #>> '{}')::numeric)))))
$$;

alter table beau_ph.providers add column if not exists default_fees jsonb not null default '{"percent":0,"fixed":{},"payer":"merchant"}'::jsonb;
alter table beau_ph.merchant_methods add column if not exists fees jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'providers_default_fees_check') then
    alter table beau_ph.providers add constraint providers_default_fees_check check (beau_ph.fees_valid(default_fees));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'merchant_methods_fees_check') then
    alter table beau_ph.merchant_methods add constraint merchant_methods_fees_check check (beau_ph.fees_valid(fees));
  end if;
end $$;

-- the merchant's fees if it set them, else the provider's default; always complete
create or replace function beau_ph.fees_effective(p_own jsonb, p_default jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'percent', coalesce((coalesce(p_own, p_default) ->> 'percent')::numeric, 0),
    'fixed',   coalesce(coalesce(p_own, p_default) -> 'fixed', '{}'::jsonb),
    'payer',   coalesce(coalesce(p_own, p_default) ->> 'payer', 'merchant'),
    'source',  case when p_own is null then 'default' else 'merchant' end)
$$;

-- The fee on p_amount (minor units, p_currency) for this merchant and method.
--   fee     = round(amount × percent / 100) + the fixed amount for that currency
--   charged = fee when the payer carries it, else 0 — what to ADD to the price
create or replace function beau_ph.method_fee(p_merchant_key text, p_provider text, p_amount integer, p_currency text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare m beau_ph.merchants%rowtype; pv beau_ph.providers%rowtype; own jsonb; eff jsonb; ccy text := upper(btrim(coalesce(p_currency, ''))); fee integer;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  select * into pv from beau_ph.providers where key = p_provider;
  if not found then raise exception 'unknown provider' using errcode = '22023'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'amount must be >= 0 (minor units)' using errcode = '22023'; end if;
  if ccy !~ '^[A-Z]{3}$' then raise exception 'currency must be an ISO 4217 code' using errcode = '22023'; end if;
  select mm.fees into own from beau_ph.merchant_methods mm where mm.merchant_id = m.id and mm.provider_key = p_provider;
  eff := beau_ph.fees_effective(own, pv.default_fees);
  fee := round(p_amount::numeric * (eff ->> 'percent')::numeric / 100)::integer + coalesce((eff -> 'fixed' ->> ccy)::integer, 0);
  if p_amount = 0 then fee := 0; end if;
  return eff || jsonb_build_object('provider', p_provider, 'currency', ccy, 'amount', p_amount, 'fee', fee,
                                   'charged', case when eff ->> 'payer' = 'payer' then fee else 0 end);
end $$;

-- the only writer: p_fees = the merchant's fees, or NULL to go back to the provider default
create or replace function beau_ph.merchant_method_set_fees(p_merchant_key text, p_provider text, p_fees jsonb, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m beau_ph.merchants%rowtype; cur beau_ph.merchant_methods%rowtype; nxt beau_ph.merchant_methods%rowtype; v jsonb;
begin
  select * into m from beau_ph.merchants where key = p_merchant_key;
  if not found then raise exception 'unknown merchant' using errcode = 'P0002'; end if;
  select * into cur from beau_ph.merchant_methods where merchant_id = m.id and provider_key = p_provider;
  if not found then raise exception 'method not configured' using errcode = 'P0002'; end if;
  v := case when p_fees is null or p_fees = 'null'::jsonb then null else p_fees end;
  if v is not null then
    if not beau_ph.fees_valid(v) then raise exception 'fees: percent 0–20, fixed {CUR: whole minor units ≥ 0}, payer "payer" or "merchant"' using errcode = '22023'; end if;
    v := jsonb_build_object('percent', coalesce((v ->> 'percent')::numeric, 0), 'fixed', coalesce(v -> 'fixed', '{}'::jsonb), 'payer', coalesce(v ->> 'payer', 'merchant'));
  end if;
  update beau_ph.merchant_methods set fees = v, updated_by = p_actor, updated_at = now() where id = cur.id returning * into nxt;
  perform beau_ph.audit_diff(m.id, 'merchant_method', p_provider, p_actor,
                             jsonb_build_object('fees', cur.fees), jsonb_build_object('fees', nxt.fees));
  return beau_ph.merchant_method_json(nxt);
end $$;

-- a method's JSON now says its fees: its own (null = default) and the ones that apply
create or replace function beau_ph.merchant_method_json(mm beau_ph.merchant_methods) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', mm.id, 'provider', mm.provider_key, 'enabled', mm.enabled, 'listed', mm.listed, 'currency', mm.currency,
                            'countries', to_jsonb(mm.countries), 'currencies', to_jsonb(mm.currencies), 'intents', to_jsonb(mm.intents),
                            'capabilities', to_jsonb(mm.capabilities), 'limits', mm.limits, 'instructions', mm.instructions, 'settings', mm.settings,
                            'settlement', (select coalesce(jsonb_object_agg(ms.currency, d.key), '{}'::jsonb)
                                             from beau_ph.method_settlements ms join beau_ph.settlement_destinations d on d.id = ms.destination_id
                                            where ms.merchant_method_id = mm.id),
                            'fees', mm.fees,
                            'fees_effective', beau_ph.fees_effective(mm.fees, (select pv.default_fees from beau_ph.providers pv where pv.key = mm.provider_key)),
                            'updated_by', mm.updated_by, 'updated_at', mm.updated_at, 'created_at', mm.created_at)
$$;

revoke all on function beau_ph.fees_valid(jsonb) from public;
revoke all on function beau_ph.fees_effective(jsonb, jsonb) from public;
revoke all on function beau_ph.method_fee(text, text, integer, text) from public;
revoke all on function beau_ph.merchant_method_set_fees(text, text, jsonb, text) from public;
grant execute on function beau_ph.fees_valid(jsonb) to service_role;
grant execute on function beau_ph.fees_effective(jsonb, jsonb) to service_role;
grant execute on function beau_ph.method_fee(text, text, integer, text) to service_role;
grant execute on function beau_ph.merchant_method_set_fees(text, text, jsonb, text) to service_role;

insert into beau_ph.schema_versions (version) values ('0003_method_fees') on conflict do nothing;
