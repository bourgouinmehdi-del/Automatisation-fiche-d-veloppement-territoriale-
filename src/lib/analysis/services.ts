import type { BpeEquipement } from "../collectors/bpe";
import { fmtNumber } from "../format";

/**
 * Accessibilité aux services, à l'échelle de la commune, comparée à celle de l'habitant moyen du
 * département (médiane pondérée par la population de toutes les communes). Les communes de même taille
 * (de la moitié au double de la population) sont données en repère : comparer à elles seules effacerait
 * le retard commun des petites villes et des bourgs délaissés.
 *
 * Trois mesures selon le service :
 * - services courants (médecin, pharmacie, dentiste, infirmier, crèche) : l'offre à portée, en nombre
 *   pour 10 000 habitants dans un rayon de 5 km (équipements de la commune et des communes proches,
 *   rapportés à leur population). Presque toutes les villes ont un médecin : c'est le nombre de
 *   médecins pour la population qui distingue un désert médical ;
 * - urgences, maternité, gare : la distance au plus proche, où qu'il soit dans le département. Un
 *   service dans la commune compte pour 0 km ; en deçà de 2 km, les écarts ne comptent pas ;
 * - les autres (poste, banque, police, école, collège, lycée, supermarché, bibliothèque, piscine,
 *   cinéma, France Services, France Travail) : les deux, et la moins favorable est retenue. À la
 *   campagne la distance parle ; en ville, où tout est dans la commune, c'est l'offre pour la population.
 */

export type ServiceCat = "sante" | "public" | "education" | "commerce" | "culture";
type Mode = "offre" | "distance" | "mixte";

/** Cinq thèmes, dits comme on en parle à la porte. */
export const SERVICE_CATS: { id: ServiceCat; label: string; exemples: string; items: { label: string; codes: string[]; mode: Mode }[] }[] = [
  {
    id: "sante",
    label: "Se soigner",
    exemples: "médecin, pharmacie, dentiste, infirmier, urgences, maternité",
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
    exemples: "poste, France Services, France Travail, police ou gendarmerie",
    items: [
      { label: "Poste (bureau, relais ou agence)", codes: ["A206", "A207", "A208"], mode: "mixte" },
      { label: "France Services", codes: ["A128"], mode: "mixte" },
      { label: "France Travail", codes: ["A122"], mode: "mixte" },
      // A140 : police dans la BPE 2025 (A101 les années précédentes).
      { label: "Police ou gendarmerie", codes: ["A140", "A101", "A104"], mode: "mixte" },
    ],
  },
  {
    id: "education",
    label: "École et petite enfance",
    exemples: "crèche, école, collège, lycée",
    items: [
      { label: "Crèche", codes: ["D502", "D509"], mode: "offre" },
      { label: "École", codes: ["C101", "C104", "C107", "C108", "C109"], mode: "mixte" },
      { label: "Collège", codes: ["C201"], mode: "mixte" },
      { label: "Lycée", codes: ["C301", "C302", "C303"], mode: "mixte" },
    ],
  },
  {
    id: "commerce",
    label: "Courses et transports",
    exemples: "supermarché, banque, gare",
    items: [
      { label: "Supermarché ou hypermarché", codes: ["B104", "B105", "B101", "B102"], mode: "mixte" },
      { label: "Banque", codes: ["A203"], mode: "mixte" },
      { label: "Gare", codes: ["E107", "E108", "E109"], mode: "distance" },
    ],
  },
  {
    id: "culture",
    label: "Sport et culture",
    exemples: "bibliothèque, piscine, cinéma",
    items: [
      { label: "Bibliothèque", codes: ["F307"], mode: "mixte" },
      { label: "Piscine", codes: ["F101"], mode: "mixte" },
      { label: "Cinéma", codes: ["F303"], mode: "mixte" },
    ],
  },
];

/** Équipements du quotidien qui situent le bourg (là où l'on habite), plutôt que le centre géométrique. */
export const BOURG_CODES = ["D265", "D307", "C107", "C108", "C109", "A206", "B105"];

/**
 * Centre habité d'une commune : point médian de ses équipements du quotidien (médecins, pharmacies,
 * écoles, poste, supermarché), quand elle en a au moins trois. Le centre géométrique peut tomber dans
 * une forêt (Compiègne : 53 km² dont la moitié en forêt, centre à 3 km de la gare).
 */
