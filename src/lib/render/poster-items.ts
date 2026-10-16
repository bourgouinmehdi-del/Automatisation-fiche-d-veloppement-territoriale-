import { area as turfArea, pointOnFeature } from "@turf/turf";
import type { MapSpec } from "../types";

/**
 * Lieux numérotés des cartes « affiche » : une seule numérotation pour
 * l'image (PDF, Word, PNG), la liste « Où agir » et la carte interactive.
 */

/** Point d'ancrage d'une entité : le point lui-même, ou un point intérieur du plus grand polygone. */
export function anchorOf(f: GeoJSON.Feature): [number, number] | null {
  const g = f.geometry;
  if (!g) return null;
  const at = (f.properties as Record<string, unknown> | null)?._at;
  if (Array.isArray(at) && at.length === 2 && at.every((v) => Number.isFinite(v))) return at as [number, number];
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

/** Lieu numéroté d'une carte « affiche » (même numéro sur la carte, dans la liste et dans la carte interactive). */
export interface PosterItem {
  n: number;
  layerId: string;
  /** « Porte-à-porte », « Tractage ». */
  action: string;
  /** Type de lieu (« Bureaux de vote prioritaires »). */
  group: string;
  color: string;
  shape: string;
  nom: string;
  sub: string;
  det: string[];
  quand: string;
  at: [number, number];
}

/** Numérotation des lieux : ordre des couches, puis des entités (une seule fonction pour tous les rendus). */
export function posterItems(map: MapSpec): PosterItem[] {
  const out: PosterItem[] = [];
  for (const l of map.layers.filter((x) => x.visible && x.labelMode === "number" && x.labelProperty)) {
    const color = l.labelColor ?? "#4c0297";
    const shape = l.kind === "points" ? (l.style?.symbol ?? "circle") : "circle";
    for (const f of l.data.features) {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      const at = anchorOf(f);
      if (!at) continue;
      out.push({
        n: out.length + 1,
        layerId: l.id,
        action: (l.legendItem?.label ?? "").split(" : ")[0] || "Où agir",
        group: l.label,
        color,
        shape,
        nom: String(p[l.labelProperty!] ?? ""),
        sub: l.sublabelProperty ? String(p[l.sublabelProperty] ?? "") : "",
        det: Array.isArray(p.det) ? (p.det as string[]) : [],
        quand: String(p.quand ?? ""),
        at,
      });
    }
  }
  return out;
}

