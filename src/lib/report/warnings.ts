import type { Report, SourceRun } from "../types";

/**
 * Avertissements de collecte. Seules les sources sans lesquelles la fiche ne tient pas
 * (résultats électoraux, recensement, référentiel des communes) donnent un avertissement
 * visible ; les autres échecs (quartiers IRIS, OpenStreetMap, gares…) restent signalés
 * discrètement, la partie concernée étant simplement absente.
 */
export const CRITICAL_SOURCES = new Set(["elections", "insee_melodi", "geoapi", "cog"]);

/** Anciens messages génériques (avant ce tri), retirés des avertissements affichés. */
const GENERIC = /étape\(s\) de collecte en échec|copie en cache périmée/;

export function criticalMessage(failed: SourceRun[]): string | null {
  const crit = failed.filter((r) => CRITICAL_SOURCES.has(r.sourceId));
  if (!crit.length) return null;
  return `Données essentielles indisponibles lors de la collecte : ${[...new Set(crit.map((r) => r.name))].join(" ; ")}. La fiche est incomplète sur ces points : régénérer plus tard.`;
}

export function splitWarnings(r: Pick<Report, "warnings" | "runs">) {
  const failed = r.runs.filter((x) => x.status === "failed");
  const crit = criticalMessage(failed);
  const main = r.warnings.filter((w) => !GENERIC.test(w) && w !== crit);
  if (crit) main.push(crit);
  const minor = failed.filter((x) => !CRITICAL_SOURCES.has(x.sourceId));
  const stale = r.runs.some((x) => x.status === "stale");
  return { main, minor, stale };
}
