import * as turf from "@turf/turf";

/**
 * Zones électorales d'une commune : regroupement de bureaux de vote voisins qui
 * votent de la même façon (régionalisation sous contrainte de contiguïté).
 *
 * Classification ascendante de Ward pondérée par les inscrits : on fusionne à
 * chaque étape les deux groupes voisins dont la fusion augmente le moins la
 * dispersion des profils (variables centrées réduites). Deux bureaux sont
 * voisins si leurs contours se touchent ; sans contours, si l'un est parmi les
 * trois lieux de vote les plus proches de l'autre.
 */

export interface ZoneInput {
  bv: string;
  inscrits: number;
  /** Profil électoral (ex. vote LFI, vote gauche hors LFI, abstention), en %. */
  x: number[];
  geometry?: GeoJSON.Geometry | null;
  at?: [number, number] | null;
}

export interface Zone {
  bvs: string[];
  inscrits: number;
  /** Centre (moyenne des positions pondérée par les inscrits). */
  at: [number, number] | null;
}

/** Nombre de zones selon le nombre de bureaux (aucune sous 8 bureaux). */
export const zoneCount = (n: number) => (n < 8 ? 0 : n < 20 ? 3 : n < 50 ? 4 : 5);

export function electoralZones(units: ZoneInput[], k = zoneCount(units.length)): Zone[] {
  const n = units.length;
  if (!k || n <= k) return [];
  // Variables centrées réduites (une variable très dispersée ne domine pas les autres).
  const d = units[0].x.length;
  const mean = Array.from({ length: d }, (_, j) => units.reduce((s, u) => s + u.x[j], 0) / n);
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(units.reduce((s, u) => s + (u.x[j] - mean[j]) ** 2, 0) / n) || 1);
  const z = units.map((u) => u.x.map((v, j) => (v - mean[j]) / sd[j]));
  const pos = units.map((u) => {
    if (u.at) return u.at;
    if (u.geometry) {
      try {
        return turf.centroid(u.geometry as GeoJSON.Polygon).geometry.coordinates as [number, number];
      } catch {
        return null;
      }
    }
    return null;
  });

  // Voisinage.
  const adj: Set<number>[] = units.map(() => new Set());
  const withGeom = units.every((u) => u.geometry);
  if (withGeom) {
    const eps = 0.0003;
    const bb = units.map((u) => turf.bbox(u.geometry as GeoJSON.Polygon));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const a = bb[i];
        const b = bb[j];
        if (a[0] > b[2] + eps || b[0] > a[2] + eps || a[1] > b[3] + eps || b[1] > a[3] + eps) continue;
        let touch = false;
        try {
          touch = turf.booleanIntersects(units[i].geometry as GeoJSON.Polygon, units[j].geometry as GeoJSON.Polygon);
        } catch {
          touch = false;
        }
        if (touch) adj[i].add(j), adj[j].add(i);
      }
  }
  // Sans contours, ou bureau isolé (contour approximatif) : les trois plus proches.
  for (let i = 0; i < n; i++) {
    if (adj[i].size || !pos[i]) continue;
    const near = units
      .map((_, j) => ({ j, dist: j !== i && pos[j] ? Math.hypot(pos[i]![0] - pos[j]![0], pos[i]![1] - pos[j]![1]) : Infinity }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3)
      .filter((x) => Number.isFinite(x.dist));
    for (const { j } of near) adj[i].add(j), adj[j].add(i);
  }

  // Groupes : membres, poids (inscrits), centre du profil.
  type G = { members: number[]; w: number; m: number[]; nb: Set<number> };
  const groups = new Map<number, G>();
  units.forEach((u, i) => groups.set(i, { members: [i], w: Math.max(1, u.inscrits), m: z[i], nb: new Set(adj[i]) }));
  const owner = units.map((_, i) => i);
  const cost = (a: G, b: G) => ((a.w * b.w) / (a.w + b.w)) * a.m.reduce((s, v, j) => s + (v - b.m[j]) ** 2, 0);

  while (groups.size > k) {
    let best: { a: number; b: number; c: number } | null = null;
    for (const [ia, a] of groups)
      for (const ib of a.nb) {
        if (ib <= ia) continue;
        const b = groups.get(ib);
        if (!b) continue;
        const c = cost(a, b);
        if (!best || c < best.c) best = { a: ia, b: ib, c };
      }
    if (!best) break; // parties de commune sans lien entre elles
    const a = groups.get(best.a)!;
    const b = groups.get(best.b)!;
    const w = a.w + b.w;
    const merged: G = { members: [...a.members, ...b.members], w, m: a.m.map((v, j) => (v * a.w + b.m[j] * b.w) / w), nb: new Set([...a.nb, ...b.nb]) };
    merged.nb.delete(best.a);
    merged.nb.delete(best.b);
    groups.delete(best.b);
    groups.set(best.a, merged);
    for (const i of b.members) owner[i] = best.a;
    for (const g of groups.values()) if (g.nb.delete(best.b)) g.nb.add(best.a);
    merged.nb.delete(best.a);
  }

  return [...groups.values()].map((g) => {
    const ps = g.members.map((i) => ({ p: pos[i], w: Math.max(1, units[i].inscrits) })).filter((x) => x.p);
    const W = ps.reduce((s, x) => s + x.w, 0);
    return {
      bvs: g.members.map((i) => units[i].bv),
      inscrits: g.members.reduce((s, i) => s + units[i].inscrits, 0),
      at: ps.length ? [ps.reduce((s, x) => s + x.p![0] * x.w, 0) / W, ps.reduce((s, x) => s + x.p![1] * x.w, 0) / W] : null,
    };
  });
}

/** « nord-est », « centre »… : position d'un point par rapport au centre de la commune. */
export function compass(at: [number, number], centre: [number, number], radiusKm: number): string {
  const dx = (at[0] - centre[0]) * Math.cos((centre[1] * Math.PI) / 180) * 111;
  const dy = (at[1] - centre[1]) * 111;
  if (Math.hypot(dx, dy) < radiusKm * 0.28) return "centre";
  const a = (Math.atan2(dy, dx) * 180) / Math.PI;
  const dirs = ["est", "nord-est", "nord", "nord-ouest", "ouest", "sud-ouest", "sud", "sud-est"];
  return dirs[Math.round(((a + 360) % 360) / 45) % 8];
}
