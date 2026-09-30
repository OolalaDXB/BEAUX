-- BEAU PH — core contract suite. One transaction, always rolls back
-- (ends with RAISE EXCEPTION 'BEAU_PH_CORE_TESTS ok=… fail=…').
--
-- The generic half of the contract, with no host at all: two throw-away
-- merchants and the beau_ph schema only. Eligibility by country and currency;
-- a disabled or not-onboarded provider never acts; the authoritative amount
-- cannot be overridden; a request belongs to one external order; provider
-- events normalise and keep their native evidence; a manual rail never
-- confirms itself; secrets never reach public output; placeholder and
-- unconfigured rails cannot fake a payment; in-person / SoftPOS eligibility;
-- rail configuration bounded by provider capability; BEAU FX (sources,
-- freshness, fail-closed, immutable quotes, isolation); cash as a rail.
--
-- Taken from Coach Gari's supabase/tests/beau_ph_contract.sql (sections 1–13,
-- 16, 22, 23, 25). The host sections (14–15, 17–21, 24, cancellation at the
-- provider) stay there: they test Coach Gari's adapter against this core.
do $$
declare
  ok int := 0; fail int := 0; log text := '';
  mk text := 'ph_contract'; rt jsonb := '{"stripe":{"configured":true,"mode":"test"}}'::jsonb;
  j jsonb; e1 jsonb; e2 jsonb; r1 uuid; r2 uuid; r3 uuid; txt text;
  cA uuid; p1 uuid; p2 uuid; p3 uuid; oref text; oref2 text; ph_ev uuid; ordid uuid; tok text; ev jsonb;
  p4 uuid; oref4 text; rA uuid; rB uuid; jB jsonb; nB int;
  q1 jsonb; q2 jsonb; qid uuid; mid uuid; nA int; p5 uuid; tok5 text; j5 jsonb; rC uuid; v int;
