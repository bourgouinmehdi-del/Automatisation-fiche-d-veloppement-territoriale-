import * as turf from "@turf/turf";
import { referentiel } from "../collectors/admin";
import type { BureauResult, ElectionResult } from "../collectors/elections";
import { abstention, BvRow, FAMILIES, familyPerformance, frenchHours, lfiOverperformance, prettyBvLabel, rankBureaux, score } from "../analysis/political";
import { gap, haversineKm, quantileBreaks } from "../analysis/stats";
import { evidenceId } from "../analysis/findings";
import { aNom, deNom, fmtNumber, fmtSigned, fmtValue } from "../format";
import type { Block, ChartSpec, DataTable, Finding, GeoRef, Indicator, MapLegend, MapSpec, Section, SourceRef } from "../types";
import { MISSING_COLOR, SEQ_COLORS } from "./assemble";
import { buildPorte } from "./porte";
import { plmInfo } from "../collectors/plm";
import { communePoster, GARE_MIN_JOUR, gareNom, openWeekend, perDay, WEEKEND } from "./affiche";
import { buildInscription } from "./inscription";
import { bureauxByQuartier, matchBureaux, quartierLabel, quartierOfBureau } from "../analysis/quartiers";
import type { Quartier } from "../collectors/quartiers";
import { NUANCES, nuanceFamily, sameList, type MunicipalList } from "../collectors/municipales";
import { BPE_TYPES } from "../collectors/bpe";
import { fmtDuration } from "../collectors/routes";
import { hlmByStreet, numsLabel } from "../collectors/rpls";
import type { Collected } from "./collect";

/**
 * Fiche d'action « développement territorial », sur le modèle des fiches
 * « PEE · Développement territorial » (proposition de ciblage par territoire) :
 *
 *  0. avertissement + « en bref » (chiffres clés, atout et difficulté principaux) ;
 *  1. profil sociodémographique : puces rédigées, limitées aux écarts
 *     significatifs au département (les autres sont regroupées), tableau
 *     comparatif, répartition par âge ;
 *  2. profil politique : implantation militante (encadré), surperformance,
 *     parrainages, tableau Inscrits / LFI P22 / LFI E24 / Parrains / Abstention,
 *     abstention, forces de gauche et RN ;
 *  3. où agir : cartes vote LFI / participation par bureau, classement ;
 *  4. pourquoi : hypothèses à confronter au terrain ;
 *  5. actions recommandées, regroupées par type de lieu (porte-à-porte,
 *     marchés, gares, supermarchés, sorties d'établissements), et accessibilité.
 *
 * Tous les chiffres proviennent des données collectées ; chaque constat porte
 * ses preuves ; les explications sont présentées comme des hypothèses.
 */

export interface LfiOutput {
  section: Section | null;
  /** Sections complémentaires (feuilles de porte-à-porte). */
  extra?: Section[];
  tables: DataTable[];
  charts: ChartSpec[];
  maps: MapSpec[];
  findings: Finding[];
  indicators: Indicator[];
}

/**
 * Graphiques « résultats par force politique » du profil politique : un par
 * scrutin, présentés en onglets (européennes 2024 par défaut). Ordre et
 * couleurs de la charte ; repère = score national (résultats définitifs,
 * France entière, % des suffrages exprimés, ministère de l'Intérieur).
 * Une force sans liste ni candidat à un scrutin n'a pas de barre.
 */
interface ChartForce {
  id: string;
  label: string;
  color: string;
  national: number;
}
const COLORS: Record<string, string> = { pcf: "#830E21", lfi: "#E8434B", eco: "#49C07A", ps: "#F08FB7", ens: "#FED700", lr: "#8CB0DC", rn: "#313567", rec: "#8D6E63" };
const force = (id: string, label: string, national: number): ChartForce => ({ id, label, color: COLORS[id], national });
export const VOTE_CHARTS: { eid: string; id: string; title: string; tab: string; forces: ChartForce[] }[] = [
  {
    eid: "PR17T1",
    id: "lfi_chart_pr17",
    title: "Présidentielle 2017 (1er tour)",
    tab: "Présidentielle 2017",
    forces: [force("lfi", "Mélenchon (LFI)", 19.58), force("ps", "Hamon (PS)", 6.36), force("ens", "Macron", 24.01), force("lr", "Fillon (LR)", 20.01), force("rn", "Le Pen (FN)", 21.3)],
  },
  {
    eid: "EU19",
    id: "lfi_chart_eu19",
    title: "Européennes 2019",
    tab: "Européennes 2019",
    forces: [force("pcf", "PCF", 2.49), force("lfi", "LFI", 6.31), force("eco", "EELV", 13.48), force("ps", "PS / PP", 6.19), force("ens", "Renaissance", 22.42), force("lr", "LR", 8.48), force("rn", "RN", 23.34)],
  },
  {
    eid: "PR22T1",
    id: "lfi_chart_pr22",
    title: "Présidentielle 2022 (1er tour)",
    tab: "Présidentielle 2022",
    forces: [
      force("pcf", "Roussel (PCF)", 2.28),
      force("lfi", "Mélenchon (LFI)", 21.95),
      force("eco", "Jadot (LÉ)", 4.63),
      force("ps", "Hidalgo (PS)", 1.75),
      force("ens", "Macron", 27.85),
      force("lr", "Pécresse (LR)", 4.78),
      force("rn", "Le Pen (RN)", 23.15),
      force("rec", "Zemmour (Reconquête)", 7.07),
    ],
  },
  {
    eid: "EU24",
    id: "lfi_chart_eu24",
    title: "Européennes 2024",
    tab: "Européennes 2024",
    forces: [force("pcf", "PCF", 2.36), force("lfi", "LFI", 9.89), force("eco", "LÉ", 5.5), force("ps", "PS / PP", 13.83), force("ens", "Ensemble", 14.6), force("lr", "LR", 7.25), force("rn", "RN", 31.37), force("rec", "Reconquête", 5.47)],
  },
];
/** Forces du graphique « Européennes 2024 » (compatibilité). */
export const EU24_CHART = VOTE_CHARTS.find((x) => x.eid === "EU24")!.forces;
export const EU24_AUTRES_COLOR = "#9AA0A6";
const NAT_URL: Record<string, string> = {
  EU24: "https://www.resultats-elections.interieur.gouv.fr/europeennes2024/ensemble_geographique/index.html",
  PR22T1: "https://www.resultats-elections.interieur.gouv.fr/presidentielle-2022/FE.html",
  EU19: "https://www.interieur.gouv.fr/Elections/Les-resultats/Europeennes/elecresult__europeennes-2019/(path)/europeennes-2019/FE.html",
  PR17T1: "https://www.interieur.gouv.fr/Elections/Les-resultats/Presidentielles/elecresult__presidentielle-2017/(path)/presidentielle-2017/FE.html",
};

type VoteAgg = { exprimes: number; candidates: { label: string; voix: number }[] };

export function voteChart(eid: string, a: VoteAgg, source: SourceRef, note?: string): ChartSpec | null {
  const cfg = VOTE_CHARTS.find((x) => x.eid === eid);
  if (!cfg || !a.exprimes) return null;
  // Chaque liste ou candidat est rattaché à une seule force (la première qui correspond).
  const voix = new Map<string, number>();
  let autres = 0;
  for (const cand of a.candidates) {
    const f = cfg.forces.find((x) => FAMILIES.find((y) => y.id === x.id)?.match[eid]?.test(cand.label));
    if (f) voix.set(f.id, (voix.get(f.id) ?? 0) + cand.voix);
    else autres += cand.voix;
  }
  const pctOf = (v: number) => Math.round((1000 * v) / a.exprimes) / 10;
  const natAutres = Math.round(10 * (100 - cfg.forces.reduce((s2, f) => s2 + f.national, 0))) / 10;
  return {
    id: cfg.id,
    title: cfg.title,
    type: "refbar",
    group: "lfi_votes",
    tab: cfg.tab,
    xKey: "label",
    series: [
      { key: "value", label: "Commune" },
      { key: "ref", label: "Score national" },
    ],
    colorKey: "color",
    unit: "%",
    data: [
      ...cfg.forces.map((f) => ({ label: f.label, value: pctOf(voix.get(f.id) ?? 0), ref: f.national, color: f.color })),
      { label: "Autres", value: pctOf(autres), ref: natAutres, color: EU24_AUTRES_COLOR },
    ],
    sources: [source, { id: "elections_nat", name: `Ministère de l'Intérieur, résultats nationaux — ${cfg.title}`, url: NAT_URL[eid], retrievedAt: VOTE_CHARTS_DATE }],
    note: `Part des voix (hors blancs et nuls) ; trait : score national (France entière).${note ? ` ${note}` : ""}`,
  };
}
const VOTE_CHARTS_DATE = "2024-06-10";

export function europeennesChart(a: VoteAgg, source: SourceRef): ChartSpec {
  return voteChart("EU24", a, source)!;
}

/** Résultats d'une commune reconstitués à partir de ses bureaux de vote (scrutins sans fichier communal). */
export function sumBureaux(rows: { exprimes: number; candidates: { label: string; voix: number }[] }[]): VoteAgg {
  const cand = new Map<string, number>();
  let exprimes = 0;
  for (const r of rows) {
    exprimes += r.exprimes;
    for (const x of r.candidates) cand.set(x.label, (cand.get(x.label) ?? 0) + x.voix);
  }
  return { exprimes, candidates: [...cand].map(([label, voix]) => ({ label, voix })) };
}

