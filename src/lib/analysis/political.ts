/**
 * Analyse électorale orientée LFI — calculs déterministes et documentés.
 *
 * Entrées : résultats officiels agrégés (commune, département, bureaux de vote),
 * populations légales, données internes facultatives (parrainages par commune).
 * Sorties : scores par famille politique, sur/sous-performance, potentiel par
 * bureau de vote et priorités de terrain.
 *
 * Méthodes (rappelées dans le rapport) :
 *  - score en % des inscrits (mesure du volume mobilisé) et en % des exprimés ;
 *  - surperformance : écart du score LFI (% des inscrits) de la commune à la
 *    médiane des communes du département de taille comparable (population à ±50 %) ;
 *  - potentiel d'un bureau : moyenne de deux scores z calculés parmi les bureaux de
 *    la commune — part LFI des exprimés (« réservoir ») et taux d'abstention
 *    (« marge de mobilisation ») ; priorités par tiers de potentiel ;
 *  - aucune donnée individuelle ; aucune variable d'origine ou de nationalité.
 */
import { prettyFr } from "../format";
import type { BureauResult, ElectionResult } from "../collectors/elections";

export interface Family {
  id: string;
  label: string;
  /** Motif de reconnaissance du libellé de liste / candidat / nuance, par scrutin. */
  match: Record<string, RegExp>;
}

/**
 * Les fichiers du ministère donnent, selon le scrutin, le libellé complet de la
 * liste, son libellé abrégé ou sa nuance (européennes 2024 : LFI, LRN, LENS,
 * LUG, LVEC, LCOM, LLR, LREC…) : les motifs couvrent ces trois formes.
 */
export const FAMILIES: Family[] = [
  { id: "lfi", label: "LFI", match: { EU24: /^LFI\b|insoumise|aubry/i, PR22T1: /m[ée]lenchon/i, EU19: /^LFI\b|insoumise|aubry/i, PR17T1: /m[ée]lenchon/i } },
  { id: "nfp", label: "NFP (Union de la gauche)", match: { LG24T1: /^UG$|union de la gauche|nouveau front populaire/i } },
  { id: "pcf", label: "PCF", match: { EU24: /^LCOM$|gauche unie|deffontaines/i, PR22T1: /roussel/i, EU19: /^LCOM$|brossat|europe des gens|communiste/i } },
  { id: "ps", label: "PS / Place publique", match: { EU24: /^LUG$|r[ée]veil|glucksmann|place publique/i, PR22T1: /hidalgo/i, LG24T1: /^SOC$/i, EU19: /^LUG$|^LSOC$|envie d.europe|glucksmann|place publique/i, PR17T1: /hamon/i } },
  { id: "eco", label: "Écologistes", match: { EU24: /^LVEC$|^LECO$|europe [ée]cologie|^les [ée]cologistes|toussaint/i, PR22T1: /jadot/i, LG24T1: /^ECO$/i, EU19: /^LVEC$|^LECO$|europe [ée]cologie|jadot/i } },
  { id: "ens", label: "Ensemble (majorité présidentielle)", match: { EU24: /^LENS$|besoin d.europe|hayer/i, PR22T1: /macron/i, LG24T1: /^ENS$/i, EU19: /^LREM$|^LENS$|^LMDM$|renaissance|loiseau/i, PR17T1: /macron/i } },
  { id: "lr", label: "LR", match: { EU24: /^LLR$|bellamy|la droite pour/i, PR22T1: /p[ée]cresse/i, LG24T1: /^LR$/i, EU19: /^LLR$|^LUD$|union (de la )?droite|bellamy/i, PR17T1: /fillon/i } },
  { id: "rn", label: "RN (et alliés)", match: { EU24: /^LRN$|bardella|rassemblement national|france revient/i, PR22T1: /le pen/i, LG24T1: /^RN$|^UXD$/i, EU19: /^LRN$|prenez le pouvoir|bardella|rassemblement national/i, PR17T1: /le pen/i } },
  { id: "rec", label: "Reconquête", match: { EU24: /^LREC$|mar[ée]chal|reconqu[êe]te|france fi[èe]re/i, PR22T1: /zemmour/i, LG24T1: /^REC$/i } },
];

