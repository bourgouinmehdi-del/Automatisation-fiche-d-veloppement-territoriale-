import proj4 from "proj4";
import { scanFile, scanText, type CaptureTest } from "./json-stream";

/**
 * Extraction ciblée d'entités dans un fichier TopoJSON national volumineux
 * (ex. contours des bureaux de vote de l'INSEE, ~100 Mo), sans décoder
 * l'ensemble du fichier :
 *  1. lecture de la transformation (quantification) ;
 *  2. repérage des positions de chaque arc dans le tableau `arcs` (balayage) ;
 *  3. décodage des seules géométries qui mentionnent le code commune ;
 *  4. reconstruction des anneaux à partir des arcs utilisés (delta-encodage) ;
 *  5. conversion en longitude/latitude (WGS84) si les coordonnées sont
 *     en Lambert-93 (EPSG:2154) ou en Web Mercator (EPSG:3857).
 */

proj4.defs(
  "EPSG:2154",
  "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
);

/** Fin de l'élément JSON (objet ou tableau) commençant à `start`. */
export function jsonEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inStr) {
      if (ch === 92) i++;
      else if (ch === 34) inStr = false;
      continue;
    }
    if (ch === 34) inStr = true;
    else if (ch === 123 || ch === 91) depth++;
    else if ((ch === 125 || ch === 93) && --depth === 0) return i + 1;
  }
  return -1;
}

/** Détecte le système de coordonnées et renvoie un convertisseur vers WGS84. */
export function toWgs84(sample: [number, number]): ((p: [number, number]) => [number, number]) | null {
  const [x, y] = sample;
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return (p) => p;
  if (x > 50000 && x < 1300000 && y > 6000000 && y < 7200000) return (p) => proj4("EPSG:2154", "WGS84", p) as [number, number];
  if (Math.abs(x) < 20037509 && Math.abs(y) < 20037509) return (p) => proj4("EPSG:3857", "WGS84", p) as [number, number];
  return null;
}

type Scan = (test: CaptureTest, onValue: (text: string) => void) => Promise<void> | void;
type Transform = { scale: [number, number]; translate: [number, number] } | null;

/**
 * Extraction en deux passes, sans jamais garder le fichier entier :
 *  1. géométries des objets (`objects.*.geometries[i]`) qui mentionnent le code,
 *     et transformation de quantification ;
 *  2. lecture des seuls arcs utilisés par ces géométries.
 */
async function extractWith(scan: Scan, code: string, diag: string[]): Promise<GeoJSON.FeatureCollection> {
  const out: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  type Geom = { type: string; arcs: number[][] | number[][][]; properties?: Record<string, unknown>; id?: unknown };
  const geoms: Geom[] = [];
  let transform: Transform = null;
  let nGeoms = 0;
  let kind: "geom" | "transform" = "geom";
  await scan(
    (o, d, k) => {
      if (o !== "{") return false;
      if (d === 1 && k[1] === "transform") return ((kind = "transform"), true);
      if (d === 4 && k[1] === "objects" && k[3] === "geometries") return ((kind = "geom"), true);
      return false;
    },
    (text) => {
      if (kind === "transform") {
        try {
          transform = JSON.parse(text);
        } catch {
          /* ignoré */
        }
        return;
      }
      nGeoms++;
      if (!text.includes(code) || !/"arcs"/.test(text)) return;
      try {
        const g = JSON.parse(text) as Geom;
        if (g.type === "Polygon" || g.type === "MultiPolygon") geoms.push(g);
      } catch {
        /* entité illisible */
      }
    },
  );
  diag.push(`${nGeoms} géométrie(s) parcourue(s) ; transformation : ${transform ? JSON.stringify(transform) : "aucune"}`);
  if (!geoms.length) {
    diag.push(`0 entité pour ${code}`);
    return out;
  }
  const needed = new Set<number>();
  const polysOf = (g: Geom) => (g.type === "Polygon" ? [g.arcs as number[][]] : (g.arcs as number[][][]));
  for (const g of geoms) for (const rings of polysOf(g)) for (const r of rings) for (const a of r) needed.add(a < 0 ? ~a : a);

  const arcs = new Map<number, [number, number][]>();
  let idx = -1;
  let current = -1;
  await scan(
    (o, d, k) => {
      if (o !== "[" || d !== 2 || k[1] !== "arcs") return false;
      idx++;
      if (!needed.has(idx)) return false;
      current = idx;
      return true;
    },
    (text) => {
      const raw = JSON.parse(text) as [number, number][];
      const t = transform as Transform;
      if (!t) {
        arcs.set(current, raw);
        return;
      }
      let x = 0;
      let y = 0;
      arcs.set(
        current,
        raw.map(([dx, dy]) => {
          x += dx;
          y += dy;
          return [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]] as [number, number];
        }),
      );
    },
  );
  diag.push(`${idx + 1} arcs ; ${arcs.size} arc(s) utile(s) lu(s)`);

  const ring = (refs: number[]) => {
    const pts: [number, number][] = [];
    for (const a of refs) {
      let p = arcs.get(a < 0 ? ~a : a) ?? [];
      if (a < 0) p = [...p].reverse();
      pts.push(...(pts.length ? p.slice(1) : p));
    }
    return pts;
  };
  let convert: ((p: [number, number]) => [number, number]) | null = null;
  for (const g of geoms) {
    const polys = polysOf(g).map((rings) => rings.map(ring));
    if (!convert) {
      const sample = polys[0]?.[0]?.[0];
      convert = sample ? toWgs84(sample) : null;
      diag.push(`premier point brut : ${JSON.stringify(sample)} → ${convert ? JSON.stringify(convert(sample!)) : "système de coordonnées non reconnu"}`);
      if (!convert) return out;
    }
    const conv = polys.map((rings) => rings.map((r) => r.map((p) => convert!(p))));
    out.features.push({
      type: "Feature",
      geometry: g.type === "Polygon" ? { type: "Polygon", coordinates: conv[0] } : { type: "MultiPolygon", coordinates: conv },
      properties: { ...(g.properties ?? {}), ...(g.id != null ? { id: g.id } : {}) },
    });
  }
  diag.push(`${out.features.length} entité(s) pour ${code}${out.features[0] ? ` ; propriétés : ${JSON.stringify(out.features[0].properties).slice(0, 200)}` : ""}`);
  return out;
}

/** Entités d'un TopoJSON lu sur disque, en flux (mémoire bornée). */
export function extractTopoJsonFile(file: string, code: string, diag: string[] = []) {
  return extractWith((t, v) => scanFile(file, t, v), code, diag);
}

/** Variante sur un texte en mémoire (petits fichiers, tests). */
export async function extractTopoJson(text: string, code: string, diag: string[] = []): Promise<GeoJSON.FeatureCollection> {
  return extractWith((t, v) => scanText(text, t, v), code, diag);
}
