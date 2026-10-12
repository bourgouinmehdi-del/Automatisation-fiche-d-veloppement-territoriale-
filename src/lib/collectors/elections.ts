import { createReadStream, promises as fsp } from "node:fs";
import { cachedExtract, heavyLane } from "../runtime";
import Papa from "papaparse";
import type { TrackedHttp } from "./context";

/**
 * Résultats électoraux officiels (ministère de l'Intérieur, publiés sur data.gouv.fr),
 * à l'échelle de la commune et du bureau de vote.
 *
 * Accès : l'API de data.gouv.fr permet de retrouver les ressources « résultats
 * par commune » et « résultats par bureau de vote » d'un scrutin ; on interroge
 * l'API tabulaire si la ressource y est indexée, sinon on lit le fichier
 * national en flux en ne gardant que le département (extraction mise en cache).
 *
 * Seuls des résultats AGRÉGÉS (commune, bureau de vote) sont manipulés ;
 * aucune donnée individuelle n'est collectée.
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

/**
 * Scrutins antérieurs, lus seulement par bureau de vote : ils servent à mesurer
 * l'évolution du vote (européennes 2019 → 2024, présidentielle 2017 → 2022).
 */
export const HISTORICAL_ELECTIONS: ElectionConfig[] = [
  {
    id: "EU19",
    label: "Européennes 2019",
    date: "2019-05-26",
    dataset: "resultats-des-elections-europeennes-2019",
    search: "élections européennes 2019 résultats définitifs",
    titleRe: /europ[ée]ennes.*2019/i,
  },
  {
    id: "PR17T1",
    label: "Présidentielle 2017 — 1er tour",
    date: "2017-04-23",
    dataset: "election-presidentielle-des-23-avril-et-7-mai-2017-resultats-definitifs-du-1er-tour-par-bureaux-de-vote",
    search: "élection présidentielle 2017 résultats définitifs premier tour bureaux de vote",
    titleRe: /pr[ée]sidentielle.*2017.*(1er|premier) tour/i,
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
  /** Résultats par commune du département (niveau départemental uniquement). */
  byCommune?: { code: string; inscrits: number; votants: number; exprimes: number; candidates: { label: string; voix: number }[] }[];
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
      /^libell[ée] (abr[ée]g[ée] )?(de (la )?)?liste/i,
      /^nuance (candidat|liste)?/i,
      /^nom (candidat)?/i,
      /^nom(_x\d+)?$/i,
    );
  const tot = { inscrits: 0, votants: 0, abstentions: 0, blancs: 0, nuls: 0, exprimes: 0 };
  let hasBlancs = !!cBla;
  const cand = new Map<string, number>();
  // Format « long » (une ligne par candidat et par bureau, ex. présidentielle 2017) :
  // les totaux du bureau sont répétés sur chaque ligne et ne sont comptés qu'une fois.
  const keyCols = cols.filter((c) => /^code/i.test(c));
  const seen = new Set<string>();
  for (const r of rows) {
    const key = keyCols.length ? keyCols.map((c) => String(r[c] ?? "")).join("|") : null;
    const first = key == null || !seen.has(key);
    if (key != null) seen.add(key);
    for (const vc of voixCols) {
      const lc = labelFor(suffix(vc));
      const label = lc ? String(r[lc] ?? "").trim() : "";
      const v = n(r[vc]);
      if (!label || v == null) continue;
      cand.set(label, (cand.get(label) ?? 0) + v);
    }
    if (!first) continue;
    tot.inscrits += n(r[cIns]) ?? 0;
    tot.exprimes += n(r[cExp]) ?? 0;
    if (cVot) tot.votants += n(r[cVot]) ?? 0;
    if (cAbs) tot.abstentions += n(r[cAbs]) ?? 0;
    if (cBla) tot.blancs += n(r[cBla]) ?? 0;
    else hasBlancs = false;
    if (cNul) tot.nuls += n(r[cNul]) ?? 0;
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
  filesize?: number;
}
interface DgDataset {
  slug: string;
  title?: string;
  organization?: { name?: string } | null;
  resources?: DgResource[];
}

export type ResultLevel = "commune" | "bureau";

const BV_RE = /bureau|burvot|b\.?\s?vote|\bbv\b/i;

/** Choisit la ressource tabulaire (CSV/TXT) « par commune » ou « par bureau de vote » d'un jeu. */
export function pickResource(resources: DgResource[], level: ResultLevel = "commune"): DgResource | null {
  const tab = (x: DgResource) => /csv|txt/i.test(x.format ?? "") || /\.(csv|txt)$/i.test(x.url ?? "");
  const ok =
    level === "bureau"
      ? (x: DgResource) => BV_RE.test(x.title ?? "") || BV_RE.test(x.url ?? "")
      : (x: DgResource) => /commun|subcom/i.test(x.title ?? "") && !BV_RE.test(x.title ?? "") && !/circonscription|d[ée]partement|r[ée]gion/i.test(x.title ?? "");
  return resources.find((x) => ok(x) && tab(x)) ?? null;
}

/** Rétrocompatibilité. */
export const pickCommuneResource = (r: DgResource[]) => pickResource(r, "commune");

/**
 * Trouve la ressource d'un scrutin :
 * 1. identifiant de ressource configuré (niveau commune) ;
 * 2. jeu de données désigné par son slug ;
 * 3. à défaut, recherche plein texte sur data.gouv.fr, limitée aux jeux publiés
 *    par le ministère de l'Intérieur.
 */
export async function resolveResource(http: TrackedHttp, e: ElectionConfig, level: ResultLevel = "commune"): Promise<ResourceInfo | null> {
  const candidates: DgDataset[] = [];
  const bySlug = await http.json<DgDataset>(`${DATAGOUV}/datasets/${e.dataset}/`, { allow404: true });
  if (bySlug.data?.resources) candidates.push(bySlug.data);
  if (e.resourceId && level === "commune") {
    const r = candidates.flatMap((d) => d.resources ?? []).find((x) => x.id === e.resourceId);
    return { id: e.resourceId, url: r?.url ?? "", title: r?.title ?? e.resourceId, format: r?.format ?? "csv", dataset: e.dataset };
  }
  if (!candidates.some((d) => pickResource(d.resources ?? [], level))) {
    const search = await http.json<{ data?: DgDataset[] }>(`${DATAGOUV}/datasets/?q=${encodeURIComponent(e.search)}&page_size=20`);
    for (const d of search.data?.data ?? [])
      if (/int[ée]rieur/i.test(d.organization?.name ?? "") && e.titleRe.test(d.title ?? "")) candidates.push(d);
  }
  for (const d of candidates) {
    const r = pickResource(d.resources ?? [], level);
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
  cBv: string | null;
  shortCodes: boolean;
}

function detectColumns(cols: string[], sampleRow: Record<string, unknown> | undefined, label: string): Columns {
  const cCom = findCol(cols, /^code (de la )?commune$/i, /^code ?commune$/i, /^codecommune$/i);
  const cDep = findCol(cols, /^code (du )?d[ée]partement$/i, /^code ?d[ée]partement$/i);
  const cBv = findCol(cols, /^code (du )?b\.?\s?vote$/i, /^code ?bv$/i, /^code (du )?bureau( de vote)?$/i, /^bureau de vote$/i);
  if (!cCom) throw new Error(`Colonne « code commune » introuvable (${label})`);
  // Anciens formats : code département + code commune sur 3 caractères.
  const shortCodes = String(sampleRow?.[cCom] ?? "").length <= 3;
  return { cCom, cDep, cBv, shortCodes };
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

/**
 * Séparateur déterminé sur la ligne d'en-tête : les fichiers du ministère
 * utilisent « ; » mais leurs valeurs contiennent des virgules décimales
 * (« 40,00 »), ce qui trompe la détection automatique de Papa Parse.
 */
export function detectDelimiter(text: string): string {
  const nl = text.search(/\r?\n/);
  const head = text.slice(0, nl < 0 ? 2000 : nl);
  const count = (d: string) => head.split(d).length - 1;
  return [";", "\t", ",", "|"].reduce((best, d) => (count(d) > count(best) ? d : best), ";");
}

/** Filtre ligne à ligne : ne garde que les lignes d'un département. */
function departmentFilter(dep: string, label: string) {
  const rows: Record<string, unknown>[] = [];
  let fields: string[] = [];
  let c: Columns | null = null;
  const step = (res: Papa.ParseStepResult<Record<string, unknown>>) => {
    const r = res.data;
    if (!c) {
      fields = res.meta.fields ?? Object.keys(r);
      c = detectColumns(fields, r, label);
    }
    const keep = c.cDep ? normDep(r[c.cDep]) === dep : rowCode(r, c, dep).startsWith(dep);
    if (keep) rows.push(r);
  };
  return { step, result: () => ({ rows, fields }) };
}

/** Lit un CSV de résultats et ne garde que les lignes d'un département. */
export function filterCsv(text: string, dep: string, label: string) {
  const f = departmentFilter(dep, label);
  Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true, delimiter: detectDelimiter(text), step: f.step });
  return f.result();
}

/** Encodage d'un fichier : UTF-8 s'il est valide, sinon ISO-8859-1 (vérifié en flux). */
export async function detectFileEncoding(file: string): Promise<"utf8" | "latin1"> {
  const dec = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) dec.decode(chunk as Buffer, { stream: true });
    dec.decode();
    return "utf8";
  } catch {
    return "latin1";
  }
}

