import * as turf from "@turf/turf";
import type { BpeEquipement } from "../collectors/bpe";
import { fmtNumber } from "../format";

/**
 * Accessibilité aux services, à l'échelle de la commune, comparée aux communes de taille semblable du
 * département (de la moitié au double de la population).
 *
 * Deux mesures selon le service :
 * - services courants (médecin, pharmacie, dentiste, infirmier, crèche) : l'offre à portée, en nombre
 *   pour 10 000 habitants dans un rayon de 5 km (équipements de la commune et des communes proches,
 *   rapportés à leur population). Presque toutes les villes ont un médecin : c'est le nombre de
 *   médecins pour la population qui distingue un désert médical ;
 * - services plus rares (urgences, lycée, gare, piscine…) : la distance au plus proche, où qu'il soit
 *   dans le département. Un service dans la commune compte pour 0 km ; en deçà de 2 km, les écarts ne
 *   comptent pas (à pied ou en bus, la différence est faible).
 */

export type ServiceCat = "sante" | "public" | "securite" | "education" | "commerce" | "transport" | "culture";
type Mode = "offre" | "distance";

export const SERVICE_CATS: { id: ServiceCat; label: string; items: { label: string; codes: string[]; mode: Mode }[] }[] = [
  {
    id: "sante",
    label: "Santé",
    items: [
      { label: "Médecin généraliste", codes: ["D265", "D201"], mode: "offre" },
      { label: "Pharmacie", codes: ["D307"], mode: "offre" },
      { label: "Dentiste", codes: ["D277", "D221"], mode: "offre" },
      { label: "Infirmier", codes: ["D281", "D232"], mode: "offre" },
      { label: "Urgences", codes: ["D106"], mode: "distance" },
      { label: "Maternité", codes: ["D107"], mode: "distance" },
    ],
  },
  {
    id: "public",
    label: "Services publics",
    items: [
      { label: "France Services", codes: ["A128"], mode: "distance" },
      { label: "France Travail", codes: ["A122"], mode: "distance" },
      { label: "Poste (bureau, relais ou agence)", codes: ["A206", "A207", "A208"], mode: "distance" },
      { label: "Banque", codes: ["A203"], mode: "distance" },
    ],
  },
  { id: "securite", label: "Sécurité", items: [{ label: "Police ou gendarmerie", codes: ["A101", "A104"], mode: "distance" }] },
  {
    id: "education",
    label: "Enfance et éducation",
    items: [
      { label: "Crèche", codes: ["D502"], mode: "offre" },
      { label: "École", codes: ["C101", "C104", "C107", "C108", "C109"], mode: "distance" },
      { label: "Collège", codes: ["C201"], mode: "distance" },
      { label: "Lycée", codes: ["C301", "C302"], mode: "distance" },
    ],
  },
  { id: "commerce", label: "Commerces", items: [{ label: "Supermarché ou hypermarché", codes: ["B104", "B105", "B101", "B102"], mode: "distance" }] },
  { id: "transport", label: "Transports", items: [{ label: "Gare", codes: ["E107", "E108", "E109"], mode: "distance" }] },
  {
    id: "culture",
    label: "Sports et culture",
    items: [
      { label: "Bibliothèque", codes: ["F307"], mode: "distance" },
      { label: "Piscine", codes: ["F101"], mode: "distance" },
      { label: "Cinéma", codes: ["F303"], mode: "distance" },
    ],
  },
];

/** Rayon de l'offre à portée (km). */
export const OFFRE_KM = 5;
/** En deçà, les distances ne sont pas distinguées (km). */
const DIST_MIN = 2;

export interface ServiceRow {
  cat: ServiceCat;
  label: string;
  mode: Mode;
  /** Distance (km) ou offre pour 10 000 habitants. */
  val: number;
  /** Médiane des communes comparables, même mesure. */
  med: number;
  surPlace: boolean;
  /** Écart aux communes comparables (log2) : positif = moins bien desservie. */
  score: number;
  faible: boolean;
  /** Ligne lisible (« 4,1 pour 10 000 habitants à moins de 5 km (communes semblables : 6,4) »). */
  txt: string;
  /** Phrase des points faibles. */
  txtFaible: string;
}

export interface CatScore {
  cat: ServiceCat;
  label: string;
  niveau: "mieux" | "comme" | "moins";
  items: number;
}

export interface ServicesResult {
  rows: ServiceRow[];
  faibles: ServiceRow[];
  cats: CatScore[];
  pairs: number;
}

type Pt = [number, number];
const km = (v: number) => (v < 0.1 ? "sur place" : `${fmtNumber(v, v < 10 ? 1 : 0)} km`);
const per = (v: number) => fmtNumber(v, v < 10 ? 1 : 0);

/**
 * `communes` : communes du département (code, centre, population). `equip` : équipements du département.
 */
