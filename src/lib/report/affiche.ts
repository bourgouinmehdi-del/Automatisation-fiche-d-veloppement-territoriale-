import * as turf from "@turf/turf";
import type { BvRow } from "../analysis/political";
import { quartierLabel } from "../analysis/quartiers";
import { fmtNumber } from "../format";
import { POSTER } from "../render/poster";
import type { MapLayer, MapSpec, SourceRef } from "../types";
import type { Collected } from "./collect";

/**
 * Carte « affiche » d'une commune : propositions de porte-à-porte (quartiers
 * prioritaires, bureaux de vote prioritaires, résidences étudiantes) et de
 * tractage (marchés, gares), sur un fond de plan OpenStreetMap.
 */

interface Lieu {
  nom: string;
  infos: string;
  lon: number | null;
  lat: number | null;
}

const ROAD: Record<number, [number, string]> = {
  1: [2.8, "#bfb5a3"],
  2: [2.1, "#c8bfae"],
  3: [1.6, "#cfc7b7"],
  4: [1.15, "#d6cebf"],
  5: [0.6, "#ddd6c9"],
};

/** « ~10 000 voyageurs par jour » à partir d'une fréquentation annuelle. */
export function perDay(voyageursAn: number): string {
  const d = voyageursAn / 365;
  const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(d)) - 1));
  return `~${fmtNumber(Math.round(d / mag) * mag)} voyageurs/jour`;
}