/**
 * Variante en flux de `filterCsv` pour un fichier sur disque : la mémoire
 * utilisée ne dépend que du nombre de lignes conservées (un département).
 */
export async function filterCsvFile(file: string, dep: string, label: string) {
  const encoding = await detectFileEncoding(file);
  const fh = await fsp.open(file, "r");
  let head: string;
  try {
    const buf = Buffer.alloc(16384);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead).toString(encoding);
  } finally {
    await fh.close();
  }
  const f = departmentFilter(dep, label);
  await new Promise<void>((resolve, reject) => {
    Papa.parse<Record<string, unknown>>(createReadStream(file, { encoding }) as unknown as File, {
      header: true,
      skipEmptyLines: true,
      delimiter: detectDelimiter(head.replace(/^\uFEFF/, "")),
      transformHeader: (h: string) => h.replace(/^\uFEFF/, ""),
      step: f.step,
      complete: () => resolve(),
      error: (e: Error) => reject(e),
    });
  });
  return f.result();
}

const normDep = (v: unknown) => String(v ?? "").trim().padStart(2, "0");

/** Code INSEE complet d'une ligne de résultats. */
function rowCode(r: Record<string, unknown>, c: Columns, dep: string) {
  const raw = String(r[c.cCom] ?? "").trim();
  if (!c.shortCodes) return raw.padStart(5, "0");
  const d = c.cDep ? normDep(r[c.cDep]) : dep;
  return d + raw.padStart(3, "0").slice(d.length === 3 ? -2 : -3);
}

