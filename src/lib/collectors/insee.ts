import { config } from "../config";
import type { TrackedHttp } from "./context";

/**
 * Connecteur INSEE — API Melodi (https://api.insee.fr/melodi).
 *
 * Melodi diffuse les jeux de données INSEE au format « cube » : chaque
 * observation porte un ensemble de dimensions (GEO, TIME_PERIOD, SEX, AGE…)
 * et une ou plusieurs mesures. Ce module :
 *  - télécharge toutes les observations d'un jeu pour un territoire donné ;
 *  - tente plusieurs syntaxes de code géographique (avec ou sans millésime
 *    de géographie) car elles varient selon les jeux ;
 *  - récupère si possible les libellés des modalités (`/range`) ;
 *  - fournit des sélecteurs tolérants (code exact, expression régulière sur
 *    le code ou sur le libellé), toutes les autres dimensions étant fixées
 *    à leur modalité « total » (`_T`).
 *
 * Les correspondances indicateur → modalités sont déclarées dans
 * `src/lib/analysis/insee-indicators.ts` ; si une modalité n'est pas
 * trouvée, l'indicateur est déclaré manquant (jamais estimé).
 * Le script `npm run check:sources` affiche les modalités réellement
 * renvoyées pour faciliter la maintenance.
 */

export const MELODI = "https://api.insee.fr/melodi";
// ~28 requêtes/minute par défaut, sous la limite publique de 30 (configurable).
const MIN_INTERVAL = () => config.inseeMinIntervalMs;

export interface MelodiObservation {
  dims: Record<string, string>;
  value: number | null;
}

export interface MelodiDataset {
  id: string;
  geo: string;
  url: string;
  retrievedAt: string;
  observations: MelodiObservation[];
  dimValues: Map<string, Set<string>>;
  labels: Map<string, Map<string, string>>;
}

type GeoKind = "COM" | "EPCI" | "DEP" | "REG" | "FRANCE";

const preferredFormat = new Map<GeoKind, number>();

export function geoCandidates(kind: GeoKind, code: string): string[] {
  if (kind === "FRANCE") return ["FRANCE-F", "FRANCE-FE", "FE-1"];
  const years = ["2025", "2024", "2026", "2023"];
  return [`${kind}-${code}`, ...years.map((y) => `${y}-${kind}-${code}`)];
}

interface RawObs {
  dimensions?: Record<string, string>;
  measures?: Record<string, { value?: number | string | null }>;
}
interface RawPage {
  observations?: RawObs[];
  paging?: { next?: string | null; isLast?: boolean };
}

export function parseObservations(raw: RawObs[] | undefined): MelodiObservation[] {
  return (raw ?? []).map((o) => {
    const measures = o.measures ?? {};
    const key = Object.keys(measures).find((k) => /OBS_VALUE/.test(k)) ?? Object.keys(measures)[0];
    const v = key ? measures[key]?.value : null;
    const num = v == null || v === "" ? null : Number(v);
    return { dims: o.dimensions ?? {}, value: num != null && Number.isFinite(num) ? num : null };
  });
}

/** Télécharge les observations d'un jeu de données pour un territoire. */
export async function loadDataset(
  http: TrackedHttp,
  datasetId: string,
  kind: GeoKind,
  code: string,
): Promise<MelodiDataset | null> {
  const all = geoCandidates(kind, code);
  const pref = preferredFormat.get(kind);
  // Lorsqu'une syntaxe a déjà fonctionné pour ce type de territoire, seule celle-ci est essayée.
  const candidates = pref != null ? [all[pref]] : all;
  for (const geo of candidates) {
    const firstUrl = `${MELODI}/data/${datasetId}?GEO=${encodeURIComponent(geo)}&maxResult=10000`;
    let url: string | null = firstUrl;
    const obs: MelodiObservation[] = [];
    let retrievedAt = "";
    let pages = 0;
    while (url && pages < 20) {
      const r: { data: RawPage | null; retrievedAt: string } = await http.json<RawPage>(url, {
        minIntervalMs: MIN_INTERVAL(),
        allow404: true,
        timeoutMs: 45000,
      });
      retrievedAt = r.retrievedAt;
      pages++;
      obs.push(...parseObservations(r.data?.observations));
      const next = r.data?.paging?.next;
      url = next && !r.data?.paging?.isLast ? (next.startsWith("http") ? next : MELODI + next) : null;
    }
    if (obs.length === 0) continue;
    preferredFormat.set(kind, all.indexOf(geo));
    const dimValues = new Map<string, Set<string>>();
    for (const o of obs)
      for (const [k, v] of Object.entries(o.dims)) {
        if (!dimValues.has(k)) dimValues.set(k, new Set());
        dimValues.get(k)!.add(v);
      }
    const labels = await loadLabels(http, datasetId);
    return { id: datasetId, geo, url: firstUrl, retrievedAt, observations: obs, dimValues, labels };
  }
  return null;
}

