import Papa from "papaparse";
import type { TrackedHttp } from "./context";

/**
 * Connecteur DVF géolocalisé (Etalab) : un fichier CSV par commune et par an.
 * https://files.data.gouv.fr/geo-dvf/latest/csv/{année}/communes/{dep}/{insee}.csv
 *
 * Méthode (documentée dans le rapport) :
 *  - on regroupe les lignes par mutation (`id_mutation`) ;
 *  - on ne retient que les « Vente » portant sur exactement UN local
 *    d'habitation (Maison ou Appartement), éventuellement accompagné de
 *    dépendances, avec une surface bâtie > 0 ;
 *  - prix au m² = valeur foncière / surface réelle bâtie ;
 *  - exclusion des valeurs aberrantes hors [200 ; 25 000] €/m² ;
 *  - statistique : médiane et quartiles par année et par type de bien.
 */

export const DVF_BASE = "https://files.data.gouv.fr/geo-dvf/latest/csv";

export interface DvfRow {
  id_mutation: string;
  date_mutation: string;
  nature_mutation: string;
  valeur_fonciere: string;
  type_local: string;
  surface_reelle_bati: string;
  code_commune: string;
}

export interface DvfSale {
  id: string;
  year: string;
  type: "Maison" | "Appartement";
  price: number;
  surface: number;
  pricePerM2: number;
}

export function salesFromRows(rows: DvfRow[]): DvfSale[] {
  const byMut = new Map<string, DvfRow[]>();
  for (const r of rows) {
    if (!r.id_mutation) continue;
    if (!byMut.has(r.id_mutation)) byMut.set(r.id_mutation, []);
    byMut.get(r.id_mutation)!.push(r);
  }
  const out: DvfSale[] = [];
  for (const [id, rs] of byMut) {
    if (rs[0].nature_mutation !== "Vente") continue;
    const dwellings = rs.filter((r) => r.type_local === "Maison" || r.type_local === "Appartement");
    const others = rs.filter((r) => r.type_local && r.type_local !== "Dépendance" && !dwellings.includes(r));
    if (dwellings.length !== 1 || others.length) continue;
    const d = dwellings[0];
    const price = Number(d.valeur_fonciere);
    const surface = Number(d.surface_reelle_bati);
    if (!(price > 0) || !(surface > 0)) continue;
    const ppm = price / surface;
    if (ppm < 200 || ppm > 25000) continue;
    out.push({ id, year: d.date_mutation.slice(0, 4), type: d.type_local as DvfSale["type"], price, surface, pricePerM2: ppm });
  }
  return out;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface DvfStat {
  year: string;
  type: "Maison" | "Appartement";
  count: number;
  median: number;
  q1: number;
  q3: number;
  medianPrice: number;
}

export function dvfStats(sales: DvfSale[]): DvfStat[] {
  const groups = new Map<string, DvfSale[]>();
  for (const s of sales) {
    const k = s.year + "|" + s.type;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  const out: DvfStat[] = [];
  for (const [k, g] of groups) {
    const [year, type] = k.split("|") as [string, DvfStat["type"]];
    const ppm = g.map((s) => s.pricePerM2).sort((a, b) => a - b);
    const prices = g.map((s) => s.price).sort((a, b) => a - b);
    out.push({ year, type, count: g.length, median: quantile(ppm, 0.5), q1: quantile(ppm, 0.25), q3: quantile(ppm, 0.75), medianPrice: quantile(prices, 0.5) });
  }
  return out.sort((a, b) => a.year.localeCompare(b.year) || a.type.localeCompare(b.type));
}

export async function collectDvf(http: TrackedHttp, codeInsee: string, dep: string, now = new Date()) {
  const y0 = now.getFullYear();
  const rows: DvfRow[] = [];
  const urls: string[] = [];
  let retrievedAt = "";
  for (let y = y0; y >= y0 - 7; y--) {
    const url = `${DVF_BASE}/${y}/communes/${dep}/${codeInsee}.csv`;
    const r = await http.text(url, { allow404: true, retries: 1 });
    if (!r.data) continue;
    urls.push(url);
    retrievedAt = r.retrievedAt;
    const parsed = Papa.parse<DvfRow>(r.data, { header: true, skipEmptyLines: true });
    rows.push(...parsed.data);
  }
  if (!urls.length) throw new Error("Aucun fichier DVF pour cette commune (Alsace-Moselle, Mayotte, ou source indisponible)");
  const sales = salesFromRows(rows);
  return { urls, retrievedAt, stats: dvfStats(sales), nSales: sales.length };
}