/** Numéro de bureau normalisé (« 0003 », « 3 », « 60159_3 » → « 3 »). */
export function normBv(v: unknown): string {
  const s = String(v ?? "").trim();
  const last = s.split(/[_\-\s]/).pop() ?? s;
  const digits = last.replace(/^0+(?=\d)/, "");
  return digits || s;
}


/**
 * Lignes d'un département pour un scrutin et un niveau (commune ou bureau de vote).
 * Ordre : extraction en mémoire → API tabulaire → fichier national lu en flux.
 */
async function departmentRows(http: TrackedHttp, e: ElectionConfig, dep: string, level: ResultLevel) {
  // Résultats d'élections passées : extraction départementale gardée 30 jours sur disque.
  return cachedExtract(`elections|${e.id}|${level}|${dep}`, 24 * 30, () => heavyLane.run(() => departmentRowsFresh(http, e, dep, level)));
}

async function departmentRowsFresh(http: TrackedHttp, e: ElectionConfig, dep: string, level: ResultLevel) {
  const res = await resolveResource(http, e, level);
  if (!res) throw new Error(`Ressource « résultats par ${level === "bureau" ? "bureau de vote" : "commune"} » introuvable pour ${e.label}`);
  let out: { rows: Record<string, unknown>[]; c: Columns; url: string; retrievedAt: string } | null = null;
  try {
    const probe = await http.json<{ data?: Record<string, unknown>[] }>(`${TABULAR}/${res.id}/data/?page_size=1`, { retries: 0 });
    const first = probe.data?.data?.[0];
    const c = detectColumns(Object.keys(first ?? {}).filter((x) => x !== "__id"), first, e.label);
    if (!c.cDep) throw new Error("pas de colonne département");
    let t = await tabularRows(http, res.id, { [c.cDep]: dep }, 150);
    // Certains fichiers écrivent « 1 » au lieu de « 01 ».
    if (!t.rows.length && dep.startsWith("0")) t = await tabularRows(http, res.id, { [c.cDep]: dep.slice(1) }, 150);
    if (!t.rows.length) throw new Error("aucune ligne");
    // L'API tabulaire perd les colonnes sans en-tête (blocs candidats 2 à N du
    // format 2022) : si un seul candidat est lisible, on bascule sur le fichier.
    const probeAgg = aggregateRows(t.rows.slice(0, 200));
    if (!probeAgg || probeAgg.candidates.length < 2) throw new Error("colonnes candidats incomplètes dans l'API tabulaire");
    out = { rows: t.rows, c, url: t.url, retrievedAt: t.retrievedAt };
  } catch {
    if (!res.url) throw new Error(`Ressource sans URL de téléchargement (${e.label})`);
    http.notes.push(`${e.id} (${level}) : lecture du fichier national`);
    const f = await http.file(res.url, { timeoutMs: 900000, retries: 1 });
    const { rows: raw, fields } = await filterCsvFile(f.data, dep, e.label);
    const rows = expandExtraColumns(raw, fields);
    if (!rows.length) throw new Error(`Aucune ligne pour le département ${dep} (${e.label})`);
    out = { rows, c: detectColumns(Object.keys(rows[0]), rows[0], e.label), url: res.url, retrievedAt: f.retrievedAt };
  }
  return out;
}