/** Adresses du REU en majuscules : « 14 PLACE DE LA FRATERNITE 48000 mende » → « 14 Place de la Fraternite, 48000 Mende ». */
export const prettyAdr = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/(^|[\s'-])([a-zà-ÿ])/g, (_m, a: string, ch: string) => a + ch.toUpperCase())
    .replace(/\b(De|Du|Des|La|Le|Les|Et|D|L|Sur|Sous|En)\b/g, (w) => w.toLowerCase())
    .replace(/\s(\d{5})\s/, ", $1 ");

/* ------------------------------------------------------------------
 * Langage courant : la fiche s'adresse à des élus et militants qui ne
 * sont pas statisticiens. Pourcentages arrondis, proportions « 1 sur 4 »,
 * comparaisons « deux fois plus ».
 * ------------------------------------------------------------------ */
/** Pourcentage arrondi à l'unité : « 22 % ». */
const pp = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "n.d." : `${Math.round(v)}\u00a0%`);
/** « 1 sur 4 », « près d'1 sur 2 », « 2 sur 3 »… quand la proportion s'y prête (sinon le pourcentage). */
export function oneIn(v: number, who = ""): string {
  const w = who.trim();
  const fracs: [number, number][] = [[9, 10], [4, 5], [3, 4], [2, 3], [3, 5], [1, 2], [2, 5], [1, 3], [1, 4], [1, 5], [1, 6], [1, 7], [1, 8], [1, 10]];
  let best: [number, number] | null = null;
  for (const f of fracs) if (!best || Math.abs((100 * f[0]) / f[1] - v) < Math.abs((100 * best[0]) / best[1] - v)) best = f;
  const fmt = ([a, b]: [number, number]) => `${a} ${w ? `${w}${a > 1 ? "s" : ""} ` : ""}sur ${b}`;
  if (v > 0 && v < 100 && best) {
    const t = (100 * best[0]) / best[1];
    const d = v - t;
    if (Math.abs(d) <= Math.max(1, 0.06 * t)) return fmt(best);
    if (Math.abs(d) <= 0.15 * t) return `${d < 0 ? "près" : "plus"} d${best[0] === 1 ? "'" : "e "}${fmt(best)}`;
  }
  return `${pp(v)}${w ? ` des ${w}s` : ""}`;
}
/** « la moitié », « près d'un tiers », « plus des deux tiers »… (sinon le pourcentage). */
export function shareWords(v: number): string {
  const names: [number, string, string][] = [
    [75, "les trois quarts", "des trois quarts"],
    [66.7, "les deux tiers", "des deux tiers"],
    [50, "la moitié", "de la moitié"],
    [33.3, "un tiers", "d'un tiers"],
    [25, "un quart", "d'un quart"],
    [20, "un cinquième", "d'un cinquième"],
    [10, "un dixième", "d'un dixième"],
  ];
  const [t, n, of] = names.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a));
  const d = v - t;
  if (Math.abs(d) <= Math.max(1, 0.06 * t)) return n;
  if (Math.abs(d) <= 0.15 * t) return d < 0 ? `près ${of}` : `plus ${of}`;
  return pp(v);
}
/** Proportion et verbe accordé : « 1 foyer sur 4 n'a pas », « 2 foyers sur 5 n'ont pas ». */
export function oneInV(v: number, who: string, sing: string, plur: string): string {
  const t = oneIn(v, who);
  return `${t} ${/^((près|plus) d')?1 /.test(t) ? sing : plur}`;
}
/** « deux fois plus », « nettement plus », « un peu plus »… */
export function compareWords(a: number, b: number, more = "plus", less = "moins"): string {
  if (!b) return more;
  const r = a / b;
  const words = ["", "", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix"];
  if (r >= 1.8) return `${r >= 2.5 ? `${words[Math.min(10, Math.round(r))] || Math.round(r)} fois` : "deux fois"} ${more}`;
  if (r >= 1.25) return `nettement ${more}`;
  if (r > 1.05) return `un peu ${more}`;
  if (r <= 1 / 1.8) return `${1 / r >= 2.5 ? `${words[Math.min(10, Math.round(1 / r))] || Math.round(1 / r)} fois` : "deux fois"} ${less}`;
  if (r <= 1 / 1.25) return `nettement ${less}`;
  if (r < 0.95) return `un peu ${less}`;
  return "autant";
}

/**
 * Comparaison d'un score de vote à une référence, en mots, avec une seule
 * règle pour toute la fiche (synthèse, « En bref ») : l'écart doit être net à
 * la fois en rapport et en points pour être signalé. 6 % contre 4 % : « un peu
 * plus » (2 points), pas « nettement plus » ; 15 % contre 14 % : « autant ».
 */
export function voteCompare(c: number, d: number): { dir: "plus" | "moins" | "autant"; words: string; net: boolean } {
  const diff = c - d;
  const r = d ? c / d : 2;
  if (Math.abs(diff) < 1.5 || Math.abs(r - 1) < 0.08) return { dir: "autant", words: "autant", net: false };
  const dir = diff > 0 ? "plus" : "moins";
  const strong = Math.abs(diff) >= 3 && (r >= 1.2 || r <= 1 / 1.2);
  if (!strong) return { dir, words: `un peu ${dir}`, net: false };
  // « deux fois plus » seulement si l'écart dépasse aussi 5 points.
  const w = compareWords(c, d, "plus", "moins");
  return { dir, words: /fois/.test(w) && Math.abs(diff) < 5 ? `nettement ${dir}` : w, net: true };
}

/** Scores nationaux du vote LFI (% des exprimés), repère d'un « terrain favorable ». */
export const LFI_NATIONAL = { EU24: 9.89, PR22T1: 21.95 };

const pct = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "n.d." : fmtValue(v, "%", d));
/** « 2 809 (9,8 %) » avec le pourcentage en gras, comme dans les fiches de référence. */
const cnt = (n: number | null | undefined, p: number | null | undefined) => (n == null ? "n.d." : `${fmtNumber(n)} **(${pct(p)})**`);
const B = (s: string) => `**${s}**`;
/** Majuscule initiale, y compris derrière un balisage `**…**`. */
const cap = (s: string) => s.replace(/^(\**)(.)/, (_m, a: string, c: string) => a + c.toUpperCase());
const joinFr = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} et ${xs[xs.length - 1]}`);

/** Palette divergente (faible → élevé) des cartes par bureau, proche des fiches de référence. */
export const DIV_COLORS = ["#3f6fb0", "#8eaed6", "#cfc8d8", "#e3a07f", "#c0503a"];

function divergingLegend(title: string, vals: number[]): MapLegend {
  // Bornes arrondies au dixième et dédoublonnées (pas de classe « 6,1–6,1 » quand les bureaux se ressemblent).
  const br = [...new Set(quantileBreaks(vals, Math.min(5, new Set(vals.map((v) => Math.round(v * 10))).size)).map((v) => Math.round(v * 10) / 10))];
  if (br.length === 1) br.push(br[0] + 0.1);
  const n = br.length - 1;
  const classes = [];
  for (let i = 0; i < n; i++) classes.push({ min: br[i], max: br[i + 1], color: DIV_COLORS[n === 1 ? 2 : Math.round((i * 4) / (n - 1))] });
  return { title, unit: "%", classes, missingLabel: "Bureau non apparié" };
}

export function buildLfi(c: Collected, indicators: Indicator[], extra: { emploiText?: string | null } = {}): LfiOutput {
  const out: LfiOutput = { section: null, tables: [], charts: [], maps: [], findings: [], indicators: [] };
  const { commune, geos } = c;
  // Paris, Lyon, Marseille : bureaux numérotés « 1325 » dans les fichiers, « 25 » dans l'arrondissement.
  const plm = plmInfo(commune.code);
  const dv = (bv: string) => (plm && /^\d{3,4}$/.test(bv) && Math.floor(Number(bv) / 100) === plm.arr ? String(Number(bv) % 100) : bv);
  let fid = 1000;
  const addF = (f: Omit<Finding, "id" | "theme">) => {
    const id = `L${++fid}`;
    out.findings.push({ ...f, id, theme: "strategie" });
    return id;
  };
  const get = (id: string, g: GeoRef | null | undefined) => (g ? indicators.find((i) => i.id === id && i.geo.level === g.level && i.geo.code === g.code && i.value != null) : undefined);
  const depName = geos.departement.name;

  /* ================================================================ 1. socio */
  /** Ligne « commune » du tableau des quartiers. */
  const rowFor = (g: GeoRef) => {
    const v = (id: string) => get(id, g)?.value ?? null;
    return {
      revenu: v("revenu_median") != null ? fmtValue(v("revenu_median"), "€") : "n.d.",
      pauvrete: pct(v("taux_pauvrete")),
      jeunes: pct(v("part_moins_25") ?? v("part_moins_30")),
      chomage: pct(v("taux_chomage_rp")),
      locataires: v("part_locataires") != null ? `${pct(v("part_locataires"), 0)} (${pct(v("part_locataires_hlm"), 0)})` : "n.d.",
    };
  };
  // Fiche destinée à des militants et élus qui ne sont pas statisticiens : une phrase
  // d'introduction en langage courant, un tableau limité aux indicateurs qui
  // distinguent vraiment la commune du département, puis 2 ou 3 phrases qualitatives.
  type SocioDef = { id: string; alt?: string; label: string; up: { adj?: string; avec?: string }; down: { adj?: string; avec?: string }; core?: boolean };
  const SOCIO: SocioDef[] = [
    { id: "taux_pauvrete", label: "Sous le seuil de pauvreté", up: { adj: "plus pauvre" }, down: { adj: "moins touchée par la pauvreté" }, core: true },
    { id: "revenu_median", label: "Revenu médian par mois", up: { adj: "plus aisée" }, down: { adj: "aux revenus plus modestes" }, core: true },
    { id: "taux_chomage_rp", label: "Chômage", up: { adj: "plus touchée par le chômage" }, down: { adj: "moins touchée par le chômage" }, core: true },
    { id: "part_locataires_hlm", label: "Logement social (HLM)", core: true, up: { avec: "beaucoup de logements sociaux" }, down: { avec: "peu de logements sociaux" } },
    { id: "part_65_plus", alt: "part_60_plus", label: "Plus de 65 ans", up: { adj: "plus âgée" }, down: { adj: "plus jeune" } },
    { id: "part_moins_25", alt: "part_moins_30", label: "Moins de 25 ans", up: { adj: "plus jeune" }, down: { adj: "plus âgée" } },
    { id: "part_sans_diplome", label: "Sans diplôme (ou brevet)", up: { adj: "moins diplômée" }, down: { adj: "plus diplômée" } },
    { id: "part_ouvriers", label: "Ouvriers", up: { avec: "une forte part d'ouvriers" }, down: { avec: "peu d'ouvriers" } },
    { id: "part_employes", label: "Employés", up: { avec: "une forte part d'employés" }, down: { avec: "peu d'employés" } },
    { id: "part_cadres", label: "Cadres", up: { avec: "beaucoup de cadres" }, down: { avec: "peu de cadres" } },
    { id: "part_menages_sans_voiture", label: "Foyers sans voiture", up: { avec: "beaucoup de foyers sans voiture" }, down: {} },
    { id: "part_logements_vacants", label: "Logements vides", up: { avec: "beaucoup de logements vides" }, down: {} },
  ];
  const socioCmp = SOCIO.map((d) => {
    const id = get(d.id, geos.commune) ? d.id : d.alt && get(d.alt, geos.commune) ? d.alt : d.id;
    const a = get(id, geos.commune);
    const b = get(id, geos.departement);
    if (!a || !b || a.value == null || b.value == null || !b.value) return null;
    const dir = gap(a.value, b.value, a.unit === "€" ? "€" : "%").direction;
    return { d, id, a, b, dir, score: Math.abs(a.value - b.value) / Math.abs(b.value) };
  }).filter((x): x is NonNullable<typeof x> => !!x);
  // Indicateurs déterminants : écarts significatifs, les plus forts d'abord (7 au plus) ;
  // complétés par les indicateurs de base (pauvreté, revenu, chômage, HLM) jusqu'à 4 colonnes
  // de chiffres (5 avec le territoire).
  const signif = socioCmp.filter((x) => x.dir === "superieur" || x.dir === "inferieur").sort((x, y) => y.score - x.score);
  // « Plus jeune » et « plus âgée » ne doivent pas se contredire : une seule mesure d'âge par sens.
  const kept: typeof signif = [];
  for (const x of signif) {
    const desc = x.dir === "superieur" ? x.d.up : x.d.down;
    if (desc.adj && kept.some((k) => (k.dir === "superieur" ? k.d.up : k.d.down).adj === desc.adj)) continue;
    if (kept.length < 7) kept.push(x);
  }
  const cols = [...kept];
  for (const x of socioCmp.filter((x) => x.d.core)) if (cols.length < 4 && !cols.includes(x)) cols.push(x);
  // Commune, département, France : l'intercommunalité n'apporte rien à un lecteur non spécialiste.
  const socioRefGeos = [geos.commune, geos.departement, geos.france].filter(Boolean) as GeoRef[];
  // Chiffres arrondis ; revenu exprimé par mois, plus parlant qu'un revenu annuel.
  const fmtCell = (id: string, g: GeoRef) => {
    const v = get(id, g);
    if (v?.value == null) return "n.d.";
    return v.unit === "€" ? `${fmtNumber(Math.round(v.value / 12 / 10) * 10)}\u00a0€` : pp(v.value);
  };
  if (cols.length) {
    out.tables.push({
      id: "lfi_socio",
      title: "Ce qui distingue la commune",
      theme: "strategie",
      columns: [{ key: "territoire", label: "", wide: true }, ...cols.map((x) => ({ key: x.id, label: x.d.label, align: "right" as const }))],
      rows: socioRefGeos.map((g) => ({ territoire: g.level === "france" ? "France" : g.name, ...Object.fromEntries(cols.map((x) => [x.id, fmtCell(x.id, g)])) })),
      highlight: [0],
      sources: [...new Map(cols.map((x) => [x.a.source.dataset ?? x.a.source.id, x.a.source])).values()],
      note: `Seuls figurent les chiffres où la commune se distingue nettement du département${cols.length > kept.length ? " (et, pour repère, la pauvreté, le revenu, le chômage et le logement social)" : ""}. Revenu médian : la moitié des habitants gagne plus, l'autre moitié moins (par personne, après impôts et aides). Tous les chiffres : diagnostic complet, partie B.`,
    });
  }
  // Phrase d'introduction en langage courant.
  const popI = get("pop_municipale", geos.commune);
  const evolI = get("evol_pop_annuelle", geos.commune);
  // Pauvreté et revenu disent la même chose : un seul des deux dans la phrase.
  const sameMsg = kept.some((x) => x.d.id === "taux_pauvrete") ? kept.filter((x) => x.d.id !== "revenu_median") : kept;
  const adjs = [...new Set(sameMsg.map((x) => (x.dir === "superieur" ? x.d.up : x.d.down).adj).filter((v): v is string => !!v))].slice(0, 3);
  const avecs = [...new Set(kept.map((x) => (x.dir === "superieur" ? x.d.up : x.d.down).avec).filter((v): v is string => !!v))].slice(0, 2);
  const socioIntro: string[] = [];
  if (popI)
    socioIntro.push(
      `${commune.nom} compte environ ${fmtNumber(Math.round(popI.value! / 100) * 100)} habitants${evolI ? (evolI.value! <= -0.5 ? ", une population en baisse" : evolI.value! >= 0.5 ? ", une population en hausse" : "") : ""}.`,
    );
  if (adjs.length || avecs.length)
    socioIntro.push(
      `${adjs.length ? `C'est une commune ${B(joinFr(adjs))} que la moyenne du département (${depName})` : `Par rapport au département (${depName}), la commune compte`}${avecs.length ? `${adjs.length ? ", avec " : " "}${B(joinFr(avecs))}` : ""}.`,
    );
  else if (socioCmp.length) socioIntro.push(`Son profil social est proche de la moyenne du département (${depName}) : les écarts portent sur les quartiers plus que sur la commune dans son ensemble.`);

  // Puces rédigées : seuls les écarts significatifs au département sont développés,
  // les indicateurs proches de la moyenne sont regroupés dans une puce unique.
  type Item = { text: string; evidence?: string[] };
  const socio: Item[] = [];
  const evOf = (...xs: (Indicator | undefined)[]) => xs.filter(Boolean).map((i) => evidenceId(i!));
  const cmp = (id: string) => {
    const a = get(id, geos.commune);
    const b = get(id, geos.departement);
    if (!a || !b) return null;
    const unit = a.unit === "€" ? "€" : "%";
    return { a, b, dir: gap(a.value!, b.value!, unit).direction, va: fmtValue(a.value, a.unit), vb: fmtValue(b.value, b.unit) };
  };
  const vs = (x: NonNullable<ReturnType<typeof cmp>>) => `${x.va} contre ${x.vb} dans le département`;

  const sec = get("part_residences_secondaires", geos.commune);
  if (sec && sec.value! >= 10) socio.push({ text: `${B("Beaucoup de résidences secondaires")} : ${oneInV(sec.value!, "logement", "n'est pas habité", "ne sont pas habités")} à l'année.`, evidence: evOf(sec) });
  const vac = cmp("part_logements_vacants");
  if (vac && vac.dir === "superieur" && vac.a.value! >= 9) socio.push({ text: `${B("Beaucoup de logements vides")} : ${oneInV(vac.a.value!, "logement", "est vide", "sont vides")} (département : ${pp(vac.b.value)}).`, evidence: evOf(vac.a, vac.b) });

  const conc = get("concentration_emploi", geos.commune);
  const nearestBig = (commune.population ?? 0) < 20000 ? c.poles.find((p) => p.population >= 20000) : null;
  if (conc && (conc.value! >= 100 || conc.value! < 80))
    socio.push({
      text:
        conc.value! >= 100
          ? `${B("Beaucoup d'emplois sur place")} : la commune fait travailler des habitants des alentours.`
          : `${B("On y habite plus qu'on n'y travaille")} : beaucoup d'habitants travaillent ailleurs${nearestBig ? `, notamment à ${nearestBig.nom}` : ""} ; mieux vaut les rencontrer le soir et le week-end.`,
      evidence: evOf(conc),
    });
  const car = cmp("part_menages_sans_voiture");
  if (car?.dir === "superieur") socio.push({ text: `${B(cap(oneInV(car.a.value!, "foyer", "n'a pas de voiture", "n'ont pas de voiture")))} (département : ${pp(car.b.value)}) : on les rencontre à pied, près des arrêts de bus et des commerces de proximité.`, evidence: evOf(car.a, car.b) });

  // Services : Base permanente des équipements (INSEE) si disponible, sinon OpenStreetMap.
  const popDep = c.populations.find((p) => p.geo.level === "departement")?.value ?? null;
  const bpeCount = (code: string) => c.bpe?.commune.filter((e) => e.type === code).length ?? 0;
  if (c.bpe && commune.population && popDep) {
    const per10k = (n: number, p: number) => (10000 * n) / p;
    const mc = per10k(bpeCount("D265"), commune.population);
    const md = per10k(c.bpe.countsDep.D265 ?? 0, popDep);
    const bpeInd = (id: string, label: string, value: number, g: GeoRef): Indicator => ({ id, label, theme: "sante", value, unit: "nombre", year: c.bpe!.source.vintage, geo: g, source: c.bpe!.source, status: "ok", method: "Équipements de type D265 (BPE) pour 10 000 habitants (population municipale)." });
    const i1 = bpeInd("medecins_10k", "Médecins généralistes pour 10 000 habitants", mc, geos.commune);
    const i2 = bpeInd("medecins_10k", "Médecins généralistes pour 10 000 habitants", md, geos.departement);
    out.indicators.push(i1, i2);
    const n = bpeCount("D265");
    const docs = `${fmtNumber(n)} médecin${n > 1 ? "s" : ""} généraliste${n > 1 ? "s" : ""}`;
    const head =
      n === 0 && commune.population >= 1500
        ? `${B("Aucun médecin généraliste")} dans la commune`
        : md && mc < md * 0.6
          ? `${B("Désert médical")} : ${docs}, ${compareWords(mc, md)} que dans le reste du département pour le même nombre d'habitants`
          : md && mc > md * 1.25
            ? `${docs}, ${compareWords(mc, md)} que dans le reste du département pour le même nombre d'habitants`
            : `${docs}, autant que dans le reste du département pour le même nombre d'habitants`;
    const urg = bpeCount("D106") > 0;
    const pub = [
      bpeCount("A128") ? "une antenne France Services" : "aucune antenne France Services",
      bpeCount("A122") ? "une agence France Travail" : "pas d'agence France Travail",
      bpeCount("A206") ? "un bureau de poste" : bpeCount("A207") + bpeCount("A208") ? "un relais ou une agence postale (pas de bureau de poste)" : "aucun point postal",
    ];
    socio.push({ text: `${head}${urg ? ", des urgences sur place" : ""} ; ${pub.join(", ")}.`, evidence: [evidenceId(i1), evidenceId(i2)] });
  }
  const med = c.bpe ? undefined : get("osm_medecin", geos.commune);
  const fs = get("osm_france_services", geos.commune);
  if (med && (commune.population ?? 0) >= 1500) {
    const parts = [`${fmtNumber(med.value!)} médecin${med.value! > 1 ? "s" : ""} ou cabinet${med.value! > 1 ? "s" : ""} médica${med.value! > 1 ? "ux" : "l"}`];
    if (fs) parts.push(fs.value! > 0 ? "une antenne France Services" : "aucune antenne France Services");
    socio.push({
      text: `${med.value === 0 ? `${B("Aucun médecin recensé")} : ` : "Services : "}${parts.join(", ")} selon OpenStreetMap (recensement à vérifier sur place).`,
      evidence: evOf(med, fs),
    });
  }
  // Demandeurs d'emploi (fichiers France Travail) : remplacent la phrase sur l'emploi local.
  if (extra.emploiText) {
    const i = socio.findIndex((x) => /emplois sur place|travaillent ailleurs/.test(x.text));
    if (i >= 0) socio.splice(i, 1);
    socio.push({ text: extra.emploiText, evidence: [`de_nombre@commune:${commune.code}`, `de_evol_1an@commune:${commune.code}`] });
  }
  // 2 ou 3 phrases qualitatives au plus, par ordre d'utilité pour l'action (services, chômage, mobilité, emploi, logement).
  const order = [/m[ée]decin|France Services/i, /demandeurs d'emploi/i, /voiture/i, /emploi|travaill/i, /vides|secondaires/i];
  const rank = (t: string) => {
    const i = order.findIndex((re) => re.test(t));
    return i < 0 ? order.length : i;
  };
  socio.sort((x, y) => rank(x.text) - rank(y.text));
  socio.splice(3);

  /* ================================================================ 2. politique */
  const el = (id: string) => c.elections.find((e) => e.results[0]?.election.id === id);
  const e24 = el("EU24");
  const p22 = el("PR22T1");
  const com = (e?: { results: ElectionResult[] }) => e?.results.find((r) => r.level === "commune");
  const depR = (e?: { results: ElectionResult[] }) => e?.results.find((r) => r.level === "departement");
  const pops = new Map(referentiel().communes.filter((x) => x.departement === commune.departement.code && x.type === "commune-actuelle").map((x) => [x.code, x.population ?? null]));
  const parrains = c.interne.parrains.get(commune.code) ?? null;
  const depParrains = [...c.interne.parrains.entries()].filter(([k]) => k.startsWith(commune.departement.code)).reduce((s, [, v]) => s + v, 0);
  const elecSources: SourceRef[] = c.elections.map((e) => e.source);
  const interneFourni = c.interne.files.length > 0;

  const bvRef = c.bureaux.find((b) => b.election.id === "EU24") ?? c.bureaux.find((b) => b.election.id === "PR22T1");
  const bvSecond = c.bureaux.find((b) => b.election.id === "PR22T1" && b !== bvRef);
  // Libellés des lieux de vote ; les libellés génériques (« Bureau 5 ») n'apportent rien.
  const labels = new Map(
    [...(c.bvGeo?.labels ?? new Map<string, string>())]
      .map(([k, v]) => [k, prettyBvLabel(v)] as [string, string])
      // « Bureau 5 », « Premier bureau de vote », « Deuxieme Bureau », « Bureau centralisateur » : génériques.
      .filter(([, v]) => !/^(bureau( de vote)?\s*(n°|no|num[ée]ro)?\s*\d+|(premier|deuxi[eè]me|troisi[eè]me|quatri[eè]me|cinqui[eè]me|sixi[eè]me|septi[eè]me|huiti[eè]me|neuvi[eè]me|dixi[eè]me|\d+(er|e|[eè]me))\s+bureau(\s+de\s+vote)?|bureau( de vote)?( centralisateur| unique| principal)?)$/i.test(v.trim())),
  );
  // Abstention par bureau : législatives 2024 (forte participation) quand tous les bureaux s'apparient.
  const ranked: BvRow[] = bvRef ? rankBureaux(bvRef.results, bvSecond?.results ?? null, labels, c.bureaux.find((b) => b.election.id === "LG24T1")?.results) : [];
  const abstBvLabel = ranked[0]?.abstSrc === "LG24T1" ? "législatives 2024" : "2024";
  const prio = ranked.filter((b) => b.priorite === 1);
  // Bureau de vote contenant un point (contours des bureaux).
  const bvPolys = (c.bvGeo?.features ?? []).map((f) => ({ bv: String(f.properties?.bv), f, bb: turf.bbox(f) }));
  const bvAt = (lon: number, lat: number) => {
    for (const p of bvPolys) {
      if (lon < p.bb[0] || lon > p.bb[2] || lat < p.bb[1] || lat > p.bb[3]) continue;
      try {
        if (turf.booleanPointInPolygon([lon, lat], p.f as GeoJSON.Feature<GeoJSON.Polygon>)) return p.bv;
      } catch {
        /* géométrie invalide */
      }
    }
    return null;
  };
  // Logements sociaux (RPLS) par résidence et par bureau de vote.
  const hlm = (c.rpls?.residences ?? []).map((r) => ({ ...r, bv: bvPolys.length ? bvAt(r.lon, r.lat) : null }));
  // Résidences étudiantes et foyers de jeunes travailleurs : les plus grandes d'abord (logements inconnus en dernier).
  const residences = (c.residences?.list ?? [])
    .map((r) => ({ ...r, bv: bvPolys.length ? bvAt(r.lon, r.lat) : null }))
    .sort((x, y) => (y.logements ?? -1) - (x.logements ?? -1) || x.nom.localeCompare(y.nom, "fr"));
  const resPorte = residences.filter((r) => r.porte);
  const resType = (r: { categorie: string }) => (/foyer de jeunes/i.test(r.categorie) ? "foyer de jeunes travailleurs" : "résidence du Crous");
  const hlmByBv = new Map<string, number>();
  for (const r of hlm) if (r.bv) hlmByBv.set(r.bv, (hlmByBv.get(r.bv) ?? 0) + r.logements);
  const hasHlm = hlm.length > 0 && hlmByBv.size > 0;

  // Quartiers (QPV, IRIS) rattachés aux bureaux de vote.
  const qAll: Quartier[] = [...(c.quartiers?.qpv ?? []), ...(c.quartiers?.iris ?? [])];
  const qMatch = qAll.length && c.bvGeo ? matchBureaux(qAll, c.bvGeo.features ?? [], c.bvGeo.points ?? []) : [];
  const qByCode = new Map(qAll.map((q) => [`${q.kind}:${q.code}`, q]));
  const qName = (q: Quartier) => (q.kind === "qpv" ? `QPV ${quartierLabel(q.nom)}` : quartierLabel(q.nom));
  /** « le quartier Saint-Lazare », sans redoubler « quartier » quand le nom le contient déjà. */
  const leQuartier = (q: Quartier) => {
    const n = quartierLabel(q.nom);
    const low = n.charAt(0).toLowerCase() + n.slice(1);
    if (/^(le |la |les |l')/i.test(n)) return low;
    if (/^(quartier|cit[ée]|r[ée]sidence|secteur)s?(\s|$)/i.test(n)) return `${/^(quartier|secteur)/i.test(n) ? "le" : "la"} ${low}`;
    return `le quartier ${n}`;
  };
  const quartierOf = (bv: string) => {
    const m = quartierOfBureau(qMatch, bv);
    return m ? (qByCode.get(`${m.kind}:${m.quartier}`) ?? null) : null;
  };
  const qBureaux = bureauxByQuartier(qMatch);
  const bvList = (raw: string[]) => {
    const bvs = raw.map(dv);
    return bvs.length > 1 ? `BV ${bvs.slice(0, -1).join(", ")} et ${bvs[bvs.length - 1]}` : `BV ${bvs[0]}`;
  };

  const ids = { perf: [] as string[], parrains: [] as string[], abst: [] as string[], partis: [] as string[], ou: [] as string[], hyp: [] as string[], spread: [] as string[] };
  // Éléments réutilisés par l'« en bref ».
  let perfMain: { dir: string; abs: number; commune: number; median: number; name: string } | null = null;
  let parrainsRatio: { r1: number; r2: number } | null = null;
  let abstMain: { c: number; d: number; dir: string } | null = null;
  let lfiVoix24: number | null = null;

  const c24 = com(e24);
  const c22 = com(p22);
  const d24 = depR(e24);
  const d22 = depR(p22);
  // Abstention de référence : législatives 2024 (1er tour), scrutin à forte participation
  // (66,7 % au niveau national), plus représentatif que les européennes ; repli sur les européennes.
  const lg24 = el("LG24T1");
  const cL = com(lg24);
  const dL = depR(lg24);
  const bvLg = c.bureaux.find((b) => b.election.id === "LG24T1")?.results;
  const abstRef = cL && dL ? { c: cL, d: dL, label: "aux législatives 2024", short: "législatives 2024" } : c24 && d24 ? { c: c24, d: d24, label: "aux européennes 2024", short: "européennes 2024" } : null;
  // Graphique systématique « Européennes 2024 » : % des exprimés par force politique, repère national.
  // Graphiques par scrutin (onglets) : 2022 et 2024 au niveau communal, 2017 et 2019 reconstitués
  // à partir des bureaux de vote de la commune.
  for (const cfg of VOTE_CHARTS) {
    const comm = cfg.eid === "EU24" ? c24 : cfg.eid === "PR22T1" ? com(p22) : null;
    const bv = c.bureaux.find((b) => b.election.id === cfg.eid);
    const src = cfg.eid === "EU24" ? e24?.source : cfg.eid === "PR22T1" ? p22?.source : bv?.source;
    const agg = comm ?? (bv?.results.length ? sumBureaux(bv.results) : null);
    if (!agg || !src) continue;
    const ch = voteChart(cfg.eid, agg, src, comm ? undefined : "Total des bureaux de vote de la commune.");
    if (ch) out.charts.push(ch);
  }
  if (c24 || c22) {
    type Row = Record<string, string | number | null>;
    const line = (name: string, ins: number | null, l22: ReturnType<typeof score>, l24: ReturnType<typeof score>, par: number | null, a22: ReturnType<typeof abstention> | null, a24: ReturnType<typeof abstention> | null): Row => ({
      territoire: name,
      inscrits: ins,
      lfi22: l22 ? cnt(l22.voix, l22.pctInscrits) : "",
      lfi24: l24 ? cnt(l24.voix, l24.pctInscrits) : "",
      parrains: par != null && ins ? cnt(par, (100 * par) / ins) : "",
      abst22: a22 ? cnt(a22.n, a22.pct) : "",
      abst24: a24 ? cnt(a24.n, a24.pct) : "",
      abstL: "",
    });
    const rows: Row[] = [{ ...line(commune.nom, c24?.inscrits ?? c22?.inscrits ?? null, c22 ? score("PR22T1", c22, "lfi") : null, c24 ? score("EU24", c24, "lfi") : null, parrains, c22 ? abstention(c22) : null, c24 ? abstention(c24) : null), abstL: cL ? cnt(abstention(cL).n, abstention(cL).pct) : "" }];
    // Bureaux regroupés (comme « BV 3 et 7 (la Madeleine) » dans les fiches de référence) :
    // bureaux prioritaires, et bureaux de chaque quartier prioritaire.
    const aggOf = (res: BureauResult[] | undefined, bvs: string[]) => {
      if (!res) return null;
      const sel = res.filter((b) => bvs.includes(b.bv));
      if (!sel.length) return null;
      const agg = { inscrits: 0, votants: 0, exprimes: 0, abstentions: 0, candidates: [] as { label: string; voix: number }[] };
      const cand = new Map<string, number>();
      for (const b of sel) {
        agg.inscrits += b.inscrits;
        agg.votants += b.votants;
        agg.exprimes += b.exprimes;
        agg.abstentions += b.abstentions;
        for (const x of b.candidates) cand.set(x.label, (cand.get(x.label) ?? 0) + x.voix);
      }
      agg.candidates = [...cand].map(([label, voix]) => ({ label, voix }));
      return agg;
    };
    const groupRow = (name: string, bvs: string[]) => {
      const a24 = aggOf(c.bureaux.find((b) => b.election.id === "EU24")?.results, bvs);
      const a22 = aggOf(c.bureaux.find((b) => b.election.id === "PR22T1")?.results, bvs);
      const aL = aggOf(bvLg, bvs);
      return { ...line(name, a24?.inscrits ?? a22?.inscrits ?? null, a22 ? score("PR22T1", a22, "lfi") : null, a24 ? score("EU24", a24, "lfi") : null, null, a22 ? abstention(a22) : null, a24 ? abstention(a24) : null), abstL: aL ? cnt(abstention(aL as ElectionResult).n, abstention(aL as ElectionResult).pct) : "" };
    };
    const prioBvs = prio.map((p) => p.bv);
    const qpvGroups = (c.quartiers?.qpv ?? []).map((q) => ({ q, bvs: qBureaux.get(q.code) ?? [] })).filter((x) => x.bvs.length);
    if (prio.length && bvRef) {
      const sameQ = prioBvs.map((b) => quartierOf(b)).filter(Boolean);
      const commonQ = sameQ.length === prioBvs.length && sameQ.every((q) => q === sameQ[0]) ? sameQ[0] : null;
      if (!qpvGroups.some((g) => g.bvs.join() === prioBvs.join())) rows.push(groupRow(`${bvList(prioBvs)} (${commonQ ? qName(commonQ) + ", " : ""}prioritaire${prioBvs.length > 1 ? "s" : ""})`, prioBvs));
    }
    for (const g of qpvGroups.slice(0, 3)) rows.push(groupRow(`${bvList(g.bvs)} (${qName(g.q)})`, g.bvs));
    const ds24 = d24 ? score("EU24", d24, "lfi") : null;
    const ds22 = d22 ? score("PR22T1", d22, "lfi") : null;
    rows.push({
      territoire: "Moyenne départementale",
      inscrits: null,
      lfi22: ds22 ? pct(ds22.pctInscrits) : "",
      lfi24: ds24 ? pct(ds24.pctInscrits) : "",
      parrains: depParrains && d24 ? pct((100 * depParrains) / d24.inscrits, 2) : "",
      abst22: d22 ? pct(abstention(d22).pct) : "",
      abst24: d24 ? pct(abstention(d24).pct) : "",
      abstL: dL ? pct(abstention(dL).pct) : "",
    });
    out.tables.push({
      id: "lfi_politique",
      title: "Vote LFI, parrainages et abstention",
      theme: "strategie",
      columns: [
        { key: "territoire", label: "", wide: true },
        { key: "inscrits", label: "Inscrits (2024)", align: "right" },
        { key: "lfi22", label: "LFI (P22)", align: "right" },
        { key: "lfi24", label: "LFI (E24)", align: "right" },
        ...(parrains != null || depParrains ? [{ key: "parrains", label: "Parrains", align: "right" as const }] : []),
        { key: "abst22", label: "Abstention (2022)", align: "right" },
        { key: "abst24", label: "Abstention (E24)", align: "right" },
        ...(cL ? [{ key: "abstL", label: "Abstention (L24)", align: "right" as const }] : []),
      ],
      rows,
      highlight: [0],
      sources: elecSources,
      note: "Le nombre brut correspond au nombre de voix (ou de signataires) ; le pourcentage entre parenthèses est rapporté aux inscrits. P22 : présidentielle 2022, 1er tour (J.-L. Mélenchon) ; E24 : européennes 2024 (liste LFI) ; L24 : législatives 2024, 1er tour (participation nationale de 66,7 %, la plus représentative). La ligne départementale n'est pas pondérée : c'est le score du département entier.",
    });

    // Tableau court de la fiche : un chiffre par case, arrondi, en part des voix.
    {
      type V = { inscrits: number; votants?: number; exprimes: number; abstentions: number; candidates: { label: string; voix: number }[] };
      const vRow = (name: string, a24: V | null | undefined, a22: V | null | undefined, par: number | null, aL?: V | null) => {
        const l24 = a24 ? score("EU24", a24 as ElectionResult, "lfi") : null;
        const l22 = a22 ? score("PR22T1", a22 as ElectionResult, "lfi") : null;
        return {
          territoire: name,
          inscrits: a24?.inscrits ?? a22?.inscrits ?? null,
          lfi24: l24 ? pp(l24.pctExprimes) : "",
          mel22: l22 ? pp(l22.pctExprimes) : "",
          abst24: (abstRef && cL ? aL : a24) ? pp(abstention((abstRef && cL ? aL : a24) as ElectionResult).pct) : "",
          parrains: par != null ? fmtNumber(par) : "",
        };
      };
      const vRows = [vRow(commune.nom, c24, c22, parrains, cL)];
      if (prio.length && bvRef) {
        const a24 = aggOf(c.bureaux.find((b) => b.election.id === "EU24")?.results, prioBvs);
        const a22 = aggOf(c.bureaux.find((b) => b.election.id === "PR22T1")?.results, prioBvs);
        vRows.push(vRow(`${prio.length > 1 ? "Bureaux" : "Bureau"} ${joinFr(prioBvs)} (à cibler)`, a24, a22, null, aggOf(bvLg, prioBvs)));
      }
      if (d24 || d22) vRows.push({ ...vRow(depName, d24, d22, depParrains || null, dL), inscrits: "" as unknown as null });
      const hasPar = parrains != null || !!depParrains;
      out.tables.push({
        id: "lfi_vote",
        title: "Le vote en chiffres",
        theme: "strategie",
        columns: [
          { key: "territoire", label: "", wide: true },
          { key: "inscrits", label: "Électeurs inscrits", align: "right" },
          ...(c24 ? [{ key: "lfi24", label: "Vote LFI européennes 2024", align: "right" as const }] : []),
          ...(c22 ? [{ key: "mel22", label: "Vote Mélenchon présidentielle 2022", align: "right" as const }] : []),
          ...(abstRef ? [{ key: "abst24", label: `N'ont pas voté (${abstRef.short})`, align: "right" as const }] : []),
          ...(hasPar ? [{ key: "parrains", label: "Parrains et marraines", align: "right" as const }] : []),
        ],
        rows: vRows,
        highlight: [0],
        sources: elecSources,
        note: `Vote : part des voix (hors blancs et nuls). « N'ont pas voté » : part des électeurs inscrits qui se sont abstenus${cL ? " au 1er tour des législatives 2024, scrutin très suivi (participation nationale de 66,7 %) : ce sont les électeurs les plus éloignés du vote" : ""}. Le détail (nombre de voix, quartiers) figure en annexe.`,
      });
    }

    // Indicateurs LFI (tableau de bord et preuves).
    const lfiInd = (id: string, label: string, value: number, g: GeoRef, src: SourceRef, year: string, method: string): Indicator => ({ id, label, theme: "strategie", value, unit: "%", year, geo: g, source: src, status: "ok", method });
    for (const [e, eid, y] of [[e24, "EU24", "2024"], [p22, "PR22T1", "2022"]] as const) {
      if (!e) continue;
      for (const r of e.results) {
        const s = score(eid, r, "lfi");
        const g = r.level === "commune" ? geos.commune : geos.departement;
        const name = eid === "EU24" ? "européennes 2024" : "présidentielle 2022";
        if (s) out.indicators.push(lfiInd(`lfi_${eid}_ins`, `Vote LFI (${name}) en % des inscrits`, s.pctInscrits, g, e.source, y, "Voix LFI / inscrits × 100."));
        if (s) out.indicators.push(lfiInd(`lfi_${eid}_exp`, `Vote LFI (${name}) en % des exprimés`, s.pctExprimes, g, e.source, y, "Voix LFI / suffrages exprimés × 100."));
        out.indicators.push(lfiInd(`abst_${eid}`, `Abstention (${name}) en % des inscrits`, abstention(r).pct, g, e.source, y, "Abstentions / inscrits × 100."));
      }
    }
    const ind = (id: string, lvl: "commune" | "departement") => out.indicators.find((i) => i.id === id && i.geo.level === lvl);
    if (c24) lfiVoix24 = score("EU24", c24, "lfi")?.voix ?? null;

    // Surperformance vs communes comparables du département (un seul constat, deux scrutins).
    const perfs: { eid: string; name: string; o: NonNullable<ReturnType<typeof lfiOverperformance>>; g: ReturnType<typeof gap> }[] = [];
    for (const [e, eid, name] of [[e24, "EU24", "européennes 2024"], [p22, "PR22T1", "présidentielle 2022"]] as const) {
      const d = depR(e);
      if (!d) continue;
      const o = lfiOverperformance(eid, d, commune.code, pops);
      if (o) perfs.push({ eid, name, o, g: gap(o.commune, o.median, "%") });
    }
    if (perfs.length) {
      const m = perfs[0];
      perfMain = { dir: m.g.direction, abs: m.g.abs, commune: m.o.commune, median: m.o.median, name: m.name };
      const verdict =
        m.g.direction === "superieur"
          ? "LFI surperforme par rapport aux communes de taille comparable du département"
          : m.g.direction === "inferieur"
            ? "LFI sous-performe par rapport aux communes de taille comparable du département"
            : "Le vote LFI est proche de celui des communes de taille comparable du département";
      const aux = (n: string) => (n.startsWith("présidentielle") ? `à la ${n}` : `aux ${n}`);
      const detail = perfs.map((p) => `${pct(p.o.commune)} des inscrits contre une médiane de ${pct(p.o.median)} ${aux(p.name)} (${fmtSigned(p.g.abs, "points")})`).join(" ; ");
      ids.perf.push(
        addF({
          kind: m.g.direction === "superieur" ? "atout" : "constat",
          text: `${B(verdict)} (les ${m.o.n} communes de taille la plus proche, de ${fmtNumber(m.o.minPop)} à ${fmtNumber(m.o.maxPop)} habitants) : ${detail}.`,
          evidence: perfs.map((p) => ind(`lfi_${p.eid}_ins`, "commune")).filter(Boolean).map((i) => evidenceId(i!)),
          weight: 90,
        }),
      );
    }

    // Parrainages.
    if (parrains != null && c24) {
      const s = score("EU24", c24, "lfi");
      const ds = d24 ? score("EU24", d24, "lfi") : null;
      if (s?.voix && ds?.voix && depParrains) {
        const r1 = parrains / s.voix;
        const r2 = depParrains / ds.voix;
        parrainsRatio = { r1, r2 };
        const src: SourceRef = { id: "interne", name: "Données militantes internes (parrains.csv)", url: "data/interne/parrains.csv", retrievedAt: new Date().toISOString() };
        out.indicators.push({ id: "parrains_pour_100_voix", label: "Parrains pour 100 voix LFI (E24)", theme: "strategie", value: r1 * 100, unit: "nombre", year: "2024", geo: geos.commune, source: src, status: "ok", method: "Parrains / voix LFI aux européennes 2024 × 100." });
        out.indicators.push({ id: "parrains_pour_100_voix", label: "Parrains pour 100 voix LFI (E24)", theme: "strategie", value: r2 * 100, unit: "nombre", year: "2024", geo: geos.departement, source: src, status: "ok", method: "Parrains / voix LFI aux européennes 2024 × 100." });
        const ratio = r1 / r2;
        /** « 1 parrain ou marraine pour 70 électeurs insoumis ». */
        const perVoters = (r: number, short = false) => (r >= 0.5 ? `${fmtNumber(Math.round(r * 10) / 10, 1)} ${short ? "" : "parrains et marraines "}par électeur insoumis`.replace("  ", " ") : `1 ${short ? "" : "parrain ou marraine "}pour ${fmtNumber(Math.round(1 / r))}${short ? "" : " électeurs insoumis"}`);
        ids.parrains.push(
          addF({
            kind: r1 > r2 * 1.2 ? "atout" : r1 < r2 * 0.8 ? "vigilance" : "constat",
            evidence: [`parrains_pour_100_voix@commune:${commune.code}`, `parrains_pour_100_voix@departement:${geos.departement.code}`],
            text: `${r1 > r2 * 1.2 ? B("Beaucoup de soutiens déclarés") : r1 < r2 * 0.8 ? B("Peu de soutiens déclarés") : "Des soutiens déclarés dans la moyenne"} : ${perVoters(r1)}, contre ${perVoters(r2, true)} dans le département.${
              r1 > r2 * 1.2
                ? " Parmi nos électeurs, on trouvera plus facilement qu'ailleurs des personnes prêtes à militer."
                : r1 < r2 * 0.8
                  ? " Il faudra accueillir et accompagner les nouveaux sympathisants."
                  : ""
            }`,
            weight: 85,
          }),
        );
      }
    }

    // Abstention et scrutins intermédiaires.
    if (c22 && c24 && d22 && d24) {
      const ac24 = abstention(c24).pct;
      const ad24 = abstention(d24).pct;
      const dc = ac24 - abstention(c22).pct;
      const dd = ad24 - abstention(d22).pct;
      // Niveau d'abstention jugé sur les législatives 2024 (forte participation) si disponibles.
      const acR = abstRef ? abstention(abstRef.c).pct : ac24;
      const adR = abstRef ? abstention(abstRef.d).pct : ad24;
      const lvl = gap(acR, adR, "%");
      abstMain = { c: acR, d: adR, dir: lvl.direction };
      const head = lvl.direction === "superieur" ? B("L'abstention est nettement plus élevée que dans le département") : lvl.direction === "inferieur" ? "L'abstention est plus faible que dans le département" : "L'abstention est proche de la moyenne départementale";
      const lgTxt = cL && dL ? `${pct(acR)} aux législatives 2024, scrutin pourtant très suivi (département : ${pct(adR)}) ; ` : "";
      ids.abst.push(
        addF({
          kind: lvl.direction === "superieur" ? "atout" : "constat",
          text: `${head} : ${lgTxt}${pct(ac24)} aux européennes 2024 (département : ${pct(ad24)}). Elle progresse de ${fmtNumber(dc, 1)} points entre la présidentielle 2022 et les européennes 2024, contre ${fmtNumber(dd, 1)} points dans le département.${lvl.direction === "superieur" ? ` On peut supposer une ${B("marge de progression chez les abstentionnistes")}.` : ""}`,
          evidence: [ind("abst_EU24", "commune"), ind("abst_EU24", "departement"), ind("abst_PR22T1", "commune")].filter(Boolean).map((i) => evidenceId(i!)),
          weight: 80,
        }),
      );
      if (dc > dd + 2)
        ids.abst.push(
          addF({
            kind: "hypothese",
            text: "La sur-abstention est plus marquée lors du scrutin intermédiaire : ce profil est souvent associé à une abstention intermittente plus forte chez les jeunes et les ménages modestes. Hypothèse à vérifier sur le terrain (listes d'émargement non exploitées).",
            evidence: [ind("abst_EU24", "commune"), ind("abst_PR22T1", "commune"), ind("abst_EU24", "departement"), ind("abst_PR22T1", "departement")].filter(Boolean).map((i) => evidenceId(i!)),
            weight: 60,
          }),
        );
    }

    // Forces politiques (sur/sous-performance relative au département).
    if (c24 && d24) {
      const perfAll = familyPerformance("EU24", c24, d24);
      for (const p of perfAll)
        for (const [g, v] of [[geos.commune, p.commune], [geos.departement, p.departement]] as const)
          out.indicators.push({ id: `vote_${p.family}_EU24_exp`, label: `Vote ${p.label} (européennes 2024) en % des exprimés`, theme: "strategie", value: v, unit: "%", year: "2024", geo: g, source: e24!.source, status: "ok" });
      const perf = perfAll.filter((p) => ["pcf", "ps", "eco", "rn", "lfi"].includes(p.family));
      const sur = perf.filter((p) => p.ratio >= 1.1);
      const sous = perf.filter((p) => p.ratio <= 0.9);
      if (sur.length || sous.length) {
        const part = (xs: typeof perf, verb: string) => `${joinFr(xs.map((p) => p.label))} ${verb}${xs.length > 1 ? "nt" : ""}`;
        const head = [sur.length ? part(sur, "surperforme") : "", sous.length ? part(sous, "sous-performe") : ""].filter(Boolean).join(" ; ");
        ids.partis.push(
          addF({
            kind: sur.some((p) => p.family === "lfi") ? "atout" : "constat",
            evidence: [...sur, ...sous].flatMap((p) => [`vote_${p.family}_EU24_exp@commune:${commune.code}`, `vote_${p.family}_EU24_exp@departement:${geos.departement.code}`]),
            text: `${B(cap(head))} par rapport au département (européennes 2024, % des exprimés) : ${[...sur, ...sous].map((p) => `${p.label} ${pct(p.commune)} contre ${pct(p.departement)}`).join(", ")}.`,
            weight: 55,
          }),
        );
      }
      out.tables.push({
        id: "lfi_partis",
        title: "Européennes 2024 — forces politiques comparées au département (% des exprimés)",
        theme: "strategie",
        columns: [
          { key: "famille", label: "Liste / famille" },
          { key: "commune", label: commune.nom, align: "right", unit: "%" },
          { key: "departement", label: depName, align: "right", unit: "%" },
          { key: "indice", label: "Indice (dép. = 100)", align: "right" },
        ],
        rows: perfAll.map((p) => ({ famille: p.label, commune: Math.round(p.commune * 10) / 10, departement: Math.round(p.departement * 10) / 10, indice: Math.round(p.ratio * 100) })),
        sources: [e24!.source],
      });
    }
  }

  /* ================================================================ 3. bureaux de vote */
  if (ranked.length && bvRef) {
    const second = bvSecond?.election.id === "PR22T1" && ranked.some((b) => b.lfi2PctIns != null) ? "P22" : "";
    const hasLabels = ranked.some((b) => labels.has(b.bv));
    out.tables.push({
      id: "lfi_bureaux",
      title: `Classement des bureaux de vote (${bvRef.election.label}${second ? " et présidentielle 2022" : ""})`,
      theme: "strategie",
      columns: [
        { key: "priorite", label: "Priorité", align: "right" },
        { key: "bv", label: "BV" },
        ...(hasLabels ? [{ key: "libelle", label: "Lieu de vote", wide: true }] : []),
        { key: "inscrits", label: "Inscrits", align: "right" },
        { key: "lfi", label: "LFI E24 (% inscrits)", align: "right", unit: "%" },
        { key: "lfiexp", label: "LFI E24 (% exprimés)", align: "right", unit: "%" },
        ...(second
          ? [
              { key: "lfi2", label: "Mélenchon P22 (% inscrits)", align: "right" as const, unit: "%" as const },
              { key: "lfi2exp", label: "Mélenchon P22 (% exprimés)", align: "right" as const, unit: "%" as const },
            ]
          : []),
        { key: "abst", label: "Abstention E24 (%)", align: "right", unit: "%" },
        { key: "abstn", label: "Abstentionnistes", align: "right" },
        ...(qMatch.length ? [{ key: "quartier", label: "Quartier" }] : []),
        { key: "type", label: "Profil" },
      ],
      rows: ranked.map((b) => ({
        priorite: b.priorite,
        bv: dv(b.bv),
        libelle: labels.get(b.bv) ?? "",
        inscrits: b.inscrits,
        lfi: Math.round(b.lfiPctIns * 10) / 10,
        lfiexp: Math.round(b.lfiPctExp * 10) / 10,
        lfi2: b.lfi2PctIns != null ? Math.round(b.lfi2PctIns * 10) / 10 : null,
        lfi2exp: b.lfi2PctExp != null ? Math.round(b.lfi2PctExp * 10) / 10 : null,
        abst: Math.round(b.abstPct * 10) / 10,
        abstn: b.abstN,
        quartier: (() => {
          const q = quartierOf(b.bv);
          return q ? qName(q) : "";
        })(),
        type: b.profil,
      })),
      highlight: ranked.map((b, i) => (b.priorite === 1 ? i : -1)).filter((i) => i >= 0),
      sources: [bvRef.source, ...(c.bvGeo ? [c.bvGeo.source] : [])],
      note: `Priorité 1 : un quart des bureaux (quatre au plus), classés par potentiel = moyenne de deux scores z calculés entre les bureaux de la commune : réservoir (part LFI des exprimés aux européennes${second ? ", moyennée avec la part de J.-L. Mélenchon au 1er tour de la présidentielle 2022" : ""}) et marge de mobilisation (taux d'abstention aux européennes).${second ? " Présidentielle : bureaux appariés par numéro lorsque leurs inscrits varient de moins de 25 % (n.d. sinon)." : ""} Profil : LFI fort, moyen ou faible selon le tiers des bureaux de la commune (part LFI des exprimés aux européennes) ; abstention forte au-dessus de la médiane des bureaux. Le découpage des bureaux peut avoir évolué depuis le scrutin.`,
    });
    out.charts.push({
      id: "lfi_chart_bureaux",
      title: `Vote LFI${second ? ", vote Mélenchon" : ""} et abstention par bureau de vote (% des inscrits)`,
      type: "bar",
      xKey: "bv",
      data: [...ranked]
        .sort((a, b) => Number(a.bv) - Number(b.bv) || a.bv.localeCompare(b.bv))
        .map((b) => ({ bv: `BV ${dv(b.bv)}`, lfi: Math.round(b.lfiPctIns * 10) / 10, ...(second ? { mel: b.lfi2PctIns != null ? Math.round(b.lfi2PctIns * 10) / 10 : null } : {}), abst: Math.round(b.abstPct * 10) / 10 })),
      series: [
        { key: "lfi", label: "LFI européennes 2024" },
        ...(second ? [{ key: "mel", label: "Mélenchon présidentielle 2022" }] : []),
        { key: "abst", label: "Abstention européennes 2024" },
      ],
      unit: "%",
      sources: [bvRef.source],
    });
    // Tableau court de la fiche : les seuls bureaux prioritaires, comparés à la commune.
    {
      const cl24 = c24 ? score("EU24", c24, "lfi") : null;
      const cm22 = c22 ? score("PR22T1", c22, "lfi") : null;
      const prioRows = ranked.filter((b) => b.priorite === 1);
      if (prioRows.length)
        out.tables.push({
          id: "lfi_bureaux_prio",
          title: "Bureaux de vote prioritaires",
          theme: "strategie",
          columns: [
            { key: "bv", label: "Bureau" },
            ...(hasLabels ? [{ key: "libelle", label: "Lieu de vote", wide: true }] : []),
            ...(qMatch.length ? [{ key: "quartier", label: "Quartier" }] : []),
            // 7 colonnes au plus : les inscrits cèdent la place aux logements sociaux.
            ...(hasHlm ? [] : [{ key: "inscrits", label: "Électeurs inscrits", align: "right" as const }]),
            { key: "lfi", label: "Vote LFI 2024", align: "right" as const },
            ...(second ? [{ key: "mel", label: "Vote Mélenchon 2022", align: "right" as const }] : []),
            { key: "abstn", label: abstBvLabel === "2024" ? "N'ont pas voté en 2024" : `N'ont pas voté (${abstBvLabel})`, align: "right" as const },
            ...(hasHlm ? [{ key: "hlm", label: "Logements sociaux", align: "right" as const }] : []),
          ],
          rows: [
            ...prioRows.map((b) => ({
              hlm: fmtNumber(hlmByBv.get(b.bv) ?? 0),
              bv: dv(b.bv),
              libelle: labels.get(b.bv) ?? "",
              quartier: quartierOf(b.bv) ? quartierLabel(quartierOf(b.bv)!.nom) : "",
              inscrits: b.inscrits,
              lfi: pp(b.lfiPctExp),
              mel: b.lfi2PctExp != null ? pp(b.lfi2PctExp) : "n.d.",
              abstn: `${fmtNumber(b.abstN)} (${pp(b.abstPct)})`,
            })),
            {
              hlm: c.rpls ? fmtNumber(c.rpls.total) : "",
              bv: hasLabels ? "" : "**Ensemble**",
              libelle: `**Ensemble ${deNom(commune.nom)}**`,
              quartier: "",
              inscrits: c24?.inscrits ?? null,
              lfi: cl24 ? pp(cl24.pctExprimes) : "",
              mel: cm22 ? pp(cm22.pctExprimes) : "",
              // Même scrutin que les bureaux (législatives 2024 si elles servent de référence).
              abstn: (() => {
                const ac = prioRows[0].abstSrc === "LG24T1" ? cL : c24;
                return ac ? `${fmtNumber(abstention(ac).n)} (${pp(abstention(ac).pct)})` : "";
              })(),
            },
          ],
          highlight: prioRows.map((_, i) => i),
          sources: [bvRef.source, ...(bvSecond ? [bvSecond.source] : [])],
          note: "Bureaux retenus : là où l'on vote déjà pour nous et où beaucoup d'inscrits ne votent pas. Vote : part des voix ; classement de tous les bureaux en annexe.",
        });
    }
    const bvGeoRef = (bv: string): GeoRef => ({ level: "bureau_vote", code: `${commune.code}-${bv}`, name: `${commune.nom} — BV ${bv}` });
    /* Évolution du vote par bureau : européennes 2019 → 2024, présidentielle 2017 → 2022,
       et score de la gauche unie aux législatives 2024. Bureaux appariés par numéro
       lorsque leurs inscrits varient de moins de 25 %. */
    {
      const resOf = (id: string) => c.bureaux.find((b) => b.election.id === id);
      const mapOf = (id: string) => new Map((resOf(id)?.results ?? []).map((r) => [r.bv, r]));
      const m19 = mapOf("EU19");
      const m17 = mapOf("PR17T1");
      const m22 = mapOf("PR22T1");
      const mlg = mapOf("LG24T1");
      const pairOf = (m: Map<string, BureauResult>, b: BvRow) => {
        const x = m.get(b.bv);
        return x && b.inscrits && Math.abs(x.inscrits - b.inscrits) / b.inscrits <= 0.25 ? x : null;
      };
      const r1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);
      const rows = [...ranked]
        .sort((a, b) => Number(a.bv) - Number(b.bv) || a.bv.localeCompare(b.bv))
        .map((b) => {
          const e19 = pairOf(m19, b);
          const p17 = pairOf(m17, b);
          const p22 = pairOf(m22, b);
          const lg = pairOf(mlg, b);
          const lfi19 = e19 ? score("EU19", e19, "lfi")?.pctInscrits ?? null : null;
          const mel17 = p17 ? score("PR17T1", p17, "lfi")?.pctInscrits ?? null : null;
          const mel22 = p22 ? score("PR22T1", p22, "lfi")?.pctInscrits ?? null : null;
          const nfp = lg ? score("LG24T1", lg, "nfp")?.pctInscrits ?? null : null;
          return {
            b,
            lfi19,
            evoE: lfi19 != null ? b.lfiPctIns - lfi19 : null,
            mel17,
            mel22,
            evoP: mel17 != null && mel22 != null ? mel22 - mel17 : null,
            nfp,
          };
        });
      const hasE = rows.some((r) => r.lfi19 != null);
      const hasP = rows.some((r) => r.mel17 != null && r.mel22 != null);
      const hasL = rows.some((r) => r.nfp != null);
      if (hasE || hasP || hasL) {
        const srcs = ["EU19", "PR17T1", "LG24T1"].map(resOf).filter((x): x is NonNullable<typeof x> => !!x).map((x) => x.source);
        const signed = (v: number | null) => {
          if (v == null) return null;
          const a = Math.abs(Math.round(v * 10) / 10);
          return `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtNumber(a, 1)} ${a >= 2 ? "pts" : "pt"}`;
        };
        out.tables.push({
          id: "lfi_evolution",
          title: "Évolution du vote par bureau de vote (% des inscrits)",
          theme: "strategie",
          columns: [
            { key: "bv", label: "BV" },
            ...(hasLabels ? [{ key: "libelle", label: "Lieu de vote", wide: true }] : []),
            ...(hasE
              ? [
                  { key: "lfi19", label: "LFI E19", align: "right" as const, unit: "%" as const },
                  { key: "lfi24", label: "LFI E24", align: "right" as const, unit: "%" as const },
                  { key: "evoE", label: "Évol. E19→E24", align: "right" as const },
                ]
              : []),
            ...(hasP
              ? [
                  { key: "mel17", label: "Mélenchon P17", align: "right" as const, unit: "%" as const },
                  { key: "mel22", label: "Mélenchon P22", align: "right" as const, unit: "%" as const },
                  { key: "evoP", label: "Évol. P17→P22", align: "right" as const },
                ]
              : []),
            ...(hasL ? [{ key: "nfp", label: "Gauche unie LG24", align: "right" as const, unit: "%" as const }] : []),
          ],
          rows: rows.map((r) => ({
            bv: dv(r.b.bv),
            libelle: labels.get(r.b.bv) ?? "",
            lfi19: r1(r.lfi19),
            lfi24: r1(r.b.lfiPctIns),
            evoE: signed(r.evoE) ?? "n.d.",
            mel17: r1(r.mel17),
            mel22: r1(r.mel22),
            evoP: signed(r.evoP) ?? "n.d.",
            nfp: r1(r.nfp),
          })),
          highlight: rows.map((r, i) => (r.b.priorite === 1 ? i : -1)).filter((i) => i >= 0),
          sources: [bvRef.source, ...(bvSecond ? [bvSecond.source] : []), ...srcs],
          note: `E19 / E24 : liste LFI aux européennes 2019 et 2024 ; P17 / P22 : J.-L. Mélenchon au 1er tour des présidentielles 2017 et 2022 ; LG24 : candidat de la gauche unie (nuance UG) au 1er tour des législatives 2024. Bureaux appariés par numéro lorsque leurs inscrits varient de moins de 25 % (n.d. sinon) : le découpage a pu changer entre deux scrutins. En surbrillance : bureaux prioritaires.`,
        });
        // Évolution d'ensemble de la commune (somme des bureaux).
        const sumAgg = (id: string) => {
          const rs = resOf(id)?.results ?? [];
          if (!rs.length) return null;
          const cand = new Map<string, number>();
          let inscrits = 0;
          let exprimes = 0;
          for (const r of rs) {
            inscrits += r.inscrits;
            exprimes += r.exprimes;
            for (const k of r.candidates) cand.set(k.label, (cand.get(k.label) ?? 0) + k.voix);
          }
          return { inscrits, exprimes, votants: 0, abstentions: 0, blancs: null, nuls: null, candidates: [...cand].map(([label, voix]) => ({ label, voix })) };
        };
        const s19 = sumAgg("EU19");
        const s24 = sumAgg("EU24");
        const s17 = sumAgg("PR17T1");
        const s22 = sumAgg("PR22T1");
        const parts: string[] = [];
        const v19 = s19 ? score("EU19", s19, "lfi") : null;
        const v24 = s24 ? score("EU24", s24, "lfi") : null;
        const v17 = s17 ? score("PR17T1", s17, "lfi") : null;
        const v22 = s22 ? score("PR22T1", s22, "lfi") : null;
        if (v19 && v24) parts.push(`${fmtNumber(v24.voix)} voix aux européennes 2024, contre ${fmtNumber(v19.voix)} en 2019`);
        if (v17 && v22) parts.push(`${fmtNumber(v22.voix)} voix pour J.-L. Mélenchon à la présidentielle 2022, contre ${fmtNumber(v17.voix)} en 2017`);
        const up = rows.filter((r) => r.evoE != null).sort((a, b) => b.evoE! - a.evoE!).slice(0, 3).filter((r) => r.evoE! > 0);
        if (parts.length)
          ids.ou.push(
            addF({
              kind: "constat",
              text: `${B(v19 && v24 ? (v24.voix > v19.voix * 1.05 ? "La France insoumise a gagné des voix" : v24.voix < v19.voix * 0.95 ? "La France insoumise a perdu des voix" : "Un vote insoumis stable") : "Évolution")} : ${parts.join(" ; ")}.${up.length ? ` Plus forte progression : ${up.length > 1 ? "bureaux" : "bureau"} ${joinFr(up.map((r) => dv(r.b.bv)))}.` : ""}`,
              evidence: ranked.map((b) => `lfi_bv_ins@bureau_vote:${commune.code}-${b.bv}`),
              weight: 84,
            }),
          );
      }
    }

    const bvInd = (b: BvRow, id: string, label: string, value: number) =>
      ({ id, label, theme: "strategie", value, unit: "%", year: bvRef.election.date.slice(0, 4), geo: bvGeoRef(b.bv), source: bvRef.source, status: "ok", denominator: b.inscrits }) as Indicator;
    for (const b of ranked) {
      out.indicators.push(bvInd(b, "lfi_bv_ins", `Vote LFI (${bvRef.election.label}) en % des inscrits`, b.lfiPctIns));
      out.indicators.push(bvInd(b, "lfi_bv_exp", `Vote LFI (${bvRef.election.label}) en % des exprimés`, b.lfiPctExp));
      out.indicators.push(bvInd(b, "abst_bv", `Abstention (${b.abstSrc === "LG24T1" ? "Législatives 2024 — 1er tour" : bvRef.election.label}) en % des inscrits`, b.abstPct));
      if (b.lfi2PctIns != null && bvSecond) out.indicators.push({ ...bvInd(b, "mel_bv_ins", "Vote J.-L. Mélenchon (présidentielle 2022, 1er tour) en % des inscrits", b.lfi2PctIns), year: "2022", source: bvSecond.source });
    }
    const bvEv = (rows: BvRow[], id = "lfi_bv_ins") => rows.map((b) => `${id}@bureau_vote:${commune.code}-${b.bv}`);
    const top = ranked.slice(0, Math.max(1, prio.length));
    const topVoix = top.reduce((s, b) => s + b.lfiVoix, 0);
    const allVoix = ranked.reduce((s, b) => s + b.lfiVoix, 0);
    const topIns = top.reduce((s, b) => s + b.inscrits, 0);
    const allIns = ranked.reduce((s, b) => s + b.inscrits, 0);
    const shIns = (100 * topIns) / (allIns || 1);
    const shVoix = (100 * topVoix) / (allVoix || 1);
    const expOf = (rows: BvRow[]) => rows.reduce((s, b) => s + (b.lfiPctExp ? (100 * b.lfiVoix) / b.lfiPctExp : 0), 0);
    const lfiTop = (100 * topVoix) / (expOf(top) || 1);
    const lfiAll = (100 * allVoix) / (expOf(ranked) || 1);
    const abstTop = (100 * top.reduce((s, b) => s + b.abstN, 0)) / (topIns || 1);
    const abstAll = (100 * ranked.reduce((s, b) => s + b.abstN, 0)) / (allIns || 1);
    const topNames = `${top.length > 1 ? "Les bureaux" : "Le bureau"} ${joinFr(top.map((b) => `${dv(b.bv)}${labels.has(b.bv) ? ` (${b.label})` : ""}`))}`;
    // Peu de bureaux : les écarts entre eux ne disent pas grand-chose, tout le territoire se couvre.
    if (ranked.length <= 3)
      ids.ou.push(
        addF({
          kind: "constat",
          evidence: bvEv(ranked),
          text: `Avec ${ranked.length} ${ranked.length > 1 ? "bureaux" : "bureau"} de vote seulement, ${B("le porte-à-porte peut couvrir toute la commune")} : ${fmtNumber(ranked.reduce((s, b) => s + b.abstN, 0))} inscrits n'ont pas voté en 2024. Commencer par le bureau ${joinFr(top.map((b) => `${dv(b.bv)}${labels.has(b.bv) ? ` (${b.label})` : ""}`))}.`,
          weight: 95,
        }),
      );
    else
      ids.ou.push(
        addF({
          kind: "atout",
          evidence: [...bvEv(top), ...bvEv(top, "abst_bv")],
          text:
            shVoix >= shIns * 1.2
              ? `${B(topNames)} ${top.length > 1 ? "regroupent" : "regroupe"} ${shareWords(shIns)} des électeurs de la commune, mais ${B(`${shareWords(shVoix)} des voix insoumises`)} aux européennes 2024 (${fmtNumber(topVoix)} voix). On y compte aussi ${fmtNumber(top.reduce((s, b) => s + b.abstN, 0))} personnes inscrites qui n'ont pas voté : c'est là que le porte-à-porte rapporte le plus.`
              : `${B(topNames)} : ${B(`${pp(lfiTop)} des voix pour la France insoumise`)} aux européennes 2024 (commune : ${pp(lfiAll)}), et ${pp(abstTop)} des inscrits n'ont pas voté (commune : ${pp(abstAll)}). ${fmtNumber(top.reduce((s, b) => s + b.abstN, 0))} personnes à aller chercher : c'est là que le porte-à-porte rapporte le plus.`,
          weight: 95,
        }),
      );
    const best = [...ranked].sort((a, b) => b.lfiPctExp - a.lfiPctExp)[0];
    const worst = [...ranked].sort((a, b) => a.lfiPctExp - b.lfiPctExp)[0];
    if (best && worst && best !== worst)
      ids.ou.push(
        addF({
          kind: "constat",
          text: `Les scores se concentrent dans une partie de la commune : de ${pct(worst.lfiPctExp)} des exprimés au BV ${dv(worst.bv)}${labels.has(worst.bv) ? ` (${worst.label})` : ""} à ${pct(best.lfiPctExp)} au BV ${dv(best.bv)}${labels.has(best.bv) ? ` (${best.label})` : ""}.`,
          evidence: bvEv([worst, best], "lfi_bv_exp"),
          weight: 70,
        }),
      );

    // Cartes par bureau : contours si disponibles, sinon lieux de vote (points).
    const geo = c.bvGeo?.features ?? [];
    // Contours des quartiers prioritaires superposés aux bureaux.
    const qpvGeo = (c.quartiers?.qpv ?? []).filter((q) => q.geometry);
    const qpvLayers = qpvGeo.length
      ? [{ id: "qpv", label: "Quartiers prioritaires", kind: "polygons" as const, data: { type: "FeatureCollection" as const, features: qpvGeo.map((q) => ({ type: "Feature" as const, geometry: q.geometry!, properties: { nom: quartierLabel(q.nom) } })) }, color: "#111827", outlineOnly: true, visible: true, source: c.quartiers!.sources[0] }]
      : [];
    const pts = c.bvGeo?.points ?? [];
    if (!geo.length && pts.length) {
      const byBv = new Map(ranked.map((b) => [b.bv, b]));
      const lg = divergingLegend("Vote LFI (part des voix)", ranked.map((b) => b.lfiPctExp));
      const colorOf = (v: number | null) => (v == null ? MISSING_COLOR : (lg.classes!.find((k) => v <= k.max) ?? lg.classes![lg.classes!.length - 1])?.color ?? MISSING_COLOR);
      const features = pts.map((f) => {
        const b = byBv.get(String(f.properties?.bv));
        return { ...f, properties: { ...f.properties, name: `Bureau ${dv(String(f.properties?.bv))} — ${f.properties?.label} : LFI ${b ? pp(b.lfiPctExp) : "n.d."} des voix, ${b ? pp(b.abstPct) : "n.d."} n'ont pas voté`, color: colorOf(b ? b.lfiPctExp : null) } };
      });
      const contour = commune.contour ? [{ type: "Feature" as const, geometry: commune.contour, properties: { nom: commune.nom } }] : [];
      const all = turf.featureCollection([...features, ...contour] as GeoJSON.Feature[]);
      out.maps.push({
        id: "lfi_map_bv",
        title: `Lieux de vote selon le vote LFI (${bvRef.election.label}, part des voix)`,
        theme: "strategie",
        bbox: turf.bbox(turf.buffer(all, 0.3, { units: "kilometers" })!) as [number, number, number, number],
        layers: [
          ...(contour.length ? [{ id: "contour", label: `Limite communale de ${commune.nom}`, kind: "polygons" as const, data: { type: "FeatureCollection" as const, features: contour }, color: "#374151", outlineOnly: true, visible: true, source: c.geoSource ?? c.bvGeo!.source }] : []),
          ...qpvLayers,
          { id: "lieux", label: "Lieux de vote", kind: "points", data: { type: "FeatureCollection", features }, visible: true, source: c.bvGeo!.source },
        ],
        legend: { title: lg.title, unit: "%", categories: lg.classes!.map((k) => ({ label: `${fmtNumber(k.min, 1)} – ${fmtNumber(k.max, 1)} %`, color: k.color })) },
        note: "Contours des bureaux non disponibles : chaque point est le lieu de vote (adresse du Répertoire électoral unique géocodée par la Base adresse nationale).",
      });
    }
    if (geo.length) {
      const byBv = new Map(ranked.map((b) => [b.bv, b]));
      const fc = (prop: (b: BvRow) => number | null): GeoJSON.FeatureCollection => ({
        type: "FeatureCollection",
        features: geo.map((f) => {
          const b = byBv.get(String(f.properties?.bv));
          const v = b ? prop(b) : null;
          return { ...turf.truncate(f, { precision: 5 }), properties: { ...f.properties, bvl: dv(String(f.properties?.bv)), ...(b?.priorite === 1 ? { prio: 1 } : {}), nom: `Bureau ${dv(String(f.properties?.bv))}${labels.has(String(f.properties?.bv)) ? ` — ${labels.get(String(f.properties?.bv))}` : ""}`, valeur: v != null ? Math.round(v * 10) / 10 : null } };
        }),
      });
      const bbox = turf.bbox(turf.featureCollection(geo)) as [number, number, number, number];
      const src = c.bvGeo!.source;
      const approx =
        c.bvGeo!.method === "enveloppe"
          ? "Contours approximatifs (enveloppe des adresses d'électeurs du REU)."
          : c.bvGeo!.method === "contours"
            ? "Contours proposés par l'INSEE (méthode statistique) : ils peuvent différer du découpage arrêté par la mairie."
            : "";
      out.maps.push({
        id: "lfi_map_bv",
        group: "lfi_bv",
        period: "Vote LFI",
        title: `Vote LFI par bureau de vote (${bvRef.election.label}, part des voix)`,
        theme: "strategie",
        bbox,
        layers: [{ id: "bv", label: "Vote LFI (part des voix)", kind: "polygons", data: fc((b) => b.lfiPctExp), valueProperty: "valeur", visible: true, source: src }, ...qpvLayers],
        legend: divergingLegend("Vote LFI (part des voix)", ranked.map((b) => b.lfiPctExp)),
        note: [approx, qpvLayers.length ? "Trait noir : quartiers prioritaires de la politique de la ville." : ""].filter(Boolean).join(" "),
      });
      out.maps.push({
        id: "lfi_map_bv_participation",
        group: "lfi_bv",
        period: "Participation",
        title: `Participation par bureau de vote (${bvRef.election.label}, part des inscrits qui ont voté)`,
        theme: "strategie",
        bbox,
        layers: [{ id: "bv", label: "Participation (%)", kind: "polygons", data: fc((b) => 100 - b.abstPct), valueProperty: "valeur", visible: true, source: src }, ...qpvLayers],
        legend: divergingLegend("Ont voté (part des inscrits)", ranked.map((b) => 100 - b.abstPct)),
        note: approx,
      });
      // Présidentielle 2022 : vote Mélenchon et participation (bureaux appariés).
      const p22 = ranked.filter((b) => b.lfi2PctIns != null);
      if (bvSecond && p22.length >= Math.max(2, ranked.length / 2)) {
        const note22 = [approx, "Bureaux de 2022 appariés par numéro aux contours actuels (inscrits à ±25 %) ; gris : bureau non apparié."].filter(Boolean).join(" ");
        out.maps.push({
          id: "lfi_map_bv_p22",
          group: "lfi_bv_p22",
          period: "Vote Mélenchon",
          title: "Vote Mélenchon par bureau de vote (présidentielle 2022, 1er tour, part des voix)",
          theme: "strategie",
          bbox,
          layers: [{ id: "bv", label: "Vote Mélenchon (part des voix)", kind: "polygons", data: fc((b) => b.lfi2PctExp ?? null), valueProperty: "valeur", visible: true, source: bvSecond.source }, ...qpvLayers],
          legend: divergingLegend("Vote Mélenchon (part des voix)", p22.filter((b) => b.lfi2PctExp != null).map((b) => b.lfi2PctExp!)),
          note: note22,
        });
        out.maps.push({
          id: "lfi_map_bv_p22_participation",
          group: "lfi_bv_p22",
          period: "Participation",
          title: "Participation par bureau de vote (présidentielle 2022, 1er tour, part des inscrits qui ont voté)",
          theme: "strategie",
          bbox,
          layers: [{ id: "bv", label: "Participation (%)", kind: "polygons", data: fc((b) => (b.abst2Pct != null ? 100 - b.abst2Pct : null)), valueProperty: "valeur", visible: true, source: bvSecond.source }, ...qpvLayers],
          legend: divergingLegend("Ont voté (part des inscrits)", p22.filter((b) => b.abst2Pct != null).map((b) => 100 - b.abst2Pct!)),
          note: note22,
        });
      }
    }
  }

  /* ================================================================ 3 bis. quartiers */
  const ids2 = { quartiers: [] as string[] };
  if (qAll.length) {
    const comPov = get("taux_pauvrete", geos.commune)?.value ?? null;
    // Part des voix (exprimés), comme partout dans la fiche : comparer en part des inscrits
    // ferait paraître « faible » un quartier où l'on vote pour nous mais où l'on vote peu.
    const lfiCom = c24 ? score("EU24", c24, "lfi")?.pctExprimes ?? null : null;
    const byBv = new Map(ranked.map((b) => [b.bv, b]));
    const expOfRow = (b: BvRow) => (b.lfiPctExp ? (100 * b.lfiVoix) / b.lfiPctExp : 0);
    const lfiOfBvs = (bvs: string[]) => {
      const rows = bvs.map((b) => byBv.get(b)).filter((x): x is BvRow => !!x);
      const exp = rows.reduce((s2, b) => s2 + expOfRow(b), 0);
      return exp ? { pct: (100 * rows.reduce((s2, b) => s2 + b.lfiVoix, 0)) / exp, ins: rows.reduce((s2, b) => s2 + b.inscrits, 0) } : null;
    };
    // Vote Mélenchon 2022 des bureaux appariés du quartier (part des voix).
    const melOfBvs = (bvs: string[]) => {
      const rows = bvs.map((b) => byBv.get(b)).filter((x): x is BvRow => !!x && x.lfi2PctExp != null && !!x.lfi2Voix);
      const exp = rows.reduce((s2, b) => s2 + (100 * b.lfi2Voix!) / b.lfi2PctExp!, 0);
      return exp && rows.length === bvs.length ? (100 * rows.reduce((s2, b) => s2 + b.lfi2Voix!, 0)) / exp : null;
    };
    const melCom = c22 ? (score("PR22T1", c22, "lfi")?.pctExprimes ?? null) : null;
    // Un même lieu nommé deux fois (QPV « la Victoire » et IRIS « Victoire ») : un seul nom.
    const uniqNames = (names: string[]) => {
      const norm = (x: string) => x.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/^(le quartier|le|la|les|l')\s*/, "").replace(/\b(cite|quartier|residence)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
      const out: string[] = [];
      for (const n of names) if (!out.some((o) => norm(o).includes(norm(n)) || norm(n).includes(norm(o)))) out.push(n);
      return out;
    };
    const prioBv = new Set(prio.map((p) => p.bv));
    const iris = (c.quartiers?.iris ?? []).filter((q) => q.type !== "A" && q.type !== "D");
    const irisShown = [...iris].sort((a, b) => (b.stats.pauvrete ?? -1) - (a.stats.pauvrete ?? -1)).slice(0, 8);
    const shown = [...(c.quartiers?.qpv ?? []), ...irisShown];
    const qSrc = c.quartiers!.sources;
    const qGeo = (q: Quartier): GeoRef => ({ level: "quartier", code: `${q.kind}:${q.code}`, name: qName(q) });
    const qInd = (q: Quartier, id: string, label: string, value: number, unit: "%" | "€") =>
      ({ id, label, theme: "strategie", value, unit, geo: qGeo(q), source: (q.kind === "qpv" ? qSrc.find((x) => x.id === "insee_qpv") : qSrc.find((x) => x.id === "iris")) ?? qSrc[0], status: "ok" }) as Indicator;
    for (const q of shown) {
      if (q.stats.pauvrete != null) out.indicators.push(qInd(q, "taux_pauvrete_quartier", "Taux de pauvreté du quartier", q.stats.pauvrete, "%"));
      if (q.stats.revenu != null) out.indicators.push(qInd(q, "revenu_median_quartier", "Revenu médian du quartier", q.stats.revenu, "€"));
    }
    const jeunesLabels = [...new Set(shown.map((q) => q.stats.jeunesLabel).filter(Boolean))];
    const cRow = rowFor(geos.commune);
    out.tables.push({
      id: "lfi_quartiers",
      title: "Profil des quartiers",
      theme: "strategie",
      columns: [
        { key: "nom", label: "", wide: true },
        { key: "revenu", label: "Revenu médian", align: "right" },
        { key: "pauvrete", label: "Taux de pauvreté", align: "right" },
        { key: "jeunes", label: jeunesLabels.length === 1 ? cap(jeunesLabels[0]!) : "Jeunes*", align: "right" },
        { key: "ages", label: "60 ans et +", align: "right" },
        { key: "chomage", label: "Taux de chômage", align: "right" },
        { key: "locataires", label: "Locataires (dont HLM)", align: "right" },
        ...(qMatch.length
          ? [
              { key: "bv", label: "Bureaux de vote" },
              { key: "lfi", label: "Vote LFI 2024 (part des voix)", align: "right" as const },
              ...(melCom != null ? [{ key: "mel", label: "Vote Mélenchon 2022 (part des voix)", align: "right" as const }] : []),
            ]
          : []),
      ],
      rows: [
        ...shown.map((q) => {
          const bvs = qBureaux.get(q.code) ?? [];
          const l = lfiOfBvs(bvs);
          return {
            nom: q.kind === "qpv" ? `**${q.nom}** (QPV)` : `${q.nom} (IRIS)`,
            revenu: q.stats.revenu != null ? fmtValue(q.stats.revenu, "€") : "n.d.",
            pauvrete: pct(q.stats.pauvrete, 0),
            jeunes: pct(q.stats.jeunes, 0),
            ages: pct(q.stats.ages, 0),
            chomage: pct(q.stats.chomage, 0),
            locataires: q.stats.locataires != null ? `${pct(q.stats.locataires, 0)}${q.stats.hlm != null ? ` (${pct(q.stats.hlm, 0)})` : ""}` : "n.d.",
            bv: bvs.length ? bvs.map(dv).join(", ") : "",
            lfi: l ? pct(l.pct) : "",
            mel: bvs.length && melOfBvs(bvs) != null ? pct(melOfBvs(bvs)) : "",
          };
        }),
        { nom: `**${commune.nom} (total)**`, revenu: cRow.revenu, pauvrete: cRow.pauvrete, jeunes: cRow.jeunes, ages: "n.d.", chomage: cRow.chomage, locataires: cRow.locataires, bv: "", lfi: lfiCom != null ? pct(lfiCom) : "", mel: melCom != null ? pct(melCom) : "" },
      ],
      highlight: shown.map((q, i) => (q.kind === "qpv" ? i : -1)).filter((i) => i >= 0),
      sources: qSrc,
      note: `QPV : quartiers prioritaires de la politique de la ville (géographie 2024, indicateurs Filosofi 2021 et estimations 2022) ; IRIS : quartiers statistiques de l'INSEE (recensement et Filosofi 2021)${iris.length > irisShown.length ? `, ${irisShown.length} IRIS d'habitat les plus pauvres sur ${iris.length}` : ""}. Bureaux de vote : bureaux dont au moins 30 % de la surface est dans le quartier (contours approximatifs). Commune : chômage au sens du recensement, part des moins de 25 ans.${jeunesLabels.length > 1 ? " *Moins de 25 ans pour les QPV, moins de 30 ans pour les IRIS." : ""}`,
    });
    // Quartier le plus pauvre.
    const poorest = shown.filter((q) => q.stats.pauvrete != null).sort((a, b) => b.stats.pauvrete! - a.stats.pauvrete!)[0];
    if (poorest && comPov != null && poorest.stats.pauvrete! >= comPov + 8)
      ids2.quartiers.push(
        addF({
          kind: "constat",
          text: `${B(`${cap(poorest.kind === "qpv" ? leQuartier(poorest) : quartierLabel(poorest.nom))} concentre la pauvreté`)} : ${oneInV(poorest.stats.pauvrete!, "habitant", "y vit", "y vivent")} sous le seuil de pauvreté, contre ${oneIn(comPov)} dans l'ensemble de la commune${poorest.stats.revenu != null ? ` (revenu médian : ${fmtNumber(Math.round(poorest.stats.revenu / 12 / 10) * 10)}\u00a0€ par mois)` : ""}.`,
          evidence: [`taux_pauvrete_quartier@quartier:${poorest.kind}:${poorest.code}`, ...(get("taux_pauvrete", geos.commune) ? [evidenceId(get("taux_pauvrete", geos.commune)!)] : [])],
          weight: 88,
        }),
      );
    // Vote LFI par quartier (bureaux rattachés). Les quartiers couverts par les mêmes
    // bureaux (QPV et IRIS superposés) sont regroupés pour éviter les redites.
    if (lfiCom != null) {
      const strong: { names: string[]; bvs: string[]; l: number; mel: number | null; qpv: boolean }[] = [];
      const weak = new Map<string, { names: string[]; bvs: string[]; l: number; ev: string[] }>();
      const evAll: string[] = [];
      const label = (q: Quartier) => (q.kind === "qpv" ? leQuartier(q) : quartierLabel(q.nom));
      // QPV d'abord : un IRIS entièrement couvert par les bureaux d'un QPV déjà cité n'apporte rien de plus.
      for (const q of [...shown].sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "qpv" ? -1 : 1))) {
        const bvs = qBureaux.get(q.code) ?? [];
        const l = lfiOfBvs(bvs);
        const poor = q.stats.pauvrete != null && comPov != null && q.stats.pauvrete >= comPov + 5;
        if (!l) {
          // Quartier déjà couvert par un bureau prioritaire : pas de question contradictoire.
          if (poor && q.kind === "qpv" && !prio.some((p) => quartierOf(p.bv)?.code === q.code))
            ids2.quartiers.push(addF({ kind: "hypothese", text: `${B(cap(leQuartier(q)))} est partagé entre plusieurs bureaux de vote : on ne connaît pas son vote. Quartier populaire, il devrait nous être favorable : qui y connaissons-nous ?`, evidence: [`taux_pauvrete_quartier@quartier:${q.kind}:${q.code}`], weight: 60 }));
          continue;
        }
        out.indicators.push({ ...qInd(q, "lfi_quartier_ins", "Vote LFI (E24) des bureaux du quartier, en part des voix", l.pct, "%"), source: bvRef!.source });
        const ev = `lfi_quartier_ins@quartier:${q.kind}:${q.code}`;
        const key = [...bvs].sort().join(",");
        // « Plus fort » seulement s'il l'est nettement (15 % au-dessus de la commune).
        if (l.pct >= lfiCom * 1.15) {
          const same = strong.find((x) => [...x.bvs].sort().join(",") === key);
          if (same) {
            same.names.push(label(q));
            continue;
          }
          if (strong.some((x) => bvs.every((b) => x.bvs.includes(b)))) continue;
          strong.push({ names: [label(q)], bvs, l: l.pct, mel: melOfBvs(bvs) ?? null, qpv: q.kind === "qpv" });
          evAll.push(ev);
        } else if (poor && l.pct < lfiCom * 1.05 && !bvs.some((b) => prioBv.has(b))) {
          const w = weak.get(key);
          const nm = q.kind === "qpv" ? leQuartier(q) : quartierLabel(q.nom);
          if (w) w.names.push(nm);
          else weak.set(key, { names: [nm], bvs, l: l.pct, ev: [ev] });
        }
      }
      const comEv = out.indicators.filter((i) => i.id === "lfi_EU24_ins" && i.geo.level === "commune").map(evidenceId);
      if (strong.length) {
        strong.sort((x, y) => y.l - x.l);
        const bvWords = (bvs: string[]) => `${bvs.length > 1 ? "bureaux" : "bureau"} ${joinFr(bvs.map(dv))}`;
        const item = (x: (typeof strong)[number]) => `${joinFr(uniqNames(x.names))} (${bvWords(x.bvs)}, vote ${compareWords(x.l, lfiCom)} fort)`;
        ids2.quartiers.push(
          addF({
            kind: "atout",
            text:
              strong.length > 1
                ? `${B("Le vote insoumis est plus fort dans plusieurs quartiers")} que dans le reste de la commune : ${strong.slice(0, 3).map(item).join(" ; ")}${strong.length > 3 ? `, et ${strong.length - 3} autre${strong.length > 4 ? "s" : ""} quartier${strong.length > 4 ? "s" : ""}` : ""}.`
                : `${B(`Le vote insoumis est ${compareWords(strong[0].l, lfiCom)} fort dans ${joinFr(uniqNames(strong[0].names))}`)} (${bvWords(strong[0].bvs)}) que dans l'ensemble de la commune${strong[0].mel != null && melCom != null && strong[0].mel > melCom * 1.05 ? ", aux européennes 2024 comme à la présidentielle 2022" : " aux européennes 2024"}.`,
            evidence: [...evAll, ...comEv],
            weight: 93,
          }),
        );
      }
      for (const w of weak.values())
        ids2.quartiers.push(addF({ kind: "hypothese", text: `${B(`${cap(joinFr(uniqNames(w.names)))} (${w.bvs.length > 1 ? "bureaux" : "bureau"} ${joinFr(w.bvs.map(dv))})`)} : un quartier populaire où le vote insoumis n'est ${w.l > lfiCom ? "guère plus fort" : "pas plus fort"} qu'ailleurs dans la commune (${pp(w.l)} des voix, contre ${pp(lfiCom)}). Les habitants sont-ils inscrits sur les listes électorales ? Avons-nous des contacts sur place ?`, evidence: [...w.ev, ...comEv], weight: 72 }));
    }
  }

  /* ================================================================ 4. pourquoi (hypothèses) */
  const povI = get("taux_pauvrete", geos.commune);
  const povDep = get("taux_pauvrete", geos.departement);
  const youngI = get("part_moins_25", geos.commune);
  const youngDep = get("part_moins_25", geos.departement);
  const hlmI = get("part_locataires_hlm", geos.commune);
  const hlmDep = get("part_locataires_hlm", geos.departement);
  const reasons: string[] = [];
  const ev: Indicator[] = [];
  if (povI && povDep && gap(povI.value!, povDep.value!, "%").direction === "superieur") {
    reasons.push("beaucoup de pauvreté");
    ev.push(povI, povDep);
  }
  if (youngI && youngDep && gap(youngI.value!, youngDep.value!, "%").direction === "superieur") {
    reasons.push("beaucoup de jeunes");
    ev.push(youngI, youngDep);
  }
  if (hlmI && hlmDep && gap(hlmI.value!, hlmDep.value!, "%").direction === "superieur") {
    reasons.push("beaucoup de logements sociaux");
    ev.push(hlmI, hlmDep);
  }
  if (reasons.length)
    ids.hyp.push(
      addF({
        kind: "hypothese",
        text: `${B(cap(joinFr(reasons)))} : ces habitants votent souvent pour nous, mais s'abstiennent aussi beaucoup. Est-ce le cas ici, et dans quels quartiers ?`,
        evidence: ev.map(evidenceId),
        weight: 75,
      }),
    );
  if (ranked.length >= 3) {
    const sorted = [...ranked].sort((x, y) => y.lfiPctExp - x.lfiPctExp);
    const spread = sorted[0].lfiPctExp - sorted[sorted.length - 1].lfiPctExp;
    if (spread >= 10)
      ids.spread.push(
        addF({
          kind: "hypothese",
          text: `Les écarts entre bureaux (${fmtNumber(spread, 1)} points de part LFI des exprimés entre le BV ${dv(sorted[0].bv)} et le BV ${dv(sorted[sorted.length - 1].bv)}) reflètent probablement des différences de composition sociale entre quartiers (habitat social, population étudiante, âge). À confirmer par les données infracommunales (IRIS, quartiers prioritaires) et la connaissance du terrain.`,
          evidence: [`lfi_bv_exp@bureau_vote:${commune.code}-${sorted[0].bv}`, `lfi_bv_exp@bureau_vote:${commune.code}-${sorted[sorted.length - 1].bv}`],
          weight: 65,
        }),
      );
  }
  if (!reasons.length && perfMain?.dir === "superieur")
    ids.hyp.push(
      addF({
        kind: "hypothese",
        text: `${B("Le vote insoumis est fort sans que les chiffres sociaux l'expliquent")} : qu'est-ce qui joue ici (militants actifs, certains quartiers, nouveaux habitants) ?`,
        evidence: out.indicators.filter((i) => i.id === "lfi_EU24_ins").map(evidenceId),
        weight: 60,
      }),
    );

  /* ================================================================ 5. comment : lieux d'action */
  const centroids = new Map<string, [number, number]>();
  for (const f of c.bvGeo?.points ?? []) centroids.set(String(f.properties?.bv), f.geometry.coordinates as [number, number]);
  for (const f of c.bvGeo?.features ?? []) {
    if (centroids.has(String(f.properties?.bv))) continue;
    try {
      centroids.set(String(f.properties?.bv), turf.centroid(f).geometry.coordinates as [number, number]);
    } catch {
      /* géométrie invalide */
    }
  }
  const polys = c.bvGeo?.features ?? [];
  const nearestBv = (lon: number | null, lat: number | null) => {
    if (lon == null || lat == null || !centroids.size) return null;
    for (const f of polys) {
      try {
        if (turf.booleanPointInPolygon([lon, lat], f)) return { bv: String(f.properties?.bv), d: 0 };
      } catch {
        /* géométrie invalide */
      }
    }
    let best: { bv: string; d: number } | null = null;
    for (const [bv, cc] of centroids) {
      const d = haversineKm([lon, lat], cc);
      if (!best || d < best.d) best = { bv, d };
    }
    return best;
  };
  const prioSet = new Set(prio.map((p) => p.bv));
  type Lieu = { type: string; nom: string; infos: string; bv: string; prioritaire: string; lon: number | null; lat: number | null };
  const lieux: Lieu[] = [];
  const pushLieu = (type: string, nom: string, infos: string, lon: number | null, lat: number | null) => {
    const nb = nearestBv(lon, lat);
    lieux.push({ type, nom, infos, bv: nb ? `BV ${dv(nb.bv)}` : "", prioritaire: nb && prioSet.has(nb.bv) ? "oui" : "", lon, lat });
  };
  const eq = c.equipments?.features ?? [];
  for (const f of eq.filter((f) => f.properties?.category === "marche")) {
    const [lon, lat] = f.geometry.coordinates;
    pushLieu("Marché", String(f.properties?.name ?? "Marché"), frenchHours(f.properties?.opening_hours as string) || "jours et horaires à vérifier", lon, lat);
  }
  for (const s of c.stations?.stations ?? []) {
    const last = s.frequentation[s.frequentation.length - 1];
    // Halte de moins de 300 voyageurs par jour : pas un lieu de tractage.
    if (last && last.voyageurs / 365 < GARE_MIN_JOUR) continue;
    pushLieu("Gare", s.nom, last ? perDay(last.voyageurs) : "fréquentation n.d.", s.lon, s.lat);
  }
  // Supermarchés : BPE (INSEE) si disponible, plus complète que OpenStreetMap.
  const singular = (t: string) => (t === "A128" ? "France Services" : BPE_TYPES[t].label.replace(/s$/, "")).replace(/^Bureaux/, "Bureau").replace(/^Agences/, "Agence").replace(/^Hypermarché$/, "Hypermarché").replace(/^Supermarché$/, "Supermarché");
  // Noms de la BPE souvent en capitales ou raisons sociales (« SOC DE COMMERCE LAMENTINOIS ») :
  // nom remis en forme, ou type d'équipement et adresse quand le nom n'apprend rien.
  const tidy = (t: string) => (/[a-zà-ÿ]/.test(t) ? t : prettyAdr(t).replace(/^./, (c) => c.toUpperCase()));
  const legalName = (n: string) => /\b(SOC|STE|SOCIETE|SAS|SARL|SA|SNC|EURL|SCI|DISTRIBUTION|DISTRIB)\b/i.test(n) || /^(APE|ALE|PFS|BP)\b/i.test(n);
  const bpeName = (e: { nom: string; type: string; adresse: string }) => {
    const adr = e.adresse ? tidy(e.adresse) : "";
    if (!e.nom || legalName(e.nom)) return `${singular(e.type)}${adr ? ` (${adr})` : ""}`;
    // Bureaux de poste : « Annonay Levert Bp » → « Bureau de poste Levert ».
    if (/(^|\s)(bp|lp)$|^(bp|lp)\s/i.test(e.nom.trim())) {
      const norm = (x: string) => x.toLowerCase().replace(/[-'’]/g, " ").replace(/\s+/g, " ").trim();
      const rest = norm(e.nom).replace(/(^|\s)(bp|lp)(\s|$)/g, " ").replace(norm(commune.nom), " ").trim();
      return `Bureau de poste${rest ? ` ${rest.replace(/(^|\s)\S/g, (m) => m.toUpperCase())}` : ""}${adr ? ` (${adr})` : ""}`;
    }
    return `${tidy(e.nom).replace(/\s+-\s+/g, " – ")}${adr ? ` (${adr})` : ""}`;
  };
  if (c.bpe) for (const e of c.bpe.commune.filter((e) => e.type === "B105" || e.type === "B104")) pushLieu("Supermarché", bpeName(e), e.type === "B104" ? "hypermarché" : "", e.lon, e.lat);
  for (const e of c.bpe?.commune.filter((e) => ["A122", "A128", "A206"].includes(e.type)) ?? []) pushLieu("Service public", bpeName(e), singular(e.type), e.lon, e.lat);
  for (const f of c.bpe ? [] : eq.filter((f) => f.properties?.category === "alimentaire" && (f.properties?.shop === "supermarket" || f.properties?.shop == null))) {
    const [lon, lat] = f.geometry.coordinates;
    if (!f.properties?.name || /^(total|esso|bp|shell|avia)\b/i.test(String(f.properties.name))) continue;
    pushLieu("Supermarché", String(f.properties.name), frenchHours(f.properties?.opening_hours as string), lon, lat);
  }
  // Un même site accueille souvent plusieurs établissements (lycée général, lycée professionnel,
  // collège) : une seule sortie à tenir, regroupée par nom de base ou par position (~100 m).
  const sites = new Map<string, { base: string; kinds: Set<string>; s: (typeof schoolsList)[number]; ep: string | null; pub: boolean; n: number }>();
  const schoolsList = (c.schools?.schools ?? []).filter((s) => /coll[èe]ge|lyc[ée]e/i.test(s.type) && !/^section/i.test(s.nom));
  const baseName = (n: string) =>
    n
      .replace(/^(cit[ée] scolaire|lyc[ée]e|coll[èe]ge)((\s+|-)(professionn?el|polyvalent|g[ée]n[ée]ral|technologique|agricole|industriel|mixte|priv[ée]|public|hors contrat|et))*\s*/i, "")
      .trim();
  const near = (a: { lon: number | null; lat: number | null }, b: { lon: number | null; lat: number | null }) =>
    a.lon == null || a.lat == null || b.lon == null || b.lat == null || haversineKm([a.lon, a.lat], [b.lon, b.lat]) <= 0.3;
  let k = 0;
  for (const s of schoolsList) {
    // Nom de base exploitable (« Mireille Grenet ») ; sinon le nom complet, pour ne rien fusionner à tort.
    const b0 = baseName(s.nom);
    const base = b0.length >= 4 && /[a-zà-ÿ]{3}/i.test(b0) && !/^\(.*\)$/.test(b0) ? b0 : s.nom;
    const ep = s.priorite && !/^non$/i.test(s.priorite) ? s.priorite : null;
    // Même site : même nom de base et à moins de 300 m (ou position inconnue).
    const hit = [...sites.values()].find((v) => v.base.toLowerCase() === base.toLowerCase() && near(v.s, s));
    if (hit) {
      hit.kinds.add(s.type.toLowerCase());
      hit.ep ??= ep;
      hit.pub ||= /public/i.test(s.statut);
      hit.n++;
    } else sites.set(String(k++), { base, kinds: new Set([s.type.toLowerCase()]), s, ep, pub: /public/i.test(s.statut), n: 1 });
  }
  for (const v of sites.values()) {
    const kinds = [...v.kinds].sort();
    const nom = v.n > 1 ? `${cap(v.base)} (${kinds.join(" et ")})` : v.s.nom;
    const type = kinds.length > 1 ? `Sortie de ${kinds.join(" et ")}` : `Sortie de ${kinds[0]}`;
    pushLieu(type, nom, v.ep ? `éducation prioritaire (${v.ep})` : v.pub ? "Public" : v.s.statut, v.s.lon, v.s.lat);
  }
  if (centroids.size && prioSet.size) {
    // Marchés, gares, services publics et établissements scolaires attirent toute la commune :
    // ils sont gardés même hors des bureaux prioritaires ; les commerces, seulement dans ceux-ci.
    const keep = lieux.filter((l) => l.prioritaire || l.type !== "Supermarché");
    lieux.length = 0;
    lieux.push(...keep);
  }
  if (lieux.length) {
    const order = ["Marché", "Gare", "Supermarché", "Service public", "Sortie de collège", "Sortie de collège et lycée", "Sortie de lycée"];
    lieux.sort((a, b) => (b.prioritaire ? 1 : 0) - (a.prioritaire ? 1 : 0) || order.indexOf(a.type) - order.indexOf(b.type) || a.bv.localeCompare(b.bv));
    out.tables.push({
      id: "lfi_lieux",
      title: "Lieux d'action : marchés, gares, commerces, établissements scolaires",
      theme: "strategie",
      columns: [
        { key: "type", label: "Type" },
        { key: "nom", label: "Nom" },
        { key: "infos", label: "Horaires / fréquentation" },
        ...(centroids.size ? [{ key: "bv", label: "Bureau le plus proche" }, { key: "prioritaire", label: "BV prioritaire" }] : []),
      ],
      rows: lieux.slice(0, 30).map(({ type, nom, infos, bv, prioritaire }) => ({ type, nom, infos, bv, prioritaire })),
      sources: [c.equipments?.source, c.stations?.source, c.schools?.source].filter(Boolean) as SourceRef[],
      note: "Horaires issus d'OpenStreetMap lorsqu'ils sont renseignés : à vérifier auprès de la mairie. Fréquentation des gares : SNCF Open Data.",
    });
  }

  // Actions recommandées, regroupées par type de lieu (comme dans les fiches de référence).
  const groupes = c.interne.groupes.filter((g) => g.code === commune.code || (commune.epci && referentiel().epcis.find((e) => e.code === commune.epci!.code)?.membres.some((m) => m.code === g.code)));
  const actionGroups: { title: string; hint?: string; items: string[] }[] = [];
  const nearSchools = (bv: string) =>
    (c.schools?.schools ?? [])
      .filter((s) => s.lon != null && centroids.has(bv))
      .map((s) => ({ s, d: haversineKm([s.lon!, s.lat!], centroids.get(bv)!) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .map((x) => x.s.nom);
  if (prio.length) {
    actionGroups.push({
      title: "Porte-à-porte",
      hint: "priorité",
      items: prio.map((p) => {
        const rawAdr = c.bvGeo?.points.find((f) => String(f.properties?.bv) === p.bv)?.properties?.adresse as string | undefined;
        // Adresses du REU en majuscules : « 14 PLACE DE LA FRATERNITE 48000 mende » → « 14 Place de la Fraternite, 48000 Mende ».
        const adr = rawAdr ? prettyAdr(rawAdr) : undefined;
        const ns = nearSchools(p.bv);
        const where = adr ? `lieu de vote : ${adr}` : ns.length ? `repères : ${ns.join(", ")}` : "";
        const q = quartierOf(p.bv);
        return `${B(`BV ${dv(p.bv)}${labels.has(p.bv) ? ` — ${p.label}` : ""}`)}${q ? ` (${qName(q)})` : ""} : LFI ${pct(p.lfiPctIns)} des inscrits aux européennes${p.lfi2PctIns != null ? `, Mélenchon ${pct(p.lfi2PctIns)} en 2022` : ""} ; abstention ${pct(p.abstPct, 0)} (${fmtNumber(p.abstN)} abstentionnistes)${where ? ` ; ${where}` : ""}.`;
      }),
    });
    const reservoir = ranked.filter((b) => b.type === "reservoir_abstention" || b.type === "bastion_a_mobiliser").filter((b) => !prioSet.has(b.bv)).slice(0, 3);
    const abstItems = [`Inscription sur les listes électorales et mobilisation des abstentionnistes dans les bureaux prioritaires${abstMain?.dir === "superieur" ? ", où la marge de progression est la plus forte" : ""}.`];
    if (reservoir.length) abstItems.push(`Bureaux à abstention forte à couvrir ensuite : ${joinFr(reservoir.map((b) => `BV ${dv(b.bv)} (${pct(b.abstPct, 0)})`))}.`);
    actionGroups.push({ title: "Abstentionnistes et inscription", items: abstItems });
  }
  if (resPorte.length)
    actionGroups.push({
      title: "Résidences étudiantes et foyers de jeunes travailleurs",
      hint: "porte-à-porte",
      items: resPorte.map((r) => `${B(r.nom)} (${resType(r)}${r.logements ? `, ${fmtNumber(r.logements)} logements` : ""}) : ${r.adresse}${r.bv ? ` (bureau ${dv(r.bv)})` : ""}.`),
    });
  // Actions le week-end : marchés du samedi ou du dimanche (ou jour inconnu, à confirmer) ; ceux de semaine sont signalés à part.
  const marketsAll = lieux.filter((l) => l.type === "Marché");
  const markets = marketsAll.filter((m) => openWeekend(m.infos) !== false);
  if (marketsAll.length) actionGroups.push({ title: "Marchés", items: marketsAll.slice(0, 5).map((m) => `${B(m.nom)} : ${m.infos}${openWeekend(m.infos) === false ? " (en semaine seulement : hors des actions du week-end)" : ""}${m.bv ? ` (${m.bv}${m.prioritaire ? ", prioritaire" : ""})` : ""}.`) });
  else if ((commune.population ?? 0) >= 2000) actionGroups.push({ title: "Marchés", items: ["Aucun marché recensé dans OpenStreetMap : jours, horaires et emplacements à demander à la mairie ou aux militants locaux, puis à ajouter dans « Lieux d'action signalés par les militants »."] });
  const gares = lieux.filter((l) => l.type === "Gare");
  const tt = (nom: string) => c.timetables?.stations.find((s) => s.nom === nom);
  if (gares.length)
    actionGroups.push({
      title: gares.length > 1 ? "Gares" : "Gare",
      items: [
        ...gares.map((g) => {
          const t = tt(g.nom);
          if (!t || !t.departs) return `${B(g.nom)} : ${g.infos}.`;
          const freq = t.departs >= 30 ? `un train toutes les ~${Math.max(5, Math.round((16 * 60) / t.departs / 5) * 5)} minutes en moyenne` : `${t.departs} passage${t.departs > 1 ? "s" : ""} un jour de semaine`;
          return `${B(g.nom)} : ${g.infos} ; ${freq}${t.paris ? ` ; Paris en ${fmtDuration(t.paris.minMinutes)} (trajets directs)` : ""}.`;
        }),
        `Le week-end : ${WEEKEND.gare.charAt(0).toLowerCase()}${WEEKEND.gare.slice(1)}.`,
      ],
    });
  const sup = lieux.filter((l) => l.type === "Supermarché");
  if (sup.length) actionGroups.push({ title: "Supermarchés", items: sup.slice(0, 5).map((s) => `${B(s.nom)}${s.infos ? ` : ${s.infos}` : ""}${s.bv ? ` (${s.bv})` : ""}.`) });
  // Services publics fermés le week-end, sauf la poste le samedi matin.
  const services = lieux.filter((l) => l.type === "Service public" && /poste/i.test(`${l.nom} ${l.infos}`));
  if (services.length) actionGroups.push({ title: "Bureaux de poste", hint: "ouverts le samedi matin", items: services.slice(0, 4).map((s) => `${B(s.nom)}${s.bv ? ` (${s.bv})` : ""}.`) });
  const implant: string[] = [];
  if (interneFourni && !groupes.length) implant.push("Aucun groupe d'action référencé : envisager la création d'un groupe local, encadré par un groupe voisin actif.");
  if (parrainsRatio && parrainsRatio.r1 < parrainsRatio.r2 * 0.8) implant.push("Prévoir l'encadrement des nouveaux sympathisants : un futur groupe serait majoritairement composé de personnes n'ayant pas encore parrainé.");
  if (implant.length) actionGroups.push({ title: "Implantation", items: implant });
  /* Plan d'action : un tableau court (où, quand, pourquoi) au lieu d'une liste de pistes. */
  // Chaque ligne dit où, pourquoi (chiffre à l'appui) et quand (créneau adapté au public visé).
  const plan: { action: string; ou: string; infos: string; quand: string; bv: string }[] = [];
  const lfiComExp = c24 ? (score("EU24", c24, "lfi")?.pctExprimes ?? null) : null;
  const abstWhen = prio[0]?.abstSrc === "LG24T1" ? " aux législatives 2024" : "";
  const hasHours = (x: string) => /\d+ h/.test(x);
  for (const p of prio)
    plan.push({
      action: "Porte-à-porte",
      ou: `Bureau ${dv(p.bv)}${labels.has(p.bv) ? ` — ${p.label}` : ""}${quartierOf(p.bv) ? ` (${quartierLabel(quartierOf(p.bv)!.nom)})` : ""}`,
      infos: `${fmtNumber(p.abstN)} inscrits n'ont pas voté${abstWhen} (${pp(p.abstPct)}) ; vote LFI à ${pp(p.lfiPctExp)}${lfiComExp != null ? `, contre ${pp(lfiComExp)} dans la commune` : ""}`,
      quand: WEEKEND.porte,
      bv: dv(p.bv),
    });
  for (const r of resPorte)
    plan.push({
      action: "Porte-à-porte",
      ou: `${r.nom} (${resType(r)}), ${r.adresse}`,
      infos: /foyer/i.test(resType(r))
        ? `${r.logements ? `${fmtNumber(r.logements)} logements de ` : ""}jeunes actifs, souvent peu inscrits sur les listes`
        : `${r.logements ? `${fmtNumber(r.logements)} logements étudiants` : "Logements étudiants"} : inscription sur les listes et mobilisation des jeunes`,
      quand: /foyer/i.test(resType(r)) ? WEEKEND.foyer : WEEKEND.crous,
      bv: r.bv ? dv(r.bv) : "",
    });
  for (const m of markets.slice(0, 2))
    plan.push({
      action: "Tractage au marché",
      ou: m.nom,
      infos: "Lieu de passage régulier des habitants du quartier",
      quand: hasHours(m.infos) ? `${cap(m.infos)} (matinée du week-end)` : WEEKEND.marche,
      bv: m.bv,
    });
  for (const g of gares.slice(0, 2)) {
    plan.push({
      action: "Tractage à la gare",
      ou: gareNom(g.nom),
      infos: /voyageurs/.test(g.infos) ? `${cap(g.infos)} en moyenne : départs et retours de week-end, étudiants` : "Départs et retours de week-end, étudiants",
      quand: WEEKEND.gare,
      bv: g.bv,
    });
  }
  const byPrio = <T extends { prioritaire: string }>(xs: T[]) => [...xs].sort((a, b) => Number(!!b.prioritaire) - Number(!!a.prioritaire));
  // Pas de sorties de collèges ni de lycées : les actions ont lieu le week-end.
  const serviceWhy = (x: string) =>
    /france travail|p[ôo]le emploi/i.test(x) ? "Demandeurs d'emploi en file d'attente" : /france services/i.test(x) ? "Habitants venus pour des démarches administratives" : /poste/i.test(x) ? "Public large, souvent âgé, en file d'attente" : "Public en file d'attente";
  for (const v of byPrio(services).slice(0, 1)) plan.push({ action: "Bureau de poste", ou: v.nom, infos: serviceWhy(`${v.nom} ${v.infos}`), quand: WEEKEND.poste, bv: v.bv });
  for (const v of byPrio(sup).slice(0, 1))
    plan.push({ action: "Supermarché", ou: v.nom, infos: `Forte fréquentation${/hyper/i.test(v.infos) ? " (hypermarché)" : ""}, tous publics`, quand: hasHours(v.infos) ? `Samedi 10 h – 12 h ou dimanche matin si ouvert (${v.infos})` : WEEKEND.supermarche, bv: v.bv });
  if (plan.length) {
    out.tables.push({
      id: "lfi_plan",
      title: "Plan d'action",
      theme: "strategie",
      columns: [
        { key: "action", label: "Action" },
        { key: "ou", label: "Où", wide: true },
        { key: "infos", label: "Pourquoi" },
        { key: "quand", label: "Quand" },
        { key: "bv", label: "Bureau" },
      ],
      rows: plan.slice(0, 10 + resPorte.length).map((r) => ({ ...r, bv: r.bv.replace(/^BV\s*/, "") })),
      highlight: plan.slice(0, 10 + resPorte.length).map((r, i) => (r.action === "Porte-à-porte" ? i : -1)).filter((i) => i >= 0),
      sources: [...(bvRef ? [bvRef.source] : []), ...(resPorte.length && c.residences ? [c.residences.source] : []), ...(c.bpe ? [c.bpe.source] : []), ...(c.schools ? [c.schools.source] : []), ...(c.stations ? [c.stations.source] : [])],
      note: "« Quand » : créneaux du week-end (samedi et dimanche), selon le public visé, à adapter avec les militants locaux ; horaires des marchés d'après OpenStreetMap, à confirmer. Le détail de toutes les pistes et de tous les lieux figure en annexe.",
    });
  }
  const lieuxMsg = [markets.length ? "au marché" : "", gares.length ? "à la gare (départs et retours de week-end)" : ""].filter(Boolean);
  const porteMsg = prio.length
    ? `porte-à-porte dans ${prio.length > 1 ? "les bureaux" : "le bureau"} ${joinFr(prio.map((p) => dv(p.bv)))} (${fmtNumber(prio.reduce((n, p) => n + p.abstN, 0))} électeurs inscrits qui n'ont pas voté)`
    : "";
  /* Résidences HLM (RPLS) : d'abord celles des bureaux prioritaires, puis les plus grandes. */
  const prioBvSet = new Set(prio.map((p) => p.bv));
  const hlmRank = [...hlm].filter((r) => r.logements >= 10).sort((a, b) => Number(!!(b.bv && prioBvSet.has(b.bv))) - Number(!!(a.bv && prioBvSet.has(a.bv))) || b.logements - a.logements);
  // Rues : résidences d'une même voie, rattachées au bureau qui regroupe le plus de leurs logements.
  const rues = hlmByStreet(hlm.filter((r) => r.logements >= 5)).map((r) => {
    const w = new Map<string, number>();
    for (const x of r.items) if (x.bv) w.set(x.bv, (w.get(x.bv) ?? 0) + x.logements);
    return { ...r, bv: [...w].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null };
  });
  const ruesRank = rues.filter((r) => r.logements >= 10).sort((a, b) => Number(!!(b.bv && prioBvSet.has(b.bv))) - Number(!!(a.bv && prioBvSet.has(a.bv))) || b.logements - a.logements);
  const hlmCols = [
    { key: "nom", label: "Résidence", wide: true },
    { key: "adresse", label: "Adresse" },
    { key: "logements", label: "Logements", align: "right" as const },
    ...(bvPolys.length ? [{ key: "bv", label: "Bureau de vote" }] : []),
  ];
  const hlmRow = (r: (typeof hlm)[number]) => ({ nom: r.nom === r.adresse ? "—" : r.nom, adresse: r.adresse, logements: fmtNumber(r.logements), bv: r.bv ? `${dv(r.bv)}${prioBvSet.has(r.bv) ? " (prioritaire)" : ""}` : "" });
  if (hlmRank.length && c.rpls) {
    // Fiche : rue par rue (« Allée Nicolas Copernic, n° 2 et 4 »), plus utile sur le terrain que des noms de programme.
    out.tables.push({
      id: "lfi_hlm",
      title: "Logements sociaux à cibler en porte-à-porte, rue par rue",
      theme: "strategie",
      columns: [
        { key: "rue", label: "Rue (numéros)", wide: true },
        { key: "nom", label: "Résidence" },
        { key: "logements", label: "Logements", align: "right" as const },
        ...(bvPolys.length ? [{ key: "bv", label: "Bureau de vote" }] : []),
      ],
      rows: ruesRank.slice(0, 8).map((r) => ({
        rue: `${r.voie}${r.nums.length ? ` (${numsLabel(r.nums)})` : ""}`,
        nom: r.noms.slice(0, 2).join(", ") || "—",
        logements: fmtNumber(r.logements),
        bv: r.bv ? `${dv(r.bv)}${prioBvSet.has(r.bv) ? " (prioritaire)" : ""}` : "",
      })),
      highlight: ruesRank.slice(0, 8).map((r, i) => (r.bv && prioBvSet.has(r.bv) ? i : -1)).filter((i) => i >= 0),
      sources: [c.rpls.source],
      note: `Logements des bailleurs sociaux (${fmtNumber(c.rpls.total)} dans la commune), regroupés par rue ; d'abord ceux des bureaux prioritaires. Liste par résidence en annexe.`,
    });
    out.tables.push({
      id: "lfi_hlm_tout",
      title: "Toutes les résidences de logements sociaux (10 logements et plus)",
      theme: "strategie",
      columns: hlmCols,
      rows: [...hlmRank].sort((a, b) => b.logements - a.logements).slice(0, 60).map(hlmRow),
      sources: [c.rpls.source],
      note: `Répertoire des logements locatifs des bailleurs sociaux${c.rpls.millesime ? ` (au 1er janvier ${c.rpls.millesime.slice(0, 4)})` : ""} : un logement par ligne, regroupés par nom de programme ou par adresse.${hlmRank.length > 60 ? ` 60 plus grandes résidences sur ${hlmRank.length}.` : ""}`,
    });
  }
  const resMsg = resPorte.length
    ? `, ${porteMsg ? "et " : ""}dans ${resPorte.length > 1 ? `les ${resPorte.length} résidences du Crous et foyers de jeunes travailleurs` : `la résidence ${resPorte[0].nom} (${resType(resPorte[0])})`}`
    : "";
  if (residences.length && c.residences)
    out.tables.push({
      id: "lfi_residences",
      title: "Résidences étudiantes et foyers de jeunes travailleurs",
      theme: "strategie",
      columns: [
        { key: "nom", label: "Nom", wide: true },
        { key: "type", label: "Type" },
        { key: "gestionnaire", label: "Gestionnaire" },
        { key: "logements", label: "Nombre de logements", align: "right" },
        { key: "adresse", label: "Adresse" },
      ],
      rows: residences.map((r) => ({ nom: r.nom, type: r.categorie, gestionnaire: r.gestionnaire, logements: r.logements != null ? fmtNumber(r.logements) : "n.d.", adresse: r.adresse })),
      highlight: residences.map((r, i) => (r.porte ? i : -1)).filter((i) => i >= 0),
      sources: [c.residences.source],
      note: "Toutes les résidences du catalogue situées dans la commune, par nombre de logements. En surbrillance : résidences du Crous et foyers de jeunes travailleurs, où le porte-à-porte est proposé systématiquement.",
    });
  const hlmTop = ruesRank.filter((r) => r.logements >= 40).slice(0, 2);
  const deVoie = (v: string) => {
    const low = v.charAt(0).toLowerCase() + v.slice(1);
    if (!/^(rue|avenue|allée|boulevard|place|chemin|impasse|square|cours|quai|route|résidence|cité|mail|esplanade|passage|sente|villa)\b/i.test(v)) return `de ${v}`;
    if (/^[aeiouyéèh]/i.test(v)) return `de l'${low}`;
    return `${/^(rue|place|résidence|cité|route|sente|villa)\b/i.test(v) ? "de la" : "du"} ${low}`;
  };
  const hlmMsg = hlmTop.length ? `, en commençant par les logements sociaux ${joinFr(hlmTop.map((r) => `${deVoie(r.voie)} (${fmtNumber(r.logements)} logements)`))}` : "";
  const planIntro =
    porteMsg || resMsg || lieuxMsg.length
      ? `${B("Priorité")} : ${porteMsg || resMsg ? `${porteMsg || "porte-à-porte"}${hlmMsg}${porteMsg ? resMsg : resMsg.replace(/^, /, " ")}${lieuxMsg.length ? `, complété par des tractages ${joinFr(lieuxMsg)}` : ""}` : `tractages ${joinFr(lieuxMsg)}`}.`
      : "";

  // Carte « affiche » : porte-à-porte et tractage sur fond de plan.
  const quandPlan = (ou: string) => plan.find((r) => r.ou === ou)?.quand;
  const affiche = communePoster(c, {
    prio,
    labels,
    dv,
    markets: markets.map((m) => ({ ...m, quand: quandPlan(m.nom) })),
    rues,
    hlmByBv,
    gares: (c.stations?.stations ?? []).filter((st) => { const l = st.frequentation[st.frequentation.length - 1]; return !l || l.voyageurs / 365 >= GARE_MIN_JOUR; }).map((st) => ({ nom: st.nom, infos: "", lon: st.lon, lat: st.lat, quand: quandPlan(gareNom(st.nom)), voyageurs: st.frequentation[st.frequentation.length - 1]?.voyageurs ?? null })),
  });
  if (affiche) out.maps.push(affiche);

  // Constats « piste » (traçabilité, synthèse du rapport complet).
  for (const g of actionGroups) addF({ kind: "piste", text: `${g.title} : ${g.items.join(" ")}`.replace(/\*\*/g, ""), evidence: [], weight: 70 });

  /* ================================================================ accessibilité */
  const access: string[] = [];
  if (c.stations?.stations.length) {
    const s = c.stations.stations;
    const names = s.map((x) => (/^gare\b/i.test(x.nom) ? x.nom : `gare de ${x.nom}`));
    access.push(joinFr(names));
  }
  const trainParis = c.timetables?.stations.map((s) => s.paris?.minMinutes).filter((x): x is number => x != null).sort((a, b) => a - b)[0];
  const road = (label: string) => c.routes?.routes.find((r) => r.label === label);
  const rPole = road("Pôle urbain le plus proche");
  const rParis = road("Paris");
  if (rPole) access.push(`${rPole.nom} à ${fmtDuration(rPole.minutes)} en voiture`);
  else if (nearestBig) access.push(`${nearestBig.nom} à ${fmtValue(nearestBig.distanceKm, "km")}`);
  for (const lab of ["Grande ville la plus proche", "Préfecture"]) {
    const r = road(lab);
    if (r) access.push(`${r.nom}${lab === "Préfecture" ? " (préfecture)" : ""} à ${fmtDuration(r.minutes)}`);
  }
  if (trainParis != null || rParis) access.push(`Paris à ${[trainParis != null ? `${fmtDuration(trainParis)} en train direct` : "", rParis ? `${fmtDuration(rParis.minutes)} en voiture` : ""].filter(Boolean).join(", ")}`);
  else if (c.parisKm != null && c.parisKm <= 250) access.push(`Paris à ${fmtValue(c.parisKm, "km")}`);
  const cy = get("km_amenagements_cyclables", geos.commune);
  if (cy && cy.value! >= 1) access.push(`${fmtValue(cy.value, "km")} d'aménagements cyclables`);

  /* ================================================================ en bref */
  const pop = popI;
  const evol = evolI;
  const pov = cmp("taux_pauvrete");
  const rev = cmp("revenu_median");
  const glance: Extract<Block, { type: "glance" }>["items"] = [];
  const tone = (dir?: string) => (dir === "superieur" ? "up" : dir === "inferieur" ? "down" : "neutral") as "up" | "down" | "neutral";
  // Chiffres clés : un seul chiffre par case, arrondi, comparé au département.
  if (pop)
    glance.push({
      label: "Habitants",
      value: fmtNumber(Math.round(pop.value! / 100) * 100),
      detail: evol ? (evol.value! <= -0.3 ? "population en baisse" : evol.value! >= 0.3 ? "population en hausse" : "population stable") : undefined,
    });
  if (pov) glance.push({ label: "Vivent sous le seuil de pauvreté", value: pp(pov.a.value), detail: `département : ${pp(pov.b.value)}`, tone: tone(pov.dir) });
  else if (rev) glance.push({ label: "Revenu médian par mois", value: `${fmtNumber(Math.round(rev.a.value! / 12 / 10) * 10)} €`, detail: `département : ${fmtNumber(Math.round(rev.b.value! / 12 / 10) * 10)} €`, tone: tone(rev.dir) });
  const l24 = c24 ? score("EU24", c24, "lfi") : null;
  const dl24 = d24 ? score("EU24", d24, "lfi") : null;
  const m22 = c22 ? score("PR22T1", c22, "lfi") : null;
  const dm22 = d22 ? score("PR22T1", d22, "lfi") : null;
  // Part des votes exprimés (le « score » au sens courant).
  if (l24) glance.push({ label: "Vote LFI aux européennes 2024", value: pp(l24.pctExprimes), detail: `département : ${pp(dl24?.pctExprimes)}`, tone: dl24 ? tone(gap(l24.pctExprimes, dl24.pctExprimes, "%").direction) : "neutral" });
  if (m22) glance.push({ label: "Vote Mélenchon à la présidentielle 2022", value: pp(m22.pctExprimes), detail: `département : ${pp(dm22?.pctExprimes)}`, tone: dm22 ? tone(gap(m22.pctExprimes, dm22.pctExprimes, "%").direction) : "neutral" });
  if (abstMain) glance.push({ label: `N'ont pas voté ${abstRef?.label ?? "aux européennes 2024"}`, value: pp(abstMain.c), detail: `département : ${pp(abstMain.d)}`, tone: tone(abstMain.dir) });
  if (parrains != null && parrains > 0) glance.push({ label: "Parrains et marraines", value: fmtNumber(parrains), detail: lfiVoix24 ? `pour ${fmtNumber(lfiVoix24)} électeurs LFI en 2024` : undefined, tone: parrainsRatio ? (parrainsRatio.r1 > parrainsRatio.r2 * 1.2 ? "up" : parrainsRatio.r1 < parrainsRatio.r2 * 0.8 ? "down" : "neutral") : "neutral" });
  if (prio.length && ranked.length > 3) glance.push({ label: prio.length > 1 ? "Bureaux de vote à cibler" : "Bureau de vote à cibler", value: joinFr(prio.map((p) => dv(p.bv))), detail: `sur ${ranked.length} bureaux` });

  // Non-inscription (estimation) : adultes français recensés et inscrits.
  const insc = buildInscription(c, ranked, dv, c24?.inscrits ?? null, d24?.inscrits ?? null);
  out.indicators.push(...insc.indicators);
  out.tables.push(...insc.tables);

  // Synthèse : des messages, pas des comparaisons statistiques.
  const synth: Item[] = [];
  // « Favorable » : nettement au-dessus du département ET au moins proche du niveau national
  // (6 % contre 4 % dans un département où LFI est faible n'est pas un terrain favorable).
  const cmp24 = l24 && dl24 ? voteCompare(l24.pctExprimes, dl24.pctExprimes) : null;
  const cmp22 = m22 && dm22 ? voteCompare(m22.pctExprimes, dm22.pctExprimes) : null;
  const lfiStrong = !!(cmp24?.net && cmp24.dir === "plus" && l24!.pctExprimes >= LFI_NATIONAL.EU24 * 0.9);
  const melStrong = !!(cmp22?.net && cmp22.dir === "plus" && m22!.pctExprimes >= LFI_NATIONAL.PR22T1 * 0.9);
  const lowAbove = !lfiStrong && !melStrong && cmp24?.dir === "plus" && l24!.pctExprimes < LFI_NATIONAL.EU24 * 0.9;
  if (lfiStrong || melStrong) {
    const x = lfiStrong ? { c: l24!.pctExprimes, d: dl24!.pctExprimes, what: "aux européennes 2024", w: cmp24!.words } : { c: m22!.pctExprimes, d: dm22!.pctExprimes, what: "pour J.-L. Mélenchon en 2022", w: cmp22!.words };
    synth.push({ text: `${B("Un terrain favorable")} : on y vote ${x.w} pour la France insoumise que dans le reste du département (${pp(x.c)} ${x.what}, contre ${pp(x.d)}).` });
  } else if (lowAbove)
    synth.push({ text: `${B("Un vote insoumis encore faible")} : ${pp(l24!.pctExprimes)} aux européennes 2024, ${cmp24!.words} que dans le département (${pp(dl24!.pctExprimes)}) mais loin du niveau national (${pp(LFI_NATIONAL.EU24)}).` });
  else if (perfMain?.dir === "superieur" && (!l24 || l24.pctExprimes >= LFI_NATIONAL.EU24 * 0.9))
    // Cohérent avec « En bref » : si l'écart au département est faible, on le dit.
    synth.push({ text: cmp24 && !cmp24.net ? `${B("Un terrain plutôt favorable")} : on y vote davantage pour la France insoumise que dans les villes de même taille du département, mais à peu près comme dans l'ensemble du département.` : `${B("Un terrain favorable")} : on y vote davantage pour la France insoumise que dans les villes de même taille du département.` });
  else if (l24 && dl24 && m22 && dm22 && l24.pctExprimes < dl24.pctExprimes * 0.85 && m22.pctExprimes >= dm22.pctExprimes * 0.95)
    // Faible aux européennes, mais au niveau du département à la présidentielle : un électorat qui se mobilise surtout pour la présidentielle.
    synth.push({ text: `${B("Un vote insoumis à réveiller")} : faible aux européennes 2024 (${pp(l24.pctExprimes)}, contre ${pp(dl24.pctExprimes)} dans le département), mais ${m22.pctExprimes >= dm22.pctExprimes * 1.05 ? "plus fort" : "au même niveau"} qu'ailleurs pour J.-L. Mélenchon en 2022 (${pp(m22.pctExprimes)}).` });
  else if (perfMain?.dir === "inferieur" || (l24 && dl24 && l24.pctExprimes < dl24.pctExprimes * 0.85))
    synth.push({ text: `${B("Un terrain difficile")} : on y vote moins pour la France insoumise que dans le reste du département ${l24 && dl24 ? `(${pp(l24.pctExprimes)} aux européennes 2024, contre ${pp(dl24.pctExprimes)}${m22 && dm22 ? ` ; ${pp(m22.pctExprimes)} pour J.-L. Mélenchon en 2022, contre ${pp(dm22.pctExprimes)}` : ""})` : ""}.` });
  if (abstMain?.dir === "superieur")
    synth.push({ text: `${B("Des électeurs à aller chercher")} : ${oneInV(abstMain.c, "électeur", "n'a pas voté", "n'ont pas voté")} ${abstRef?.label ?? "aux européennes 2024"}${cL ? ", un scrutin pourtant très suivi" : ""} (${pp(abstMain.c)}, contre ${pp(abstMain.d)} dans le département).` });
  if (insc.ficheText && insc.commune) synth.push({ text: `${B(insc.ficheText.startsWith("**Des jeunes") ? "Des jeunes à inscrire" : "Des habitants à inscrire")} : environ ${fmtNumber(Math.round(insc.commune.ecart / 100) * 100)} adultes de nationalité française absents des listes de la commune.` });
  if (parrainsRatio && parrainsRatio.r1 < parrainsRatio.r2 * 0.8) synth.push({ text: `${B("Peu de soutiens déclarés")} au regard du vote : il faudra accueillir et encadrer de nouveaux militants.` });
  else if (interneFourni && !groupes.length) synth.push({ text: `${B("Pas encore de groupe d'action")} dans la commune ni aux alentours : tout est à construire.` });
  if (prio.length && ranked.length <= 3) synth.push({ text: `${B("Où aller en priorité")} : toute la commune (${ranked.length} ${ranked.length > 1 ? "bureaux" : "bureau"} de vote), en commençant par le bureau ${dv(prio[0].bv)}${labels.has(prio[0].bv) ? ` (${prio[0].label})` : ""}.` });
  else if (prio.length) synth.push({ text: `${B("Où aller en priorité")} : ${prio.length > 1 ? "les bureaux de vote" : "le bureau de vote"} ${joinFr(prio.map((p) => `${dv(p.bv)}${labels.has(p.bv) ? ` (${p.label})` : ""}`))}.` });
  // Lieux nommés, avec jour et heure quand on les connaît ; rien de générique (sinon la ligne est omise).
  const lieuBv = (l: { lon: number | null; lat: number | null }) => {
    const nb = nearestBv(l.lon, l.lat);
    if (!nb) return "";
    const q = quartierOf(nb.bv);
    return q ? ` ${leQuartier(q).replace(/^(le|la|les|l')\s?/i, (m) => `dans ${m}`)}` : labels.has(nb.bv) ? `, près de ${labels.get(nb.bv)} (bureau ${dv(nb.bv)})` : ` (bureau ${dv(nb.bv)})`;
  };
  const named = (n: string) => !/^(march[ée]|supermarch[ée]|gare)$/i.test(n.trim());
  const weHours = (h: string) =>
    h
      .split(" ; ")
      .filter((p) => /samedi|dimanche|tous les jours/i.test(p))
      .join(" ; ");
  const leviers = [
    ...markets.slice(0, 2).map((m) => {
      const h = weHours(m.infos);
      const where = named(m.nom) ? m.nom : `le marché${lieuBv(m)}`;
      return h ? `${where} (${h})` : named(m.nom) ? `${where} (jour du week-end à confirmer)` : "";
    }),
    ...gares.slice(0, 1).map((g) => `${gareNom(g.nom)}${/voyageurs/.test(g.infos) ? ` (${g.infos})` : ""}, le samedi matin ou le dimanche soir`),
    ...byPrio(sup.filter((v) => named(v.nom))).slice(0, 1).map((v) => `${v.nom}, le samedi matin`),
    ...byPrio(services).slice(0, 1).map((v) => `${v.nom}, le samedi matin`),
  ].filter(Boolean);
  if (leviers.length) synth.push({ text: `${B("Où croiser les habitants le week-end")} : ${leviers.join(" ; ")}.` });

  /* ================================================================ contexte municipal */
  let municipalText = "";
  const m = c.municipal;
  if (m) {
    const nu = (code: string) => NUANCES[code] ?? code;
    const maj = m.majorite;
    const t1 = m.rounds.find((r) => r.tour === 1);
    const t2 = m.rounds.find((r) => r.tour === 2);
    const majT1 = maj && t1 ? t1.listes.find((l) => sameList(l, maj)) : null;
    const majT2 = maj && t2 ? t2.listes.find((l) => sameList(l, maj)) : null;
    const parts: string[] = [];
    if (maj) {
      const fam = nuanceFamily(maj.nuance);
      parts.push(
        `${m.ville ? `${B(`À l'échelle de la ville de ${m.ville}`)} (résultats de l'arrondissement non publiés séparément) : ` : ""}${B(`${m.ville ? "la ville" : "La commune"} est dirigée par ${m.maire ? `${m.maire.prenom} ${m.maire.nom}` : maj.tete}`)}${maj.nuance ? ` (${nu(maj.nuance)}${fam === "gauche" ? ", mairie de gauche" : ""})` : ""} : sa liste « ${maj.libelle} » a obtenu ${majT1 ? `${pct(majT1.pctExprimes, 0)} des voix au 1er tour des municipales 2026${t2 ? "" : " (élection dès le 1er tour)"}` : "la majorité aux municipales 2026"}${majT2 && majT1 ? ` et ${pct(majT2.pctExprimes, 0)} au 2nd tour` : majT2 ? ` : ${pct(majT2.pctExprimes, 0)} des voix au 2nd tour` : ""}.`,
      );
      const last = t2 ?? t1;
      const left = last?.listes.filter((l) => !sameList(l, maj) && nuanceFamily(l.nuance) === "gauche") ?? [];
      if (left.length && nuanceFamily(maj.nuance) !== "gauche")
        parts.push(`Liste${left.length > 1 ? "s" : ""} de gauche battue${left.length > 1 ? "s" : ""} : ${left.map((l) => `« ${l.libelle} » (${nu(l.nuance)}, ${pct(l.pctExprimes, 0)})`).join(", ")}.`);
      if (!last?.listes.some((l) => nuanceFamily(l.nuance) === "gauche")) parts.push("Aucune liste de gauche au tour décisif.");
      if (last && last.listes.length === 1) parts.push("Liste unique : élection sans opposition.");
    } else if (m.maire) parts.push(`Maire : ${B(`${m.maire.prenom} ${m.maire.nom}`)} (commune sans scrutin de liste).`);
    municipalText = parts.join(" ");
    if (m.rounds.some((r) => r.listes.length)) {
      // Listes rapprochées d'un tour à l'autre (tête de liste, sinon libellé).
      const lists: { a?: MunicipalList; b?: MunicipalList }[] = [];
      for (const l of t1?.listes ?? []) lists.push({ a: l });
      for (const l of t2?.listes ?? []) {
        const hit = lists.find((x) => x.a && !x.b && sameList(x.a, l));
        if (hit) hit.b = l;
        else lists.push({ b: l });
      }
      out.tables.push({
        id: "lfi_municipales",
        title: "Élections municipales 2026",
        theme: "strategie",
        columns: [
          { key: "liste", label: "Liste (tête de liste)", wide: true },
          { key: "nuance", label: "Nuance" },
          { key: "t1", label: "1er tour (% exprimés)", align: "right" },
          ...(t2 ? [{ key: "t2", label: "2nd tour (% exprimés)", align: "right" as const }] : []),
          { key: "sieges", label: "Sièges au conseil", align: "right" },
        ],
        rows: lists.map(({ a, b }) => {
          const any = (b ?? a)!;
          const tete = b?.tete || a?.tete || "";
          return { liste: `${any.libelle || "—"}${tete ? ` (${tete})` : ""}`, nuance: nu(any.nuance), t1: a ? pct(a.pctExprimes) : "", t2: b ? pct(b.pctExprimes) : "", sieges: (b?.sieges ?? a?.sieges) ?? "" };
        }),
        highlight: maj ? [lists.findIndex((x) => (x.b && sameList(x.b, maj)) || (x.a && sameList(x.a, maj)))] : [],
        sources: [m.source],
        note: "Résultats définitifs par commune (ministère de l'Intérieur) ; nuances attribuées par les préfectures. Maire : Répertoire national des élus.",
      });
    }
  }
  // Groupes d'action : description enrichie (export Action Populaire).
  const groupeText = (g: (typeof groupes)[number]) => {
    const meta = [
      g.creation ? `créé ${/^\d{4}-\d{2}-\d{2}/.test(g.creation) ? `le ${new Date(g.creation).toLocaleDateString("fr-FR")}` : g.creation}` : "",
      g.membres != null ? `${g.membres} membre${g.membres > 1 ? "s" : ""}` : "",
      g.type ?? "",
      g.certifie === true ? "certifié" : g.certifie === false ? "non certifié" : "",
      g.actions != null ? `${g.actions} action${g.actions > 1 ? "s" : ""} référencée${g.actions > 1 ? "s" : ""}` : "",
      g.derniereAction ? `dernière action : ${g.derniereAction}` : "",
      g.statut,
    ].filter(Boolean);
    return `${B(`« ${g.nom} »`)}${g.code !== commune.code ? ` (${referentiel().communes.find((x) => x.code === g.code)?.nom ?? g.code})` : ""}${meta.length ? ` — ${meta.join(", ")}` : ""}.${g.description ? ` ${g.description.replace(/\.?$/, ".")}` : ""}`;
  };

  /* ================================================================ section */
  if (!out.tables.length && !socio.length) return out;
  const blocks: Block[] = [];
  /** Annexe de la fiche (diagnostic complet) : ce qui aide à choisir mais ne porte pas le message. */
  const detail: Block[] = [];
  const has = (t: string) => out.tables.some((x) => x.id === t);
  blocks.push({
    type: "callout",
    tone: "warning",
    text: `Le ciblage présenté ci-dessous s'appuie uniquement sur l'exploitation de données statistiques et électorales publiques agrégées (commune, bureau de vote), par des personnes qui ne vivent pas forcément ${commune.nom ? aNom(commune.nom) : "sur place"}. ${B("Les informations suggérées doivent être confrontées à la connaissance du terrain des militantes et militants locaux.")}`,
  });
  if (glance.length >= 3) blocks.push({ type: "glance", items: glance });
  if (synth.length) blocks.push({ type: "list", items: synth });
  blocks.push({
    type: "note",
    text: "Pour lire cette fiche : les chiffres sont arrondis. Les votes sont donnés en part des voix (hors blancs et nuls) ; « n'ont pas voté » désigne les électeurs inscrits qui se sont abstenus. Seuil de pauvreté : environ 1 150 € par mois pour une personne seule. Chaque électeur vote dans un bureau de vote : c'est l'échelle la plus fine des résultats, celle du porte-à-porte.",
  });
  blocks.push({ type: "fieldNotes" });

  blocks.push({ type: "heading", text: "Profil sociodémographique du territoire" });
  if (socioIntro.length) blocks.push({ type: "paragraph", text: socioIntro.join(" ") });
  if (has("lfi_socio")) blocks.push({ type: "table", tableId: "lfi_socio" });
  // Quartier qui concentre la pauvreté : en tête des phrases qualitatives (3 au plus).
  const poorQ = ids2.quartiers.map((id) => out.findings.find((f) => f.id === id)).find((f) => f?.kind === "constat" && /concentre la pauvreté/.test(f.text));
  const socioItems = [...(poorQ ? [{ text: poorQ.text, evidence: poorQ.evidence }] : []), ...socio].slice(0, 3);
  if (socioItems.length) blocks.push({ type: "list", items: socioItems });
  blocks.push({ type: "fieldNotes", part: "socio" });

  blocks.push({ type: "heading", text: "Profil politique du territoire" });
  // En bref, en langage courant : vote insoumis, participation, mairie.
  {
    const parts: string[] = [];
    if (l24 && dl24) {
      // Même règle que la synthèse (voteCompare) : jamais « autant » ici et « nettement plus » plus haut.
      const v24 = voteCompare(l24.pctExprimes, dl24.pctExprimes);
      const w2 = v24.words;
      // Les deux scrutins ne disent pas toujours la même chose : on le signale plutôt que de juxtaposer les chiffres.
      const d22 = m22 && dm22 ? voteCompare(m22.pctExprimes, dm22.pctExprimes).dir : null;
      const sameWay = !d22 || d22 === v24.dir;
      const p22 = m22 && dm22 ? `${pp(m22.pctExprimes)} pour J.-L. Mélenchon en 2022 (département : ${pp(dm22.pctExprimes)})` : "";
      parts.push(
        sameWay
          ? `On y vote ${B(`${w2} pour la France insoumise`)} que dans le reste du département : ${pp(l24.pctExprimes)} des voix aux européennes 2024 (département : ${pp(dl24.pctExprimes)})${p22 ? `, ${p22}` : ""}.`
          : `Aux européennes 2024, on y vote ${B(`${w2} pour la France insoumise`)} que dans le reste du département (${pp(l24.pctExprimes)} des voix, contre ${pp(dl24.pctExprimes)}) ; ${d22 === "autant" ? "l'écart disparaît" : v24.dir === "autant" ? `on y vote ${d22} qu'ailleurs` : "c'est l'inverse"} à la présidentielle 2022 : ${p22}.`,
      );
    }
    if (abstMain)
      parts.push(
        abstMain.dir === "superieur"
          ? `${cap(oneInV(abstMain.c, "électeur", "n'a pas voté", "n'ont pas voté"))} ${abstRef?.label ?? "en 2024"}, ${B("plus qu'ailleurs")} : il y a des électeurs à remobiliser.`
          : abstMain.dir === "inferieur"
            ? `On y vote plus qu'ailleurs : ${oneInV(abstMain.c, "électeur", "n'a pas voté", "n'ont pas voté")} en 2024 (département : ${pp(abstMain.d)}).`
            : `${cap(oneInV(abstMain.c, "électeur", "n'a pas voté", "n'ont pas voté"))} ${abstRef?.label ?? "en 2024"}, comme dans le reste du département.`,
      );
    if (parts.length) {
      const t = parts.join(" ");
      blocks.push({ type: "paragraph", text: `${B("En bref")} : ${t.charAt(0).toLowerCase()}${t.slice(1)}` });
    }
  }
  if (groupes.length)
    blocks.push({
      type: "callout",
      tone: "accent",
      title: groupes.length > 1 ? `${groupes.length} groupes d'action` : "Groupe d'action",
      text: groupes.map(groupeText).join("\n"),
    });
  else if (interneFourni) blocks.push({ type: "callout", tone: "accent", text: `${B("Aucun groupe d'action n'est référencé")} dans la commune ni dans son intercommunalité.` });
  // (Sans données internes : rien dans la fiche, qui s'adresse aux élus ; le signalement figure dans le journal de collecte.)
  const prose = (list: string[]) => list.length && blocks.push({ type: "findings", ids: list, style: "prose" });
  // Un tableau, puis 3 phrases au plus : mairie, quartiers où LFI surperforme, parrainages.
  if (out.charts.some((x) => x.id === "lfi_chart_eu24")) blocks.push({ type: "chart", chartId: "lfi_chart_eu24" });
  if (has("lfi_vote")) blocks.push({ type: "table", tableId: "lfi_vote" });
  if (municipalText) blocks.push({ type: "paragraph", text: municipalText.split(/(?<=\.)\s+(?=[A-ZÀ-Ý«])/).slice(0, 2).join(" "), evidence: [] });
  prose([...ids2.quartiers.filter((id) => out.findings.find((f) => f.id === id)?.kind === "atout"), ...ids.parrains].slice(0, 2));
  blocks.push({ type: "fieldNotes", part: "politique" });
  // Détail (annexe du diagnostic) : résultats municipaux, comparaisons, forces politiques.
  if (has("lfi_politique")) detail.push({ type: "heading", text: "Vote LFI, parrainages et abstention (en nombre de voix)" }, { type: "table", tableId: "lfi_politique" });
  if (has("lfi_municipales")) detail.push({ type: "heading", text: "Élections municipales 2026" }, { type: "table", tableId: "lfi_municipales" });
  if (ids.perf.length || ids.abst.length || ids.partis.length) {
    detail.push({ type: "heading", text: "Vote insoumis, participation et forces politiques" });
    detail.push({ type: "findings", ids: [...ids.perf, ...ids.abst, ...ids.partis], style: "prose" });
  }
  if (has("lfi_partis")) detail.push({ type: "table", tableId: "lfi_partis" });

  blocks.push({ type: "heading", text: "Où agir : analyse par bureau de vote" });
  const kindOf = (id: string) => out.findings.find((f) => f.id === id)?.kind;
  const ouMain = ids.ou.filter((id) => kindOf(id) === "atout");
  const ouEvo = ids.ou.filter((id) => /Évolution/.test(out.findings.find((f) => f.id === id)?.text ?? ""));
  if (has("lfi_bureaux")) {
    prose(ouMain.slice(0, 1));
    if (out.maps.some((m) => m.id === "lfi_map_bv_participation")) blocks.push({ type: "mapPair", mapIds: ["lfi_map_bv", "lfi_map_bv_participation"], title: abstBvLabel === "2024" ? `Vote insoumis (à gauche) et participation (à droite) par bureau de vote aux européennes 2024 : plus la couleur est rouge, plus le chiffre est élevé` : `Vote insoumis aux européennes 2024 (à gauche) et participation aux législatives 2024 (à droite), par bureau de vote : plus la couleur est rouge, plus le chiffre est élevé` });
    else blocks.push({ type: "map", mapId: "lfi_map_bv" });
    if (has("lfi_bureaux_prio")) blocks.push({ type: "table", tableId: "lfi_bureaux_prio" });
    if (insc.ficheText) blocks.push({ type: "paragraph", text: insc.ficheText });
    prose(ouEvo.slice(0, 1));
    // Détail : classement complet, présidentielle 2022, évolution par bureau.
    detail.push({ type: "heading", text: "Classement de tous les bureaux de vote" });
    detail.push({ type: "table", tableId: "lfi_bureaux" }, { type: "chart", chartId: "lfi_chart_bureaux" });
    if (out.maps.some((m) => m.id === "lfi_map_bv_p22")) detail.push({ type: "mapPair", mapIds: ["lfi_map_bv_p22", "lfi_map_bv_p22_participation"], title: "Vote Mélenchon (à gauche) et participation (à droite) par bureau de vote, présidentielle 2022 (1er tour)" });
    const rest = ids.ou.filter((id) => !ouMain.slice(0, 1).includes(id) && !ouEvo.slice(0, 1).includes(id));
    if (rest.length) detail.push({ type: "findings", ids: rest, style: "prose" });
    if (has("lfi_evolution")) detail.push({ type: "table", tableId: "lfi_evolution" });
  } else blocks.push({ type: "note", text: "Résultats par bureau de vote indisponibles lors de la génération." });
  // Deux pistes à vérifier au plus ; les autres hypothèses passent en annexe.
  const hypQ = ids2.quartiers.filter((id) => kindOf(id) === "hypothese");
  const hyps = [...hypQ, ...ids.hyp];
  if (hyps.length) {
    blocks.push({ type: "paragraph", text: `${B("Questions pour le terrain")} :` });
    const fs = hyps.slice(0, 2).map((id) => out.findings.find((f) => f.id === id)!).filter(Boolean);
    blocks.push({ type: "list", items: fs.map((f) => ({ text: f.text, evidence: f.evidence })) });
  }
  const otherHyps = [...hyps.slice(2), ...ids.spread];
  if (otherHyps.length) detail.push({ type: "heading", text: "Autres questions à vérifier" }, { type: "findings", ids: otherHyps, style: "prose" });
  if (has("lfi_quartiers")) detail.push({ type: "heading", text: "Profil des quartiers" }, { type: "table", tableId: "lfi_quartiers" });
  if (has("lfi_inscription")) detail.push({ type: "heading", text: "Inscription sur les listes électorales" }, ...(insc.commune ? [{ type: "paragraph" as const, text: `Environ ${fmtNumber(Math.round(insc.commune.adultesFr / 100) * 100)} adultes de nationalité française recensés pour ${fmtNumber(insc.commune.inscrits)} électeurs inscrits, soit ${Math.round(insc.commune.taux)} inscrits pour 100 adultes${insc.departement ? ` (département : ${Math.round(insc.departement.taux)})` : ""}.` }] : []), { type: "table", tableId: "lfi_inscription" });
  if (c.emploi?.commune.length) detail.push({ type: "heading", text: "Demandeurs d'emploi" }, { type: "table", tableId: "table_demandeurs" }, { type: "chart", chartId: "chart_demandeurs" });

  blocks.push({ type: "heading", text: "Actions recommandées" });
  if (planIntro) blocks.push({ type: "paragraph", text: planIntro });
  if (affiche) blocks.push({ type: "map", mapId: "lfi_affiche" });
  if (has("lfi_plan")) blocks.push({ type: "table", tableId: "lfi_plan" });
  if (has("lfi_hlm")) blocks.push({ type: "table", tableId: "lfi_hlm" });
  else blocks.push({ type: "note", text: "Aucun lieu d'action identifié automatiquement (marchés, gares, commerces, établissements) : à compléter avec les militants locaux." });
  if (access.length) blocks.push({ type: "paragraph", text: `${B("Accès")} : ${access.join(" ; ")}${c.routes || c.timetables ? " (temps théoriques, sans trafic)" : " (distances à vol d'oiseau)"}.` });
  // Détail : toutes les pistes et tous les lieux repérés.
  if (actionGroups.length) detail.push({ type: "heading", text: "Toutes les pistes d'action" }, { type: "actions", groups: actionGroups });
  if (has("lfi_lieux")) detail.push({ type: "table", tableId: "lfi_lieux" });
  if (has("lfi_hlm_tout")) detail.push({ type: "heading", text: "Logements sociaux" }, { type: "table", tableId: "lfi_hlm_tout" });
  if (has("lfi_residences")) detail.push({ type: "table", tableId: "lfi_residences" });
  blocks.push({ type: "fieldPlaces" });
  blocks.push({ type: "fieldNotes", part: "actions" });

  out.section = { id: "LFI", letter: "", title: "Fiche d'action — proposition de ciblage", blocks };
  if (detail.length) out.extra = [...(out.extra ?? []), { id: "LFI_DETAIL", letter: "", title: "Détail de la fiche d'action (bureaux, quartiers, lieux)", blocks: detail }];

  // Feuilles de porte-à-porte des bureaux prioritaires.
  const porte = buildPorte(c, ranked, labels, (bv) => {
    const raw = c.bvGeo?.points.find((f) => String(f.properties?.bv) === bv)?.properties?.adresse as string | undefined;
    return raw ? prettyAdr(raw) : "";
  }, dv);
  if (porte.section) {
    out.maps.push(...porte.maps);
    out.tables.push(...porte.tables);
    out.extra = [porte.section, ...(out.extra ?? [])];
    blocks.push({ type: "note", text: `${B("Feuilles de porte-à-porte")} : une page par bureau prioritaire (rues et numéros à couvrir) est jointe à la fiche et disponible en PDF séparé.` });
  }
  // Arrondissement de Paris, Lyon ou Marseille : « l'arrondissement » et la ville, pas « la commune » et « le département ».
  if (plm) plmWording(out, plm.ville);
  return out;
}

const PLM_WORDS: [RegExp, (v: string) => string][] = [
  [/C'est une commune/g, () => "C'est un arrondissement"],
  [/Ce qui distingue la commune/g, () => "Ce qui distingue l'arrondissement"],
  [/\b(de|dans|à) la commune\b/g, () => "$1 l'arrondissement"],
  [/\bla commune\b/g, () => "l'arrondissement"],
  [/\(commune :/g, () => "(arrondissement :"],
  [/que la moyenne du département \([^)]*\)/g, (v) => `que la moyenne de ${v}`],
  [/du département \([^)]*\)/g, (v) => `de ${v}`],
  [/le reste du département/g, (v) => `le reste de ${v}`],
  [/dans le département/g, (v) => `à ${v}`],
  [/\bdépartement :/g, (v) => `${v} :`],
];

function plmWording(out: LfiOutput, ville: string) {
  const fix = (t: string) => PLM_WORDS.reduce((x, [re, to]) => x.replace(re, to(ville)), t);
  for (const f of out.findings) f.text = fix(f.text);
  for (const t of out.tables) {
    t.title = fix(t.title);
    if (t.note) t.note = fix(t.note);
  }
  for (const sec of [out.section, ...(out.extra ?? [])]) {
    if (!sec) continue;
    for (const b of sec.blocks) {
      if (b.type === "paragraph" || b.type === "note" || b.type === "callout") b.text = fix(b.text);
      else if (b.type === "list") for (const it of b.items) it.text = fix(it.text);
      else if (b.type === "glance") for (const it of b.items) if (it.detail) it.detail = fix(it.detail);
    }
  }
}
