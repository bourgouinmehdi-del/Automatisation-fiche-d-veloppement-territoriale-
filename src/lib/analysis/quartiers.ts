import * as turf from "@turf/turf";
import type { Quartier } from "../collectors/quartiers";

/**
 * Croisement des quartiers (QPV, IRIS) avec les bureaux de vote.
 *
 * Méthode : part de la surface de chaque bureau comprise dans chaque
 * quartier (contours des bureaux, même approximatifs). Un bureau est rattaché
 * à un quartier si au moins 30 % de sa surface s'y trouve ; à défaut de
 * contours, on teste la position du lieu de vote. Le recouvrement est
 * indicatif : les contours des bureaux sont souvent des enveloppes
 * d'adresses, et les quartiers ne suivent pas le découpage électoral.
 */

export const OVERLAP_MIN = 0.3;

export interface BvQuartier {
  bv: string;
  quartier: string;
  kind: "qpv" | "iris";
  /** Part de la surface du bureau dans le quartier (0-1), ou 1 si le lieu de vote y est situé. */
  share: number;
}

function asFeature(g: GeoJSON.Geometry): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
  if (g.type !== "Polygon" && g.type !== "MultiPolygon") return null;
  return turf.feature(g as GeoJSON.Polygon | GeoJSON.MultiPolygon);
}

/** Rattache les bureaux aux quartiers (surface, sinon lieu de vote). */
export function matchBureaux(quartiers: Quartier[], bvPolys: GeoJSON.Feature[], bvPoints: GeoJSON.Feature<GeoJSON.Point>[]): BvQuartier[] {
  const out: BvQuartier[] = [];
  const qs = quartiers.map((q) => ({ q, f: q.geometry ? asFeature(q.geometry) : null })).filter((x) => x.f);
  const done = new Set<string>();
  for (const b of bvPolys) {
    const bv = String(b.properties?.bv ?? "");
    const bf = b.geometry ? asFeature(b.geometry) : null;
    if (!bv || !bf) continue;
    let area = 0;
    try {
      area = turf.area(bf);
    } catch {
      continue;
    }
    if (!area) continue;
    for (const { q, f } of qs) {
      try {
        const bb1 = turf.bbox(bf);
        const bb2 = turf.bbox(f!);
        if (bb1[0] > bb2[2] || bb1[2] < bb2[0] || bb1[1] > bb2[3] || bb1[3] < bb2[1]) continue;
        const inter = turf.intersect(turf.featureCollection([bf, f!]));
        const share = inter ? turf.area(inter) / area : 0;
        if (share >= 0.05) out.push({ bv, quartier: q.code, kind: q.kind, share });
      } catch {
        /* géométrie invalide */
      }
    }
    done.add(bv);
  }
  for (const p of bvPoints) {
    const bv = String(p.properties?.bv ?? "");
    if (!bv || done.has(bv)) continue;
    for (const { q, f } of qs) {
      try {
        if (turf.booleanPointInPolygon(p, f!)) out.push({ bv, quartier: q.code, kind: q.kind, share: 1 });
      } catch {
        /* géométrie invalide */
      }
    }
  }
  return out;
}

/** Bureaux principalement situés dans un quartier (part ≥ seuil), par quartier. */
export function bureauxByQuartier(m: BvQuartier[], min = OVERLAP_MIN) {
  const by = new Map<string, string[]>();
  for (const x of m) {
    if (x.share < min) continue;
    if (!by.has(x.quartier)) by.set(x.quartier, []);
    by.get(x.quartier)!.push(x.bv);
  }
  for (const v of by.values()) v.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  return by;
}

/** Quartier principal d'un bureau : QPV prioritaire sur l'IRIS, puis plus forte part. */
export function quartierOfBureau(m: BvQuartier[], bv: string, min = OVERLAP_MIN): BvQuartier | null {
  const xs = m.filter((x) => x.bv === bv && x.share >= min);
  xs.sort((a, b) => (a.kind === b.kind ? b.share - a.share : a.kind === "qpv" ? -1 : 1));
  return xs[0] ?? null;
}

/** « la Madeleine » à partir de « La Madeleine » ; garde les noms propres. */
/**
 * Nom d'un quartier lisible dans une phrase : article initial en minuscule,
 * mots de liaison en minuscules (« Frange Ouest du Centre-Ville », « Pierre et
 * Marie Curie »), numéro d'IRIS détaché (« Gare 31 » → « Gare (secteur 31) »).
 */
export const quartierLabel = (nom: string) =>
  nom
    .trim()
    .replace(/(?<=\S\s)(Du|De|Des|La|Le|Les|Et|Aux?|Sur|En|D'|L')(?=\s|[A-ZÀ-Ý])/g, (m) => m.toLowerCase())
    .replace(/^(.*\D)\s+(\d{1,3})$/, "$1 (secteur $2)")
    .replace(/^(Le|La|Les|L')\s?/, (m) => m.toLowerCase());
