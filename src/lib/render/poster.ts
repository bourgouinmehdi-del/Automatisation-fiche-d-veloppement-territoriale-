import { geoMercator, geoPath, type GeoProjection } from "d3-geo";
import { area as turfArea, bboxClip, distance, pointOnFeature, rewind } from "@turf/turf";
import type { MapLayer, MapSpec } from "../types";

/**
 * Cartes « affiche », sur le modèle des cartes du pôle (état des groupes
 * d'action d'un département, propositions de porte-à-porte et de tractage
 * d'une commune) : bandeau titre, carte encadrée sur fond clair, étiquettes
 * décalées avec trait de rappel, légende encadrée, échelle et source.
 * Rendu SVG autonome (pas de tuiles), utilisé tel quel en PDF, Word et PNG.
 */

export const POSTER = {
  violet: "#4c0297",
  jaune: "#f3b51b",
  jauneTexte: "#c98a00",
  charbon: "#212320",
  creme: "#fffcf4",
  hors: "#ddd8cd",
  trait: "#c9c3b6",
};

const FONT = `font-family="Stack Sans Text Variable, Stack Sans Text, Public Sans, DejaVu Sans, Arial, sans-serif"`;
const TITLE_FONT = `font-family="Archivo Variable, Archivo, Arial Narrow, DejaVu Sans, sans-serif"`;
const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const textW = (s: string, size: number, bold = false) => s.length * size * (bold ? 0.6 : 0.54);

function forD3<T extends GeoJSON.Feature | GeoJSON.FeatureCollection>(g: T): T {
  try {
    return rewind(g as never, { reverse: true }) as T;
  } catch {
    return g;
  }
}

/** Point d'ancrage d'une entité : le point lui-même, ou un point intérieur du plus grand polygone. */
function anchorOf(f: GeoJSON.Feature): [number, number] | null {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === "Point") return g.coordinates as [number, number];
  try {
    let poly: GeoJSON.Feature = f;
    if (g.type === "MultiPolygon") {
      const parts = g.coordinates.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: c } }) as GeoJSON.Feature<GeoJSON.Polygon>);
      poly = parts.sort((a, b) => turfArea(b) - turfArea(a))[0];
    }
    return pointOnFeature(poly as GeoJSON.Feature<GeoJSON.Polygon>).geometry.coordinates as [number, number];
  } catch {
    return null;
  }
}

function symbolSvg(kind: string, x: number, y: number, size: number, fill: string, stroke: string) {
  if (kind === "diamond") {
    const r = size * 0.75;
    return `<path d="M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>`;
  }
  if (kind === "dot") return `<circle cx="${x}" cy="${y}" r="${size / 3}" fill="${fill}"/>`;
  return `<circle cx="${x}" cy="${y}" r="${size / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>`;
}

function swatch(kind: string, x: number, y: number, l: MapLayer) {
  const st = l.style ?? {};
  const fill = st.fill ?? l.color ?? "#ccc";
  const stroke = st.stroke ?? POSTER.charbon;
  if (kind === "fill") return `<rect x="${x}" y="${y - 5}" width="24" height="10" fill="${fill}" stroke="${stroke}" stroke-width="0.8"/>`;
  if (kind === "line" || kind === "dash")
    return `<line x1="${x}" x2="${x + 24}" y1="${y}" y2="${y}" stroke="${kind === "line" && (st.strokeWidth ?? 1) < 1 ? "#9b9485" : st.stroke ?? fill}" stroke-width="${Math.max(1.2, Math.min(2.4, st.strokeWidth ?? 1.4))}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""}/>`;
  return symbolSvg(kind, x + 12, y, 12, fill, stroke);
}