/** Résultats de la commune et du département (avec le détail par commune). */
export async function collectElection(http: TrackedHttp, e: ElectionConfig, codeInsee: string, dep: string): Promise<ElectionResult[]> {
  const d = await departmentRows(http, e, dep, "commune");
  const comRows = d.rows.filter((r) => rowCode(r, d.c, dep) === codeInsee);
  const agg = aggregateRows(comRows);
  if (!agg) throw new Error(`Aucun résultat pour la commune (${e.label})`);
  const out: ElectionResult[] = [{ election: e, level: "commune", code: codeInsee, ...agg, sourceUrl: d.url, retrievedAt: d.retrievedAt }];
  const a2 = aggregateRows(d.rows);
  if (a2) {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const r of d.rows) {
      const k = rowCode(r, d.c, dep);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    const byCommune = [...groups.entries()]
      .map(([code, rows]) => ({ code, a: aggregateRows(rows) }))
      .filter((x) => x.a)
      .map((x) => ({ code: x.code, inscrits: x.a!.inscrits, votants: x.a!.votants, exprimes: x.a!.exprimes, candidates: x.a!.candidates }));
    out.push({ election: e, level: "departement", code: dep, ...a2, byCommune, sourceUrl: d.url, retrievedAt: d.retrievedAt });
  }
  return out;
}

export interface BureauResult {
  election: ElectionConfig;
  bv: string;
  inscrits: number;
  votants: number;
  abstentions: number;
  exprimes: number;
  blancs: number | null;
  nuls: number | null;
  candidates: { label: string; voix: number }[];
  sourceUrl: string;
  retrievedAt: string;
}

/** Résultats par bureau de vote d'une commune. */
export async function collectBureaux(http: TrackedHttp, e: ElectionConfig, codeInsee: string, dep: string): Promise<BureauResult[]> {
  const d = await departmentRows(http, e, dep, "bureau");
  if (!d.c.cBv) throw new Error(`Colonne « bureau de vote » introuvable (${e.label})`);
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of d.rows) {
    if (rowCode(r, d.c, dep) !== codeInsee) continue;
    const k = normBv(r[d.c.cBv]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const out: BureauResult[] = [];
  for (const [bv, rows] of groups) {
    const a = aggregateRows(rows);
    if (a) out.push({ election: e, bv, ...a, sourceUrl: d.url, retrievedAt: d.retrievedAt });
  }
  if (!out.length) throw new Error(`Aucun bureau de vote trouvé pour la commune (${e.label})`);
  return out.sort((x, y) => Number(x.bv) - Number(y.bv) || x.bv.localeCompare(y.bv));
}
