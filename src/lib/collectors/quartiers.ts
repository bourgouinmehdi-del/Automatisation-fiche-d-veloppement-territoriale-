import proj4 from "proj4";
import type { TrackedHttp } from "./context";
import { clean, findResource, num, tabular } from "./datagouv";
import { JsonScanner, geoJsonFeatures } from "./json-stream";
import { cachedExtract, heavyLane } from "../runtime";
import { zipCsvRows, zipLines } from "./zip";

/**
 * Quartiers infracommunaux : quartiers prioritaires de la politique de la
 * ville (QPV 2024) et IRIS, avec leurs contours et leurs indicateurs
 * (revenu médian, pauvreté, âge, chômage, locataires et HLM).
 *
 * Sources (relevées en octobre 2026) :
 *  - liste et contours des QPV 2024 : ANCT, jeu data.gouv.fr
 *    « quartiers-prioritaires-de-la-politique-de-la-ville-qpv » ;
 *  - indicateurs QPV : INSEE (Filosofi 2021 et estimations démographiques
 *    2022 à la géographie QP2024) ;
 *  - contours IRIS : IGN, service WFS de la Géoplateforme (IRIS… GE) ;
 *  - indicateurs IRIS : INSEE, bases infracommunales du recensement 2021
 *    et Filosofi 2021 à l'IRIS (fichiers nationaux lus en flux).
 *
 * Les adresses des fichiers INSEE changent à chaque millésime : elles sont
 * réunies ci-dessous (et surchargeables par variables d'environnement).
 */

export const QUARTIERS_SOURCES = {
  qpvDataset: "quartiers-prioritaires-de-la-politique-de-la-ville-qpv",
  qpvListFallback: {
    id: "4c6bb7f3-97b6-4834-8a3a-f5f8b3e6735b",
    url: "https://static.data.gouv.fr/resources/quartiers-prioritaires-de-la-politique-de-la-ville-qpv/20260721-095036/listeqp2024-cog2025.csv",
  },
  qpvGeojsonFallback: {
    id: "942d4ee8-8142-4556-8ea1-335537ce1119",
    url: "https://static.data.gouv.fr/resources/quartiers-prioritaires-de-la-politique-de-la-ville-qpv/20260115-204323/qpv-2024-geojson.zip",
  },
  qpvFilosofi: process.env.INSEE_QPV_FILOSOFI_URL ?? "https://www.insee.fr/fr/statistiques/fichier/8243167/revenus_pauvrete_2021_qp24_v2_csv.zip",
  qpvRp: process.env.INSEE_QPV_RP_URL ?? "https://www.insee.fr/fr/statistiques/fichier/8742545/estimations-demographiques_2022_QPV2024_csv.zip",
  irisWfs: "https://data.geopf.fr/wfs/ows",
  irisTypename: "STATISTICALUNITS.IRISGE:iris_ge",
  irisPop: process.env.INSEE_IRIS_POP_URL ?? "https://www.insee.fr/fr/statistiques/fichier/8268806/base-ic-evol-struct-pop-2021_csv.zip",
  irisLogement: process.env.INSEE_IRIS_LOGEMENT_URL ?? "https://www.insee.fr/fr/statistiques/fichier/8268838/base-ic-logement-2021_csv.zip",
  irisActivite: process.env.INSEE_IRIS_ACTIVITE_URL ?? "https://www.insee.fr/fr/statistiques/fichier/8268843/base-ic-activite-residents-2021_csv.zip",
  irisFilosofi: process.env.INSEE_IRIS_FILOSOFI_URL ?? "https://www.insee.fr/fr/statistiques/fichier/8229323/BASE_TD_FILO_IRIS_2021_DISP_CSV.zip",
};

export interface QuartierStats {
  population?: number | null;
  revenu?: number | null;
  pauvrete?: number | null;
  /** Part des moins de 25 ans (ou des moins de 30 ans, cf. `jeunesLabel`). */
  jeunes?: number | null;
  jeunesLabel?: string;
  /** Part des 60 ans et plus. */
  ages?: number | null;
  chomage?: number | null;
  locataires?: number | null;
  hlm?: number | null;
}

