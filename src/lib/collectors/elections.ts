import type { TrackedHttp } from "./context";

/**
 * Résultats électoraux officiels (ministère de l'Intérieur, publiés sur data.gouv.fr).
 *
 * Accès : l'API de data.gouv.fr permet de retrouver la ressource CSV
 * « résultats par commune » d'un jeu de données ; l'API tabulaire
 * (tabular-api.data.gouv.fr) permet ensuite de filtrer les lignes d'une
 * commune ou d'un département sans télécharger le fichier complet.
 *
 * Usage : ce module ne produit que des résultats AGRÉGÉS par commune et par
 * département, à vocation descriptive. Aucune donnée individuelle n'est
 * collectée et aucune inférence sur les opinions des habitants n'est réalisée.
 *
 * Les identifiants de jeux (slug data.gouv) sont configurables ici. Si un jeu
 * n'est pas trouvé ou si la structure du fichier diffère, le scrutin est
 * signalé comme indisponible.
 */

export interface ElectionConfig {
  id: string;
  label: string;
  date: string;
  /** Slug ou identifiant du jeu de données sur data.gouv.fr. */
  dataset: string;
  /** Identifiant de ressource à utiliser directement (prioritaire sur la recherche). */
  resourceId?: string;
}

export const ELECTIONS: ElectionConfig[] = [
  {
    id: "LG24T1",
    label: "Législatives 2024 — 1er tour",
    date: "2024-06-30",
    dataset: "elections-legislatives-des-30-juin-et-7-juillet-2024-resultats-definitifs-du-1er-tour",
  },
  {
    id: "EU24",
    label: "Européennes 2024",
    date: "2024-06-09",
    dataset: "resultats-des-elections-europeennes-du-9-juin-2024",
  },
  {
    id: "PR22T1",
    label: "Présidentielle 2022 — 1er tour",
    date: "2022-04-10",
    dataset: "election-presidentielle-des-10-et-24-avril-2022-resultats-definitifs-du-1er-tour",
  },
];

const DATAGOUV = "https://www.data.gouv.fr/api/1";
const TABULAR = "https://tabular-api.data.gouv.fr/api/resources";

export interface ElectionResult {
  election: ElectionConfig;
  level: "commune" | "departement";
  code: string;
  inscrits: number;
  votants: number;
  abstentions: number;
  blancs: number | null;
  nuls: number | null;
  exprimes: number;
  /** Voix par liste / candidat / nuance, agrégées. */
  candidates: { label: string; voix: number }[];
  /** Participation par commune (niveau départemental uniquement, pour la carte). */
  byCommune?: { code: string; inscrits: number; votants: number }[];
  sourceUrl: string;
  retrievedAt: string;
}

const n = (v: unknown) => {
  const x = typeof v === "number" ? v : Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(x) ? x : null;
};

/** Trouve la colonne dont le nom correspond à l'un des motifs. */
export function findCol(cols: string[], ...res: RegExp[]) {
  for (const re of res) {
    const c = cols.find((x) => re.test(x));
    if (c) return c;
  }
  return null;
}

/**
 * Agrège une ou plusieurs lignes de résultats (format « large » du ministère :
 * colonnes répétées « Voix 1, Voix 2… » ou « Voix, Voix_1… »).
 */
export function aggregateRows(rows: Record<string, unknown>[]) {
  if (!rows.length) return null;
  const cols = Object.keys(rows[0]);
  const cIns = findCol(cols, /^inscrits$/i);
  const cVot = findCol(cols, /^votants$/i);
  const cAbs = findCol(cols, /^abstentions$/i);
  const cBla = findCol(cols, /^blancs$/i);
  const cNul = findCol(cols, /^nuls$/i);
  const cExp = findCol(cols, /^exprim[ée]s$/i);
  if (!cIns || !cExp) return null;
  // Colonnes de voix et libellé associé (même suffixe numérique).
  const voixCols = cols.filter((c) => /^voix([ _]?\d+)?$/i.test(c));
  const suffix = (c: string) => (c.match(/(\d+)$/)?.[1] ?? "");
  const labelFor = (s: string) =>
    findCol(
      cols.filter((c) => suffix(c) === s),
      /^libell[ée] (abr[ée]g[ée] )?(de la )?liste/i,
      /^nuance (candidat|liste)?/i,
      /^nom (candidat)?/i,
      /^nom$/i,
    );
  const tot = { inscrits: 0, votants: 0, abstentions: 0, blancs: 0, nuls: 0, exprimes: 0 };
  let hasBlancs = !!cBla;
  const cand = new Map<string, number>();
  for (const r of rows) {
    tot.inscrits += n(r[cIns]) ?? 0;
    tot.exprimes += n(r[cExp]) ?? 0;
    if (cVot) tot.votants += n(r[cVot]) ?? 0;
    if (cAbs) tot.abstentions += n(r[cAbs]) ?? 0;
    if (cBla) tot.blancs += n(r[cBla]) ?? 0;
    else hasBlancs = false;
    if (cNul) tot.nuls += n(r[cNul]) ?? 0;
    for (const vc of voixCols) {
      const lc = labelFor(suffix(vc));
      const label = lc ? String(r[lc] ?? "").trim() : "";
      const v = n(r[vc]);
      if (!label || v == null) continue;
      cand.set(label, (cand.get(label) ?? 0) + v);
    }
  }
  if (!cVot) tot.votants = tot.inscrits - tot.abstentions;
  if (!cAbs) tot.abstentions = tot.inscrits - tot.votants;
  return {
    ...tot,
    blancs: hasBlancs ? tot.blancs : null,
    nuls: cNul ? tot.nuls : null,
    candidates: [...cand.entries()].map(([label, voix]) => ({ label, voix })).sort((a, b) => b.voix - a.voix),
  };
}

