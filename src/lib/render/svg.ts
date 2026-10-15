import fs from "node:fs";
import path from "node:path";
import { geoMercator, geoPath } from "d3-geo";
import { rewind } from "@turf/turf";
import { fmtNumber, fmtValue } from "../format";
import type { ChartSpec, MapSpec } from "../types";
import { colorFor, MISSING_COLOR } from "../report/assemble";
import { posterMapSvg } from "./poster";

/**
 * Rendu SVG statique des graphiques et des cartes, utilisé par l'export PDF
 * (via HTML) et par l'export DOCX (SVG rasterisé en PNG). Ces rendus ne
 * dépendent d'aucun service externe (pas de tuiles) afin d'être reproductibles.
 *
 * Palette : référence du skill dataviz (catégorielle ordonnée, séquentielle bleue).
 */

export const PALETTE = {
  series: ["#4c0297", "#d1271c", "#9c6ee8", "#f9a89e", "#212320", "#8f120a", "#c9adff", "#85877f"],
  text: "#0b0b0b",
  text2: "#52514e",
  muted: "#8a8984",
  grid: "#e9e3d3",
  surface: "#ffffff",
};

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const FONT = `font-family="Public Sans, Inter, DejaVu Sans, Arial, sans-serif"`;

/** Graduations « rondes » pour un axe. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  // La dernière graduation couvre le maximum (sinon les barres débordent du cadre).
  const top = Math.ceil(max / step - 1e-9) * step;
  for (let v = Math.floor(min / step) * step; v <= top + step * 1e-9; v += step) out.push(Math.round(v * 1e9) / 1e9);
  return out;
}

/** Libellés d'axe distincts : « 41 k » répété devient « 40,6 k », « 40,8 k »… ou le nombre entier. */
export function tickLabels(ticks: number[]): string[] {
  const tries = [(v: number) => shortNum(v), (v: number) => (Math.abs(v) >= 10000 ? fmtNumber(v / 1000, 1) + " k" : fmtNumber(v, 1)), (v: number) => fmtNumber(v, Number.isInteger(v) ? 0 : 2)];
  for (const f of tries) {
    const l = ticks.map(f);
    if (new Set(l).size === l.length) return l;
  }
  return ticks.map((v) => fmtNumber(v));
}

const shortNum = (v: number) => (Math.abs(v) >= 10000 ? fmtNumber(v / 1000, 0) + " k" : fmtNumber(v, Math.abs(v) < 10 && !Number.isInteger(v) ? 1 : 0));

function legend(series: { label: string }[], x: number, y: number) {
  if (series.length < 2) return "";
  let cx = x;
  return series
    .map((s, i) => {
      const w = 30 + s.label.length * 6.8;
      const out = `<rect x="${cx}" y="${y - 9}" width="12" height="12" rx="3" fill="${PALETTE.series[i]}"/><text x="${cx + 17}" y="${y + 1}" font-size="11" fill="${PALETTE.text2}" ${FONT}>${esc(s.label)}</text>`;
      cx += w;
      return out;
    })
    .join("");
}

