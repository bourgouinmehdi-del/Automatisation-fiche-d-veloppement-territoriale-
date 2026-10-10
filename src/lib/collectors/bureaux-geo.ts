import { promises as fs } from "node:fs";
import path from "node:path";
import * as turf from "@turf/turf";
import { config } from "../config";
import type { TrackedHttp } from "./context";
import { findCol, normBv } from "./elections";

/**
 * Noms et géométries des bureaux de vote d'une commune.
 *
 * Sources, essayées dans l'ordre :
 *  1. un GeoJSON fourni par l'utilisateur : `data/interne/bv-<code INSEE>.geojson`
 *     (contours officiels obtenus auprès de la mairie, par exemple) ;
 *  2. les contours publiés sur data.gouv.fr (« proposition de contours des bureaux
 *     de vote selon la méthode de l'INSEE », ~100 Mo pour la France) : le fichier
 *     est parcouru en texte et seules les entités de la commune sont décodées ;
 *  3. le Répertoire électoral unique (INSEE), table des bureaux (`table-bv-reu`) :
 *     libellé et adresse du lieu de vote, géocodés par la Base adresse nationale.
 *
 * Les contours (2) sont une proposition statistique de l'INSEE, pas le découpage
 * arrêté par la mairie : ils sont signalés comme tels.
 */

const DATAGOUV = "https://www.data.gouv.fr/api/1";
const TABULAR = "https://tabular-api.data.gouv.fr/api/resources";

export interface BureauGeo {
  /** Polygones par bureau (propriétés : bv, label). */
  features: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[];
  /** Lieux de vote géocodés (propriétés : bv, label, adresse). */
  points: GeoJSON.Feature<GeoJSON.Point>[];
  /** Libellés (souvent le lieu de vote : école, mairie…). */
  labels: Map<string, string>;
  method: "fourni" | "contours" | "enveloppe" | "lieux" | "libelles";
  sourceName: string;
  url: string;
  retrievedAt: string;
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
  resources?: DgResource[];
}

const lowerKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

/** Propriété identifiant le bureau : nom exact connu, sinon toute clé évoquant un bureau. */
function bvKey(p: Record<string, unknown>) {
  const exact = ["bv", "code_bv", "codebv", "id_bv", "numero_bv", "num_bv", "codebureauvote", "code_bureau_vote", "id_bureau", "code_bureau", "bureau", "numero", "num"];
  return exact.find((k) => p[k] != null) ?? Object.keys(p).find((k) => /bureau|(^|_)bv($|_)/.test(k) && p[k] != null && !/libel|nom|label/.test(k));
}
function comKey(p: Record<string, unknown>) {
  const exact = ["code_commune", "codecommune", "code_insee", "insee", "codeinsee", "insee_com", "com_code", "codgeo", "com"];
  return exact.find((k) => p[k] != null) ?? Object.keys(p).find((k) => /commune|insee/.test(k) && /code|insee/.test(k) && p[k] != null);
}
function labelKey(p: Record<string, unknown>) {
  return ["libelle", "libelle_bv", "libelle_reu", "nom", "nom_bv", "lieu", "label", "libellebureauvote"].find((k) => p[k] != null && typeof p[k] === "string");
}