async function resolveResource(http: TrackedHttp, e: ElectionConfig) {
  if (e.resourceId) return e.resourceId;
  const r = await http.json<{ resources?: { id: string; title?: string; format?: string }[] }>(`${DATAGOUV}/datasets/${e.dataset}/`, {
    allow404: true,
  });
  const res = r.data?.resources ?? [];
  const hit =
    res.find((x) => /commune/i.test(x.title ?? "") && /csv/i.test(x.format ?? "") && !/bureau/i.test(x.title ?? "")) ??
    res.find((x) => /commune/i.test(x.title ?? "") && !/bureau/i.test(x.title ?? ""));
  return hit?.id ?? null;
}

async function tabularRows(http: TrackedHttp, rid: string, filters: Record<string, string>, maxPages = 30) {
  const rows: Record<string, unknown>[] = [];
  const qs = Object.entries(filters)
    .map(([k, v]) => `${encodeURIComponent(k)}__exact=${encodeURIComponent(v)}`)
    .join("&");
  let url: string | null = `${TABULAR}/${rid}/data/?${qs}&page_size=50`;
  const first = url;
  let retrievedAt = "";
  let pages = 0;
  while (url && pages++ < maxPages) {
    const r: { data: { data?: Record<string, unknown>[]; links?: { next?: string | null } } | null; retrievedAt: string } =
      await http.json(url, { minIntervalMs: 150 });
    retrievedAt = r.retrievedAt;
    rows.push(...(r.data?.data ?? []));
    url = r.data?.links?.next ?? null;
  }
  return { rows, url: first, retrievedAt };
}

export async function collectElection(
  http: TrackedHttp,
  e: ElectionConfig,
  codeInsee: string,
  dep: string,
): Promise<ElectionResult[]> {
  const rid = await resolveResource(http, e);
  if (!rid) throw new Error(`Ressource « résultats par commune » introuvable pour ${e.label}`);
  // Découverte des colonnes.
  const probe = await http.json<{ data?: Record<string, unknown>[] }>(`${TABULAR}/${rid}/data/?page_size=1`);
  const cols = Object.keys(probe.data?.data?.[0] ?? {}).filter((c) => c !== "__id");
  const cCom = findCol(cols, /^code (de la )?commune$/i, /^code ?commune$/i, /^codecommune$/i);
  const cDep = findCol(cols, /^code (du )?d[ée]partement$/i, /^code ?d[ée]partement$/i);
  if (!cCom) throw new Error(`Colonne « code commune » introuvable (${e.label})`);
  const sample = String(probe.data?.data?.[0]?.[cCom] ?? "");
  const shortCodes = sample.length <= 3; // anciens formats : code département + code commune sur 3 caractères
  const comFilters: Record<string, string> = shortCodes && cDep ? { [cDep]: dep, [cCom]: codeInsee.slice(dep.length === 3 ? 3 : 2) } : { [cCom]: codeInsee };
  const com = await tabularRows(http, rid, comFilters, 2);
  const out: ElectionResult[] = [];
  const agg = aggregateRows(com.rows);
  if (!agg) throw new Error(`Aucun résultat pour la commune (${e.label})`);
  out.push({ election: e, level: "commune", code: codeInsee, ...agg, sourceUrl: com.url, retrievedAt: com.retrievedAt });
  if (cDep) {
    const depRows = await tabularRows(http, rid, { [cDep]: dep }, 40);
    const a2 = aggregateRows(depRows.rows);
    if (a2) {
      const groups = new Map<string, Record<string, unknown>[]>();
      for (const r of depRows.rows) {
        let k = String(r[cCom] ?? "");
        if (shortCodes) k = dep + k.padStart(3, "0").slice(dep.length === 3 ? -2 : -3);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }
      const byCommune = [...groups.entries()]
        .map(([code, rows]) => ({ code, a: aggregateRows(rows) }))
        .filter((x) => x.a)
        .map((x) => ({ code: x.code, inscrits: x.a!.inscrits, votants: x.a!.votants }));
      out.push({ election: e, level: "departement", code: dep, ...a2, byCommune, sourceUrl: depRows.url, retrievedAt: depRows.retrievedAt });
    }
  }
  return out;
}