export function centreBourg(pts: { lon: number; lat: number }[]): [number, number] | null {
  if (pts.length < 3) return null;
  const med = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  return [med(pts.map((p) => p.lon)), med(pts.map((p) => p.lat))];
}

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
  /** Référence : habitant moyen du département (médiane pondérée par la population), même mesure. */
  med: number;
  surPlace: boolean;
  /** Écart à la référence (log2) : positif = moins bien desservie. */
  score: number;
  faible: boolean;
  /** Ligne lisible (« 4,1 pour 10 000 habitants à moins de 5 km (habitant moyen du département : 6,4 ; communes de même taille : 6,0) »). */
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
  /** Indice d'accès (France = 100) : global et par gamme. */
  indice: { global: number; ref: "France" | "département"; gammes: { id: ServiceCat; label: string; exemples: string; value: number }[] } | null;
}

type Pt = [number, number];
/** Distance approchée en km (équirectangulaire : suffisant à l'échelle d'un département, et rapide). */
const dkm = (a: Pt, b: Pt) => {
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) * Math.PI) / 360);
  return Math.hypot(x, b[1] - a[1]) * 111.2;
};
const km = (v: number) => (v < 0.1 ? "sur place" : `${fmtNumber(v, v < 10 ? 1 : 0)} km`);
const per = (v: number) => fmtNumber(v, v < 10 ? 1 : 0);

/**
 * `communes` : communes du département (code, centre, population). `equip` : équipements du département.
 */