export interface Quartier {
  kind: "qpv" | "iris";
  code: string;
  nom: string;
  geometry: GeoJSON.Geometry | null;
  stats: QuartierStats;
  /** Type d'IRIS (H : habitat, A : activité, D : divers, Z : commune non découpée). */
  type?: string;
}

export interface QuartiersResult {
  quartiers: Quartier[];
  urls: string[];
  retrievedAt: string;
  notes: string[];
}

/* ----------------------------------------------------------------- outils */

proj4.defs("EPSG:2154", "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

/** Reprojette une géométrie Lambert-93 en WGS84 (les autres sont laissées telles quelles). */
export function toWgs84(g: GeoJSON.Geometry): GeoJSON.Geometry {
  const first = JSON.stringify(g).match(/-?\d+(\.\d+)?/g)?.slice(0, 2).map(Number) ?? [0, 0];
  if (Math.abs(first[0]) <= 180 && Math.abs(first[1]) <= 90) return g;
  const tr = proj4("EPSG:2154", "EPSG:4326");
  const map = (c: unknown): unknown => (Array.isArray(c) && typeof c[0] === "number" ? tr.forward([c[0] as number, c[1] as number]) : (c as unknown[]).map(map));
  if (g.type === "GeometryCollection") return { ...g, geometries: g.geometries.map(toWgs84) };
  return { ...g, coordinates: map((g as GeoJSON.Polygon).coordinates) } as GeoJSON.Geometry;
}

const pctOf = (a: number | null | undefined, b: number | null | undefined) => (a != null && b ? (100 * a) / b : null);
const sum = (...xs: (number | null | undefined)[]) => (xs.every((x) => x == null) ? null : xs.reduce<number>((s, x) => s + (x ?? 0), 0));

/** Valeur d'une colonne trouvée par motif (premier motif qui correspond). */
function pick(row: Record<string, string>, ...res: RegExp[]): number | null {
  for (const re of res) {
    const k = Object.keys(row).find((c) => re.test(c));
    if (k) return num(row[k]);
  }
  return null;
}

/* -------------------------------------------------------------------- QPV */

/** Liste des QPV 2024 d'une commune (code, nom). */
export async function listQpv(http: TrackedHttp, codeInsee: string): Promise<{ list: { code: string; nom: string }[]; url: string; retrievedAt: string }> {
  const res = await findResource(http, QUARTIERS_SOURCES.qpvDataset, /liste.*quartiers.*2024|listeqp2024/i, QUARTIERS_SOURCES.qpvListFallback);
  if (!res) throw new Error("Liste des QPV 2024 introuvable");
  const toList = (rows: Record<string, unknown>[]) => {
    const m = new Map<string, string>();
    for (const r of rows) if (clean(r.insee_com) === codeInsee && r.code_qp) m.set(String(r.code_qp), String(r.lib_qp ?? r.code_qp));
    return [...m].map(([code, nom]) => ({ code, nom }));
  };
  try {
    const t = await tabular(http, res.id, [{ col: "insee_com", op: "contains", value: codeInsee }], 5);
    return { list: toList(t.rows), url: t.url, retrievedAt: t.retrievedAt };
  } catch {
    // Repli : fichier CSV complet (moins de 200 ko).
    const f = await http.text(res.url!);
    const lines = f.data.split(/\r?\n/).filter(Boolean);
    const sep = lines[0].includes(";") ? ";" : ",";
    const head = lines[0].split(sep).map((h) => h.replace(/^"|"$/g, "").trim());
    const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(sep).map((v, i) => [head[i], v.replace(/^"|"$/g, "")])));
    return { list: toList(rows), url: res.url!, retrievedAt: f.retrievedAt };
  }
}