export function chartSvg(c: ChartSpec, width = 720): string {
  if (c.type === "hbar") return hbarSvg(c, width);
  if (c.type === "pyramid") return pyramidSvg(c, width);
  const rows = c.data;
  const vals = rows.flatMap((r) => c.series.map((s) => r[s.key])).filter((v): v is number => typeof v === "number");
  if (!vals.length) return emptySvg(width, "Aucune donnée à représenter");
  const height = 300;
  const m = { l: 56, r: 16, t: 34, b: 52 };
  const minV = c.type === "line" ? Math.min(...vals) : Math.min(0, ...vals);
  const maxV = Math.max(...vals);
  const pad = c.type === "line" ? (maxV - minV) * 0.08 || Math.abs(maxV) * 0.05 || 1 : 0;
  const ticks = niceTicks(c.type === "line" ? minV - pad : minV, maxV + pad);
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const W = width - m.l - m.r;
  const H = height - m.t - m.b;
  const y = (v: number) => m.t + H - ((v - y0) / (y1 - y0 || 1)) * H;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(c.title)}"><rect width="100%" height="100%" fill="${PALETTE.surface}"/>`;
  s += legend(c.series, m.l, 16);
  const tl = tickLabels(ticks);
  ticks.forEach((t, i) => {
    s += `<line x1="${m.l}" x2="${width - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="${PALETTE.grid}"/><text x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end" font-size="10.5" fill="${PALETTE.muted}" ${FONT}>${tl[i]}</text>`;
  });
  const n = rows.length;
  const labelEvery = Math.ceil(n / Math.max(1, Math.floor(W / 64)));
  if (c.type === "bar") {
    const band = W / n;
    const bw = Math.min(36, (band * 0.75) / c.series.length);
    rows.forEach((r, i) => {
      const cx = m.l + band * i + band / 2;
      c.series.forEach((se, j) => {
        const v = r[se.key];
        if (typeof v !== "number") return;
        const x = cx - (bw * c.series.length) / 2 + j * bw + 1;
        const top = y(Math.max(0, v));
        const h = Math.abs(y(v) - y(0));
        s += `<path d="${roundedBar(x, top, bw - 2, h)}" fill="${PALETTE.series[j]}"><title>${esc(r[c.xKey])} — ${esc(se.label)} : ${esc(fmtValue(v, c.unit))}</title></path>`;
      });
      if (i % labelEvery === 0) s += wrapLabel(String(r[c.xKey]), cx, height - m.b + 16, band);
    });
  } else {
    const x = (i: number) => m.l + (n === 1 ? W / 2 : (i / (n - 1)) * W);
    c.series.forEach((se, j) => {
      let d = "";
      let pen = false;
      rows.forEach((r, i) => {
        const v = r[se.key];
        if (typeof v !== "number") {
          pen = false;
          return;
        }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      s += `<path d="${d}" fill="none" stroke="${PALETTE.series[j]}" stroke-width="2" stroke-linejoin="round"/>`;
      rows.forEach((r, i) => {
        const v = r[se.key];
        if (typeof v === "number")
          s += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${PALETTE.series[j]}" stroke="#fff" stroke-width="2"><title>${esc(r[c.xKey])} — ${esc(se.label)} : ${esc(fmtValue(v, c.unit))}</title></circle>`;
      });
      // Étiquette directe de la dernière valeur.
      const last = [...rows].reverse().find((r) => typeof r[se.key] === "number");
      if (last && c.series.length <= 4) {
        const i = rows.indexOf(last);
        s += `<text x="${x(i) - 4}" y="${y(last[se.key] as number) - 9}" text-anchor="end" font-size="10.5" fill="${PALETTE.text}" ${FONT}>${esc(fmtValue(last[se.key] as number, c.unit))}</text>`;
      }
    });
    rows.forEach((r, i) => {
      if (i % labelEvery === 0 || i === n - 1) s += `<text x="${x(i)}" y="${height - m.b + 16}" text-anchor="middle" font-size="10.5" fill="${PALETTE.text2}" ${FONT}>${esc(r[c.xKey])}</text>`;
    });
  }
  s += `<line x1="${m.l}" x2="${width - m.r}" y1="${y(Math.max(y0, 0))}" y2="${y(Math.max(y0, 0))}" stroke="${PALETTE.muted}"/>`;
  return s + "</svg>";
}

function wrapLabel(text: string, cx: number, y: number, band: number) {
  const maxChars = Math.max(6, Math.floor(band / 6));
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines
    .slice(0, 3)
    .map((l, i) => `<text x="${cx}" y="${y + i * 12}" text-anchor="middle" font-size="10" fill="${PALETTE.text2}" ${FONT}>${esc(l)}</text>`)
    .join("");
}

function roundedBar(x: number, y: number, w: number, h: number, r = 4) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function hbarSvg(c: ChartSpec, width: number): string {
  const rows = c.data.filter((r) => c.series.some((s) => typeof r[s.key] === "number"));
  if (!rows.length) return emptySvg(width, "Aucune donnée à représenter");
  const labelW = Math.min(260, Math.max(...rows.map((r) => String(r[c.xKey]).length)) * 6.2 + 12);
  const rowH = c.series.length > 1 ? 30 : 22;
  const m = { l: labelW, r: 70, t: c.series.length > 1 ? 30 : 10, b: 10 };
  const height = m.t + m.b + rows.length * rowH;
  const vals = rows.flatMap((r) => c.series.map((s) => r[s.key])).filter((v): v is number => typeof v === "number");
  const maxV = Math.max(...vals, 0) || 1;
  const W = width - m.l - m.r;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(c.title)}"><rect width="100%" height="100%" fill="${PALETTE.surface}"/>`;
  s += legend(c.series, m.l, 16);
  const bh = (rowH - 6) / c.series.length;
  rows.forEach((r, i) => {
    const top = m.t + i * rowH + 3;
    const label = String(r[c.xKey]);
    s += `<text x="${m.l - 8}" y="${top + (rowH - 6) / 2 + 4}" text-anchor="end" font-size="10.5" fill="${PALETTE.text}" ${FONT}>${esc(label.length > 44 ? label.slice(0, 42) + "…" : label)}</text>`;
    c.series.forEach((se, j) => {
      const v = r[se.key];
      if (typeof v !== "number") return;
      const w = Math.max(1, (v / maxV) * W);
      const yy = top + j * bh;
      s += `<path d="${roundedHBar(m.l, yy, w, bh - 2)}" fill="${PALETTE.series[j]}"><title>${esc(label)} — ${esc(se.label)} : ${esc(fmtValue(v, c.unit))}</title></path>`;
      s += `<text x="${m.l + w + 4}" y="${yy + bh / 2 + 3}" font-size="10" fill="${PALETTE.text2}" ${FONT}>${esc(fmtValue(v, c.unit))}</text>`;
    });
  });
  s += `<line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${height - m.b}" stroke="${PALETTE.muted}"/>`;
  return s + "</svg>";
}