/** Scrutin de référence pour le score LFI, par ordre de préférence. */
export const LFI_ELECTIONS = ["EU24", "PR22T1"] as const;

interface Agg {
  inscrits: number;
  votants: number;
  exprimes: number;
  abstentions?: number;
  candidates: { label: string; voix: number }[];
}

export function familyVotes(electionId: string, a: Agg, familyId: string): number | null {
  const f = FAMILIES.find((x) => x.id === familyId);
  const re = f?.match[electionId];
  if (!re) return null;
  return a.candidates.filter((c) => re.test(c.label)).reduce((s, c) => s + c.voix, 0);
}

export interface Score {
  voix: number;
  pctInscrits: number;
  pctExprimes: number;
}

export function score(electionId: string, a: Agg, familyId: string): Score | null {
  const v = familyVotes(electionId, a, familyId);
  if (v == null || !a.inscrits) return null;
  return { voix: v, pctInscrits: (100 * v) / a.inscrits, pctExprimes: a.exprimes ? (100 * v) / a.exprimes : 0 };
}

export function abstention(a: Agg) {
  const n = a.abstentions ?? a.inscrits - a.votants;
  return { n, pct: a.inscrits ? (100 * n) / a.inscrits : 0 };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function zscores(values: number[]): number[] {
  const mean = values.reduce((s, v) => s + v, 0) / (values.length || 1);
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length || 1));
  return values.map((v) => (sd ? (v - mean) / sd : 0));
}

/**
 * Surperformance LFI : score de la commune (% inscrits) comparé à la médiane
 * des communes du département de population comparable (±50 %).
 */
export function lfiOverperformance(
  electionId: string,
  dep: ElectionResult,
  codeInsee: string,
  populations: Map<string, number | null>,
): { commune: number; median: number; n: number; ratio: number; minPop: number; maxPop: number } | null {
  if (!dep.byCommune?.length) return null;
  const target = dep.byCommune.find((c) => c.code === codeInsee);
  const pop = populations.get(codeInsee);
  if (!target || !pop) return null;
  const sc = (c: Agg) => score(electionId, c, "lfi")?.pctInscrits ?? null;
  const own = sc(target);
  if (own == null) return null;
  let peers = dep.byCommune.filter((c) => c.code !== codeInsee && (populations.get(c.code) ?? 0) >= pop * 0.5 && (populations.get(c.code) ?? 0) <= pop * 1.5);
  if (peers.length < 5)
    peers = dep.byCommune
      .filter((c) => c.code !== codeInsee && populations.get(c.code))
      .sort((a, b) => Math.abs((populations.get(a.code) ?? 0) - pop) - Math.abs((populations.get(b.code) ?? 0) - pop))
      .slice(0, 10);
  const vals = peers.map(sc).filter((v): v is number => v != null);
  const m = median(vals);
  if (m == null || !vals.length) return null;
  const pp = peers.map((c) => populations.get(c.code) ?? 0);
  return { commune: own, median: m, n: vals.length, ratio: m ? own / m : NaN, minPop: Math.min(...pp), maxPop: Math.max(...pp) };
}

export type BvType = "bastion_a_mobiliser" | "bastion" | "reservoir_abstention" | "terrain_difficile";

export const BV_TYPE_LABELS: Record<BvType, string> = {
  bastion_a_mobiliser: "LFI fort, abstention forte",
  bastion: "LFI fort, participation forte",
  reservoir_abstention: "LFI faible, abstention forte",
  terrain_difficile: "LFI faible, participation forte",
};

/**
 * Libellé lisible d'un lieu de vote (le REU est en minuscules abrégées) :
 * « ecole mat ph lebesgue » → « École maternelle Ph Lebesgue ».
 */
