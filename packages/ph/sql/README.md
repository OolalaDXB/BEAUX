# beau_ph — the schema

BEAU PH is installed **into each host's database**. It owns the `beau_ph` schema
and nothing else; a host talks to it through `beau_ph.*` functions.

## Versions

`beau_ph.schema_versions` is BEAU PH's own ledger, separate from the host's
migration history (two repositories pushing migrations into one Supabase
ledger would trample each other).

| File | Content |
|---|---|
| `migrations/0001_baseline.sql` | the whole schema as it ran in production on 2026-09-30, plus reference data (providers, capabilities, FX sources and currencies) |

## Installing into a new database

Apply every file in `migrations/` in filename order, each in one transaction
(`psql --single-transaction -f …`). Then create the host's merchant row and
configure its rails with `beau_ph.merchant_method_configure`.

## A database that already runs BEAU PH (Coach Gari)

It is **not** re-installed. Its schema was verified identical to the baseline
(fingerprints of columns, constraints, indexes, triggers, functions and
reference data), so it only receives the ledger, marked at `0001_baseline`:

```sql
create table if not exists beau_ph.schema_versions (version text primary key, applied_at timestamptz not null default now(), note text);
alter table beau_ph.schema_versions enable row level security;
revoke all on beau_ph.schema_versions from public, anon, authenticated;
grant select on beau_ph.schema_versions to service_role;
insert into beau_ph.schema_versions (version, note) values ('0001_baseline', 'adopted: schema verified identical') on conflict do nothing;
```

## Adding a change

1. A new file `migrations/NNNN_what.sql`, ending with
   `insert into beau_ph.schema_versions (version) values ('NNNN_what');`
2. The contract suite extended to prove it.
3. Each host applies the files it has not recorded in `schema_versions`, in order.