/** Contours des QPV demandés (archive nationale GeoJSON de l'ANCT). */
export async function qpvContours(http: TrackedHttp, codes: string[]): Promise<{ geoms: Map<string, GeoJSON.Geometry>; url: string; retrievedAt: string }> {
  const res = await findResource(http, QUARTIERS_SOURCES.qpvDataset, /2024.*geojson/i, QUARTIERS_SOURCES.qpvGeojsonFallback);
  if (!res?.url) throw new Error("Contours des QPV 2024 introuvables");
  const f = await http.file(res.url, { timeoutMs: 300000 });
  const want = new Set(codes);
  const geoms = new Map<string, GeoJSON.Geometry>();
  // Lecture en flux de l'archive : seules les entités des QPV demandés sont décodées.
  const scanners = new Map<string, JsonScanner>();
  await zipLines(f.data, (n) => /\.(geo)?json$/i.test(n), (name, line) => {
    if (!scanners.has(name))
      scanners.set(
        name,
        new JsonScanner(geoJsonFeatures, (t) => {
          if (!codes.some((c) => t.includes(c))) return;
          try {
            const ft = JSON.parse(t) as GeoJSON.Feature;
            const code = Object.values(ft.properties ?? {}).find((v) => typeof v === "string" && want.has(v)) as string | undefined;
            if (code && ft.geometry && !geoms.has(code)) geoms.set(code, toWgs84(ft.geometry));
          } catch {
            /* entité illisible */
          }
        }),
      );
    scanners.get(name)!.feed(line + "\n");
  });
  return { geoms, url: res.url, retrievedAt: f.retrievedAt };
}

/**
 * Indicateurs des QPV : Filosofi (revenu médian, taux de pauvreté) et
 * estimations démographiques (âges, chômage, locataires). Les colonnes des
 * estimations sont repérées par leur libellé dans le fichier de métadonnées
 * de l'archive lorsqu'il existe, sinon par leur code.
 */
export async function qpvStats(http: TrackedHttp, codes: string[], notes: string[]): Promise<{ stats: Map<string, QuartierStats>; urls: string[] }> {
  const want = new Set(codes);
  const stats = new Map<string, QuartierStats>(codes.map((c) => [c, {}]));
  const urls: string[] = [];
  const idOf = (r: Record<string, string>) => r.CODGEO ?? r.CODE_QP ?? r.code_qp ?? r.QP ?? Object.values(r).find((v) => want.has(v)) ?? "";
  const prefilter = (l: string) => codes.some((c) => l.includes(c));
  try {
    const f = await http.file(QUARTIERS_SOURCES.qpvFilosofi, { timeoutMs: 300000 });
    urls.push(QUARTIERS_SOURCES.qpvFilosofi);
    const { rows } = await zipCsvRows(f.data, (n) => /\.csv$/i.test(n) && !/meta|dico|var/i.test(n), (r) => want.has(idOf(r)), prefilter);
    for (const r of rows) {
      const s = stats.get(idOf(r))!;
      s.revenu ??= pick(r, /^DISP_MED/i);
      s.pauvrete ??= pick(r, /^DISP_TP60/i);
    }
  } catch (e) {
    notes.push(`Filosofi QPV indisponible : ${e instanceof Error ? e.message : e}`);
  }
  try {
    const f = await http.file(QUARTIERS_SOURCES.qpvRp, { timeoutMs: 300000 });
    urls.push(QUARTIERS_SOURCES.qpvRp);
    // Métadonnées (code → libellé), si l'archive en contient.
    const labels = new Map<string, string>();
    const meta = await zipCsvRows(f.data, (n) => /\.csv$/i.test(n) && /meta|dico|var/i.test(n), () => true);
    for (const m of meta.rows) {
      const code = m.COD_VAR ?? m.CODE ?? m.VARIABLE ?? Object.values(m)[0];
      const lib = m.LIB_VAR ?? m.LIBELLE ?? m.LIB_VAR_LONG ?? Object.values(m)[1];
      if (code && lib) labels.set(code.trim(), lib.trim());
    }
    const { rows } = await zipCsvRows(f.data, (n) => /\.csv$/i.test(n) && !/meta|dico|var/i.test(n), (r) => want.has(idOf(r)), prefilter);
    const col = (r: Record<string, string>, labelRe: RegExp, codeRe: RegExp, exclude = /femme|homme|[ée]tranger|fran[çc]ais|15-24 ans.*ch[ôo]m|nombre/i) => {
      const byLabel = Object.keys(r).find((c) => labels.has(c) && labelRe.test(labels.get(c)!) && !exclude.test(labels.get(c)!));
      const k = byLabel ?? Object.keys(r).find((c) => codeRe.test(c));
      return k ? num(r[k]) : null;
    };
    for (const r of rows) {
      const s = stats.get(idOf(r))!;
      s.chomage ??= col(r, /taux de ch[ôo]mage/i, /TX_?CHOM|TCHOM/i);
      const p0014 = col(r, /0-14 ans/i, /0014|P_?0_14/i);
      const p1524 = col(r, /15-24 ans dans la pop/i, /1524|P_?15_24/i);
      s.jeunes ??= p0014 != null && p1524 != null ? p0014 + p1524 : null;
      s.jeunesLabel = "moins de 25 ans";
      const p6074 = col(r, /60-74 ans/i, /6074|P_?60_74/i);
      const p75 = col(r, /75 ans et plus/i, /75P|P_?75/i);
      s.ages ??= p6074 != null && p75 != null ? p6074 + p75 : null;
      s.locataires ??= col(r, /m[ée]nages locataires/i, /LOCAT|LOC$/i, /HLM|social|femme|homme/i);
      s.hlm ??= col(r, /HLM|logement social|parc social/i, /HLM/i);
      s.population ??= col(r, /^population( totale| municipale)?$/i, /^POP(_?TOT)?$/i);
    }
    if (rows.length && !labels.size) notes.push("Estimations démographiques QPV : pas de métadonnées dans l'archive, colonnes repérées par leur code (à vérifier).");
  } catch (e) {
    notes.push(`Estimations démographiques QPV indisponibles : ${e instanceof Error ? e.message : e}`);
  }
  return { stats, urls };
}

