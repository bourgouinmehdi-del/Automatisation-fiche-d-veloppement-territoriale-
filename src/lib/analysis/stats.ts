/**
 * Calculs statistiques déterministes. Toutes les fonctions sont pures et
 * testées (tests/stats.test.ts). Aucune valeur n'est imputée : une entrée
 * manquante produit un résultat `null`.
 */
import type { Indicator, Unit } from "../types";

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Écart absolu médian (MAD), non normalisé. */
export function mad(values: number[]): number | null {
  const m = median(values);
  if (m == null) return null;
  return median(values.map((x) => Math.abs(x - m)));
}

/**
 * Score z robuste : (x − médiane) / (1,4826 × MAD).
 * Le facteur 1,4826 rend le MAD comparable à un écart-type pour une loi normale.
 * Renvoie null si moins de 5 points de comparaison ou dispersion nulle.
 */
export function robustZ(x: number, sample: number[]): number | null {
  const s = sample.filter((v) => Number.isFinite(v));
  if (s.length < 5) return null;
  const m = median(s)!;
  const d = mad(s)!;
  if (!d) return null;
  return (x - m) / (1.4826 * d);
}

/** Taux de croissance annuel moyen (en %) entre deux valeurs séparées de `years` années. */
export function cagr(start: number, end: number, years: number): number | null {
  if (!(start > 0) || !(end > 0) || !(years > 0)) return null;
  return (Math.pow(end / start, 1 / years) - 1) * 100;
}

export function pctChange(start: number, end: number): number | null {
  if (!start) return null;
  return ((end - start) / start) * 100;
}

export function density(population: number | null, km2: number | null): number | null {
  if (population == null || !km2) return null;
  return population / km2;
}

export interface Gap {
  /** Écart absolu (en points pour les %, en unité sinon). */
  abs: number;
  /** Écart relatif en %. */
  rel: number | null;
  unit: Unit;
  significant: boolean;
  direction: "superieur" | "inferieur" | "proche";
}

/**
 * Écart d'un territoire à une référence.
 * Règle de significativité (documentée dans le rapport) :
 *  - indicateurs en % : écart ≥ 2 points ET ≥ 10 % en relatif ;
 *  - autres indicateurs : écart relatif ≥ 10 %.
 * En deçà, la valeur est qualifiée de « proche » de la référence.
 */
export function gap(value: number, ref: number, unit: Unit): Gap {
  const abs = value - ref;
  const rel = ref !== 0 ? (abs / Math.abs(ref)) * 100 : null;
  const significant =
    unit === "%" ? Math.abs(abs) >= 2 && rel != null && Math.abs(rel) >= 10 : rel != null && Math.abs(rel) >= 10;
  return {
    abs,
    rel,
    unit: unit === "%" ? "points" : unit,
    significant,
    direction: !significant ? "proche" : abs > 0 ? "superieur" : "inferieur",
  };
}

/** Seuil en deçà duquel un ratio est signalé comme fragile (petits effectifs). */
export const SMALL_SAMPLE = 200;

export function isSmallSample(ind: Indicator): boolean {
  return ind.denominator != null && ind.denominator < SMALL_SAMPLE;
}

/** Évolution d'une série sur une période cible (approximativement `span` années). */
export function seriesEvolution(points: { x: string; y: number | null }[], span: number) {
  const valid = points.filter((p) => p.y != null && /^\d{4}$/.test(p.x)).map((p) => ({ year: Number(p.x), y: p.y! }));
  if (valid.length < 2) return null;
  const last = valid[valid.length - 1];
  const target = last.year - span;
  // Point le plus proche de l'année cible (sans aller au-delà de la série).
  let first = valid[0];
  for (const p of valid) if (Math.abs(p.year - target) < Math.abs(first.year - target)) first = p;
  if (first.year === last.year) return null;
  return {
    from: first.year,
    to: last.year,
    start: first.y,
    end: last.y,
    change: pctChange(first.y, last.y),
    annual: cagr(first.y, last.y, last.year - first.year),
  };
}

/** Distance orthodromique (km). */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Discrétisation en classes de quantiles (bornes uniques). */
export function quantileBreaks(values: number[], k = 5): number[] {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return [];
  const br: number[] = [];
  for (let i = 0; i <= k; i++) {
    const pos = (v.length - 1) * (i / k);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    br.push(v[lo] + (v[hi] - v[lo]) * (pos - lo));
  }
  return [...new Set(br)];
}

/** Rang (1 = plus grande valeur) d'un élément dans une liste. */
export function rankOf<T>(items: T[], getter: (t: T) => number | null, predicate: (t: T) => boolean) {
  const sorted = items.filter((i) => getter(i) != null).sort((a, b) => getter(b)! - getter(a)!);
  const idx = sorted.findIndex(predicate);
  return idx < 0 ? null : { rank: idx + 1, of: sorted.length };
}

/** Sélection de communes comparables : population à ±`tol` et même type de territoire. */
export function comparableCommunes<T extends { code: string; population: number | null }>(
  all: T[],
  target: { code: string; population: number | null },
  tol = 0.25,
  max = 12,
): T[] {
  if (!target.population) return [];
  const p = target.population;
  return all
    .filter((c) => c.code !== target.code && c.population != null && c.population >= p * (1 - tol) && c.population <= p * (1 + tol))
    .sort((a, b) => Math.abs(a.population! - p) - Math.abs(b.population! - p))
    .slice(0, max);
}