const labelsCache = new Map<string, Map<string, Map<string, string>>>();

interface RawRange {
  range?: { dimension?: { id?: string }; values?: { code?: string; id?: string; label?: Record<string, string> | string }[] }[];
}

/** Libellés des modalités (facultatif : en cas d'échec, seules les règles sur les codes s'appliquent). */
async function loadLabels(http: TrackedHttp, datasetId: string) {
  if (labelsCache.has(datasetId)) return labelsCache.get(datasetId)!;
  const out = new Map<string, Map<string, string>>();
  try {
    const r = await http.json<RawRange>(`${MELODI}/range/${datasetId}`, { minIntervalMs: MIN_INTERVAL(), allow404: true, retries: 0 });
    for (const d of r.data?.range ?? []) {
      const dim = d.dimension?.id;
      if (!dim) continue;
      const m = new Map<string, string>();
      for (const v of d.values ?? []) {
        const code = v.code ?? v.id;
        const label = typeof v.label === "string" ? v.label : v.label?.fr ?? v.label?.["fr-FR"] ?? Object.values(v.label ?? {})[0];
        if (code && label) m.set(code, label);
      }
      out.set(dim, m);
    }
  } catch {
    /* libellés indisponibles : non bloquant */
  }
  labelsCache.set(datasetId, out);
  return out;
}

/* ------------------------------------------------------------- sélecteurs */

export interface CodeSpec {
  codes?: string[];
  codeRe?: RegExp;
  labelRe?: RegExp;
}

/** Trouve la modalité d'une dimension répondant à la spécification. */
export function resolveCode(ds: MelodiDataset, dim: string, spec: CodeSpec | string): string | null {
  const values = ds.dimValues.get(dim);
  if (!values) return null;
  if (typeof spec === "string") return values.has(spec) ? spec : null;
  for (const c of spec.codes ?? []) if (values.has(c)) return c;
  if (spec.codeRe) for (const v of values) if (spec.codeRe.test(v)) return v;
  if (spec.labelRe) {
    const lab = ds.labels.get(dim);
    if (lab) for (const v of values) if (spec.labelRe.test(lab.get(v) ?? "")) return v;
  }
  return null;
}

/** Trouve la première dimension (parmi des candidates) qui existe dans le jeu. */
export function resolveDim(ds: MelodiDataset, candidates: string[]): string | null {
  for (const c of candidates) if (ds.dimValues.has(c)) return c;
  return null;
}

const FIXED = new Set(["GEO", "TIME_PERIOD"]);

/**
 * Modalités retenues par défaut pour les dimensions sans total (`_T`),
 * constatées sur l'API Melodi (voir `npm run check:sources -- --insee`).
 * Ex. : les jeux emploi n'ont pas d'âge « total » mais « Y_GE15 » / « Y15T64 » ;
 * le jeu logement mesure des logements (`DWELLINGS`) ou des personnes.
 */
export const DEFAULT_MODALITIES: Record<string, string[]> = {
  AGE: ["_T", "Y_GE15", "Y15T64"],
  RP_MEASURE: ["POP", "DWELLINGS", "NBEMP"],
  FREQ: ["A"],
};

/**
 * Renvoie les observations correspondant aux critères. Les autres dimensions
 * sont fixées à leur total (`_T`) lorsqu'il existe, sinon à une modalité par
 * défaut (`DEFAULT_MODALITIES`). Si, après ce filtrage, une dimension varie
 * encore, la sélection est ambiguë : elle est rejetée (null) plutôt que de
 * risquer un double comptage. Une dimension qui ne prend qu'une valeur parmi
 * les observations retenues (ex. l'unité d'une mesure Filosofi) n'est pas ambiguë.
 */
