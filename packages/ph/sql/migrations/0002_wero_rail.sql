-- =====================================================================
-- BEAU PH — Wero, the euro-area instant payment, as a manual rail
--
-- Same shape as Aani: the payer pays the merchant's registered Wero phone
-- or email from their own bank app, with the human reference; an authorised
-- operator confirms receipt. EUR only; BE, DE, FR, LU, NL. Added to the
-- catalogue only: no merchant has it switched on by this migration.
-- =====================================================================
alter table beau_ph.providers drop constraint if exists providers_key_check;
alter table beau_ph.providers add constraint providers_key_check
  check (key in ('stripe','aani','bank_transfer','cash','paynow','mpesa','ozow','payshap','beau_wallet',
                 'network_international','magnati','adyen','wise','paypal','wero'));

insert into beau_ph.providers (key, display_name, kind, confirmation, countries, currencies, readiness, sort, notes, channel_label, intents, secrets, config_schema, onboarding, supports_cancel)
values ('wero', 'Wero (instant payment, EU)', 'manual', 'operator', '{BE,DE,FR,LU,NL}', '{EUR}', 'available', 22,
        'Payer pays the merchant''s registered Wero phone or email from their bank app (SEPA Instant underneath); an authorised operator confirms receipt. No Wero API, request-to-pay or auto-confirm is used.',
        'Manual · Instant payment (EU)', null, '{}',
        '[{"key":"display_value","type":"text","label":"Wero phone or email","store":"instructions","public":true,"placeholder":"+33 6 XX XX XX XX"},
          {"key":"account_holder","type":"text","label":"Name shown in Wero","store":"instructions","public":true},
          {"key":"instructions","type":"textarea","label":"Instructions shown to the client","store":"instructions","public":true}]'::jsonb,
        'No API. Register the phone or email your bank enrolled in Wero; an authorised operator confirms each receipt.', false)
on conflict (key) do nothing;

insert into beau_ph.provider_capabilities (provider_key, capability, readiness, confirmation, platforms, initiated_by, handoff, notes, intents)
values ('wero', 'manual_instructions', 'available', 'operator', null, 'any', false, 'Wero phone or email; an authorised operator confirms receipt.', null)
on conflict do nothing;