function roundedHBar(x: number, y: number, w: number, h: number, r = 4) {
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

function pyramidSvg(c: ChartSpec, width: number): string {
  const rows = [...c.data].reverse();
  const [left, right] = c.series;
  const rowH = 22;
  const m = { t: 30, b: 10, mid: 80 };
  const height = m.t + m.b + rows.length * rowH;
  const maxV = Math.max(...rows.flatMap((r) => [r[left.key], r[right.key]]).filter((v): v is number => typeof v === "number"), 1);
  const half = (width - m.mid) / 2 - 50;
  const cx = width / 2;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(c.title)}"><rect width="100%" height="100%" fill="${PALETTE.surface}"/>`;
  s += legend(c.series, 10, 16);
  rows.forEach((r, i) => {
    const y = m.t + i * rowH + 2;
    const lv = r[left.key] as number;
    const rv = r[right.key] as number;
    const lw = (lv / maxV) * half;
    const rw = (rv / maxV) * half;
    s += `<rect x="${cx - m.mid / 2 - lw}" y="${y}" width="${lw}" height="${rowH - 4}" rx="3" fill="${PALETTE.series[0]}"><title>${esc(r[c.xKey])} — ${esc(left.label)} : ${fmtNumber(lv)}</title></rect>`;
    s += `<rect x="${cx + m.mid / 2}" y="${y}" width="${rw}" height="${rowH - 4}" rx="3" fill="${PALETTE.series[1]}"><title>${esc(r[c.xKey])} — ${esc(right.label)} : ${fmtNumber(rv)}</title></rect>`;
    s += `<text x="${cx}" y="${y + 13}" text-anchor="middle" font-size="10.5" fill="${PALETTE.text}" ${FONT}>${esc(r[c.xKey])}</text>`;
    s += `<text x="${cx - m.mid / 2 - lw - 4}" y="${y + 13}" text-anchor="end" font-size="10" fill="${PALETTE.text2}" ${FONT}>${fmtNumber(lv)}</text>`;
    s += `<text x="${cx + m.mid / 2 + rw + 4}" y="${y + 13}" font-size="10" fill="${PALETTE.text2}" ${FONT}>${fmtNumber(rv)}</text>`;
  });
  return s + "</svg>";
}

function emptySvg(width: number, msg: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 60" width="${width}" height="60"><rect width="100%" height="100%" fill="#f6f6f4"/><text x="${width / 2}" y="34" text-anchor="middle" font-size="12" fill="${PALETTE.muted}" ${FONT}>${esc(msg)}</text></svg>`;
}

/* ================================================================ cartes */

/**
 * d3-geo attend des anneaux extérieurs orientés dans le sens horaire, alors que
 * la norme GeoJSON (RFC 7946) impose le sens antihoraire : sans réorientation,
 * un polygone est interprété comme son complémentaire (le globe entier).
 */
function forD3<T extends GeoJSON.Feature | GeoJSON.FeatureCollection>(g: T): T {
  try {
    return rewind(g as never, { reverse: true }) as T;
  } catch {
    return g;
  }
}