export function selectObs(ds: MelodiDataset, criteria: Record<string, string>): MelodiObservation[] | null {
  let obs = ds.observations.filter((o) => {
    for (const [dim, vals] of ds.dimValues) {
      if (FIXED.has(dim)) continue;
      const want = criteria[dim] ?? (vals.has("_T") ? "_T" : undefined);
      if (want !== undefined && o.dims[dim] !== want) return false;
    }
    return true;
  });
  for (const dim of ds.dimValues.keys()) {
    if (FIXED.has(dim) || dim in criteria) continue;
    const present = new Set(obs.map((o) => o.dims[dim]));
    if (present.size <= 1) continue;
    const pref = (DEFAULT_MODALITIES[dim] ?? []).find((v) => present.has(v));
    if (!pref) return null;
    obs = obs.filter((o) => o.dims[dim] === pref);
  }
  // Plusieurs observations pour un même millésime = sélection non univoque.
  const years = obs.map((o) => o.dims.TIME_PERIOD ?? "");
  if (new Set(years).size !== years.length) return null;
  return obs;
}

/** Valeur du dernier millésime (ou d'un millésime donné). */
export function latestValue(
  ds: MelodiDataset,
  criteria: Record<string, string>,
  year?: string,
): { value: number; year: string } | null {
  const obs = selectObs(ds, criteria);
  if (!obs) return null;
  const valid = obs.filter((o) => o.value != null && (!year || o.dims.TIME_PERIOD === year));
  if (!valid.length) return null;
  valid.sort((a, b) => (b.dims.TIME_PERIOD ?? "").localeCompare(a.dims.TIME_PERIOD ?? ""));
  return { value: valid[0].value!, year: valid[0].dims.TIME_PERIOD ?? "" };
}

/** Série temporelle complète. */
export function timeSeries(ds: MelodiDataset, criteria: Record<string, string>) {
  const obs = selectObs(ds, criteria) ?? [];
  const m = new Map<string, number>();
  for (const o of obs) if (o.value != null && o.dims.TIME_PERIOD) m.set(o.dims.TIME_PERIOD, o.value);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([x, y]) => ({ x, y }));
}

/* ------------------------------------------------------------- âges */

export interface AgeBand {
  code: string;
  min: number;
  max: number; // borne supérieure exclusive, Infinity pour « et plus »
}

/** Interprète les codes d'âge SDMX de l'INSEE (Y_LT15, Y15T29, Y_GE75, Y30…). */
export function parseAgeCode(code: string): AgeBand | null {
  let m = code.match(/^Y_LT(\d+)$/);
  if (m) return { code, min: 0, max: Number(m[1]) };
  m = code.match(/^Y(\d+)T(\d+)$/);
  if (m) return { code, min: Number(m[1]), max: Number(m[2]) + 1 };
  m = code.match(/^Y_GE(\d+)$/);
  if (m) return { code, min: Number(m[1]), max: Infinity };
  m = code.match(/^Y(\d+)$/);
  if (m) return { code, min: Number(m[1]), max: Number(m[1]) + 1 };
  return null;
}

/**
 * Choisit, parmi les tranches d'âge disponibles, une partition sans
 * recouvrement couvrant 0 → ∞ en privilégiant les tranches les plus larges
 * (lisibilité) avec un nombre de tranches compris entre 4 et 10.
 */
export function choosePartition(bands: AgeBand[]): AgeBand[] | null {
  const sorted = [...bands].sort((a, b) => a.min - b.min || a.max - b.max);
  let best: AgeBand[] | null = null;
  const dfs = (from: number, acc: AgeBand[]) => {
    if (acc.length > 10) return;
    if (from === Infinity) {
      if (acc.length >= 4 && (!best || score(acc) > score(best))) best = [...acc];
      return;
    }
    for (const b of sorted) if (b.min === from && b.max > from) dfs(b.max, [...acc, b]);
  };
  const score = (p: AgeBand[]) => -Math.abs(p.length - 6);
  dfs(0, []);
  return best;
}

export function ageLabel(b: AgeBand) {
  if (b.min === 0) return `Moins de ${b.max} ans`;
  if (b.max === Infinity) return `${b.min} ans et plus`;
  return `${b.min}-${b.max - 1} ans`;
}