export function servicesAccess(code: string, communes: { code: string; at: Pt; pop: number }[], equip: BpeEquipement[]): ServicesResult | null {
  const me = communes.find((x) => x.code === code);
  if (!me) return null;
  let pairs = communes.filter((x) => x.code !== code && x.pop >= me.pop / 2 && x.pop <= me.pop * 2);
  if (pairs.length < 10) pairs = communes.filter((x) => x.code !== code).sort((a, b) => Math.abs(a.pop - me.pop) - Math.abs(b.pop - me.pop)).slice(0, 15);
  // Équipement sans coordonnées : placé au centre de sa commune plutôt qu'ignoré.
  const centreOf = new Map(communes.map((x) => [x.code, x.at]));
  const byCode = new Map<string, { lon: number; lat: number; commune: string }[]>();
  for (const e of equip) {
    const at: Pt | undefined = e.lon != null && e.lat != null ? [e.lon, e.lat] : centreOf.get(e.commune);
    if (!at) continue;
    (byCode.get(e.type) ?? byCode.set(e.type, []).get(e.type)!).push({ lon: at[0], lat: at[1], commune: e.commune });
  }
  // Communes à moins de 5 km de chaque commune étudiée (population à portée).
  const voisinsMemo = new Map<string, { code: string; pop: number }[]>();
  const voisins = (x: { code: string; at: Pt; pop: number }) => {
    if (!voisinsMemo.has(x.code)) voisinsMemo.set(x.code, communes.filter((y) => y.code === x.code || turf.distance(x.at, y.at) <= OFFRE_KM));
    return voisinsMemo.get(x.code)!;
  };
  const median = (v: number[]) => {
    const s = v.filter(Number.isFinite).sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
  };
  const rows: ServiceRow[] = [];
  for (const cat of SERVICE_CATS)
    for (const it of cat.items) {
      const pts = it.codes.flatMap((k) => byCode.get(k) ?? []);
      if (pts.length < 2) continue;
      const here = (c: string) => pts.some((e) => e.commune === c);
      if (it.mode === "distance") {
        const dist = (x: { code: string; at: Pt }) => {
          if (here(x.code)) return 0;
          let best = Infinity;
          for (const e of pts) best = Math.min(best, turf.distance(x.at, [e.lon, e.lat]));
          return best;
        };
        const val = dist(me);
        const med = median(pairs.map(dist));
        if (!Number.isFinite(val) || !Number.isFinite(med)) continue;
        const score = Math.log2((Math.max(val, DIST_MIN) + 0.5) / (Math.max(med, DIST_MIN) + 0.5));
        const faible = score >= 0.6 && val - med >= 1.5 && val >= 3;
        rows.push({
          cat: cat.id,
          label: it.label,
          mode: it.mode,
          val,
          med,
          surPlace: val === 0,
          score,
          faible,
          txt: `${val === 0 ? "dans la commune" : `à ${km(val)}`} (communes semblables : ${km(med)})`,
          txtFaible: `le plus proche à ${km(val)}, ${med < 0.1 ? "alors que la plupart des communes de cette taille en ont un sur place" : `contre ${km(med)} en général pour une commune de cette taille`}`,
        });
      } else {
        // Offre à portée : équipements de la commune et à moins de 5 km, pour 10 000 habitants à portée.
        const offre = (x: { code: string; at: Pt; pop: number }) => {
          const vs = voisins(x);
          const set = new Set(vs.map((v) => v.code));
          const n = pts.filter((e) => set.has(e.commune) || turf.distance(x.at, [e.lon, e.lat]) <= OFFRE_KM).length;
          const pop = vs.reduce((s, v) => s + v.pop, 0);
          return pop > 0 ? (10000 * n) / pop : NaN;
        };
        const val = offre(me);
        const med = median(pairs.map(offre));
        if (!Number.isFinite(val) || !Number.isFinite(med) || med <= 0) continue;
        const e = Math.max(0.05 * med, 0.1);
        const score = Math.log2((med + e) / (val + e));
        const faible = val <= 0.7 * med;
        rows.push({
          cat: cat.id,
          label: it.label,
          mode: it.mode,
          val,
          med,
          surPlace: here(code),
          score,
          faible,
          txt: `${per(val)} pour 10 000 habitants à moins de ${OFFRE_KM} km (communes semblables : ${per(med)})`,
          txtFaible: `${per(val)} pour 10 000 habitants à moins de ${OFFRE_KM} km, contre ${per(med)} en général pour une commune de cette taille`,
        });
      }
    }
  const faibles = rows.filter((r) => r.faible).sort((a, b) => b.score - a.score);
  const cats: CatScore[] = SERVICE_CATS.map((c) => {
    const rs = rows.filter((r) => r.cat === c.id);
    if (!rs.length) return null;
    const g = rs.reduce((s, r) => s + r.score, 0) / rs.length;
    const faible = rs.some((r) => r.faible);
    // « Moins bien desservie » : écart moyen net, ou la plupart des services un peu moins accessibles
    // (Ivry : médecins, dentistes, infirmiers, urgences tous un peu en dessous, sans point faible isolé).
    const pire = rs.filter((r) => r.score >= 0.25).length;
    const mieux = rs.filter((r) => r.score <= -0.25).length;
    const moitie = Math.ceil(rs.length / 2);
    // Une catégorie avec un point faible n'est jamais « mieux desservie ».
    const niveau = g >= 0.2 || (pire >= moitie && pire > mieux) || (faible && g >= 0) ? "moins" : !faible && (g <= -0.2 || (mieux >= moitie && mieux > pire)) ? "mieux" : "comme";
    return { cat: c.id, label: c.label, niveau, items: rs.length } as CatScore;
  }).filter((x): x is CatScore => !!x);
  return { rows, faibles, cats, pairs: pairs.length };
}