export function communePoster(
  c: Collected,
  o: { prio: BvRow[]; labels: Map<string, string>; markets: Lieu[]; gares: (Lieu & { voyageurs?: number | null })[] },
): MapSpec | null {
  const { commune } = c;
  if (!commune.contour) return null;
  const contour = turf.feature(commune.contour as GeoJSON.Polygon, { nom: commune.nom });
  const qpv = (c.quartiers?.qpv ?? []).filter((q) => q.geometry);
  const prioPolys = (c.bvGeo?.features ?? []).filter((f) => o.prio.some((p) => p.bv === String(f.properties?.bv)));
  const res = c.residences?.list ?? [];
  const pts = <T extends Lieu>(xs: T[]) => xs.filter((x) => x.lon != null && x.lat != null);
  const markets = pts(o.markets);
  const gares = pts(o.gares);
  if (!qpv.length && !prioPolys.length && !res.length && !markets.length && !gares.length) return null;
  const bbox = c.fond?.bbox ?? (turf.bbox(contour) as [number, number, number, number]);
  const geoSrc: SourceRef = c.geoSource ?? { id: "geoapi", name: "geo.api.gouv.fr", url: "https://geo.api.gouv.fr", retrievedAt: new Date().toISOString() };
  const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
  const layers: MapLayer[] = [];

  // Communes voisines (grisées, nom en capitales) ; une « commune » qui contient la nôtre (Paris pour un arrondissement) est écartée.
  const centre = turf.pointOnFeature(contour);
  const box = turf.bboxPolygon(bbox);
  const voisins = (c.depFeatures?.features ?? []).filter((f) => {
    const p = f.properties as { code: string };
    if (!f.geometry || p.code === commune.code) return false;
    try {
      if (!turf.booleanIntersects(f, box)) return false;
      return !turf.booleanPointInPolygon(centre, f as GeoJSON.Feature<GeoJSON.Polygon>);
    } catch {
      return false;
    }
  });
  const capsAt = (f: GeoJSON.Feature) => {
    // Nom placé dans la partie visible de la commune voisine.
    try {
      const clip = turf.bboxClip(f as GeoJSON.Feature<GeoJSON.Polygon>, bbox);
      return turf.pointOnFeature(clip).geometry.coordinates;
    } catch {
      return undefined;
    }
  };
  if (voisins.length)
    layers.push({
      id: "voisins",
      label: "Communes voisines",
      kind: "polygons",
      data: fc(voisins.map((f) => ({ type: "Feature", geometry: f.geometry, properties: { nom: (f.properties as { nom: string }).nom, _at: capsAt(f) } }))),
      style: { fill: POSTER.hors, stroke: "#b9b2a4", strokeWidth: 0.8 },
      labelMode: "caps",
      labelProperty: "nom",
      visible: true,
      source: geoSrc,
    });
  layers.push({ id: "commune", label: commune.nom, kind: "polygons", data: fc([{ ...contour, properties: { nom: commune.nom, _at: centre.geometry.coordinates } }]), style: { fill: POSTER.creme, stroke: "none" }, labelMode: "caps", labelProperty: "nom", visible: true, source: geoSrc });

  const f = c.fond;
  if (f) {
    if (f.water.length) layers.push({ id: "eau", label: "Cours d'eau", kind: "polygons", data: fc(f.water), style: { fill: "#cfe0ea", stroke: "none" }, legendItem: { label: "Cours d'eau", swatch: "fill" }, visible: true, source: f.source });
    if (f.waterLines.length) layers.push({ id: "rivieres", label: "Rivières", kind: "lines", data: fc(f.waterLines), style: { fill: "#cfe0ea", stroke: "#bcd5e4", strokeWidth: 3 }, ...(f.water.length ? {} : { legendItem: { label: "Cours d'eau", swatch: "line" as const } }), visible: true, source: f.source });
    layers.push({
      id: "voies",
      label: "Voies",
      kind: "lines",
      data: fc([...f.roads].sort((a, b) => (b.properties?.c ?? 5) - (a.properties?.c ?? 5)).map((r) => ({ ...r, properties: { _sw: ROAD[r.properties?.c ?? 5][0], _stroke: ROAD[r.properties?.c ?? 5][1] } }))),
      visible: true,
      source: f.source,
    });
    if (f.rail.length) layers.push({ id: "fer", label: "Voie ferrée", kind: "lines", data: fc(f.rail), style: { stroke: "#77736a", strokeWidth: 1.2, dash: "7 4" }, legendItem: { label: "Voie ferrée", swatch: "dash" }, visible: true, source: f.source });
  }
  layers.push({ id: "limite", label: "Limite communale", kind: "polygons", data: fc([contour]), style: { fill: "none", stroke: POSTER.charbon, strokeWidth: 1.4, dash: "5 4" }, legendItem: { label: "Limite communale", swatch: "dash" }, visible: true, source: geoSrc });

  if (prioPolys.length) {
    const byBv = new Map(o.prio.map((p) => [p.bv, p]));
    layers.push({
      id: "bv_prio",
      label: "Bureaux de vote prioritaires",
      kind: "polygons",
      data: fc(
        prioPolys.map((p) => {
          const bv = String(p.properties?.bv);
          const r = byBv.get(bv)!;
          return { type: "Feature", geometry: p.geometry, properties: { nom: `Bureau ${bv}${o.labels.has(bv) ? ` — ${o.labels.get(bv)}` : ""}`, sub: `${fmtNumber(r.abstN)} inscrits n'ont pas voté` } };
        }),
      ),
      style: { fill: "#fbe3a2", stroke: POSTER.jauneTexte, strokeWidth: 1.4 },
      labelMode: "callout",
      labelProperty: "nom",
      sublabelProperty: "sub",
      labelColor: POSTER.jauneTexte,
      legendItem: { label: "Bureau de vote prioritaire (porte-à-porte)", swatch: "fill" },
      visible: true,
      source: c.bvGeo!.source,
    });
  }
  if (qpv.length)
    layers.push({
      id: "qpv",
      label: "Quartiers prioritaires",
      kind: "polygons",
      data: fc(
        qpv.map((q) => ({
          type: "Feature",
          geometry: q.geometry!,
          properties: { nom: quartierLabel(q.nom), sub: q.stats.hlm != null ? `${Math.round(q.stats.hlm)} % de logements sociaux` : q.stats.population ? `${fmtNumber(Math.round(q.stats.population / 100) * 100)} habitants` : "quartier prioritaire" },
        })),
      ),
      style: { fill: POSTER.jaune, stroke: POSTER.charbon, strokeWidth: 1 },
      labelMode: "callout",
      labelProperty: "nom",
      sublabelProperty: "sub",
      labelColor: POSTER.jauneTexte,
      legendItem: { label: "Quartier prioritaire (porte-à-porte)", swatch: "fill" },
      visible: true,
      source: c.quartiers!.sources[0],
    });
  if (res.length)
    layers.push({
      id: "residences",
      label: "Résidences étudiantes",
      kind: "points",
      data: fc(res.map((r) => turf.point([r.lon, r.lat], { nom: r.nom, sub: r.logements ? `${fmtNumber(r.logements)} logements` : r.crous ? "résidence du Crous" : "résidence étudiante" }))),
      style: { fill: POSTER.jaune, stroke: POSTER.charbon, symbol: "circle", size: 15 },
      labelMode: "callout",
      labelProperty: "nom",
      sublabelProperty: "sub",
      labelColor: POSTER.jauneTexte,
      legendItem: { label: "Résidence étudiante (porte-à-porte)", swatch: "circle" },
      visible: true,
      source: c.residences!.source,
    });
  const tract = [
    ...markets.map((m) => ({ nom: m.nom, sub: /à compléter/.test(m.infos) || !m.infos ? "jours et horaires à vérifier" : m.infos, lon: m.lon!, lat: m.lat! })),
    ...gares.map((g) => ({ nom: /^gare\b/i.test(g.nom) ? g.nom : `Gare de ${g.nom}`, sub: g.voyageurs ? perDay(g.voyageurs) : "", lon: g.lon!, lat: g.lat! })),
  ].filter((t) => t.lon >= bbox[0] && t.lon <= bbox[2] && t.lat >= bbox[1] && t.lat <= bbox[3]);
  if (tract.length)
    layers.push({
      id: "tractage",
      label: "Lieux de tractage",
      kind: "points",
      data: fc(tract.map((t) => turf.point([t.lon, t.lat], { nom: t.nom, sub: t.sub }))),
      style: { fill: POSTER.jaune, stroke: POSTER.charbon, symbol: "diamond", size: 17 },
      labelMode: "callout",
      labelProperty: "nom",
      sublabelProperty: "sub",
      labelColor: POSTER.jauneTexte,
      legendItem: { label: "Lieu de tractage (marché, gare)", swatch: "diamond" },
      visible: true,
      source: c.equipments?.source ?? c.stations?.source ?? geoSrc,
    });
  return {
    id: "lfi_affiche",
    title: `${commune.nom} : propositions de ciblage, porte-à-porte et tractage`,
    theme: "strategie",
    bbox,
    poster: {
      kicker: commune.nom,
      title: "Propositions de ciblage : porte-à-porte et tractage",
      source: "Source : Pôle d'études électorales. Fond de carte : © contributeurs OpenStreetMap, IGN.",
      footnote: "Périmètres et emplacements indicatifs.",
      scaleBar: true,
    },
    layers,
    note: "Porte-à-porte : quartiers prioritaires, bureaux de vote prioritaires et résidences étudiantes ; tractage : marchés et gares.",
  };
}