const complete = (r: QuartiersResult) => !r.notes.some((n) => /indisponible/i.test(n));

/** QPV d'une commune : 30 jours sur disque (sauf si une sous-source était en panne). */
export function collectQpv(http: TrackedHttp, codeInsee: string): Promise<QuartiersResult> {
  return cachedExtract(`qpv|${codeInsee}`, 24 * 30, () => heavyLane.run(() => collectQpvFresh(http, codeInsee)), complete);
}

async function collectQpvFresh(http: TrackedHttp, codeInsee: string): Promise<QuartiersResult> {
  const notes: string[] = [];
  const l = await listQpv(http, codeInsee);
  if (!l.list.length) return { quartiers: [], urls: [l.url], retrievedAt: l.retrievedAt, notes };
  const codes = l.list.map((q) => q.code);
  let geoms = new Map<string, GeoJSON.Geometry>();
  const urls = [l.url];
  try {
    const c = await qpvContours(http, codes);
    geoms = c.geoms;
    urls.push(c.url);
  } catch (e) {
    notes.push(`Contours QPV indisponibles : ${e instanceof Error ? e.message : e}`);
  }
  const s = await qpvStats(http, codes, notes);
  urls.push(...s.urls);
  return {
    quartiers: l.list.map((q) => ({ kind: "qpv", code: q.code, nom: q.nom, geometry: geoms.get(q.code) ?? null, stats: s.stats.get(q.code) ?? {} })),
    urls,
    retrievedAt: l.retrievedAt,
    notes,
  };
}

/* ------------------------------------------------------------------- IRIS */

export async function irisContours(http: TrackedHttp, codeInsee: string) {
  const url = `${QUARTIERS_SOURCES.irisWfs}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${encodeURIComponent(QUARTIERS_SOURCES.irisTypename)}&outputFormat=application/json&CQL_FILTER=${encodeURIComponent(`code_insee='${codeInsee}'`)}`;
  const r = await http.json<GeoJSON.FeatureCollection>(url);
  return { features: r.data?.features ?? [], url, retrievedAt: r.retrievedAt };
}

