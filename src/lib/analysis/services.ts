import * as turf from "@turf/turf";
import type { BpeEquipement } from "../collectors/bpe";

/**
 * Accessibilité aux services (première version, à l'échelle de la commune) : pour chaque service,
 * distance à vol d'oiseau entre le centre de la commune et l'équipement le plus proche, où qu'il soit
 * dans le département. Une commune sans pharmacie mais avec une pharmacie à 800 m dans la commune
 * voisine n'est pas traitée comme une commune sans pharmacie à 10 km à la ronde.
 *
 * Comparaison : médiane des communes de taille comparable du département (moitié à double de la
 * population), mesurées de la même façon.
 */

export type ServiceCat = "sante" | "public" | "securite" | "education" | "commerce" | "transport" | "culture";

export const SERVICE_CATS: { id: ServiceCat; label: string; items: { label: string; codes: string[] }[] }[] = [
  {
    id: "sante",
    label: "Santé",
    items: [
      { label: "Médecin généraliste", codes: ["D265", "D201"] },
      { label: "Pharmacie", codes: ["D307"] },
      { label: "Dentiste", codes: ["D277", "D221"] },
      { label: "Infirmier", codes: ["D281", "D232"] },
      { label: "Urgences", codes: ["D106"] },
      { label: "Maternité", codes: ["D107"] },
    ],
  },
  {
    id: "public",
    label: "Services publics",
    items: [
      { label: "France Services", codes: ["A128"] },
      { label: "France Travail", codes: ["A122"] },
      { label: "Poste (bureau, relais ou agence)", codes: ["A206", "A207", "A208"] },
      { label: "Banque", codes: ["A203"] },
    ],
  },
  { id: "securite", label: "Sécurité", items: [{ label: "Police ou gendarmerie", codes: ["A101", "A104"] }] },
  {
    id: "education",
    label: "Enfance et éducation",
    items: [
      { label: "Crèche", codes: ["D502"] },
      { label: "École", codes: ["C101", "C104", "C107", "C108", "C109"] },
      { label: "Collège", codes: ["C201"] },
      { label: "Lycée", codes: ["C301", "C302"] },
    ],
  },
  { id: "commerce", label: "Commerces", items: [{ label: "Supermarché ou hypermarché", codes: ["B104", "B105", "B101", "B102"] }] },
  { id: "transport", label: "Transports", items: [{ label: "Gare", codes: ["E107", "E108", "E109"] }] },
  {
    id: "culture",
    label: "Sports et culture",
    items: [
      { label: "Bibliothèque", codes: ["F307"] },
      { label: "Piscine", codes: ["F101"] },
      { label: "Cinéma", codes: ["F303"] },
    ],
  },
];

export interface ServiceRow {
  cat: ServiceCat;
  label: string;
  /** Distance au plus proche (km) depuis le centre de la commune. */
  km: number;
  /** Médiane des communes comparables (km). */
  medKm: number;
  /** Dans la commune même. */
  surPlace: boolean;
}

export interface CatScore {
  cat: ServiceCat;
  label: string;
  /** « mieux », « comme », « moins bien » que les communes comparables. */
  niveau: "mieux" | "comme" | "moins";
  items: number;
}

export interface ServicesResult {
  rows: ServiceRow[];
  /** Services nettement moins accessibles que dans les communes comparables. */
  faibles: ServiceRow[];
  cats: CatScore[];
  pairs: number;
}

type Pt = [number, number];

/**
 * `communes` : communes du département (code, centre, population). `equip` : équipements du
 * département avec coordonnées.
 */
export function servicesAccess(code: string, communes: { code: string; at: Pt; pop: number }[], equip: BpeEquipement[]): ServicesResult | null {
  const me = communes.find((x) => x.code === code);
  if (!me) return null;
  // Communes comparables : population de la moitié au double (au moins 10, sinon les 15 plus proches en taille).
  let pairs = communes.filter((x) => x.code !== code && x.pop >= me.pop / 2 && x.pop <= me.pop * 2);
  if (pairs.length < 10) pairs = communes.filter((x) => x.code !== code).sort((a, b) => Math.abs(a.pop - me.pop) - Math.abs(b.pop - me.pop)).slice(0, 15);
  const byCode = new Map<string, BpeEquipement[]>();
  for (const e of equip) if (e.lon != null && e.lat != null) (byCode.get(e.type) ?? byCode.set(e.type, []).get(e.type)!).push(e);
  const nearest = (at: Pt, pts: BpeEquipement[]) => {
    let best = Infinity;
    for (const e of pts) {
      const d = turf.distance(at, [e.lon!, e.lat!]);
      if (d < best) best = d;
    }
    return best;
  };
  const median = (v: number[]) => {
    const s = v.filter(Number.isFinite).sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
  };
  const rows: ServiceRow[] = [];
  for (const cat of SERVICE_CATS)
    for (const it of cat.items) {
      const pts = it.codes.flatMap((k) => byCode.get(k) ?? []);
      // Service trop rare dans le département pour une comparaison parlante.
      if (pts.length < 2) continue;
      const km = nearest(me.at, pts);
      const medKm = median(pairs.map((p) => nearest(p.at, pts)));
      if (!Number.isFinite(km) || !Number.isFinite(medKm)) continue;
      rows.push({ cat: cat.id, label: it.label, km, medKm, surPlace: pts.some((e) => e.commune === code) });
    }
  // Écart : en minutes de trajet, 1 km de plus pèse davantage près de chez soi (échelle logarithmique).
  const gap = (r: ServiceRow) => Math.log2((r.km + 0.5) / (r.medKm + 0.5));
  const faibles = rows.filter((r) => gap(r) >= 0.8 && r.km - r.medKm >= 1.5 && !r.surPlace).sort((a, b) => gap(b) - gap(a));
  const cats: CatScore[] = SERVICE_CATS.map((c) => {
    const rs = rows.filter((r) => r.cat === c.id);
    if (!rs.length) return null;
    const g = rs.reduce((s, r) => s + gap(r), 0) / rs.length;
    return { cat: c.id, label: c.label, niveau: g >= 0.5 ? "moins" : g <= -0.5 ? "mieux" : "comme", items: rs.length } as CatScore;
  }).filter((x): x is CatScore => !!x);
  return { rows, faibles, cats, pairs: pairs.length };
}
