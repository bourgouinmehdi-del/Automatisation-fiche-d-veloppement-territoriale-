import Papa from "papaparse";
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
  /** Recherche plein texte de repli sur data.gouv.fr si le slug n'existe pas. */
  search: string;
  /** Le titre du jeu trouvé par la recherche doit correspondre à ce motif. */
  titleRe: RegExp;
}

export const ELECTIONS: ElectionConfig[] = [
  {
    id: "LG24T1",
    label: "Législatives 2024 — 1er tour",
    date: "2024-06-30",
    dataset: "elections-legislatives-des-30-juin-et-7-juillet-2024-resultats-definitifs-du-1er-tour",
    search: "élections législatives 2024 résultats définitifs premier tour",
    titleRe: /l[ée]gislatives.*2024.*(1er|premier) tour|1er tour.*l[ée]gislatives.*2024/i,
  },
  {
    id: "EU24",
    label: "Européennes 2024",
    date: "2024-06-09",
    dataset: "resultats-des-elections-europeennes-du-9-juin-2024",
    search: "élections européennes 2024 résultats définitifs",
    titleRe: /europ[ée]ennes.*2024/i,
  },
  {
    id: "PR22T1",
    label: "Présidentielle 2022 — 1er tour",
    date: "2022-04-10",
    dataset: "election-presidentielle-des-10-et-24-avril-2022-resultats-definitifs-du-1er-tour",
    search: "élection présidentielle 2022 résultats définitifs premier tour",
    titleRe: /pr[ée]sidentielle.*2022.*(1er|premier) tour/i,
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
  const voixCols = cols.filter((c) => /^voix([ _]?(x)?\d+)?$/i.test(c));
  const suffix = (c: string) => (c.match(/(\d+)$/)?.[1] ?? "");
  const labelFor = (s: string) =>
    findCol(
      cols.filter((c) => suffix(c) === s),
      /^libell[ée] (abr[ée]g[ée] )?(de la )?liste/i,
      /^nuance (candidat|liste)?/i,
      /^nom (candidat)?/i,
      /^nom(_x\d+)?$/i,
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

export interface ResourceInfo {
  id: string;
  url: string;
  title: string;
  format: string;
  dataset: string;
}

interface DgResource {
  id: string;
  title?: string;
  format?: string;
  url?: string;
}
interface DgDataset {
  slug: string;
  title?: string;
  organization?: { name?: string } | null;
  resources?: DgResource[];
}

/** Choisit la ressource « résultats par commune » (CSV de préférence) d'un jeu. */
export function pickCommuneResource(resources: DgResource[]): DgResource | null {
  const isCommune = (x: DgResource) => /commun|subcom/i.test(x.title ?? "") && !/bureau|circonscription|d[ée]partement|r[ée]gion/i.test(x.title ?? "");
  const tab = (x: DgResource) => /csv|txt/i.test(x.format ?? "") || /\.(csv|txt)$/i.test(x.url ?? "");
  return resources.find((x) => isCommune(x) && tab(x)) ?? null;
}

/**
 * Trouve la ressource « résultats par commune » d'un scrutin :
 * 1. identifiant de ressource configuré ;
 * 2. jeu de données désigné par son slug ;
 * 3. à défaut, recherche plein texte sur data.gouv.fr, limitée aux jeux publiés
 *    par le ministère de l'Intérieur.
 */
export async function resolveResource(http: TrackedHttp, e: ElectionConfig): Promise<ResourceInfo | null> {
  const candidates: DgDataset[] = [];
  const bySlug = await http.json<DgDataset>(`${DATAGOUV}/datasets/${e.dataset}/`, { allow404: true });
  if (bySlug.data?.resources) candidates.push(bySlug.data);
  if (e.resourceId) {
    const r = candidates.flatMap((d) => d.resources ?? []).find((x) => x.id === e.resourceId);
    return { id: e.resourceId, url: r?.url ?? "", title: r?.title ?? e.resourceId, format: r?.format ?? "csv", dataset: e.dataset };
  }
  const search = await http.json<{ data?: DgDataset[] }>(`${DATAGOUV}/datasets/?q=${encodeURIComponent(e.search)}&page_size=20`);
  for (const d of search.data?.data ?? [])
    if (/int[ée]rieur/i.test(d.organization?.name ?? "") && e.titleRe.test(d.title ?? "")) candidates.push(d);
  for (const d of candidates) {
    const r = pickCommuneResource(d.resources ?? []);
    if (r) return { id: r.id, url: r.url ?? "", title: r.title ?? "", format: r.format ?? "", dataset: d.slug };
  }
  return null;
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

interface Columns {
  cCom: string;
  cDep: string | null;
  shortCodes: boolean;
}

function detectColumns(cols: string[], sampleRow: Record<string, unknown> | undefined, label: string): Columns {
  const cCom = findCol(cols, /^code (de la )?commune$/i, /^code ?commune$/i, /^codecommune$/i);
  const cDep = findCol(cols, /^code (du )?d[ée]partement$/i, /^code ?d[ée]partement$/i);
  if (!cCom) throw new Error(`Colonne « code commune » introuvable (${label})`);
  // Anciens formats : code département + code commune sur 3 caractères.
  const shortCodes = String(sampleRow?.[cCom] ?? "").length <= 3;
  return { cCom, cDep, shortCodes };
}

/**
 * Certains fichiers du ministère (ex. présidentielle 2022) ne nomment que le
 * premier bloc candidat (« N°Panneau, Sexe, Nom, Prénom, Voix, % Voix/Ins,
 * % Voix/Exp ») ; les blocs suivants arrivent dans des colonnes sans en-tête
 * (`__parsed_extra` pour Papa Parse). On les renomme « Nom_x101 », « Voix_x101 »…
 */
export function expandExtraColumns(rows: Record<string, unknown>[], header: string[]): Record<string, unknown>[] {
  const gs = header.findIndex((h) => /^(n°\s*panneau|n°\s*liste|code nuance|sexe)$/i.test(h.trim()));
  if (gs < 0) return rows;
  const g = header.length - gs;
  const ni = header.findIndex((h, i) => i >= gs && /^(nom|libell[ée].*liste|nuance)$/i.test(h.trim()));
  const vi = header.findIndex((h, i) => i >= gs && /^voix$/i.test(h.trim()));
  if (ni < 0 || vi < 0 || g <= 0) return rows;
  return rows.map((r) => {
    const extra = r.__parsed_extra as unknown[] | undefined;
    if (!Array.isArray(extra) || !extra.length) return r;
    const o: Record<string, unknown> = { ...r };
    delete o.__parsed_extra;
    for (let k = 0; (k + 1) * g <= extra.length; k++) {
      o[`Nom_x${101 + k}`] = extra[k * g + (ni - gs)];
      o[`Voix_x${101 + k}`] = extra[k * g + (vi - gs)];
    }
    return o;
  });
}

const normDep = (v: unknown) => String(v ?? "").trim().padStart(2, "0");

/** Code INSEE complet d'une ligne de résultats. */
function rowCode(r: Record<string, unknown>, c: Columns, dep: string) {
  const raw = String(r[c.cCom] ?? "").trim();
  if (!c.shortCodes) return raw.padStart(5, "0");
  const d = c.cDep ? normDep(r[c.cDep]) : dep;
  return d + raw.padStart(3, "0").slice(d.length === 3 ? -2 : -3);
}

function buildResults(
  e: ElectionConfig,
  comRows: Record<string, unknown>[],
  depRows: Record<string, unknown>[] | null,
  c: Columns,
  codeInsee: string,
  dep: string,
  src: { com: string; dep: string; retrievedAt: string },
): ElectionResult[] {
  const out: ElectionResult[] = [];
  const agg = aggregateRows(comRows);
  if (!agg) throw new Error(`Aucun résultat pour la commune (${e.label})`);
  out.push({ election: e, level: "commune", code: codeInsee, ...agg, sourceUrl: src.com, retrievedAt: src.retrievedAt });
  if (depRows?.length) {
    const a2 = aggregateRows(depRows);
    if (a2) {
      const groups = new Map<string, Record<string, unknown>[]>();
      for (const r of depRows) {
        const k = rowCode(r, c, dep);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }
      const byCommune = [...groups.entries()]
        .map(([code, rows]) => ({ code, a: aggregateRows(rows) }))
        .filter((x) => x.a)
        .map((x) => ({ code: x.code, inscrits: x.a!.inscrits, votants: x.a!.votants }));
      out.push({ election: e, level: "departement", code: dep, ...a2, byCommune, sourceUrl: src.dep, retrievedAt: src.retrievedAt });
    }
  }
  return out;
}

/**
 * Collecte un scrutin : via l'API tabulaire de data.gouv.fr si la ressource y
 * est indexée, sinon par téléchargement du fichier CSV (mis en cache).
 */
export async function collectElection(
  http: TrackedHttp,
  e: ElectionConfig,
  codeInsee: string,
  dep: string,
): Promise<ElectionResult[]> {
  const res = await resolveResource(http, e);
  if (!res) throw new Error(`Ressource « résultats par commune » introuvable pour ${e.label}`);

  // 1. API tabulaire
  try {
    const probe = await http.json<{ data?: Record<string, unknown>[] }>(`${TABULAR}/${res.id}/data/?page_size=1`, { retries: 0 });
    const first = probe.data?.data?.[0];
    const cols = Object.keys(first ?? {}).filter((x) => x !== "__id");
    const c = detectColumns(cols, first, e.label);
    const comFilters: Record<string, string> =
      c.shortCodes && c.cDep ? { [c.cDep]: dep, [c.cCom]: codeInsee.slice(dep.length === 3 ? 3 : 2) } : { [c.cCom]: codeInsee };
    const com = await tabularRows(http, res.id, comFilters, 2);
    const depRows = c.cDep ? await tabularRows(http, res.id, { [c.cDep]: dep }, 40) : null;
    return buildResults(e, com.rows, depRows?.rows ?? null, c, codeInsee, dep, { com: com.url, dep: depRows?.url ?? com.url, retrievedAt: com.retrievedAt });
  } catch (err) {
    if (!res.url) throw err;
    http.notes.push(`API tabulaire indisponible pour ${e.id} : téléchargement du fichier`);
  }

  // 2. Fichier complet
  const f = await http.text(res.url, { timeoutMs: 180000, retries: 1, decodeLatin1: true });
  const parsed = Papa.parse<Record<string, unknown>>(f.data, { header: true, skipEmptyLines: true, delimiter: "" });
  const rows = expandExtraColumns(parsed.data, parsed.meta.fields ?? []);
  if (!rows.length) throw new Error(`Fichier vide ou illisible (${e.label})`);
  const c = detectColumns(Object.keys(rows[0]), rows[0], e.label);
  const depRows = c.cDep ? rows.filter((r) => normDep(r[c.cDep!]) === dep) : rows.filter((r) => rowCode(r, c, dep).startsWith(dep));
  const comRows = depRows.filter((r) => rowCode(r, c, dep) === codeInsee);
  return buildResults(e, comRows, depRows, c, codeInsee, dep, { com: res.url, dep: res.url, retrievedAt: f.retrievedAt });
}