export function mapSvg(map: MapSpec, width = 720, height = 540): string {
  if (map.poster) return posterMapSvg(map, Math.max(width, 900));
  const visible = map.layers
    .filter((l) => l.visible && l.data.features.length)
    .map((l) => (l.kind === "polygons" ? { ...l, data: forD3(structuredClone(l.data)) } : l));
  const all: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: visible.flatMap((l) => l.data.features) };
  if (!all.features.length) return emptySvg(width, "Aucune donnée cartographique");
  const extent: GeoJSON.Feature = map.bbox
    ? {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          // Sens horaire (convention d3-geo).
          coordinates: [[[map.bbox[0], map.bbox[1]], [map.bbox[0], map.bbox[3]], [map.bbox[2], map.bbox[3]], [map.bbox[2], map.bbox[1]], [map.bbox[0], map.bbox[1]]]],
        },
      }
    : (forD3(structuredClone(all)) as unknown as GeoJSON.Feature);
  const legendH = legendHeight(map);
  const mapH = height - legendH;
  const proj = geoMercator().fitExtent(
    [
      [8, 8],
      [width - 8, mapH - 8],
    ],
    extent,
  );
  const path = geoPath(proj);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(map.title)}"><rect width="100%" height="100%" fill="#f8fafc"/><defs><clipPath id="clip-${map.id}"><rect width="${width}" height="${mapH}"/></clipPath></defs><g clip-path="url(#clip-${map.id})">`;
  let labelsSvg = "";
  for (const l of visible) {
    if (l.kind === "polygons") {
      // Un bureau peut compter plusieurs polygones : son numéro n'est écrit qu'une fois, sur le plus grand.
      const labelOf = new Map<string, GeoJSON.Feature>();
      for (const f of l.data.features) {
        const bv = (f.properties as Record<string, unknown>)?.bv;
        if (bv == null) continue;
        const prev = labelOf.get(String(bv));
        if (!prev || path.area(f) > path.area(prev)) labelOf.set(String(bv), f);
      }
      for (const f of l.data.features) {
        const p = f.properties as Record<string, unknown>;
        // Étiquette (ex. noms des territoires ciblés) au centre du polygone.
        if (l.labelProperty && p[l.labelProperty]) {
          const c = path.centroid(f);
          if (Number.isFinite(c[0])) labelsSvg += `<text x="${c[0].toFixed(1)}" y="${(c[1] - 8).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="600" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke" ${FONT}>${esc(p[l.labelProperty])}</text>`;
        }
        // Numéro de bureau de vote au centre de chaque contour.
        if (p.bv != null && l.valueProperty && labelOf.get(String(p.bv)) === f) {
          const c = path.centroid(f);
          if (Number.isFinite(c[0])) labelsSvg += `<text x="${c[0].toFixed(1)}" y="${(c[1] + 3.5).toFixed(1)}" text-anchor="middle" font-size="${labelOf.size > 40 ? 8 : 10}" font-weight="700" fill="#111" stroke="#fff" stroke-width="2.5" paint-order="stroke" ${FONT}>${esc(p.bvl ?? p.bv)}</text>`;
        }
        const fill = l.outlineOnly
          ? "none"
          : l.valueProperty
            ? colorFor(p[l.valueProperty] as number | null, map.legend)
            : (p.color as string) ?? l.color ?? "#cbd5e1";
        const d = path(f);
        if (!d) continue;
        // Bureaux de vote : contours sombres et fins (lisibilité des aplats contigus).
        const isBv = p.bv != null && !!l.valueProperty;
        const stroke = l.outlineOnly ? l.color ?? "#111827" : l.id === "commune" || l.id === "contour" ? l.color ?? "#111" : isBv ? "#4b5563" : "#ffffff";
        const sw = l.outlineOnly || l.id === "commune" || l.id === "contour" ? 1.8 : isBv ? 0.8 : 0.4;
        const fo = l.id === "commune" && !l.valueProperty && map.layers.length > 1 && map.layers[0].valueProperty ? "none" : fill;
        const tip = l.valueProperty ? `${p.nom ?? ""} : ${p[l.valueProperty] == null ? "n.d." : fmtValue(p[l.valueProperty] as number, map.legend?.unit ?? "nombre")}` : String(p.nom ?? p.name ?? "");
        s += `<path d="${d}" fill="${l.id === "contour" ? "none" : fo}" fill-opacity="${l.id === "commune" && fo !== "none" ? 0.85 : 1}" stroke="${stroke}" stroke-width="${sw}"><title>${esc(tip)}</title></path>`;
      }
    } else if (l.kind === "lines") {
      for (const f of l.data.features) {
        const d = path(f);
        if (d) s += `<path d="${d}" fill="none" stroke="${l.color ?? "#16a34a"}" stroke-width="1.6"/>`;
      }
    } else {
      for (const f of l.data.features) {
        const g = f.geometry as GeoJSON.Point;
        const xy = proj(g.coordinates as [number, number]);
        if (!xy) continue;
        const p = f.properties as Record<string, unknown>;
        s += `<circle cx="${xy[0].toFixed(1)}" cy="${xy[1].toFixed(1)}" r="4" fill="${(p.color as string) ?? l.color ?? "#111"}" stroke="#fff" stroke-width="1.5"><title>${esc(p.name ?? "")}</title></circle>`;
      }
    }
  }
  s += labelsSvg + `</g>`;
  s += legendSvg(map, 10, mapH + 6, width);
  return s + "</svg>";
}