/** Normalise une FeatureCollection de bureaux (filtre éventuel sur la commune). */
export function normalizeBvFeatures(fc: GeoJSON.FeatureCollection, codeInsee?: string) {
  const out: BureauGeo["features"] = [];
  const labels = new Map<string, string>();
  for (const f of fc.features ?? []) {
    if (!f.geometry || (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")) continue;
    const p = lowerKeys((f.properties ?? {}) as Record<string, unknown>);
    const ck = comKey(p);
    if (codeInsee && ck) {
      const v = String(p[ck]);
      // Le code commune peut être isolé (« 60159 ») ou préfixer l'identifiant du bureau (« 60159_3 »).
      if (v.padStart(5, "0") !== codeInsee && !v.startsWith(codeInsee)) continue;
    }
    const bk = bvKey(p);
    if (!bk) continue;
    if (codeInsee && !ck && !String(p[bk]).startsWith(codeInsee)) continue;
    const bv = normBv(p[bk]);
    const lk = labelKey(p);
    const label = lk ? String(p[lk]) : `Bureau ${bv}`;
    labels.set(bv, label);
    out.push({ type: "Feature", geometry: f.geometry as GeoJSON.Polygon, properties: { bv, label } });
  }
  return { features: out, labels };
}

/** Fin de l'objet JSON commençant à `start` (accolades équilibrées, chaînes ignorées). */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inStr) {
      if (ch === 92) i++; // antislash
      else if (ch === 34) inStr = false;
      continue;
    }
    if (ch === 34) inStr = true;
    else if (ch === 123) depth++;
    else if (ch === 125 && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Extrait d'un GeoJSON national les seules entités mentionnant la commune,
 * sans décoder tout le fichier (évite plusieurs Go de mémoire).
 */
export function extractFeaturesByText(text: string, codeInsee: string): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const re = /\{\s*"type"\s*:\s*"Feature"/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = re.exec(text))) {
    if (m.index < lastEnd) continue;
    const end = balancedEnd(text, m.index);
    if (end < 0) break;
    lastEnd = end;
    re.lastIndex = end;
    // Test rapide sur les propriétés avant décodage.
    const chunk = text.slice(m.index, end);
    if (!chunk.includes(codeInsee)) continue;
    try {
      features.push(JSON.parse(chunk));
    } catch {
      /* entité illisible */
    }
  }
  return { type: "FeatureCollection", features };
}

