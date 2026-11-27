-- =====================================================================
-- BEAU PH 0005 — the PayPal catalogue row, filled in
--
-- PayPal entered the catalogue (baseline) as a shell: no secret names, no
-- configuration fields, no channel label, no currency list. Two consequences,
-- both found by the first host that tried to switch the rail on:
--
--   · the operator screen had nothing to show for PayPal — no secret to check,
--     no account field to fill in;
--   · nothing stopped a merchant enabling PayPal in a currency PayPal does not
--     take. AED is one, and it is the first host's home currency: the request
--     would have been created and refused by PayPal at the moment of payment.
--
-- The currency list is PayPal's own (developer.paypal.com › currency codes).
-- BRL, CNY and MYR are in-country only at PayPal; they are listed because the
-- provider supports them, and a merchant elsewhere simply does not select them.
-- A merchant narrows a provider and never broadens it, so the list is a ceiling:
-- merchant_method_configure refuses a currency outside it.
--
-- A merchant method ALREADY configured outside the list is not rewritten here —
-- it is the merchant's — and the method matrix simply stops offering it in that
-- currency (reason `currency`), which is the truth.
--
-- The three configuration fields are the ones the adapter's instructionFields()
-- names; the three secrets are the ones its capabilities() names. The adapter
-- and this row are held equal by tests/paypal.test.mjs.
-- Forward migration only.
-- =====================================================================
update beau_ph.providers set
  channel_label = 'Online · PayPal',
  secrets = '{PAYPAL_CLIENT_ID,PAYPAL_SECRET,PAYPAL_WEBHOOK_ID}',
  currencies = '{AUD,BRL,CAD,CHF,CNY,CZK,DKK,EUR,GBP,HKD,HUF,ILS,JPY,MXN,MYR,NOK,NZD,PHP,PLN,SEK,SGD,THB,TWD,USD}',
  onboarding = 'PayPal Business account (never a personal one). Create a REST app in the PayPal developer dashboard, set its client id and secret as deployment secrets, subscribe a webhook on the host''s PayPal endpoint to PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.DENIED, PAYMENT.CAPTURE.REFUNDED, PAYMENT.CAPTURE.REVERSED and CHECKOUT.ORDER.APPROVED, and set that webhook''s id as PAYPAL_WEBHOOK_ID. PAYMENTS_MODE declares sandbox (test) or live. An approved order is captured by the host through the adapter; only the verified capture event marks anything paid.',
  config_schema = '[
    {"key":"paypal_business_email","label":"PayPal business account","store":"instructions","type":"text","placeholder":"payments@your-company.com","public":true},
    {"key":"account_holder","label":"Account name","store":"instructions","type":"text","public":true},
    {"key":"notes","label":"Notes for the payer","store":"instructions","type":"textarea","public":true}]'::jsonb
where key = 'paypal';

insert into beau_ph.schema_versions (version) values ('0005_paypal_catalogue') on conflict do nothing;
