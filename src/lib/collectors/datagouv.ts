import type { TrackedHttp } from "./context";

/**
 * Accès générique à data.gouv.fr : ressource d'un jeu repérée par son titre
 * (les identifiants de ressources changent à chaque mise à jour, les titres
 * restent stables), et lecture filtrée par l'API tabulaire.
 */

export const DATAGOUV = "https://www.data.gouv.fr/api/1";
export const TABULAR = "https://tabular-api.data.gouv.fr/api/resources";

export interface DgResource {
  id: string;
  title?: string;
  format?: string;
  url?: string;
  last_modified?: string;
  filesize?: number;
}

/**
 * Ressource d'un jeu dont le titre correspond au motif ; à défaut, la
 * ressource connue (`fallback`) relevée lors de la mise au point.
 */
export async function findResource(http: TrackedHttp, dataset: string, titleRe: RegExp, fallback?: DgResource): Promise<DgResource | null> {
  try {
    const d = await http.json<{ resources?: DgResource[] }>(`${DATAGOUV}/datasets/${dataset}/`, { allow404: true });
    const found = (d.data?.resources ?? []).filter((r) => titleRe.test(r.title ?? "") || titleRe.test(r.url ?? ""));
    // La plus récente d'abord (plusieurs versions coexistent parfois).
    found.sort((a, b) => String(b.last_modified ?? "").localeCompare(String(a.last_modified ?? "")));
    if (found[0]) return found[0];
  } catch {
    /* repli */
  }
  return fallback ?? null;
}

type Filter = { col: string; op: "exact" | "contains"; value: string };

/** Lignes d'une ressource indexée par l'API tabulaire, filtrées. */
export async function tabular(http: TrackedHttp, rid: string, filters: Filter[], maxPages = 40): Promise<{ rows: Record<string, unknown>[]; url: string; retrievedAt: string }> {
  const qs = filters.map((f) => `${encodeURIComponent(f.col)}__${f.op}=${encodeURIComponent(f.value)}`).join("&");
  let url: string | null = `${TABULAR}/${rid}/data/?${qs}&page_size=50`;
  const first = url;
  const rows: Record<string, unknown>[] = [];
  let retrievedAt = "";
  let pages = 0;
  while (url && pages++ < maxPages) {
    const r: { data: { data?: Record<string, unknown>[]; links?: { next?: string | null } } | null; retrievedAt: string } = await http.json(url, { minIntervalMs: 150 });
    retrievedAt = r.retrievedAt;
    rows.push(...(r.data?.data ?? []).map((x) => {
      const o = { ...x };
      delete o.__id;
      return o;
    }));
    url = r.data?.links?.next ?? null;
  }
  return { rows, url: first, retrievedAt };
}

/** Nettoie une valeur exportée depuis un tableur (`="01053"` → `01053`). */
export const clean = (v: unknown) => String(v ?? "").replace(/^="?|"$/g, "").trim();

export const num = (v: unknown) => {
  if (v == null || v === "") return null;
  const x = typeof v === "number" ? v : Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(x) ? x : null;
};
