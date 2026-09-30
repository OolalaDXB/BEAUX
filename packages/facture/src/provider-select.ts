/**
 * Sélection de provider PA — CONFIGURATION SERVEUR uniquement (mandat
 * provider #2, §6) : même flux, même orchestrateur, connecteur A ou B selon
 * le secret d'environnement EINVOICING_PROVIDER ('iopole' par défaut,
 * 'b2brouter'). AUCUN sélecteur côté tenant, aucun routage dynamique, aucun
 * failover : une valeur inconnue rend la sélection INERTE (fail-closed,
 * la fonction répond 503) plutôt que de choisir un provider à la place de
 * l'opérateur. Copie byte-identique entre fonctions einvoicing-*
 * (facturx-shared-sync.test.ts).
 */

import type { EInvoicingProvider } from './provider';
import { getConfiguredProvider as getConfiguredIopole } from './iopole.ts';
import { getConfiguredB2BrouterProvider } from './b2brouter.ts';

interface EnvReader {
  get(key: string): string | undefined;
}

export type ConfiguredProvider =
  | { provider: EInvoicingProvider; reason: null }
  | { provider: null; reason: string };

/** Connecteur configuré — null (503) si secrets absents ou slug inconnu. */
export function resolveConfiguredProvider(env: EnvReader): ConfiguredProvider {
  const slug = (env.get('EINVOICING_PROVIDER') ?? 'iopole').trim().toLowerCase();
  if (slug === 'iopole') return getConfiguredIopole(env);
  if (slug === 'b2brouter') return getConfiguredB2BrouterProvider(env);
  return {
    provider: null,
    reason: `EINVOICING_PROVIDER « ${slug} » inconnu — sélection fail-closed, aucun envoi possible.`,
  };
}