begin
  insert into beau_ph.merchants (key, name, country, default_currency, mode) values (mk, 'Contract Test', 'ZW', 'USD', 'test');
  -- merchant configuration is explicit (countries + currencies persisted); a provider's open coverage is never read as "any"
  perform beau_ph.merchant_method_configure(mk, 'stripe', '{"enabled":true,"countries":["AE","ZW"],"currencies":["AED","USD"]}'::jsonb, 't');
  perform beau_ph.merchant_method_set(mk, 'aani', true, 'AED', '{"display_value":"+971 50 000 0000"}'::jsonb, '{}'::jsonb, null, 't');
  perform beau_ph.merchant_method_configure(mk, 'bank_transfer', '{"enabled":true,"currency":"USD","countries":["AE","ZW"],"currencies":["AED","USD"],"instructions":{"account_holder":"Test Co","iban":"ZW00TEST","bic":"TESTZWHX"}}'::jsonb, 't');
  -- the merchant may "enable" rails that are not onboarded; readiness still wins
  perform beau_ph.merchant_method_set(mk, 'paynow', true, 'USD', '{}'::jsonb, '{}'::jsonb, null, 't');
  perform beau_ph.merchant_method_set(mk, 'mpesa', true, 'KES', '{}'::jsonb, '{}'::jsonb, null, 't');
  perform beau_ph.merchant_method_set(mk, 'ozow', true, 'ZAR', '{}'::jsonb, '{}'::jsonb, null, 't');
  perform beau_ph.merchant_method_set(mk, 'payshap', true, 'ZAR', '{}'::jsonb, '{}'::jsonb, null, 't');
  perform beau_ph.merchant_method_set(mk, 'beau_wallet', true, null, '{}'::jsonb, '{}'::jsonb, null, 't');

  -- a second, unrelated merchant: what one merchant owns, the other must never reach
  insert into beau_ph.merchants (key, name, country, default_currency, mode) values ('ph_other', 'Other Host', 'ZW', 'USD', 'test');

  /* ---- 1. eligibility by country / currency ---- */
  j := beau_ph.eligible_methods(mk, 'AE', 'AED', rt);
  if (select array_agg(e ->> 'provider' order by e ->> 'provider') from jsonb_array_elements(j) e) = array['aani','bank_transfer','stripe'] then ok := ok + 1; else fail := fail + 1; log := log || ' [elig AE/AED ' || j::text || ']'; end if;
  j := beau_ph.eligible_methods(mk, 'ZW', 'USD', rt);
  if (select array_agg(e ->> 'provider' order by e ->> 'provider') from jsonb_array_elements(j) e) = array['bank_transfer','stripe'] then ok := ok + 1; else fail := fail + 1; log := log || ' [elig ZW/USD ' || j::text || ']'; end if;
  j := beau_ph.method_matrix(mk, 'ZW', 'USD', rt);
  if (select e ->> 'reason' from jsonb_array_elements(j) e where e ->> 'provider' = 'aani') = 'country'
     and (select e ->> 'reason' from jsonb_array_elements(j) e where e ->> 'provider' = 'paynow') = 'not_configured'
     and (select e ->> 'reason' from jsonb_array_elements(j) e where e ->> 'provider' = 'beau_wallet') = 'coming_soon' then ok := ok + 1; else fail := fail + 1; log := log || ' [matrix reasons ' || j::text || ']'; end if;

  /* ---- 2. disabled provider omitted; undeployed / wrong-mode online rail omitted ---- */
  perform beau_ph.merchant_method_set(mk, 'bank_transfer', false, 'USD', '{"iban":"ZW00TEST"}'::jsonb, '{}'::jsonb, null, 't');
  j := beau_ph.eligible_methods(mk, 'ZW', 'USD', rt);
  if j::text not like '%bank_transfer%' then ok := ok + 1; else fail := fail + 1; log := log || ' [disabled listed]'; end if;
  perform beau_ph.merchant_method_set(mk, 'bank_transfer', true, 'USD', '{"account_holder":"Test Co","iban":"ZW00TEST","bic":"TESTZWHX"}'::jsonb, '{}'::jsonb, null, 't');
  j := beau_ph.eligible_methods(mk, 'ZW', 'USD', '{}'::jsonb);
  if j::text not like '%"stripe"%' then ok := ok + 1; else fail := fail + 1; log := log || ' [stripe without runtime listed]'; end if;
  j := beau_ph.eligible_methods(mk, 'ZW', 'USD', '{"stripe":{"configured":true,"mode":"live"}}'::jsonb);
  if j::text not like '%"stripe"%' then ok := ok + 1; else fail := fail + 1; log := log || ' [live runtime listed for test merchant]'; end if;

  /* ---- 3. not_configured provider cannot act as active ---- */
  begin perform beau_ph.create_request(mk, 'paynow', 'ORD-P', 'REF-2001', 1000, 'USD', 'ZW', null, '{}'::jsonb, rt); fail := fail + 1; log := log || ' [paynow request created]'; exception when sqlstate 'P0003' then ok := ok + 1; end;

  /* ---- 4. authoritative amount cannot be overridden ---- */
  j := beau_ph.create_request(mk, 'stripe', 'ORD-1', 'REF-2002', 5000, 'USD', 'ZW', null, '{"order_id":"x"}'::jsonb, rt); r1 := (j ->> 'id')::uuid;
  perform beau_ph.attach_attempt(r1, 'cs_c1', 'https://checkout.example/c1', now() + interval '30 min');
  e1 := beau_ph.ingest_stripe_event(jsonb_build_object('id', 'evt_c1', 'type', 'checkout.session.completed', 'livemode', false,
          'data', jsonb_build_object('object', jsonb_build_object('id', 'cs_c1', 'payment_status', 'paid', 'amount_total', 4999, 'currency', 'usd', 'payment_intent', 'pi_c1'))));
  if (e1 ->> 'outcome') = 'rejected:amount_mismatch' and (select status from beau_ph.payment_requests where id = r1) = 'requires_action' then ok := ok + 1; else fail := fail + 1; log := log || ' [amount override ' || e1::text || ']'; end if;
  if exists (select 1 from beau_ph.provider_events where provider_key = 'stripe' and provider_event_id = 'evt_c1' and outcome = 'rejected:amount_mismatch'
              and payload -> 'data' -> 'object' ->> 'amount_total' = '4999') then ok := ok + 1; else fail := fail + 1; log := log || ' [refused evidence lost]'; end if;
  begin perform beau_ph.create_request(mk, 'stripe', 'ORD-1', 'REF-2002', 1, 'USD', 'ZW', null, '{}'::jsonb, rt); fail := fail + 1; log := log || ' [amount changed on live request]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  begin insert into beau_ph.payment_requests (merchant_id, provider_key, external_reference, public_reference, amount, currency)
          values ((select id from beau_ph.merchants where key = mk), 'stripe', 'ORD-U', gen_random_uuid()::text, 100, 'USD');
        fail := fail + 1; log := log || ' [uuid public reference accepted]'; exception when check_violation then ok := ok + 1; end;

  /* ---- 5. request scoped to one external order ---- */
  j := beau_ph.create_request(mk, 'stripe', 'ORD-1', 'REF-2002', 5000, 'USD', 'ZW', null, '{}'::jsonb, rt);
  if (j ->> 'id')::uuid = r1 then ok := ok + 1; else fail := fail + 1; log := log || ' [live request not reused]'; end if;
  e1 := beau_ph.ingest_stripe_event(jsonb_build_object('id', 'evt_c2', 'type', 'checkout.session.completed', 'livemode', false,
          'data', jsonb_build_object('object', jsonb_build_object('id', 'cs_other', 'payment_status', 'paid', 'amount_total', 5000, 'currency', 'usd', 'payment_intent', 'pi_x', 'client_reference_id', 'ORD-NOPE'))));
  if (e1 ->> 'outcome') = 'no_request' and (select status from beau_ph.payment_requests where id = r1) = 'requires_action' then ok := ok + 1; else fail := fail + 1; log := log || ' [cross-order event ' || e1::text || ']'; end if;

  /* ---- 6. provider event → normalized state; 7. native evidence preserved ---- */
  e1 := beau_ph.ingest_stripe_event(jsonb_build_object('id', 'evt_c3', 'type', 'checkout.session.completed', 'livemode', false,
          'data', jsonb_build_object('object', jsonb_build_object('id', 'cs_c1', 'payment_status', 'paid', 'amount_total', 5000, 'currency', 'usd', 'payment_intent', 'pi_c1')),
          '_enrich', jsonb_build_object('charge_id', 'ch_c1', 'balance_transaction_id', 'txn_c1', 'fee_amount', 175)));
  if (e1 ->> 'outcome') = 'normalized' and (e1 ->> 'from') = 'requires_action' and (e1 ->> 'to') = 'paid'
     and (select status from beau_ph.payment_requests where id = r1) = 'paid'
     and (select payment_reference from beau_ph.payment_requests where id = r1) = 'pi_c1' then ok := ok + 1; else fail := fail + 1; log := log || ' [normalize ' || e1::text || ']'; end if;
  if exists (select 1 from beau_ph.payment_events where id = (e1 ->> 'payment_event_id')::uuid and provider_status = 'paid' and provider_reference = 'pi_c1'
              and (evidence ->> 'fee_amount')::int = 175 and evidence ->> 'charge_id' = 'ch_c1' and actor = 'provider')
     and exists (select 1 from beau_ph.provider_events where provider_key = 'stripe' and provider_event_id = 'evt_c3' and payload ->> 'type' = 'checkout.session.completed' and outcome = 'normalized')
     then ok := ok + 1; else fail := fail + 1; log := log || ' [evidence]'; end if;
  e2 := beau_ph.ingest_stripe_event(jsonb_build_object('id', 'evt_c3b', 'type', 'checkout.session.completed', 'livemode', false,
          'data', jsonb_build_object('object', jsonb_build_object('id', 'cs_c1', 'payment_status', 'paid', 'amount_total', 5000, 'currency', 'usd', 'payment_intent', 'pi_c1'))));
  if (e2 ->> 'outcome') = 'ignored:already_paid' and (select count(*) from beau_ph.payment_events where request_id = r1 and to_status = 'paid') = 1 then ok := ok + 1; else fail := fail + 1; log := log || ' [already paid ' || e2::text || ']'; end if;
  e2 := beau_ph.ingest_stripe_event(jsonb_build_object('id', 'evt_c4', 'type', 'checkout.session.expired', 'livemode', false, 'data', jsonb_build_object('object', jsonb_build_object('id', 'cs_c1'))));
  if (e2 ->> 'outcome') like 'rejected:illegal_transition%' and (select status from beau_ph.payment_requests where id = r1) = 'paid' then ok := ok + 1; else fail := fail + 1; log := log || ' [paid→expired ' || e2::text || ']'; end if;
  e2 := beau_ph.ingest_stripe_event(jsonb_build_object('id', 'evt_c5', 'type', 'refund.created', 'livemode', false,
          'data', jsonb_build_object('object', jsonb_build_object('id', 're_c1', 'amount', 1000, 'currency', 'usd', 'status', 'succeeded', 'payment_intent', 'pi_c1'))));
  if (e2 ->> 'outcome') = 'evidence' and (select status from beau_ph.payment_requests where id = r1) = 'paid' then ok := ok + 1; else fail := fail + 1; log := log || ' [partial refund ' || e2::text || ']'; end if;
  e2 := beau_ph.ingest_stripe_event(jsonb_build_object('id', 'evt_c6', 'type', 'refund.created', 'livemode', false,
          'data', jsonb_build_object('object', jsonb_build_object('id', 're_c2', 'amount', 5000, 'currency', 'usd', 'status', 'succeeded', 'payment_intent', 'pi_c1'))));
  if (e2 ->> 'to') = 'refunded' and (select status from beau_ph.payment_requests where id = r1) = 'refunded' then ok := ok + 1; else fail := fail + 1; log := log || ' [full refund ' || e2::text || ']'; end if;
  -- a live-mode event can never touch a test merchant
  e2 := beau_ph.ingest_stripe_event(jsonb_build_object('id', 'evt_c7', 'type', 'checkout.session.completed', 'livemode', true,
          'data', jsonb_build_object('object', jsonb_build_object('id', 'cs_c1', 'payment_status', 'paid', 'amount_total', 5000, 'currency', 'usd', 'payment_intent', 'pi_c1'))));
  if (e2 ->> 'outcome') = 'rejected:mode_mismatch' then ok := ok + 1; else fail := fail + 1; log := log || ' [livemode accepted ' || e2::text || ']'; end if;

  /* ---- 8. manual provider never self-confirms ---- */
  j := beau_ph.create_request(mk, 'bank_transfer', 'ORD-2', 'REF-2003', 7000, 'USD', 'ZW'); r2 := (j ->> 'id')::uuid;
  if (j ->> 'status') = 'pending' and (j -> 'instructions' ->> 'iban') = 'ZW00TEST' and (j -> 'instructions' ->> 'reference') = 'REF-2003' then ok := ok + 1; else fail := fail + 1; log := log || ' [manual request ' || j::text || ']'; end if;
  e1 := beau_ph.ingest_provider_event('bank_transfer', 'fake-bank-1', 'bank.credit', '{"claimed":"paid"}'::jsonb, jsonb_build_object('request_id', r2, 'status', 'paid', 'amount', 7000, 'currency', 'USD'));
  if (e1 ->> 'outcome') = 'rejected:manual_provider_requires_operator' and (select status from beau_ph.payment_requests where id = r2) = 'pending' then ok := ok + 1; else fail := fail + 1; log := log || ' [manual self-confirm ' || e1::text || ']'; end if;
  begin perform beau_ph.confirm_manual(r2, null, 7000, 'USD'); fail := fail + 1; log := log || ' [anonymous confirm]'; exception when insufficient_privilege then ok := ok + 1; end;
  begin perform beau_ph.confirm_manual(r2, 'op@test', 6000, 'USD'); fail := fail + 1; log := log || ' [confirm wrong amount]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  e1 := beau_ph.confirm_manual(r2, 'op@test', 7000, 'USD', 'bank-ref-77', now() - interval '1 day', 'statement line 12');
  if (e1 ->> 'to') = 'paid' and exists (select 1 from beau_ph.payment_events where id = (e1 ->> 'payment_event_id')::uuid and actor = 'operator' and actor_id = 'op@test'
                                          and provider_reference = 'bank-ref-77' and amount = 7000 and currency = 'USD')
     and exists (select 1 from beau_ph.provider_events where request_id = r2 and event_type = 'operator.confirmed' and payload ->> 'operator' = 'op@test')
     then ok := ok + 1; else fail := fail + 1; log := log || ' [operator confirm ' || e1::text || ']'; end if;
  begin perform beau_ph.confirm_manual(r2, 'op@test', 7000, 'USD'); fail := fail + 1; log := log || ' [confirmed twice]'; exception when sqlstate 'P0003' then ok := ok + 1; end;

  /* ---- 9. provider secrets never appear in public output ---- */
  begin perform beau_ph.merchant_method_set(mk, 'stripe', true, null, '{"webhook_secret":"whsec_abcdefghijklmnop"}'::jsonb, '{}'::jsonb, null, 't'); fail := fail + 1; log := log || ' [secret accepted in instructions]'; exception when check_violation or sqlstate '22023' then ok := ok + 1; end;
  begin perform beau_ph.merchant_method_set(mk, 'stripe', true, null, '{}'::jsonb, '{"api_key":"sk_test_abcdefghijklmnop"}'::jsonb, null, 't'); fail := fail + 1; log := log || ' [secret accepted in settings]'; exception when check_violation or sqlstate '22023' then ok := ok + 1; end;
  txt := beau_ph.eligible_methods(mk, 'AE', 'AED', rt)::text || beau_ph.method_matrix(mk, 'AE', 'AED', rt)::text || beau_ph.get_request(r1)::text || beau_ph.request_events(r1)::text;
  if txt !~ '(sk|rk)_(live|test)_|whsec_' and txt !~* '"(secret|api_?key|private_?key|password)"' then ok := ok + 1; else fail := fail + 1; log := log || ' [secret in output]'; end if;

  /* ---- 10. BEAU Wallet placeholder cannot mark paid ---- */
  begin perform beau_ph.create_request(mk, 'beau_wallet', 'ORD-W', 'REF-2004', 100, 'USD', 'ZW'); fail := fail + 1; log := log || ' [wallet request]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  e1 := beau_ph.ingest_provider_event('beau_wallet', 'tx-0xabc', 'wallet.transfer', '{"tx":"0xabc"}'::jsonb, jsonb_build_object('external_reference', 'ORD-2', 'merchant', mk, 'status', 'paid', 'amount', 7000, 'currency', 'USD'));
  -- refused either as "cannot confirm" (confirmation = unavailable) or as placeholder — never normalized
  if (e1 ->> 'outcome') in ('rejected:provider_cannot_confirm', 'rejected:provider_placeholder')
     and (select status from beau_ph.payment_requests where id = r2) = 'paid'   -- untouched by the wallet claim
     then ok := ok + 1; else fail := fail + 1; log := log || ' [wallet event ' || e1::text || ']'; end if;

  /* ---- 11–13. unconfigured Paynow / M-PESA / Ozow / PayShap cannot fake a payment ---- */
  j := beau_ph.create_request(mk, 'stripe', 'ORD-3', 'REF-2005', 2500, 'USD', 'ZW', null, '{}'::jsonb, rt); r3 := (j ->> 'id')::uuid;
  e1 := beau_ph.ingest_provider_event('paynow', 'pn-1', 'paynow.paid', '{"status":"Paid"}'::jsonb, jsonb_build_object('external_reference', 'ORD-3', 'merchant', mk, 'status', 'paid', 'amount', 2500, 'currency', 'USD'));
  if (e1 ->> 'outcome') = 'rejected:provider_not_configured' and (select status from beau_ph.payment_requests where id = r3) = 'created' then ok := ok + 1; else fail := fail + 1; log := log || ' [paynow fake ' || e1::text || ']'; end if;
  e1 := beau_ph.ingest_provider_event('mpesa', 'mp-1', 'stkCallback', '{"ResultCode":0}'::jsonb, jsonb_build_object('external_reference', 'ORD-3', 'merchant', mk, 'status', 'paid', 'amount', 2500, 'currency', 'USD'));
  if (e1 ->> 'outcome') = 'rejected:provider_not_configured' then ok := ok + 1; else fail := fail + 1; log := log || ' [mpesa fake ' || e1::text || ']'; end if;
  e1 := beau_ph.ingest_provider_event('ozow', 'oz-1', 'notify', '{"Status":"Complete"}'::jsonb, jsonb_build_object('external_reference', 'ORD-3', 'merchant', mk, 'status', 'paid', 'amount', 2500, 'currency', 'USD'));
  e2 := beau_ph.ingest_provider_event('payshap', 'ps-1', 'rpp.settled', '{}'::jsonb, jsonb_build_object('external_reference', 'ORD-3', 'merchant', mk, 'status', 'paid', 'amount', 2500, 'currency', 'USD'));
  if (e1 ->> 'outcome') = 'rejected:provider_not_configured' and (e2 ->> 'outcome') = 'rejected:provider_not_configured'
     and (select status from beau_ph.payment_requests where id = r3) = 'created' then ok := ok + 1; else fail := fail + 1; log := log || ' [ozow/payshap fake]'; end if;
  if (select count(*) from beau_ph.provider_events where provider_key in ('paynow','mpesa','ozow','payshap','beau_wallet') and outcome like 'rejected:provider_%') = 5 then ok := ok + 1; else fail := fail + 1; log := log || ' [unconfigured evidence]'; end if;

  /* ---- 16. in-person / SoftPOS: capability model, platform + initiator eligibility, handoff attestation ---- */
  -- the capability vocabulary and the reserved in-person keys exist on the UAE PSP boundaries
  if (select count(*) from beau_ph.provider_capabilities where capability in ('softpos','card_present','tap_to_pay') and provider_key in ('network_international','magnati','adyen')) = 9
     and beau_ph.is_capability('softpos') and beau_ph.is_capability('tap_to_pay') and beau_ph.is_capability('card_present') and not beau_ph.is_capability('nfc_raw')
     then ok := ok + 1; else fail := fail + 1; log := log || ' [capability vocabulary]'; end if;
  -- an AED merchant enables the Magnati handoff (app name only — never a credential)
  insert into beau_ph.merchants (key, name, country, default_currency, mode) values ('ph_uae', 'UAE Test', 'AE', 'AED', 'test');
  perform beau_ph.merchant_method_set('ph_uae', 'stripe', true, null, '{}'::jsonb, '{}'::jsonb, null, 't');
  perform beau_ph.merchant_method_set('ph_uae', 'magnati', true, 'AED', '{}'::jsonb, '{"handoff_app":"SwipeX","handoff_url":"swipex://"}'::jsonb, null, 't');
  -- a customer-facing page never sees an in-person capability (initiator), even though the merchant enabled it
  j := beau_ph.eligible_methods('ph_uae', 'AE', 'AED', rt);
  if j::text not like '%magnati%' then ok := ok + 1; else fail := fail + 1; log := log || ' [customer sees softpos]'; end if;
  -- merchant-initiated: the handoff is offered (any platform — the tap happens in the PSP app), native tap_to_pay is not (placeholder)
  j := beau_ph.eligible_capabilities('ph_uae', null, 'AED', rt, 'ios_pwa', 'merchant');
  if (select count(*) from jsonb_array_elements(j) e where e ->> 'provider' = 'magnati' and e ->> 'capability' = 'softpos' and (e ->> 'handoff')::boolean and e -> 'settings' ->> 'handoff_app' = 'SwipeX') = 1
     and j::text not like '%tap_to_pay%' and j::text not like '%network_international%' then ok := ok + 1; else fail := fail + 1; log := log || ' [merchant capabilities ' || j::text || ']'; end if;
  j := beau_ph.method_matrix('ph_uae', null, 'AED', rt, 'ios_pwa', 'merchant');
  if (select c ->> 'reason' from jsonb_array_elements(j) e, jsonb_array_elements(e -> 'capabilities') c where e ->> 'provider' = 'magnati' and c ->> 'capability' = 'tap_to_pay') = 'coming_soon'
     and (select c ->> 'reason' from jsonb_array_elements(j) e, jsonb_array_elements(e -> 'capabilities') c where e ->> 'provider' = 'network_international' and c ->> 'capability' = 'softpos') = 'disabled'
     then ok := ok + 1; else fail := fail + 1; log := log || ' [capability reasons]'; end if;
  begin perform beau_ph.create_request('ph_uae', 'magnati', 'ORD-T1', 'REF-3000', 85000, 'AED', 'AE', null, '{}'::jsonb, rt, 'tap_to_pay', 'ios_app', 'merchant');
        fail := fail + 1; log := log || ' [tap_to_pay request created]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  -- the PLATFORM gate is real: make tap_to_pay hypothetically live (rolled back) — it is offered on ios_app only, never from a browser/PWA
  update beau_ph.provider_capabilities set readiness = 'available' where provider_key = 'magnati' and capability = 'tap_to_pay';
  update beau_ph.providers set readiness = 'available' where key = 'magnati';
  if beau_ph.eligible_capabilities('ph_uae', null, 'AED', '{"magnati":{"configured":true,"mode":"test"}}'::jsonb, 'web', 'merchant')::text not like '%tap_to_pay%'
     and beau_ph.eligible_capabilities('ph_uae', null, 'AED', '{"magnati":{"configured":true,"mode":"test"}}'::jsonb, 'ios_pwa', 'merchant')::text not like '%tap_to_pay%'
     and beau_ph.eligible_capabilities('ph_uae', null, 'AED', '{"magnati":{"configured":true,"mode":"test"}}'::jsonb, 'ios_app', 'merchant')::text like '%tap_to_pay%'
     and beau_ph.eligible_capabilities('ph_uae', null, 'AED', '{}'::jsonb, 'ios_app', 'merchant')::text not like '%tap_to_pay%'   -- and still needs deployed PSP credentials
     then ok := ok + 1; else fail := fail + 1; log := log || ' [platform gate]'; end if;
  update beau_ph.provider_capabilities set readiness = 'placeholder' where provider_key = 'magnati' and capability = 'tap_to_pay';
  update beau_ph.providers set readiness = 'not_configured' where key = 'magnati';
  -- handoff request: in-person, merchant-initiated, instructions carry the app + reference + amount
  j := beau_ph.create_request('ph_uae', 'magnati', 'ORD-T1', 'REF-3000', 85000, 'AED', 'AE', null, '{}'::jsonb, rt, 'softpos', 'ios_pwa', 'merchant'); r3 := (j ->> 'id')::uuid;
  if (j ->> 'status') = 'pending' and (j ->> 'channel') = 'in_person' and (j ->> 'initiated_by') = 'merchant' and (j ->> 'capability') = 'softpos' and (j ->> 'platform') = 'ios_pwa'
     and (j -> 'instructions' ->> 'handoff_app') = 'SwipeX' and (j -> 'instructions' ->> 'reference') = 'REF-3000' and (j -> 'instructions' ->> 'amount') = '85000'
     then ok := ok + 1; else fail := fail + 1; log := log || ' [handoff request ' || j::text || ']'; end if;
  -- no verified API path exists: a "provider event" for the PSP is refused as evidence, the request stays pending
  e1 := beau_ph.ingest_provider_event('magnati', 'swipex-1', 'swipex.approved', '{"claimed":"approved"}'::jsonb, jsonb_build_object('request_id', r3, 'status', 'paid', 'amount', 85000, 'currency', 'AED'));
  if (e1 ->> 'outcome') = 'rejected:provider_not_configured' and (select status from beau_ph.payment_requests where id = r3) = 'pending' then ok := ok + 1; else fail := fail + 1; log := log || ' [psp event ' || e1::text || ']'; end if;
  -- the operator must attest the app's receipt reference; then the evidence says so
  begin perform beau_ph.confirm_manual(r3, 'op@test', 85000, 'AED', null); fail := fail + 1; log := log || ' [handoff confirmed without receipt]'; exception when sqlstate '22023' then ok := ok + 1; end;
  e1 := beau_ph.confirm_manual(r3, 'op@test', 85000, 'AED', 'RRN-123456');
  if (e1 ->> 'to') = 'paid' and (e1 ->> 'capability') = 'softpos'
     and exists (select 1 from beau_ph.payment_events where id = (e1 ->> 'payment_event_id')::uuid and actor = 'operator' and provider_reference = 'RRN-123456'
                   and evidence ->> 'verification' = 'operator_attested_provider_receipt' and evidence ->> 'capability' = 'softpos')
     then ok := ok + 1; else fail := fail + 1; log := log || ' [handoff attested ' || e1::text || ']'; end if;

  /* ---- 22. RAIL CONFIGURATION: persisted, bounded by provider capability, explicit or not eligible ---- */
  j := beau_ph.merchant_method_configure(mk, 'stripe', '{"countries":["AE","ZW","KE"],"currencies":["AED","USD","KES"]}'::jsonb, 'cfg@test');
  if (j -> 'countries')::text = '["AE", "KE", "ZW"]' and (j -> 'currencies')::text = '["AED", "KES", "USD"]'
     and (beau_ph.merchant_method_get(mk, 'stripe') -> 'method' -> 'currencies')::text = '["AED", "KES", "USD"]' then ok := ok + 1; else fail := fail + 1; log := log || ' [cfg: countries/currencies persist ' || j::text || ']'; end if;
  -- a merchant can never broaden a provider (Aani = AE / AED only)
  begin perform beau_ph.merchant_method_configure(mk, 'aani', '{"countries":["AE","ZW"]}'::jsonb, 't'); fail := fail + 1; log := log || ' [cfg: broadened countries]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  begin perform beau_ph.merchant_method_configure(mk, 'aani', '{"currencies":["USD"]}'::jsonb, 't'); fail := fail + 1; log := log || ' [cfg: broadened currencies]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  begin perform beau_ph.merchant_method_configure(mk, 'aani', '{"capabilities":["online_checkout"]}'::jsonb, 't'); fail := fail + 1; log := log || ' [cfg: capability not offered]'; exception when sqlstate '22023' then ok := ok + 1; end;
  -- unsupported country / currency → ineligible with the reason; a disabled rail → ineligible
  if (select e ->> 'reason' from jsonb_array_elements(beau_ph.method_matrix(mk, 'FR', 'USD', rt)) e where e ->> 'provider' = 'stripe') = 'country'
     and (select e ->> 'reason' from jsonb_array_elements(beau_ph.method_matrix(mk, 'AE', 'GBP', rt)) e where e ->> 'provider' = 'stripe') = 'currency'
     and beau_ph.eligible_methods(mk, 'KE', 'KES', rt)::text like '%"stripe"%' then ok := ok + 1; else fail := fail + 1; log := log || ' [cfg: country/currency reasons]'; end if;
  perform beau_ph.merchant_method_configure(mk, 'stripe', '{"enabled":false}'::jsonb, 't');
  if beau_ph.eligible_methods(mk, 'AE', 'AED', rt)::text not like '%"stripe"%'
     and (select e ->> 'reason' from jsonb_array_elements(beau_ph.method_matrix(mk, 'AE', 'AED', rt)) e where e ->> 'provider' = 'stripe') = 'disabled' then ok := ok + 1; else fail := fail + 1; log := log || ' [cfg: disabled rail eligible]'; end if;
  perform beau_ph.merchant_method_configure(mk, 'stripe', '{"enabled":true}'::jsonb, 't');
  -- no countries = needs configuration, never "everywhere"
  perform beau_ph.merchant_method_configure(mk, 'stripe', '{"countries":null}'::jsonb, 't');
  if (select e ->> 'reason' from jsonb_array_elements(beau_ph.method_matrix(mk, 'AE', 'AED', rt)) e where e ->> 'provider' = 'stripe') = 'needs_configuration'
     and (select e ->> 'health' from jsonb_array_elements(beau_ph.method_matrix(mk, 'AE', 'AED', rt)) e where e ->> 'provider' = 'stripe') = 'needs_configuration'
     and beau_ph.eligible_methods(mk, 'AE', 'AED', rt)::text not like '%"stripe"%' then ok := ok + 1; else fail := fail + 1; log := log || ' [cfg: null countries read as any]'; end if;
  perform beau_ph.merchant_method_configure(mk, 'stripe', '{"countries":["AE","ZW","KE"]}'::jsonb, 't');
  -- intents: a rail may support or block a payment type
  perform beau_ph.merchant_method_configure(mk, 'stripe', '{"intents":["service","package"]}'::jsonb, 't');
  if (select e ->> 'reason' from jsonb_array_elements(beau_ph.method_matrix(mk, 'AE', 'AED', rt, null, 'customer', 'support')) e where e ->> 'provider' = 'stripe') = 'intent'
     and beau_ph.eligible_methods(mk, 'AE', 'AED', rt, null, 'customer', 'package')::text like '%"stripe"%' then ok := ok + 1; else fail := fail + 1; log := log || ' [cfg: intent dimension]'; end if;
  begin perform beau_ph.create_request(mk, 'stripe', 'ORD-INT', 'REF-INT', 1000, 'USD', 'ZW', null, '{}'::jsonb, rt, null, null, null, 'support'); fail := fail + 1; log := log || ' [cfg: blocked intent request]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  perform beau_ph.merchant_method_configure(mk, 'stripe', '{"intents":null}'::jsonb, 't');
  -- limits per currency
  perform beau_ph.merchant_method_configure(mk, 'stripe', '{"limits":{"USD":{"min":1000,"max":500000}}}'::jsonb, 't');
  begin perform beau_ph.create_request(mk, 'stripe', 'ORD-LIM', 'REF-LIM', 500, 'USD', 'ZW', null, '{}'::jsonb, rt); fail := fail + 1; log := log || ' [cfg: below minimum]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  begin perform beau_ph.create_request(mk, 'stripe', 'ORD-LIM', 'REF-LIM', 900000, 'USD', 'ZW', null, '{}'::jsonb, rt); fail := fail + 1; log := log || ' [cfg: above maximum]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  perform beau_ph.merchant_method_configure(mk, 'stripe', '{"limits":{}}'::jsonb, 't');
  -- "Remove" keeps history: a rail with requests is deactivated + unlisted, its requests untouched; an unused one is deleted
  select count(*) into nA from beau_ph.payment_requests r join beau_ph.merchants m on m.id = r.merchant_id where m.key = mk and r.provider_key = 'stripe';
  j := beau_ph.merchant_method_remove(mk, 'stripe', 'rm@test');
  if j ->> 'removed' = 'unlisted' and (j ->> 'history')::int = nA and nA > 0
     and (select count(*) from beau_ph.payment_requests r join beau_ph.merchants m on m.id = r.merchant_id where m.key = mk and r.provider_key = 'stripe') = nA
     and exists (select 1 from beau_ph.merchant_methods mm join beau_ph.merchants m on m.id = mm.merchant_id where m.key = mk and mm.provider_key = 'stripe' and not mm.enabled and not mm.listed)
     and beau_ph.merchant_methods_summary(mk)::text not like '%"stripe"%' and beau_ph.eligible_methods(mk, 'AE', 'AED', rt)::text not like '%"stripe"%'
     then ok := ok + 1; else fail := fail + 1; log := log || ' [cfg: remove with history ' || j::text || ']'; end if;
  perform beau_ph.merchant_method_configure(mk, 'stripe', '{"enabled":true,"listed":true}'::jsonb, 't');
  j := beau_ph.merchant_method_remove(mk, 'ozow', 'rm@test');
  if j ->> 'removed' = 'deleted' and not exists (select 1 from beau_ph.merchant_methods mm join beau_ph.merchants m on m.id = mm.merchant_id where m.key = mk and mm.provider_key = 'ozow') then ok := ok + 1; else fail := fail + 1; log := log || ' [cfg: delete unused]'; end if;
  -- settlement destinations are distinct from methods; a rail maps a currency to one destination of that currency
  j := beau_ph.settlement_destination_set(mk, '{"key":"usd_main","label":"USD account","kind":"bank_account","currency":"USD","details":{"bank":"Test Bank","account_hint":"•••• 1234"}}'::jsonb, 'dest@test');
  perform beau_ph.merchant_method_configure(mk, 'bank_transfer', '{"settlement":{"USD":"usd_main"}}'::jsonb, 't');
  if (beau_ph.merchant_method_get(mk, 'bank_transfer') -> 'method' -> 'settlement' ->> 'USD') = 'usd_main'
     and (beau_ph.settlement_destinations_list(mk) -> 0 -> 'used_by')::text like '%bank_transfer%' then ok := ok + 1; else fail := fail + 1; log := log || ' [cfg: settlement mapping]'; end if;
  begin perform beau_ph.merchant_method_configure(mk, 'bank_transfer', '{"settlement":{"AED":"usd_main"}}'::jsonb, 't'); fail := fail + 1; log := log || ' [cfg: settlement currency mismatch]'; exception when sqlstate '22023' then ok := ok + 1; end;
  j := beau_ph.settlement_destination_remove(mk, 'usd_main', 't');
  if j ->> 'removed' = 'deactivated' and exists (select 1 from beau_ph.settlement_destinations d join beau_ph.merchants m on m.id = d.merchant_id where m.key = mk and d.key = 'usd_main' and not d.active) then ok := ok + 1; else fail := fail + 1; log := log || ' [cfg: mapped destination deleted]'; end if;
  begin perform beau_ph.settlement_destination_set(mk, '{"key":"bad","label":"x","currency":"USD","details":{"api_key":"sk_test_abcdefghijklmnop"}}'::jsonb, 't'); fail := fail + 1; log := log || ' [cfg: secret in destination]'; exception when sqlstate '22023' then ok := ok + 1; end;
  -- audit: field-level rows with actor, before and after; nothing secret-shaped in the audit output
  j := beau_ph.config_audit_list(mk, 200);
  if exists (select 1 from jsonb_array_elements(j) a where a ->> 'area' = 'merchant_method' and a ->> 'entity' = 'stripe' and a ->> 'field' = 'currencies' and a ->> 'actor' = 'cfg@test' and (a -> 'new_value')::text like '%KES%')
     and exists (select 1 from jsonb_array_elements(j) a where a ->> 'field' = 'enabled' and a ->> 'actor' = 'rm@test')
     and exists (select 1 from jsonb_array_elements(j) a where a ->> 'area' = 'settlement_destination' and a ->> 'entity' = 'usd_main')
     and beau_ph.no_secret_keys(j) and beau_ph.no_secret_keys(beau_ph.rails_overview(mk)) and beau_ph.no_secret_keys(beau_ph.merchant_method_get(mk, 'stripe'))
     then ok := ok + 1; else fail := fail + 1; log := log || ' [cfg: audit trail]'; end if;
  -- the rails overview derives everything from persisted state (no literal "any")
  j := beau_ph.rails_overview(mk);
  if jsonb_array_length(j -> 'rails') >= 11
     and (select r -> 'merchant' ->> 'health' from jsonb_array_elements(j -> 'rails') r where r ->> 'provider' = 'stripe') = 'configured'
     and (select r -> 'merchant' -> 'currencies' from jsonb_array_elements(j -> 'rails') r where r ->> 'provider' = 'stripe')::text like '%KES%'
     and (select r -> 'merchant' from jsonb_array_elements(j -> 'rails') r where r ->> 'provider' = 'ozow') = 'null'::jsonb
     and (select jsonb_array_length(r -> 'secrets') from jsonb_array_elements(j -> 'rails') r where r ->> 'provider' = 'stripe') = 3
     and j::text not like '%"countries": "any"%' and j::text not like '%"currencies": "any"%' then ok := ok + 1; else fail := fail + 1; log := log || ' [cfg: rails overview]'; end if;

  /* ---- 23. BEAU FX: source recorded, freshness, fail closed, immutable expiring quotes, server-side amounts, isolation ---- */
  select id into mid from beau_ph.merchants where key = mk;
  delete from beau_ph.fx_quotes where merchant_id = mid;   -- suite hygiene inside the rolled-back transaction
  j := beau_ph.fx_ingest_rate('USD', 1.10, current_date, 'test_src');
  perform beau_ph.fx_ingest_rate('AED', 1.10 * 3.6725, current_date, 'test_src(USD)');
  perform beau_ph.fx_ingest_rate('GBP', 0.85, current_date, 'test_src');
  if (j ->> 'accepted')::boolean and (select source from beau_ph.fx_rate_on('USD', current_date)) = 'test_src'
     and (beau_ph.fx_currency_status('USD') ->> 'freshness') = 'fresh' and (beau_ph.fx_currency_status('USD') ->> 'source') = 'frankfurter' then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: source + fresh ' || beau_ph.fx_currency_status('USD')::text || ']'; end if;
  -- anomaly rejection keeps the last valid rate
  j := beau_ph.fx_ingest_rate('USD', 1.60, current_date, 'test_src');
  if not (j ->> 'accepted')::boolean and (j ->> 'reason') like 'variation_%' and (select rate from beau_ph.fx_rate_on('USD', current_date)) = 1.10
     and beau_ph.fx_validate_rate(-1, null) = 'non_positive' and beau_ph.fx_validate_rate(null, 1) = 'not_numeric' and beau_ph.fx_validate_rate(1.15, 1.10) is null then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: anomaly ' || j::text || ']'; end if;
  -- freshness categories from the last successful fetch
  update beau_ph.fx_rates set fetched_at = now() - interval '50 hours' where quote_currency = 'GBP';
  if (beau_ph.fx_currency_status('GBP') ->> 'freshness') = 'acceptable' and beau_ph.fx_freshness(80) = 'stale' and beau_ph.fx_freshness(null) = 'missing' and beau_ph.fx_freshness(36) = 'fresh' then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: freshness]'; end if;
  -- FX off for the merchant → no conversion at all
  begin perform beau_ph.fx_quote(mk, 10000, 'USD', 'AED', true); fail := fail + 1; log := log || ' [fx: disabled merchant quoted]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  perform beau_ph.merchant_fx_set(mk, '{"enabled":true,"adjustment_bps":0,"quote_ttl_minutes":15}'::jsonb, 'fx@test');
  -- the amount is derived server-side through the EUR pivot: USD 100.00 → AED 367.25
  j := beau_ph.fx_quote(mk, 10000, 'USD', 'AED', true);
  if (j ->> 'payment_amount')::int = 36725 and (j ->> 'preview')::boolean and round((j ->> 'reference_rate')::numeric, 4) = 3.6725 and j ->> 'freshness' = 'fresh' then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: preview ' || j::text || ']'; end if;
  if (beau_ph.fx_quote(mk, 10000, 'USD', 'USD', true) ->> 'same_currency')::boolean then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: same currency]'; end if;
  -- a merchant adjustment is a separate component, never hidden in the reference rate
  perform beau_ph.merchant_fx_set(mk, '{"adjustment_bps":100}'::jsonb, 'fx@test');
  j := beau_ph.fx_quote(mk, 10000, 'USD', 'AED', true);
  if (j ->> 'payment_amount')::int = 37092 and round((j ->> 'reference_rate')::numeric, 4) = 3.6725 and round((j ->> 'customer_rate')::numeric, 4) = 3.7092 and (j ->> 'merchant_adjustment_bps')::int = 100 then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: adjustment ' || j::text || ']'; end if;
  perform beau_ph.merchant_fx_set(mk, '{"adjustment_bps":0}'::jsonb, 'fx@test');
  -- stale or missing rate: fail closed
  update beau_ph.fx_rates set fetched_at = now() - interval '80 hours' where quote_currency = 'AED';
  begin perform beau_ph.fx_quote(mk, 10000, 'USD', 'AED', true); fail := fail + 1; log := log || ' [fx: stale converted]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  update beau_ph.fx_rates set fetched_at = now() where quote_currency = 'AED';
  begin perform beau_ph.fx_quote(mk, 10000, 'USD', 'KES', true); fail := fail + 1; log := log || ' [fx: missing converted]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  perform beau_ph.fx_currency_set('CHF', '{"enabled":true}'::jsonb, 'fx@test');
  begin perform beau_ph.fx_quote(mk, 10000, 'USD', 'CHF', true); fail := fail + 1; log := log || ' [fx: no rate converted]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  -- a real quote is an immutable row with an expiry
  q1 := beau_ph.fx_quote(mk, 10000, 'USD', 'AED', false); qid := (q1 ->> 'id')::uuid;
  if q1 ->> 'status' = 'active' and (q1 ->> 'expires_at')::timestamptz between now() + interval '14 minutes' and now() + interval '16 minutes' and (q1 ->> 'payment_amount')::int = 36725 then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: quote row ' || q1::text || ']'; end if;
  begin update beau_ph.fx_quotes set payment_amount = 1 where id = qid; fail := fail + 1; log := log || ' [fx: quote amount mutated]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  begin update beau_ph.fx_quotes set expires_at = now() + interval '1 day' where id = qid; fail := fail + 1; log := log || ' [fx: quote expiry mutated]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  begin delete from beau_ph.fx_quotes where id = qid; fail := fail + 1; log := log || ' [fx: quote deleted]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  -- the browser cannot override the rate or the amount: the request must match the quote exactly, and another currency needs a quote
  begin perform beau_ph.create_request(mk, 'stripe', 'ORD-FX', 'REF-FX', 36726, 'AED', 'AE', null, '{}'::jsonb, rt, null, null, null, 'package', 10000, 'USD', qid); fail := fail + 1; log := log || ' [fx: amount override]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  begin perform beau_ph.create_request(mk, 'stripe', 'ORD-FX', 'REF-FX', 36725, 'AED', 'AE', null, '{}'::jsonb, rt, null, null, null, 'package', 10000, 'USD', null); fail := fail + 1; log := log || ' [fx: conversion without quote]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  j := beau_ph.create_request(mk, 'stripe', 'ORD-FX', 'REF-FX', 36725, 'AED', 'AE', null, '{}'::jsonb, rt, null, null, null, 'package', 10000, 'USD', qid);
  if j ->> 'currency' = 'AED' and (j ->> 'amount')::int = 36725 and j ->> 'pricing_currency' = 'USD' and (j ->> 'pricing_amount')::int = 10000 and (j ->> 'fx_quote_id')::uuid = qid and j ->> 'intent' = 'package'
     and (select status from beau_ph.fx_quotes where id = qid) = 'consumed' and (select request_id from beau_ph.fx_quotes where id = qid) = (j ->> 'id')::uuid then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: request carries the quote ' || j::text || ']'; end if;
  -- a quote is consumed exactly once; an expired quote must be replaced by a new one
  begin perform beau_ph.fx_quote_consume(qid, mid, gen_random_uuid(), 36725, 'AED', 10000, 'USD'); fail := fail + 1; log := log || ' [fx: quote consumed twice]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  q2 := beau_ph.fx_quote(mk, 10000, 'USD', 'AED', false);
  update beau_ph.fx_quotes set status = 'expired' where id = (q2 ->> 'id')::uuid;
  begin perform beau_ph.fx_quote_consume((q2 ->> 'id')::uuid, mid, gen_random_uuid(), 36725, 'AED', 10000, 'USD'); fail := fail + 1; log := log || ' [fx: expired quote consumed]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  q2 := beau_ph.fx_quote(mk, 10000, 'USD', 'AED', false);
  if (q2 ->> 'id')::uuid <> qid and q2 ->> 'status' = 'active' then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: replacement quote]'; end if;
  -- merchant isolation: another merchant cannot consume this merchant's quote
  begin perform beau_ph.fx_quote_consume((q2 ->> 'id')::uuid, (select id from beau_ph.merchants where key = 'ph_other'), gen_random_uuid(), 36725, 'AED', 10000, 'USD'); fail := fail + 1; log := log || ' [fx: foreign merchant consumed]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  -- settings and currency configuration are audited
  j := beau_ph.config_audit_list(mk, 200);
  if exists (select 1 from jsonb_array_elements(j) a where a ->> 'area' = 'merchant_fx' and a ->> 'field' = 'enabled' and a ->> 'actor' = 'fx@test')
     and exists (select 1 from jsonb_array_elements(j) a where a ->> 'area' = 'fx_currency' and a ->> 'entity' = 'CHF' and a ->> 'field' = 'enabled') then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: audit]'; end if;
  -- a refresh is observable: the run row exists and waits for the collector (no response inside this transaction)
  perform beau_ph.fx_refresh_start('fx@test');
  perform beau_ph.fx_refresh_collect();
  if exists (select 1 from beau_ph.fx_refresh_runs where requested_by = 'fx@test' and status = 'requested' and http ? 'frankfurter') then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: refresh run]'; end if;
  j := beau_ph.fx_overview(mk);
  if (j -> 'health' ->> 'in_progress')::boolean and (j -> 'settings' ->> 'enabled')::boolean and jsonb_array_length(j -> 'currencies') >= 10 and beau_ph.no_secret_keys(j) then ok := ok + 1; else fail := fail + 1; log := log || ' [fx: overview]'; end if;

  /* ---- 25. cash is a rail: manual, in person, operator-confirmed, market-scoped ---- */
  j := beau_ph.rails_overview(mk);
  if exists (select 1 from jsonb_array_elements(j -> 'rails') r where r ->> 'provider' = 'cash' and r ->> 'kind' = 'manual' and r ->> 'confirmation' = 'operator' and r ->> 'readiness' = 'available' and (r -> 'merchant') = 'null'::jsonb) then ok := ok + 1; else fail := fail + 1; log := log || ' [cash: catalogue]'; end if;
  if beau_ph.eligible_methods(mk, 'ZW', 'USD', rt)::text not like '%"cash"%' then ok := ok + 1; else fail := fail + 1; log := log || ' [cash: offered unconfigured]'; end if;
  perform beau_ph.merchant_method_configure(mk, 'cash', '{"enabled":true,"listed":true,"currency":"USD","countries":["ZW"],"currencies":["USD"],"instructions":{"instructions":"Bring cash to the session."}}'::jsonb, 't');
  j := beau_ph.eligible_methods(mk, 'ZW', 'USD', rt);
  if exists (select 1 from jsonb_array_elements(j) e where e ->> 'provider' = 'cash' and e ->> 'capability' = 'cash' and e -> 'instructions' ->> 'instructions' = 'Bring cash to the session.') then ok := ok + 1; else fail := fail + 1; log := log || ' [cash: eligible]'; end if;
  if beau_ph.eligible_methods(mk, 'AE', 'USD', rt)::text not like '%"cash"%' and beau_ph.eligible_methods(mk, 'ZW', 'AED', rt)::text not like '%"cash"%' then ok := ok + 1; else fail := fail + 1; log := log || ' [cash: market scope]'; end if;
  if exists (select 1 from jsonb_array_elements(beau_ph.eligible_capabilities(mk, 'ZW', 'USD', rt, null, 'merchant')) c where c ->> 'provider' = 'cash' and (c ->> 'in_person')::boolean) then ok := ok + 1; else fail := fail + 1; log := log || ' [cash: collect option]'; end if;
  j := beau_ph.create_request(mk, 'cash', 'ORD-CASH', 'REF-2099', 4000, 'USD', 'ZW', null, '{}'::jsonb, rt, 'cash'); rC := (j ->> 'id')::uuid;
  if j ->> 'status' = 'pending' and j ->> 'capability' = 'cash' and j ->> 'channel' = 'in_person' then ok := ok + 1; else fail := fail + 1; log := log || ' [cash: request]'; end if;
  e1 := beau_ph.ingest_provider_event('cash', 'fake-cash-1', 'cash.received', '{"claimed":"paid"}'::jsonb, jsonb_build_object('request_id', rC, 'status', 'paid', 'amount', 4000, 'currency', 'USD'));
  if (e1 ->> 'outcome') = 'rejected:manual_provider_requires_operator' and (select status from beau_ph.payment_requests where id = rC) = 'pending' then ok := ok + 1; else fail := fail + 1; log := log || ' [cash: self-confirm]'; end if;
  begin perform beau_ph.confirm_manual(rC, 'op@test', 3900, 'USD'); fail := fail + 1; log := log || ' [cash: wrong amount]'; exception when sqlstate 'P0003' then ok := ok + 1; end;
  e1 := beau_ph.confirm_manual(rC, 'op@test', 4000, 'USD', null, now(), 'counted at the court');
  if (e1 ->> 'to') = 'paid' and exists (select 1 from beau_ph.payment_events where id = (e1 ->> 'payment_event_id')::uuid and actor = 'operator' and actor_id = 'op@test') then ok := ok + 1; else fail := fail + 1; log := log || ' [cash: operator confirm]'; end if;
  begin perform beau_ph.confirm_manual(rC, 'op@test', 4000, 'USD'); fail := fail + 1; log := log || ' [cash: confirmed twice]'; exception when sqlstate 'P0003' then ok := ok + 1; end;

  raise exception 'BEAU_PH_CORE_TESTS ok=% fail=% %', ok, fail, log;
end $$;