/** Barre d'échelle : longueur « ronde » d'environ 110 px. */
function scaleBar(proj: GeoProjection, x: number, y: number) {
  const a = proj.invert!([x, y]);
  const b = proj.invert!([x + 110, y]);
  if (!a || !b) return "";
  const m = distance(a, b, { units: "kilometers" }) * 1000;
  const nice = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000].filter((v) => v <= m).pop() ?? 50;
  const px = (110 * nice) / m;
  const lab = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
  return `<g><rect x="${x - 10}" y="${y - 30}" width="${px + 20}" height="44" fill="#fff" fill-opacity="0.75"/><text x="${x + px / 2}" y="${y - 12}" text-anchor="middle" font-size="11" fill="${POSTER.charbon}" ${FONT}>${lab}</text><rect x="${x}" y="${y - 4}" width="${px / 2}" height="7" fill="${POSTER.charbon}"/><rect x="${x + px / 2}" y="${y - 4}" width="${px / 2}" height="7" fill="#fff" stroke="${POSTER.charbon}" stroke-width="1"/></g>`;
}

export function posterMapSvg(map: MapSpec, width = 900): string {
  const P = map.poster!;
  const layers = map.layers.filter((l) => l.visible && l.data.features.length).map((l) => (l.kind === "polygons" ? { ...l, data: forD3(structuredClone(l.data)) } : l));
  const bb = map.bbox ?? [-5, 41, 10, 51];
  const pad = 24;
  const headH = 74;
  const frameW = width - 2 * pad;
  // Hauteur du cadre : proportions de l'emprise (projection de Mercator).
  const k = 1 / Math.cos((((bb[1] + bb[3]) / 2) * Math.PI) / 180);
  const ratio = ((bb[3] - bb[1]) * k) / (bb[2] - bb[0] || 1);
  const frameH = Math.round(Math.max(0.62, Math.min(1.25, ratio)) * frameW);
  const fx = pad;
  const fy = headH;
  const extent: GeoJSON.Feature = {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[bb[0], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]], [bb[2], bb[1]], [bb[0], bb[1]]]] },
  };
  const proj = geoMercator().fitExtent(
    [
      [fx + 2, fy + 2],
      [fx + frameW - 2, fy + frameH - 2],
    ],
    extent,
  );
  const path = geoPath(proj);
  const clip = `clip-${map.id.replace(/[^\w-]/g, "")}`;
  let body = "";
  for (const l of layers) {
    const st = l.style ?? {};
    for (const f of l.data.features) {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      const fill = (p._fill as string) ?? st.fill ?? (l.kind === "polygons" ? l.color ?? "none" : "none");
      const stroke = (p._stroke as string) ?? st.stroke ?? (l.kind === "lines" ? l.color ?? POSTER.trait : "none");
      const sw = (p._sw as number) ?? st.strokeWidth ?? 1;
      const dash = (p._dash as string) ?? st.dash;
      if (l.kind === "points") {
        if (st.symbol === undefined && !l.legendItem) continue;
        const xy = f.geometry?.type === "Point" ? proj(f.geometry.coordinates as [number, number]) : null;
        if (xy) body += symbolSvg(st.symbol ?? "circle", +xy[0].toFixed(1), +xy[1].toFixed(1), st.size ?? 14, st.fill ?? l.color ?? POSTER.jaune, st.stroke ?? POSTER.charbon);
        continue;
      }
      const d = path(f);
      if (!d) continue;
      body += `<path d="${d}" fill="${l.kind === "lines" ? "none" : fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
    }
  }

  // Étiquettes : capitales grises (territoires voisins, circonscriptions), puis étiquettes à trait de rappel.
  const boxes: Box[] = [];
  const frame: Box = { x: fx + 4, y: fy + 4, w: frameW - 8, h: frameH - 8 };
  // Emplacement de l'échelle réservé (aucune étiquette dessous).
  if (P.scaleBar) boxes.push({ x: fx + 26, y: fy + frameH - 74, w: 150, h: 70 });
  const inside = (b: Box) => b.x >= frame.x && b.y >= frame.y && b.x + b.w <= frame.x + frame.w && b.y + b.h <= frame.y + frame.h;
  let labels = "";
  for (const l of layers.filter((x) => x.labelMode === "caps" && x.labelProperty)) {
    for (const f of l.data.features) {
      const t = String((f.properties as Record<string, unknown>)?.[l.labelProperty!] ?? "").toUpperCase();
      if (!t) continue;
      const at = (f.properties as Record<string, unknown>)?._at as [number, number] | undefined;
      // Partie visible de l'entité (département voisin à moitié hors cadre).
      let a = at ?? null;
      if (!a && f.geometry && /Polygon/.test(f.geometry.type)) {
        try {
          const clip = bboxClip(f as GeoJSON.Feature<GeoJSON.Polygon>, bb);
          a = anchorOf(clip as GeoJSON.Feature);
        } catch {
          a = null;
        }
      }
      a ??= anchorOf(f);
      const xy = a ? proj(a) : null;
      if (!xy) continue;
      const size = l.labelColor ? 13 : 11;
      const w = textW(t, size, true) * 0.95;
      const b = { x: xy[0] - w / 2, y: xy[1] - size, w, h: size + 4 };
      if (!inside(b) || boxes.some((x) => overlap(x, b))) continue;
      boxes.push(b);
      labels += `<text x="${xy[0].toFixed(1)}" y="${xy[1].toFixed(1)}" text-anchor="middle" font-size="${size}" font-weight="700" letter-spacing="0.6" fill="${l.labelColor ?? "#6f6b62"}" stroke="${l.labelColor ? "#fff" : POSTER.creme}" stroke-width="${l.labelColor ? 3 : 2}" paint-order="stroke" ${FONT}>${esc(t)}</text>`;
    }
  }
  type Call = { xy: [number, number]; t: string; sub: string; color: string; size: number };
  const calls: Call[] = [];
  for (const l of layers.filter((x) => x.labelMode === "callout" && x.labelProperty)) {
    for (const f of l.data.features) {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      const t = String(p[l.labelProperty!] ?? "");
      if (!t) continue;
      const a = anchorOf(f);
      const xy = a ? proj(a) : null;
      if (!xy) continue;
      calls.push({ xy: [xy[0], xy[1]], t, sub: l.sublabelProperty ? String(p[l.sublabelProperty] ?? "") : "", color: (p._label as string) ?? l.labelColor ?? POSTER.violet, size: 12 });
    }
  }
  // Les ancres occupent leur place : une étiquette ne recouvre pas le point d'une autre.
  for (const c of calls) boxes.push({ x: c.xy[0] - 4, y: c.xy[1] - 4, w: 8, h: 8 });
  const dirs: [number, number][] = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
    [0.8, 0.8],
    [-0.8, 0.8],
    [0.8, -0.8],
    [-0.8, -0.8],
  ];
  for (const c of calls) {
    const w = Math.max(textW(c.t, c.size, true), c.sub ? textW(c.sub, 10) : 0);
    const h = c.sub ? 28 : 15;
    let placed: { b: Box; tx: number; ty: number } | null = null;
    search: for (const dist of [26, 42, 62, 90, 125, 165])
      for (const [dx, dy] of dirs) {
        const cx = c.xy[0] + dx * dist;
        const cy = c.xy[1] + dy * dist;
        // Boîte centrée horizontalement sous / au-dessus, ou accolée à gauche / à droite.
        const bx = dx > 0.5 ? cx : dx < -0.5 ? cx - w : cx - w / 2;
        const by = dy > 0.5 ? cy : dy < -0.5 ? cy - h : cy - h / 2;
        const b = { x: bx - 2, y: by - 2, w: w + 4, h: h + 4 };
        if (!inside(b) || boxes.some((x) => overlap(x, b))) continue;
        placed = { b, tx: bx + w / 2, ty: by + 12 };
        break search;
      }
    // Aucune place libre : le symbole reste, sans étiquette (plutôt qu'un texte illisible).
    if (!placed) continue;
    boxes.push(placed.b);
    // Trait de rappel : du point d'ancrage au bord le plus proche de l'étiquette.
    const ex = Math.max(placed.b.x, Math.min(c.xy[0], placed.b.x + placed.b.w));
    const ey = Math.max(placed.b.y, Math.min(c.xy[1], placed.b.y + placed.b.h));
    labels += `<line x1="${c.xy[0].toFixed(1)}" y1="${c.xy[1].toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${POSTER.charbon}" stroke-width="1.1"/><circle cx="${c.xy[0].toFixed(1)}" cy="${c.xy[1].toFixed(1)}" r="2.6" fill="${POSTER.charbon}"/>`;
    labels += `<text x="${placed.tx.toFixed(1)}" y="${placed.ty.toFixed(1)}" text-anchor="middle" font-size="${c.size}" font-weight="700" fill="${c.color}" stroke="#fff" stroke-width="3" paint-order="stroke" ${FONT}>${esc(c.t)}</text>`;
    if (c.sub) labels += `<text x="${placed.tx.toFixed(1)}" y="${(placed.ty + 14).toFixed(1)}" text-anchor="middle" font-size="10" fill="${POSTER.charbon}" stroke="#fff" stroke-width="2.5" paint-order="stroke" ${FONT}>${esc(c.sub)}</text>`;
  }

  // Légende encadrée (deux colonnes).
  const items = layers.filter((l) => l.legendItem).map((l) => ({ l, it: l.legendItem! }));
  const cols = items.length > 4 ? 3 : 2;
  const rows = Math.ceil(items.length / cols);
  const legY = fy + frameH + 16;
  const legH = items.length ? 26 + rows * 26 : 0;
  let legend = "";
  if (items.length) {
    legend += `<rect x="${fx}" y="${legY}" width="${frameW}" height="${legH}" fill="#fff" stroke="${POSTER.charbon}" stroke-width="1.2"/>`;
    const colW = frameW / cols;
    items.forEach(({ l, it }, i) => {
      const x = fx + 30 + (i % cols) * colW;
      const y = legY + 26 + Math.floor(i / cols) * 26;
      legend += swatch(it.swatch, x, y, l) + `<text x="${x + 34}" y="${y + 4}" font-size="11.5" fill="${POSTER.charbon}" ${FONT}>${esc(it.label)}</text>`;
    });
  }
  const footY = legY + legH + 18;
  const height = footY + 10;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(`${P.kicker} — ${P.title}`)}">`;
  s += `<rect width="100%" height="100%" fill="#fff"/>`;
  s += `<rect x="${pad}" y="14" width="6" height="50" fill="${POSTER.violet}"/>`;
  s += `<text x="${pad + 18}" y="38" font-size="25" font-weight="800" fill="${POSTER.violet}" ${TITLE_FONT}>${esc(P.kicker.toUpperCase())}</text>`;
  s += `<text x="${pad + 18}" y="62" font-size="19" font-weight="700" fill="${POSTER.charbon}" ${TITLE_FONT}>${esc(P.title)}</text>`;
  s += `<line x1="${pad}" x2="${width - pad}" y1="${headH - 4}" y2="${headH - 4}" stroke="${POSTER.charbon}" stroke-width="0.6"/>`;
  s += `<defs><clipPath id="${clip}"><rect x="${fx}" y="${fy}" width="${frameW}" height="${frameH}"/></clipPath></defs>`;
  s += `<g clip-path="url(#${clip})"><rect x="${fx}" y="${fy}" width="${frameW}" height="${frameH}" fill="${POSTER.hors}"/>${body}${labels}${P.scaleBar ? scaleBar(proj, fx + 40, fy + frameH - 40) : ""}</g>`;
  s += `<rect x="${fx}" y="${fy}" width="${frameW}" height="${frameH}" fill="none" stroke="${POSTER.charbon}" stroke-width="1.5"/>`;
  s += legend;
  if (P.footnote) s += `<text x="${pad}" y="${footY}" font-size="10" fill="#52514e" ${FONT}>${esc(P.footnote)}</text>`;
  s += `<text x="${width - pad}" y="${footY}" text-anchor="end" font-size="10" fill="#52514e" ${FONT}>${esc(P.source)}</text>`;
  return s + "</svg>";
}
