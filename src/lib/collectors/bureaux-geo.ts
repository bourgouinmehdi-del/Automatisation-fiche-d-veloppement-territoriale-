import { promises as fs } from "node:fs";
import path from "node:path";
import * as turf from "@turf/turf";
import { config } from "../config";
import type { TrackedHttp } from "./context";
import { findCol, normBv } from "./elections";

/**
 * Noms et géométries des bureaux de vote d'une commune.
 *
 * Trois sources, essayées dans l'ordre :
 *  1. un GeoJSON fourni par l'utilisateur : `data/interne/bv-<code INSEE>.geojson`
 *     (contours officiels obtenus auprès de la mairie, par exemple) ;
 *  2. les contours de bureaux de vote publiés sur data.gouv.fr (si la
 *     ressource n'excède pas BV_CONTOURS_MAX_MB) ;
 *  3. le Répertoire électoral unique (INSEE) — « bureaux de vote et adresses de
 *     leurs électeurs » — interrogé via l'API tabulaire : libellé de chaque
 *     bureau et enveloppe approximative calculée à partir des adresses géolocalisées.
 *
 * Les contours calculés (3) sont des approximations : ils sont signalés comme tels.
 */

const DATAGOUV = "https://www.data.gouv.fr/api/1";
const TABULAR = "https://tabular-api.data.gouv.fr/api/resources";

export interface BureauGeo {
  /** Polygones par bureau (propriétés : bv, label). */
  features: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[];
  /** Libellés (souvent le lieu de vote : école, mairie…). */
  labels: Map<string, string>;
  method: "fourni" | "contours" | "enveloppe" | "libelles";
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

const BV_PROPS = ["bv", "code_bv", "codebv", "id_bv", "numero_bv", "num_bv", "numero", "bureau", "code_bureau", "bureau_de_vote"];
const COM_PROPS = ["code_commune", "codecommune", "code_insee", "insee", "codeinsee", "insee_com", "com_code", "commune"];
const LABEL_PROPS = ["libelle", "libelle_bv", "nom", "nom_bv", "lieu", "libelle_reu", "label"];

const lowerKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

/** Normalise une FeatureCollection de bureaux (filtre éventuel sur la commune). */
export function normalizeBvFeatures(fc: GeoJSON.FeatureCollection, codeInsee?: string) {
  const out: BureauGeo["features"] = [];
  const labels = new Map<string, string>();
  for (const f of fc.features ?? []) {
    if (!f.geometry || (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")) continue;
    const p = lowerKeys((f.properties ?? {}) as Record<string, unknown>);
    if (codeInsee) {
      const ck = COM_PROPS.find((k) => p[k] != null);
      if (ck && String(p[ck]).padStart(5, "0") !== codeInsee) continue;
    }
    const bk = BV_PROPS.find((k) => p[k] != null);
    if (!bk) continue;
    const bv = normBv(p[bk]);
    const lk = LABEL_PROPS.find((k) => p[k] != null && typeof p[k] === "string");
    const label = lk ? String(p[lk]) : `Bureau ${bv}`;
    labels.set(bv, label);
    out.push({ type: "Feature", geometry: f.geometry as GeoJSON.Polygon, properties: { bv, label } });
  }
  return { features: out, labels };
}

async function fromUserFile(codeInsee: string): Promise<BureauGeo | null> {
  const file = path.join(config.dataDir, "interne", `bv-${codeInsee}.geojson`);
  try {
    const fc = JSON.parse(await fs.readFile(file, "utf8")) as GeoJSON.FeatureCollection;
    const n = normalizeBvFeatures(fc, codeInsee);
    if (!n.features.length) return null;
    const st = await fs.stat(file);
    return { ...n, method: "fourni", sourceName: "Contours fournis par l'utilisateur", url: `data/interne/bv-${codeInsee}.geojson`, retrievedAt: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

async function searchDatasets(http: TrackedHttp, q: string) {
  const r = await http.json<{ data?: DgDataset[] }>(`${DATAGOUV}/datasets/?q=${encodeURIComponent(q)}&page_size=10`);
  return r.data?.data ?? [];
}

async function fromContours(http: TrackedHttp, codeInsee: string): Promise<BureauGeo | null> {
  const maxBytes = Number(process.env.BV_CONTOURS_MAX_MB ?? 200) * 1024 * 1024;
  for (const d of await searchDatasets(http, "contours des bureaux de vote")) {
    if (!/contour/i.test(d.title ?? "") || !/bureau/i.test(d.title ?? "")) continue;
    const res = (d.resources ?? []).find((r) => /geo\+?json/i.test(r.format ?? "") || /\.geojson$/i.test(r.url ?? ""));
    if (!res?.url || (res.filesize && res.filesize > maxBytes)) continue;
    const r = await http.json<GeoJSON.FeatureCollection>(res.url, { timeoutMs: 600000, retries: 1 });
    if (!r.data) continue;
    const n = normalizeBvFeatures(r.data, codeInsee);
    if (n.features.length) return { ...n, method: "contours", sourceName: `Contours des bureaux de vote (data.gouv.fr — ${d.title})`, url: res.url, retrievedAt: r.retrievedAt };
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
    let url = "";
    let retrievedAt = "";
    // Libellés des bureaux.
    if (resBv) {
      try {
        const rows = await tabularCommune(http, resBv.id, codeInsee);
        for (const r of rows.rows) {
          const cols = Object.keys(r);
          const cBv = findCol(cols, /^id_bv$/i, /^code_?bv$/i, /^num(ero)?_?bv$/i, /bv/i);
          const cLab = findCol(cols, /^libelle_reu$/i, /^libelle/i, /^nom/i);
          if (cBv && cLab && r[cLab]) labels.set(normBv(r[cBv]), String(r[cLab]));
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
    if (features.length || labels.size)
      return {
        features,
        labels,
        method: features.length ? "enveloppe" : "libelles",
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
  if (user) return user;
  try {
    const c = await fromContours(http, codeInsee);
    if (c) return c;
  } catch {
    http.notes.push("Contours de bureaux de vote indisponibles");
  }
  return fromReu(http, codeInsee);
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
  void codeInsee;
  return lines;
}
