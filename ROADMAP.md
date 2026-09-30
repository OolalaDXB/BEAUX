# BEAUX — récapitulatif et feuille de route

État au 30/09/2026. Ce document sert de point de départ à une session dédiée à
BEAU PH et FactureX : il dit ce qui existe, où, ce qui est vérifié, et dans quel
ordre continuer.

## 1. Où sont les choses

| Dépôt | Rôle | Branche / état |
|---|---|---|
| **OolalaDXB/BEAUX** (privé) | Source de vérité de **BEAU PH** (`packages/ph`) et **FactureX** (`packages/facture`). | `main`, dernier commit FactureX `770a093`. CI GitHub Actions : job `ph` (Postgres 16) et job `facture`. |
| **OolalaDXB/SILLON** | Premier hôte de FactureX : `packages/einvoicing-core/src` est une **copie figée** de `packages/facture/src`. | #229 (adoption FactureX + franchise 293 B) et #230 (e-reporting) **fusionnées** sur `main`. Aucune branche en cours. |
| **OolalaDXB/CoachGari** | Premier hôte de BEAU PH. **Gel fonctionnel** (CG-066) : corrections seulement. `beau-ph/` n'y est plus qu'un instantané (`beau-ph/SNAPSHOT.md`, BEAUX `ffd21e2`). | Production : coachgari28.com. |

| Supabase | Projet | Contenu utile |
|---|---|---|
| Coach Gari | `acrjrlgeeyseyolmofuq` | Schéma `beau_ph` (conforme à `0001_baseline`), registre `beau_ph.schema_versions` (ligne `0001_baseline` « adopted »). |
| SILLON | (projet SILLON) | Fonctions `facturx-generate` (v25), `einvoicing-transmit`, `einvoicing-ereporting` (verify_jwt). Table `einvoicing_transmissions` **vide** en production. |

## 2. Ce qui est fait

### BEAU PH (`packages/ph`) — phase A
- Code, contrats, adaptateurs, docs (`packages/ph/docs/*`, dont sa propre
  `ROADMAP.md` V0→V3 et la liste honnête des lacunes V0).
- Migrations autonomes : `sql/migrations/0001_baseline.sql` + registre propre
  `beau_ph.schema_versions`, séparé de celui de l'hôte.
- Tests : `npm run test:ph` (TS) et `npm run test:ph:db` (schéma reconstruit
  depuis les migrations + suite de contrat `sql/tests/core_contract.sql`).

### FactureX (`packages/facture`) — phase B
- Import depuis SILLON : génération Factur-X (EN 16931), PDF/A-3, contrat
  fournisseur (iopole, B2Brouter), ingestion entrante.
- **Franchise en base (art. 293 B CGI)** : catégorie E + `VATEX-FR-FRANCHISE`,
  mention légale, BT-32 schemeID `FC`. Validé Mustang 2.16.2.
- **E-reporting (flux 10)** : `ereporting.ts` (périodes par régime, agrégats
  jour de Paris, TLB1/TPS1/TNT1/TMA1, rapport idempotent, `reconcileAggregates`)
  et `b2brouter-ereporting.ts` (réglage dgfip en lecture, `recordPayment` dédoublonné
  par `reference`, états des rapports, ledgers). Le connecteur n'est **pas**
  exporté par `index.ts`.
- 171 tests vitest ; `tsc` strict + `tsc` « loose » avec les options de SILLON
  (`tsconfig.loose.json`) pour attraper ce qui casserait chez l'hôte.

### SILLON
- `packages/einvoicing-core/UPSTREAM.json` : commit BEAUX + SHA-256 par fichier ;
  contrôle CI bloquant `npm run einvoicing:upstream:check`.
- Mise à jour : `node scripts/einvoicing-core-upstream.mjs --from <checkout BEAUX>`
  puis `npm run sync:einvoicing` (copies Deno, manifeste incluant
  `einvoicing-ereporting`).
- Fonction `einvoicing-ereporting` : actions `setting`, `record_payment`,
  `reports` ; staff/admin du tenant ; exige `EINVOICING_PROVIDER=b2brouter`
  (409 sinon), 503 sans configuration ; clé non sandbox refusée sans
  `B2BROUTER_ALLOW_LIVE`. Procédure : `docs/EREPORTING.md`.

### B2Brouter sandbox (constaté le 30/09/2026)
- Comptes sandbox : **343190 OUTRE-NATIONAL SAS** (émetteur) et 343187 OOLALA
  FRANCE SAS. Un échange B2B 343190 → 343187 a déjà été fait, hors journal SILLON.