export function prettyBvLabel(raw: string): string {
  const abbr: [RegExp, string][] = [
    [/\becole\b/gi, "école"],
    [/\bmat\b\.?/gi, "maternelle"],
    [/\bprim\b\.?/gi, "primaire"],
    [/\belem\b\.?/gi, "élémentaire"],
    [/\belementaire\b/gi, "élémentaire"],
    [/\bmaternel\b/gi, "maternelle"],
    [/\bhotel de ville\b/gi, "hôtel de ville"],
    [/\bcentre social\b/gi, "centre social"],
    [/\bcite\b/gi, "cité"],
    [/\bsalle polyvalente\b/gi, "salle polyvalente"],
    [/\bgr(p)?\b\.?\s+scol(aire)?\b\.?/gi, "groupe scolaire"],
    [/\bscol\b\.?/gi, "scolaire"],
    [/\bsco\b\.?/gi, "scolaire"],
    [/\bbat\b\.?(?=\s)/gi, "bât."],
    [/\bbibiliotheque|bibliotheque\b/gi, "bibliothèque"],
    [/\bcollege\b/gi, "collège"],
    [/\blycee\b/gi, "lycée"],
    [/\bmairie\b/gi, "mairie"],
    [/\bgymnase\b/gi, "gymnase"],
  ];
  // Numéro du bureau répété en tête du libellé (« 22 école… », « BV 3 - … »).
  let s = raw.trim().replace(/\s+/g, " ").replace(/^(bv|bureau( de vote)?)?\s*n?°?\s*\d{1,4}\s*[-–:.]?\s+(?=\D)/i, "");
  for (const [re, rep] of abbr) s = s.replace(re, rep);
  const small = new Set(["de", "du", "des", "la", "le", "les", "l", "d", "et", "à", "au", "aux", "sur", "en"]);
  const lowerWords = new Set(["école", "maternelle", "primaire", "élémentaire", "groupe", "scolaire", "bibliothèque", "collège", "lycée", "salle", "salles", "mairie", "gymnase", "centre", "espace", "maison", "rencontres", "professionnel", "polyvalente", "social", "quartier", "hôtel", "ville", "médiathèque", "bât."]);
  s = s
    .split(" ")
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (i > 0 && (small.has(lw) || lowerWords.has(lw))) return lw;
      if (/^[a-z]$/i.test(w)) return w.toUpperCase();
      return lw.charAt(0).toUpperCase() + lw.slice(1);
    })
    .join(" ")
    .replace(/\b([ld]) ([A-ZÉÈ])/g, "$1'$2");
  return prettyFr(s.charAt(0).toUpperCase() + s.slice(1));
}

export interface BvRow {
  bv: string;
  label: string;
  inscrits: number;
  abstPct: number;
  abstN: number;
  lfiVoix: number;
  lfiPctIns: number;
  lfiPctExp: number;
  /** Score LFI au second scrutin de référence (si le bureau est apparié). */
  lfi2PctIns: number | null;
  lfi2PctExp: number | null;
  lfi2Voix: number | null;
  abst2Pct: number | null;
  /** Scrutin de l'abstention (législatives 2024 si les bureaux s'apparient, sinon le scrutin principal). */
  abstSrc?: string;
  potentiel: number;
  type: BvType;
  /** Profil lisible : vote LFI en tiers (fort / moyen / faible) et abstention par rapport à la médiane. */
  profil: string;
  priorite: 1 | 2 | 3;
}

/** Profil d'un bureau : tiers de la part LFI des exprimés, abstention au-dessus ou en dessous de la médiane. */
function profilOf(lfi: number, abst: number, t1: number, t2: number, mA: number) {
  const l = lfi >= t2 ? "LFI fort" : lfi > t1 || t1 === -Infinity ? "LFI moyen" : "LFI faible";
  return `${l}, ${abst >= mA ? "abstention forte" : "participation forte"}`;
}

/**
 * Classement des bureaux d'une commune. `ref` : scrutin principal (E24 par défaut),
 * `second` : scrutin de comparaison (P22), apparié par numéro de bureau lorsque
 * les effectifs d'inscrits restent proches (±25 %), faute de quoi le découpage
 * est présumé avoir changé.
 */