export function servicesAccess(code: string, communes: { code: string; at: Pt; pop: number }[], equip: BpeEquipement[], nat?: Record<string, { dist?: number; offre?: number }>): ServicesResult | null {
  // Centre habité de chaque commune (voir centreBourg).
  {
    const parCommune = new Map<string, { lon: number; lat: number }[]>();
    for (const e of equip) if (BOURG_CODES.includes(e.type) && e.lon != null && e.lat != null) (parCommune.get(e.commune) ?? parCommune.set(e.commune, []).get(e.commune)!).push({ lon: e.lon, lat: e.lat });
    communes = communes.map((x) => {
      const c = centreBourg(parCommune.get(x.code) ?? []);
      return c ? { ...x, at: c } : x;
    });
  }
  const me = communes.find((x) => x.code === code);
  if (!me) return null;
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
    if (!voisinsMemo.has(x.code)) voisinsMemo.set(x.code, communes.filter((y) => y.code === x.code || dkm(x.at, y.at) <= OFFRE_KM));
    return voisinsMemo.get(x.code)!;
  };
  // Référence : l'habitant moyen du département (médiane pondérée par la population de toutes ses
  // communes). Comparer aux seules communes de même taille effacerait le retard commun des petites
  // villes et des bourgs délaissés : elles comptent ici face à ce dont dispose un habitant ordinaire.
  const medianePond = (vals: number[]) => {
    const xs = communes.map((c, i) => ({ v: vals[i], w: Math.max(1, c.pop) })).filter((x) => Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
    const tot = xs.reduce((s, x) => s + x.w, 0);
    let acc = 0;
    for (const x of xs) {
      acc += x.w;
      if (acc >= tot / 2) return x.v;
    }
    return NaN;
  };
  const rows: ServiceRow[] = [];
  for (const cat of SERVICE_CATS)
    for (const it of cat.items) {
      const pts = it.codes.flatMap((k) => byCode.get(k) ?? []);
      if (pts.length < 2) continue;
      const here = (c: string) => pts.some((e) => e.commune === c);
      const distRow = (): ServiceRow | null => {
        const dist = (x: { code: string; at: Pt }) => {
          if (here(x.code)) return 0;
          let best = Infinity;
          for (const e of pts) best = Math.min(best, dkm(x.at, [e.lon, e.lat]));
          return best;
        };
        const val = dist(me);
        const dep = medianePond(communes.map(dist));
        const fr = nat?.[it.label]?.dist;
        // Référence : la France (habitant moyen) ; le département en second repère.
        const ref = fr != null && Number.isFinite(fr) ? fr : dep;
        if (!Number.isFinite(val) || !Number.isFinite(ref)) return null;
        const score = Math.log2((Math.max(val, DIST_MIN) + 0.5) / (Math.max(ref, DIST_MIN) + 0.5));
        const faible = score >= 0.6 && val - ref >= 1.5 && val >= 3;
        const refTxt = ref === fr ? `France : ${km(ref)}${Number.isFinite(dep) ? ` ; département : ${km(dep)}` : ""}` : `habitant moyen du département : ${km(ref)}`;
        return {
          cat: cat.id,
          label: it.label,
          mode: "distance",
          val,
          med: ref,
          surPlace: val === 0,
          score,
          faible,
          txt: `${val === 0 ? "dans la commune" : `à ${km(val)}`} (${refTxt})`,
          txtFaible: `le plus proche à ${km(val)}, contre ${km(ref)} pour l'habitant moyen ${ref === fr ? `en France${Number.isFinite(dep) ? ` (département : ${km(dep)})` : ""}` : "du département"}`,
        };
      };
      // Offre à portée : équipements de la commune et à moins de 5 km, pour 10 000 habitants à portée.
      const offreRow = (seuilFaible: number): ServiceRow | null => {
        const offre = (x: { code: string; at: Pt; pop: number }) => {
          const vs = voisins(x);
          const set = new Set(vs.map((v) => v.code));
          const n = pts.filter((e) => set.has(e.commune) || dkm(x.at, [e.lon, e.lat]) <= OFFRE_KM).length;
          const pop = vs.reduce((s, v) => s + v.pop, 0);
          return pop > 0 ? (10000 * n) / pop : NaN;
        };
        const val = offre(me);
        const dep = medianePond(communes.map(offre));
        const fr = nat?.[it.label]?.offre;
        const ref = fr != null && Number.isFinite(fr) && fr > 0 ? fr : dep;
        if (!Number.isFinite(val) || !Number.isFinite(ref) || ref <= 0) return null;
        const e = Math.max(0.05 * ref, 0.1);
        const score = Math.log2((ref + e) / (val + e));
        const refTxt = ref === fr ? `France : ${per(ref)}${Number.isFinite(dep) ? ` ; département : ${per(dep)}` : ""}` : `habitant moyen du département : ${per(ref)}`;
        return {
          cat: cat.id,
          label: it.label,
          mode: "offre",
          val,
          med: ref,
          surPlace: here(code),
          score,
          faible: val <= seuilFaible * ref,
          txt: `${per(val)} pour 10 000 habitants à moins de ${OFFRE_KM} km (${refTxt})`,
          txtFaible: `${per(val)} pour 10 000 habitants à moins de ${OFFRE_KM} km, contre ${per(ref)} pour l'habitant moyen ${ref === fr ? `en France${Number.isFinite(dep) ? ` (département : ${per(dep)})` : ""}` : "du département"}`,
        };
      };
      let row: ServiceRow | null;
      if (it.mode === "distance") row = distRow();
      else if (it.mode === "offre") {
        // Aucun à moins de 5 km : la distance au plus proche le dit mieux que « 0 pour 10 000 habitants ».
        const o = offreRow(0.7);
        row = o && o.val === 0 ? (distRow() ?? o) : o;
      }
      else {
        // Mixte (poste, école, lycée, piscine…) : à la campagne, c'est la distance qui compte ; en ville, où
        // tout est « dans la commune », c'est le nombre pour la population (une piscine pour 65 000 habitants
        // contre une pour 30 000). On retient la mesure la moins favorable ; aucun à moins de 5 km : la distance.
        const d = distRow();
        const o = offreRow(0.5);
        row = !o || !d ? (o ?? d) : o.val === 0 ? d : o.score > d.score ? o : d;
      }
      if (row) rows.push(row);
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
  // Niveau d'ensemble et par thème : 100 × 2^(−écart moyen) (100 = comme l'habitant moyen, 50 = deux fois
  // moins accessible) ; ensemble = moyenne des thèmes.
  const themes = SERVICE_CATS.map((c) => {
    const rs = rows.filter((r) => r.cat === c.id);
    if (!rs.length) return null;
    const m = rs.reduce((t, r) => t + r.score, 0) / rs.length;
    // Le niveau affiché suit la règle des catégories (moyenne, majorité, point faible) : la pastille et
    // le détail disent la même chose (« moins bien desservie » = pastille orange ou rouge).
    const niveau = cats.find((k) => k.cat === c.id)?.niveau;
    let v = Math.round(Math.max(0, Math.min(200, 100 * 2 ** -m)));
    if (niveau === "moins") v = Math.min(v, 89);
    else if (niveau === "mieux") v = Math.max(v, 111);
    else v = Math.max(90, Math.min(110, v));
    return { id: c.id, label: c.label, exemples: c.exemples, value: v };
  }).filter((x): x is { id: ServiceCat; label: string; exemples: string; value: number } => !!x);
  const indice = themes.length ? { global: Math.round(themes.reduce((t, g) => t + g.value, 0) / themes.length), ref: (nat && Object.keys(nat).length ? "France" : "département") as "France" | "département", gammes: themes } : null;
  return { rows, faibles, cats, indice };
}