/** Indicateurs IRIS d'une commune, lus dans les fichiers nationaux de l'INSEE. */
export async function irisStats(http: TrackedHttp, codeInsee: string, notes: string[]): Promise<{ stats: Map<string, QuartierStats>; urls: string[] }> {
  const stats = new Map<string, QuartierStats>();
  const urls: string[] = [];
  const get = (iris: string) => {
    if (!stats.has(iris)) stats.set(iris, {});
    return stats.get(iris)!;
  };
  const read = async (url: string, label: string, apply: (r: Record<string, string>, s: QuartierStats) => void) => {
    try {
      const f = await http.file(url, { timeoutMs: 900000 });
      urls.push(url);
      const { rows } = await zipCsvRows(
        f.data,
        (n) => /\.csv$/i.test(n) && !/meta|dico|var/i.test(n),
        (r) => (r.COM ?? "").padStart(5, "0") === codeInsee || (r.IRIS ?? "").startsWith(codeInsee),
        (line) => line.includes(codeInsee),
      );
      for (const r of rows) if (r.IRIS) apply(r, get(r.IRIS));
    } catch (e) {
      notes.push(`${label} indisponible : ${e instanceof Error ? e.message : e}`);
    }
  };
  await read(QUARTIERS_SOURCES.irisFilosofi, "Filosofi IRIS", (r, s) => {
    s.revenu = pick(r, /^DISP_MED/i);
    s.pauvrete = pick(r, /^DISP_TP60/i);
  });
  await read(QUARTIERS_SOURCES.irisPop, "Population IRIS", (r, s) => {
    const pop = pick(r, /^P\d\d_POP$/);
    s.population = pop;
    const fine = [/^P\d\d_POP0002$/, /^P\d\d_POP0305$/, /^P\d\d_POP0610$/, /^P\d\d_POP1117$/, /^P\d\d_POP1824$/].map((re) => pick(r, re));
    if (fine.every((x) => x != null)) {
      s.jeunes = pctOf(sum(...fine), pop);
      s.jeunesLabel = "moins de 25 ans";
    } else {
      s.jeunes = pctOf(sum(pick(r, /^P\d\d_POP0014$/), pick(r, /^P\d\d_POP1529$/)), pop);
      s.jeunesLabel = "moins de 30 ans";
    }
    s.ages = pctOf(sum(pick(r, /^P\d\d_POP6074$/), pick(r, /^P\d\d_POP75P$/)), pop);
  });
  await read(QUARTIERS_SOURCES.irisLogement, "Logement IRIS", (r, s) => {
    const rp = pick(r, /^P\d\d_RP$/);
    s.locataires = pctOf(pick(r, /^P\d\d_RP_LOC$/), rp);
    s.hlm = pctOf(pick(r, /^P\d\d_RP_LOCHLMV$/), rp);
  });
  await read(QUARTIERS_SOURCES.irisActivite, "Activité IRIS", (r, s) => {
    s.chomage = pctOf(pick(r, /^P\d\d_CHOM1564$/), pick(r, /^P\d\d_ACT1564$/));
  });
  return { stats, urls };
}

/** IRIS d'une commune : 30 jours sur disque (sauf si une sous-source était en panne). */
export function collectIris(http: TrackedHttp, codeInsee: string): Promise<QuartiersResult> {
  return cachedExtract(`iris|${codeInsee}`, 24 * 30, () => heavyLane.run(() => collectIrisFresh(http, codeInsee)), complete);
}

async function collectIrisFresh(http: TrackedHttp, codeInsee: string): Promise<QuartiersResult> {
  const notes: string[] = [];
  const c = await irisContours(http, codeInsee);
  // Commune non découpée en IRIS : un seul « IRIS » égal à la commune.
  if (c.features.length < 2) return { quartiers: [], urls: [c.url], retrievedAt: c.retrievedAt, notes };
  const s = await irisStats(http, codeInsee, notes);
  const quartiers: Quartier[] = c.features.map((f) => {
    const p = (f.properties ?? {}) as Record<string, string>;
    const code = String(p.code_iris ?? p.CODE_IRIS ?? "");
    return { kind: "iris", code, nom: String(p.nom_iris ?? p.NOM_IRIS ?? code), type: p.type_iris ?? p.TYP_IRIS, geometry: f.geometry ? toWgs84(f.geometry) : null, stats: s.stats.get(code) ?? {} };
  });
  return { quartiers, urls: [c.url, ...s.urls], retrievedAt: c.retrievedAt, notes };
}
