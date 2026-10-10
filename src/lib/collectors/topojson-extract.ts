import proj4 from "proj4";

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

interface Located {
  arcsStart: number;
  arcsEnd: number;
  /** Position de début de chaque arc dans le texte. */
  offsets: number[];
  transform: { scale: [number, number]; translate: [number, number] } | null;
}

function locate(text: string): Located | null {
  const m = /"arcs"\s*:\s*\[/.exec(text);
  if (!m) return null;
  const arcsStart = m.index + m[0].length - 1;
  const offsets: number[] = [];
  let depth = 0;
  let i = arcsStart;
  for (; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 91) {
      depth++;
      if (depth === 2) offsets.push(i);
    } else if (ch === 93) {
      depth--;
      if (depth === 0) break;
    }
  }
  const arcsEnd = i + 1;
  // La clé « transform » ne peut pas figurer dans le tableau d'arcs (que des nombres) :
  // une recherche sur tout le texte est donc sûre.
  let transform: Located["transform"] = null;
  const t = /"transform"\s*:\s*\{/.exec(text);
  if (t) {
    const s0 = t.index + t[0].length - 1;
    try {
      transform = JSON.parse(text.slice(s0, jsonEnd(text, s0)));
    } catch {
      transform = null;
    }
  }
  return { arcsStart, arcsEnd, offsets, transform };
}

function decodeArc(text: string, loc: Located, idx: number): [number, number][] {
  const start = loc.offsets[idx];
  const raw = JSON.parse(text.slice(start, jsonEnd(text, start))) as [number, number][];
  if (!loc.transform) return raw;
  const { scale, translate } = loc.transform;
  let x = 0;
  let y = 0;
  return raw.map(([dx, dy]) => {
    x += dx;
    y += dy;
    return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
  });
}

function ringFromArcs(text: string, loc: Located, arcs: number[], cache: Map<number, [number, number][]>): [number, number][] {
  const ring: [number, number][] = [];
  for (const a of arcs) {
    const idx = a < 0 ? ~a : a;
    if (!cache.has(idx)) cache.set(idx, decodeArc(text, loc, idx));
    let pts = cache.get(idx)!;
    if (a < 0) pts = [...pts].reverse();
    ring.push(...(ring.length ? pts.slice(1) : pts));
  }
  return ring;
}

/** Détecte le système de coordonnées et renvoie un convertisseur vers WGS84. */
export function toWgs84(sample: [number, number]): ((p: [number, number]) => [number, number]) | null {
  const [x, y] = sample;
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return (p) => p;
  if (x > 50000 && x < 1300000 && y > 6000000 && y < 7200000) return (p) => proj4("EPSG:2154", "WGS84", p) as [number, number];
  if (Math.abs(x) < 20037509 && Math.abs(y) < 20037509) return (p) => proj4("EPSG:3857", "WGS84", p) as [number, number];
  return null;
}

/**
 * Renvoie les entités dont les propriétés mentionnent `code`, converties en
 * GeoJSON (WGS84). `diag` reçoit des informations utiles au diagnostic.
 */
export function extractTopoJson(text: string, code: string, diag: string[] = []): GeoJSON.FeatureCollection {
  const out: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  const loc = locate(text);
  if (!loc) {
    diag.push("tableau « arcs » introuvable");
    return out;
  }
  diag.push(`${loc.offsets.length} arcs ; transformation : ${loc.transform ? JSON.stringify(loc.transform) : "aucune"}`);
  const objects = text.slice(loc.arcsEnd);
  const re = /\{\s*"(?:type|arcs|properties|id)"\s*:/g;
  let m: RegExpExecArray | null;
  const cache = new Map<number, [number, number][]>();
  let convert: ((p: [number, number]) => [number, number]) | null = null;
  let lastEnd = 0;
  while ((m = re.exec(objects))) {
    if (m.index < lastEnd) continue;
    const end = jsonEnd(objects, m.index);
    if (end < 0) break;
    const chunk = objects.slice(m.index, end);
    // On ne retient que les géométries élémentaires (pas les collections) contenant le code.
    if (!chunk.includes(code) || !/"arcs"/.test(chunk) || /"geometries"/.test(chunk)) continue;
    lastEnd = end;
    re.lastIndex = end;
    let g: { type: string; arcs: number[][] | number[][][]; properties?: Record<string, unknown>; id?: unknown };
    try {
      g = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (g.type !== "Polygon" && g.type !== "MultiPolygon") continue;
    const polys = (g.type === "Polygon" ? [g.arcs as number[][]] : (g.arcs as number[][][])).map((rings) => rings.map((r) => ringFromArcs(text, loc, r, cache)));
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