async function fromUserFile(codeInsee: string): Promise<BureauGeo | null> {
  const file = path.join(config.dataDir, "interne", `bv-${codeInsee}.geojson`);
  try {
    const fc = JSON.parse(await fs.readFile(file, "utf8")) as GeoJSON.FeatureCollection;
    const n = normalizeBvFeatures(fc, codeInsee);
    if (!n.features.length) return null;
    const st = await fs.stat(file);
    return { ...n, points: [], method: "fourni", sourceName: "Contours fournis par l'utilisateur", url: `data/interne/bv-${codeInsee}.geojson`, retrievedAt: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

async function searchDatasets(http: TrackedHttp, q: string) {
  const r = await http.json<{ data?: DgDataset[] }>(`${DATAGOUV}/datasets/?q=${encodeURIComponent(q)}&page_size=10`);
  return r.data?.data ?? [];
}

async function fromContours(http: TrackedHttp, codeInsee: string): Promise<BureauGeo | null> {
  const maxBytes = Number(process.env.BV_CONTOURS_MAX_MB ?? 250) * 1024 * 1024;
  for (const d of await searchDatasets(http, "contours des bureaux de vote")) {
    if (!/contour/i.test(d.title ?? "") || !/bureau/i.test(d.title ?? "")) continue;
    const res = (d.resources ?? [])
      .filter((r) => (/json/i.test(r.format ?? "") || /\.(geo)?json$/i.test(r.url ?? "")) && r.url && (!r.filesize || r.filesize <= maxBytes))
      .sort((x, y) => (x.filesize ?? 0) - (y.filesize ?? 0))[0];
    if (!res?.url) continue;
    const r = await http.text(res.url, { timeoutMs: 900000, retries: 1 });
    const n = normalizeBvFeatures(extractFeaturesByText(r.data, codeInsee), codeInsee);
    if (n.features.length)
      return { ...n, points: [], method: "contours", sourceName: `${d.title} (data.gouv.fr)`, url: res.url, retrievedAt: r.retrievedAt };
  }
  return null;
}

/** Libellés et enveloppes des bureaux à partir du Répertoire électoral unique. */
async function fromReu(http: TrackedHttp, codeInsee: string): Promise<BureauGeo | null> {
  const datasets = (await searchDatasets(http, "bureaux de vote et adresses de leurs électeurs")).filter((d) => /bureau/i.test(d.title ?? "") && /adresse/i.test(d.title ?? ""));
  for (const d of datasets) {
    const tab = (r: DgResource) => /csv/i.test(r.format ?? "") || /\.csv$/i.test(r.url ?? "");
    const resBv = (d.resources ?? []).find((r) => tab(r) && /table[-_ ]?bv|bureaux?/i.test(r.title ?? "") && !/adresse/i.test(r.title ?? ""));
    const resAdr = (d.resources ?? []).find((r) => tab(r) && /adresse/i.test(r.title ?? ""));
    const labels = new Map<string, string>();
    const addresses = new Map<string, string>();
    let url = "";
    let retrievedAt = "";
    // Libellés des bureaux.
    if (resBv) {
      try {
        const rows = await tabularCommune(http, resBv.id, codeInsee);
        for (const r of rows.rows) {
          const cols = Object.keys(r);
          const cBv = findCol(cols, /^id_bv$/i, /^code_?bv$/i, /^num(ero)?_?bv$/i, /^code$/i, /bv/i);
          const cLab = findCol(cols, /^libelle_reu$/i, /^libelle/i, /^nom/i);
          if (!cBv || !cLab || !r[cLab]) continue;
          const bv = normBv(r[cBv]);
          labels.set(bv, String(r[cLab]).trim());
          const g = (re: RegExp) => {
            const c = findCol(cols, re);
            return c && r[c] != null ? String(r[c]).trim() : "";
          };
          const adresse = [g(/^num_voie/i), g(/^voie/i), g(/^cp/i), g(/^commune_reu$/i)].filter(Boolean).join(" ");
          if (adresse) addresses.set(bv, adresse);
        }
        url = rows.url;
        retrievedAt = rows.retrievedAt;
      } catch {
        /* libellés indisponibles */
      }
    }
    // Enveloppes à partir des adresses géolocalisées.
    const features: BureauGeo["features"] = [];
    if (resAdr) {
      try {
        const rows = await tabularCommune(http, resAdr.id, codeInsee, 400);
        const pts = new Map<string, [number, number][]>();
        for (const r of rows.rows) {
          const cols = Object.keys(r);
          const cBv = findCol(cols, /^id_bv$/i, /^code_?bv$/i, /bv/i);
          const cLon = findCol(cols, /^longitude$/i, /^lon$/i, /^x$/i);
          const cLat = findCol(cols, /^latitude$/i, /^lat$/i, /^y$/i);
          if (!cBv || !cLon || !cLat) continue;
          const lon = Number(r[cLon]);
          const lat = Number(r[cLat]);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          const bv = normBv(r[cBv]);
          if (!pts.has(bv)) pts.set(bv, []);
          pts.get(bv)!.push([lon, lat]);
        }
        for (const [bv, p] of pts) {
          if (p.length < 3) continue;
          const hull = turf.convex(turf.featureCollection(p.map((c) => turf.point(c))));
          if (!hull) continue;
          const buf = turf.buffer(hull, 0.04, { units: "kilometers" });
          if (buf) features.push({ type: "Feature", geometry: buf.geometry as GeoJSON.Polygon, properties: { bv, label: labels.get(bv) ?? `Bureau ${bv}`, adresses: p.length } });
        }
        url = url || rows.url;
        retrievedAt = retrievedAt || rows.retrievedAt;
      } catch {
        /* adresses indisponibles */
      }
    }
    // Lieux de vote géocodés (Base adresse nationale).
    const points: BureauGeo["points"] = [];
    for (const [bv, adresse] of addresses) {
      try {
        const g = await http.json<{ features?: GeoJSON.Feature<GeoJSON.Point>[] }>(
          `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(adresse)}&citycode=${codeInsee}&limit=1`,
          { minIntervalMs: 120, retries: 1 },
        );
        const f = g.data?.features?.[0];
        if (f) points.push({ type: "Feature", geometry: f.geometry, properties: { bv, label: labels.get(bv) ?? `Bureau ${bv}`, adresse } });
      } catch {
        http.partial = true;
      }
    }
    if (features.length || labels.size)
      return {
        features,
        points,
        labels,
        method: features.length ? "enveloppe" : points.length ? "lieux" : "libelles",
        sourceName: `Répertoire électoral unique — ${d.title} (INSEE, data.gouv.fr)`,
        url,
        retrievedAt,
      };
  }
  return null;
}

async function tabularCommune(http: TrackedHttp, rid: string, codeInsee: string, maxPages = 20) {
  const probe = await http.json<{ data?: Record<string, unknown>[] }>(`${TABULAR}/${rid}/data/?page_size=1`, { retries: 0 });
  const cols = Object.keys(probe.data?.data?.[0] ?? {});
  const cCom = findCol(cols, /^code_commune_ref$/i, /^code_commune$/i, /^code_?insee$/i, /commune/i);
  if (!cCom) throw new Error("colonne commune introuvable");
  const rows: Record<string, unknown>[] = [];
  let url: string | null = `${TABULAR}/${rid}/data/?${encodeURIComponent(cCom)}__exact=${codeInsee}&page_size=200`;
  const first = url;
  let retrievedAt = "";
  let pages = 0;
  while (url && pages++ < maxPages) {
    const r: { data: { data?: Record<string, unknown>[]; links?: { next?: string | null } } | null; retrievedAt: string } = await http.json(url, { minIntervalMs: 120 });
    retrievedAt = r.retrievedAt;
    rows.push(...(r.data?.data ?? []));
    url = r.data?.links?.next ?? null;
  }
  return { rows, url: first, retrievedAt };
}

export async function collectBureauxGeo(http: TrackedHttp, codeInsee: string): Promise<BureauGeo | null> {
  const user = await fromUserFile(codeInsee);
  let contours: BureauGeo | null = null;
  if (!user) {
    try {
      contours = await fromContours(http, codeInsee);
    } catch {
      http.notes.push("Contours de bureaux de vote indisponibles");
    }
  }
  // Libellés et lieux de vote : complètent les contours (ou s'y substituent).
  let reu: BureauGeo | null = null;
  try {
    reu = await fromReu(http, codeInsee);
  } catch {
    http.notes.push("Table des bureaux (REU) indisponible");
  }
  const base = user ?? contours;
  if (!base) return reu;
  if (reu) {
    for (const [bv, l] of reu.labels) base.labels.set(bv, l);
    for (const f of base.features) if (reu.labels.has(String(f.properties?.bv))) f.properties = { ...f.properties, label: reu.labels.get(String(f.properties?.bv)) };
    base.points = reu.points;
    base.sourceName += ` ; libellés et lieux de vote : ${reu.sourceName}`;
  }
  return base;
}

/** Diagnostic détaillé (check:sources) : jeux trouvés, ressources, indexation tabulaire. */
export async function diagnoseBureauxGeo(http: TrackedHttp, codeInsee: string): Promise<string[]> {
  const lines: string[] = [];
  for (const q of ["contours des bureaux de vote", "bureaux de vote et adresses de leurs électeurs", "bureaux de vote"]) {
    const ds = await searchDatasets(http, q);
    lines.push(`recherche « ${q} » : ${ds.length} jeu(x)`);
    for (const d of ds.slice(0, 6)) {
      lines.push(`  • ${d.title} [${d.slug}]`);
      for (const r of (d.resources ?? []).slice(0, 8)) {
        let tab = "";
        if (/csv/i.test(r.format ?? "")) {
          try {
            const p = await http.json<{ data?: Record<string, unknown>[] }>(`${TABULAR}/${r.id}/data/?page_size=1`, { retries: 0, noCache: true });
            tab = ` — API tabulaire : OK, colonnes ${Object.keys(p.data?.data?.[0] ?? {}).slice(0, 12).join(", ")}`;
          } catch (e) {
            tab = ` — API tabulaire : ${e instanceof Error ? e.message : e}`;
          }
        }
        lines.push(`      - ${r.title} (${r.format}, ${r.filesize ? Math.round(r.filesize / 1e6) + " Mo" : "taille ?"})${tab}`);
      }
    }
  }
  // Aperçu du fichier de contours (structure, présence de la commune).
  for (const d of await searchDatasets(http, "contours des bureaux de vote")) {
    if (!/contour/i.test(d.title ?? "") || !/bureau/i.test(d.title ?? "")) continue;
    const res = (d.resources ?? []).find((r) => /json/i.test(r.format ?? "") && r.filesize && r.filesize < 250e6);
    if (!res?.url) continue;
    try {
      const r = await http.text(res.url, { timeoutMs: 900000, retries: 1 });
      const fc = extractFeaturesByText(r.data, codeInsee);
      lines.push(`contours « ${res.title} » : début du fichier = ${r.data.slice(0, 160).replace(/\s+/g, " ")}`);
      lines.push(`  entités mentionnant ${codeInsee} : ${fc.features.length} ; propriétés de la 1re : ${JSON.stringify(fc.features[0]?.properties ?? {}).slice(0, 300)}`);
      const idx = r.data.indexOf(codeInsee);
      if (idx >= 0) lines.push(`  contexte de la 1re occurrence : …${r.data.slice(Math.max(0, idx - 150), idx + 100).replace(/\s+/g, " ")}…`);
    } catch (e) {
      lines.push(`contours « ${res.title} » : ${e instanceof Error ? e.message : e}`);
    }
  }
  return lines;
}