function legendHeight(map: MapSpec) {
  if (map.legend?.classes?.length) return 56;
  const n = map.legend?.categories?.length ?? 0;
  return n ? 26 + Math.ceil(n / 3) * 16 : 10;
}

function legendSvg(map: MapSpec, x: number, y: number, width: number) {
  const lg = map.legend;
  if (!lg) return "";
  let s = `<text x="${x}" y="${y + 12}" font-size="11" font-weight="600" fill="${PALETTE.text}" ${FONT}>${esc(lg.title)}</text>`;
  if (lg.classes?.length) {
    const w = Math.min(110, (width - 140) / lg.classes.length);
    // Une décimale lorsque les classes sont étroites (sinon « 11–11 »).
    const fine = lg.classes.some((c) => c.max - c.min < 2 && Math.abs(c.max) < 1000);
    const lab = (v: number) => (fine ? fmtNumber(v, 1) : shortNum(v));
    lg.classes.forEach((c, i) => {
      s += `<rect x="${x + i * w}" y="${y + 18}" width="${w - 2}" height="12" fill="${c.color}"/>`;
      s += `<text x="${x + i * w}" y="${y + 44}" font-size="${w < 70 ? 8.5 : 9.5}" fill="${PALETTE.text2}" ${FONT}>${esc(lab(c.min))}–${esc(lab(c.max))}</text>`;
    });
    s += `<rect x="${x + lg.classes.length * w + 10}" y="${y + 18}" width="14" height="12" fill="${MISSING_COLOR}"/><text x="${x + lg.classes.length * w + 28}" y="${y + 28}" font-size="9.5" fill="${PALETTE.text2}" ${FONT}>${esc(lg.missingLabel ?? "n.d.")}</text>`;
  } else if (lg.categories?.length) {
    const colW = (width - 20) / 3;
    lg.categories.forEach((c, i) => {
      const cx = x + (i % 3) * colW;
      const cy = y + 20 + Math.floor(i / 3) * 16;
      s += `<rect x="${cx}" y="${cy}" width="11" height="11" rx="2" fill="${c.color}"/><text x="${cx + 16}" y="${cy + 9.5}" font-size="10" fill="${PALETTE.text2}" ${FONT}>${esc(c.label.length > 46 ? c.label.slice(0, 44) + "…" : c.label)}</text>`;
    });
  }
  return s;
}

/* ======================================================= carte nationale */

let _deps: { id: string; name: string; path: string }[] | null = null;
let _viewBox = "0 0 613 585";

function loadDepartments() {
  if (_deps) return _deps;
  const file = path.join(process.cwd(), "node_modules", "@svg-maps", "france.departments", "index.js");
  const txt = fs.readFileSync(file, "utf8").replace(/^\s*export default\s*/, "").replace(/;\s*$/, "");
  const json = JSON.parse(txt) as { viewBox: string; locations: { id: string; name: string; path: string }[] };
  _viewBox = json.viewBox;
  _deps = json.locations;
  return _deps;
}

/** Carte de localisation nationale : département de la commune en surbrillance. */
export function locatorSvg(depCode: string, label: string, width = 360): string {
  const deps = loadDepartments();
  const [, , vw, vh] = _viewBox.split(" ").map(Number);
  const h = Math.round((width * vh) / vw);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${_viewBox}" width="${width}" height="${h}" role="img" aria-label="${esc(label)}">`;
  for (const d of deps) {
    const on = d.id.toUpperCase() === depCode.toUpperCase();
    s += `<path d="${d.path}" fill="${on ? PALETTE.series[0] : "#e5e7eb"}" stroke="#ffffff" stroke-width="0.6"><title>${esc(d.name)}</title></path>`;
  }
  return s + "</svg>";
}

export function hasLocator(depCode: string) {
  return loadDepartments().some((d) => d.id.toUpperCase() === depCode.toUpperCase());
}