export function rankBureaux(ref: BureauResult[], second: BureauResult[] | null, labels: Map<string, string>, abstRef?: BureauResult[] | null): BvRow[] {
  const eid = ref[0]?.election.id;
  const sid = second?.[0]?.election.id;
  // Abstention d'un autre scrutin (législatives 2024, forte participation) si chaque bureau
  // s'y retrouve avec un nombre d'inscrits comparable (±25 %) ; sinon celle du scrutin principal,
  // pour ne pas mélanger deux scrutins dans le classement.
  const match = (b: BureauResult) => abstRef?.find((x) => x.bv === b.bv && b.inscrits && Math.abs(x.inscrits - b.inscrits) / b.inscrits <= 0.25);
  const useAlt = !!abstRef?.length && ref.every((b) => match(b));
  const all = ref
    .map((b) => {
      const s = score(eid, b, "lfi");
      if (!s) return null;
      const ab = useAlt ? abstention(match(b)!) : abstention(b);
      const sb = second?.find((x) => x.bv === b.bv);
      const same = sb && Math.abs(sb.inscrits - b.inscrits) / b.inscrits <= 0.25;
      const s2 = same && sid ? score(sid, sb!, "lfi") : null;
      return {
        bv: b.bv,
        label: labels.get(b.bv) ?? `Bureau ${b.bv}`,
        inscrits: b.inscrits,
        abstPct: ab.pct,
        abstN: ab.n,
        lfiVoix: s.voix,
        lfiPctIns: s.pctInscrits,
        lfiPctExp: s.pctExprimes,
        lfi2PctIns: s2?.pctInscrits ?? null,
        lfi2PctExp: s2?.pctExprimes ?? null,
        lfi2Voix: s2?.voix ?? null,
        abst2Pct: same ? abstention(sb!).pct : null,
        abstSrc: (useAlt ? abstRef![0].election.id : eid) as string,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!all.length) return [];
  // Les très petits bureaux (bureaux spéciaux, quelques dizaines d'inscrits) ont des taux
  // instables : ils sont classés à part, en priorité 3, et n'entrent pas dans les scores z.
  const medIns = median(all.map((b) => b.inscrits)) ?? 0;
  const tiny = (b: { inscrits: number }) => all.length >= 3 && b.inscrits < Math.max(100, 0.2 * medIns);
  const small = all.filter(tiny);
  const base = all.filter((b) => !tiny(b));
  if (!base.length) return [];
  // Réservoir : part LFI des exprimés au scrutin principal, moyennée avec celle du
  // second scrutin (Mélenchon 2022) lorsque les bureaux sont appariés.
  const z1 = zscores(base.map((b) => b.lfiPctExp));
  const paired = base.filter((b) => b.lfi2PctExp != null);
  const z2all = paired.length >= Math.max(3, base.length / 2) ? zscores(paired.map((b) => b.lfi2PctExp!)) : [];
  const z2 = new Map(paired.map((b, i) => [b.bv, z2all[i]]));
  const zL = base.map((b, i) => (z2.get(b.bv) != null ? (z1[i] + z2.get(b.bv)!) / 2 : z1[i]));
  const zA = zscores(base.map((b) => b.abstPct));
  const mL = median(base.map((b) => b.lfiPctExp))!;
  const mA = median(base.map((b) => b.abstPct))!;
  const sortedL = base.map((b) => b.lfiPctExp).sort((x, y) => x - y);
  const q = (p: number) => sortedL[Math.min(sortedL.length - 1, Math.floor(p * sortedL.length))];
  // Écarts faibles entre bureaux (moins de 4 points) : tiers sans signification.
  const flat = sortedL[sortedL.length - 1] - sortedL[0] < 4;
  const t1 = flat ? -Infinity : q(1 / 3);
  const t2 = flat ? Infinity : q(2 / 3);
  const withPot = base.map((b, i) => {
    const highL = b.lfiPctExp >= mL;
    const highA = b.abstPct >= mA;
    const type: BvType = highL && highA ? "bastion_a_mobiliser" : highL ? "bastion" : highA ? "reservoir_abstention" : "terrain_difficile";
    return { ...b, potentiel: (zL[i] + zA[i]) / 2, type, profil: profilOf(b.lfiPctExp, b.abstPct, t1, t2, mA) };
  });
  const sorted = [...withPot].sort((a, b) => b.potentiel - a.potentiel);
  const n = sorted.length;
  // Priorité 1 proportionnée à la taille (1 bureau jusqu'à 3, 2 jusqu'à 8, 3 jusqu'à 20,
  // 4 jusqu'à 40, 5 jusqu'à 70, 6 au-delà) pour rester actionnable ; priorité 2 jusqu'à la moitié.
  const p1 = n <= 3 ? 1 : n <= 8 ? 2 : n <= 20 ? 3 : n <= 40 ? 4 : n <= 70 ? 5 : 6;
  const p2 = Math.max(p1, Math.ceil(n / 2));
  return [
    ...sorted.map((b, i) => ({ ...b, priorite: (i < p1 ? 1 : i < p2 ? 2 : 3) as 1 | 2 | 3 })),
    ...small.map((b) => {
      const type: BvType = b.lfiPctExp >= mL ? (b.abstPct >= mA ? "bastion_a_mobiliser" : "bastion") : b.abstPct >= mA ? "reservoir_abstention" : "terrain_difficile";
      return { ...b, potentiel: Number.NEGATIVE_INFINITY, type, profil: profilOf(b.lfiPctExp, b.abstPct, t1, t2, mA), priorite: 3 as const };
    }),
  ];
}

/** Performance d'une famille dans la commune rapportée au département (% des exprimés). */
export function familyPerformance(electionId: string, com: Agg, dep: Agg) {
  return FAMILIES.filter((f) => f.match[electionId])
    .map((f) => {
      const c = score(electionId, com, f.id);
      const d = score(electionId, dep, f.id);
      if (!c || !d || !d.pctExprimes) return null;
      return { family: f.id, label: f.label, commune: c.pctExprimes, departement: d.pctExprimes, ratio: c.pctExprimes / d.pctExprimes };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

/** Libellés OSM d'horaires traduits (ex. « We,Sa 08:00-13:00 » → « mer., sam. 08:00-13:00 »). */
export function frenchHours(oh: string | null | undefined): string {
  if (!oh) return "";
  const raw = oh.trim();
  if (/^24\/7$/.test(raw)) return "tous les jours, 24 h/24";
  if (/^sunrise-sunset$/.test(raw)) return "du lever au coucher du soleil";
  const D = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
  const hour = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
  };
  // Règles simples « Tu-Sa 08:00-19:00; Mo,Su off » → « du mardi au samedi, 8 h – 19 h ».
  const parts: string[] = [];
  const MOIS: Record<string, string> = { Jan: "janvier", Feb: "février", Mar: "mars", Apr: "avril", May: "mai", Jun: "juin", Jul: "juillet", Aug: "août", Sep: "septembre", Oct: "octobre", Nov: "novembre", Dec: "décembre" };
  for (const rule0 of raw.split(/\s*;\s*/).filter(Boolean)) {
    if (/^PH\s+(off|closed)$/.test(rule0)) continue;
    // Période de l'année (« Jul-Aug Th 08:00-13:00 » : marché d'été).
    const mo = rule0.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))?:?\s+/);
    const periode = mo ? ` (${mo[2] ? `de ${MOIS[mo[1]]} à ${MOIS[mo[2]]}` : `en ${MOIS[mo[1]]}`})` : "";
    const rule = mo ? rule0.slice(mo[0].length) : rule0;
    const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)\s+(off|closed|(?:\d{1,2}:\d{2}-\d{1,2}:\d{2},?\s*)+)$/);
    if (!m) return frenchHoursRaw(raw);
    if (/off|closed/.test(m[2])) continue;
    const days = m[1].split(",").filter(Boolean).map((d) => {
      const [a, b] = d.split("-");
      const i = D.indexOf(a);
      if (!b) return NAMES[i];
      const j = D.indexOf(b);
      return j - i === 1 ? `${NAMES[i]} et ${NAMES[j]}` : j === 6 && i === 0 ? "tous les jours" : `du ${NAMES[i]} au ${NAMES[j]}`;
    });
    const times = m[2].split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.split("-").map(hour).join(" – "));
    const dayTxt = days.length > 1 ? `${days.slice(0, -1).join(", ")} et ${days[days.length - 1]}` : days[0];
    parts.push(`${dayTxt}, ${times.join(" et ")}${periode}`);
  }
  return parts.join(" ; ");
}

function frenchHoursRaw(oh: string): string {
  const days: Record<string, string> = { Mo: "lun.", Tu: "mar.", We: "mer.", Th: "jeu.", Fr: "ven.", Sa: "sam.", Su: "dim.", PH: "jours fériés" };
  return oh
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (d) => days[d])
    .replace(/,/g, ", ")
    .replace(/;/g, " ;")
    .replace(/\boff\b/g, "fermé");
}