- **Réglage `dgfip` créé par API sur 343190** (`POST /accounts/343190/tax_report_settings`),
  ce qui fonctionne avec le compte gratuit : activé, `reel_normal_mensuel`,
  `goods`, micro, NAF 47, début **2026-10-01** (l'API refuse une date antérieure),
  réponse `issue_only: false`.
- Le compte live BASIC n'a **pas** l'e-reporting et ne doit pas l'avoir : sandbox seulement.

## 3. Feuille de route

### Étape 1 — Recette e-reporting en sandbox (à partir du 01/10/2026)
1. Secrets Supabase SILLON : `EINVOICING_PROVIDER=b2brouter`,
   `B2BROUTER_ACCOUNT_ID=343190`, `B2BROUTER_API_KEY` = clé sandbox. Le
   propriétaire les saisit et compare les empreintes SHA-256 ; la clé n'est
   jamais collée dans une conversation ni committée.
2. Tenant émetteur : recommandé, un **tenant de test** portant le SIREN
   828681528 (pour ne pas consommer la séquence légale d'OUTRE-NATIONAL) ; sinon
   OUTRE-NATIONAL + avoir d'annulation.
3. Facture **B2C** (acheteur sans SIREN/TVA), datée ≥ 01/10/2026, « Marquer
   envoyée » puis `einvoicing-transmit` depuis SILLON.
4. `setting` → `configured: true`. `record_payment` (rejouer la même
   `reference` → 200 `created: false`). `reports` → rapport transaction et
   rapport paiement jusqu'à `registered`.
5. Consigner dans SILLON `docs/EREPORTING.md` : acceptation du Factur-X B2C,
   classement en flux 10, format du Ledger XML, délais, écarts.

### Étape 2 — Corriger selon la recette
- Ajuster `b2brouter-ereporting.ts` / `ereporting.ts` dans BEAUX d'après ce qui
  a été observé ; brancher `reconcileAggregates` sur le Ledger réel.
- Vérifier BT-32 et le code d'exonération franchise côté plateforme.
- Confirmer contre les spécifications externes DGFiP en vigueur : données de
  paiement sous franchise, catégorie d'une vente en franchise.
- Remonter dans SILLON (upstream + sync), PR, CI verte.

### Étape 3 — Branchement automatique dans SILLON
- Un encaissement enregistré dans SILLON appelle `record_payment`
  (idempotent par l'id de l'encaissement), sans action manuelle.
- Suivi des états de rapport (tâche planifiée ou webhook B2Brouter) et
  affichage dans l'interface : `registered_with_errors`, `refused`, `error`.
- Note : le régime simplifié disparaît au 01/01/2027.

### Étape 4 — BEAU PH
- Suivre `packages/ph/docs/ROADMAP.md` : V1 = premier rail africain réel
  (Paynow) + second hôte ; combler les lacunes V0 listées.
- Coach Gari reste gelé : toute évolution BEAU PH se fait ici, puis est reprise
  par l'hôte par migration.

### À décider (propriétaire)
- Nom public de FactureX (« Factur-X » est le nom de la norme).
- Mise en production B2Brouter (compte payant, `B2BROUTER_ALLOW_LIVE`) : jamais
  sans accord explicite.
- Carry-over Coach Gari : dépôt privé, Supabase Pro, historique git (PII), 2FA.

## 4. Règles de travail

1. BEAUX est la source : on ne modifie jamais `einvoicing-core` directement dans
   SILLON, on le reprend par `einvoicing-core-upstream.mjs`.
2. Dans SILLON : branche + PR, fusion seulement sur accord du propriétaire.
3. Aucun secret committé ni recopié (clé sandbox comprise) ; aucune donnée
   client réelle dans le code ou les fixtures.
4. Chaque changement garde verts : `npm test`, `npm run test:ph:db` (BEAUX) et
   la CI SILLON (typecheck non strict inclus).

## 5. Contraintes d'environnement (sessions cloud)

- Le conteneur ne joint pas `*.supabase.co`, `b2brouter.net`, `deno.land`,
  `esm.sh`. Contournement pour lire une doc ou appeler une API HTTP : `pg_net`
  depuis une base Supabase via une table sonde temporaire, lecture dans
  `net._http_response`, puis suppression de la sonde.
- `npm ci` dans SILLON échoue (registre Lovable privé) : node_modules de travail
  depuis le registre public, lien symbolique temporaire.
- `deno check` impossible (deno.land bloqué) : stubs typés dans une copie
  temporaire.
- Les appels réels à la sandbox B2Brouter se font depuis le poste du
  propriétaire (curl) ou via les fonctions déployées.
