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
  { id: "lfi", label: "LFI", match: { EU24: /^LFI$|insoumise|aubry/i, PR22T1: /m[ée]lenchon/i } },
  { id: "nfp", label: "NFP (Union de la gauche)", match: { LG24T1: /^UG$|union de la gauche|nouveau front populaire/i } },
  { id: "pcf", label: "PCF", match: { EU24: /^LCOM$|gauche unie|deffontaines/i, PR22T1: /roussel/i } },
  { id: "ps", label: "PS / Place publique", match: { EU24: /^LUG$|r[ée]veiller l.europe|glucksmann|place publique/i, PR22T1: /hidalgo/i, LG24T1: /^SOC$/i } },
  { id: "eco", label: "Écologistes", match: { EU24: /^LVEC$|^LECO$|toussaint|europe [ée]cologie/i, PR22T1: /jadot/i, LG24T1: /^ECO$/i } },
  { id: "ens", label: "Ensemble (majorité présidentielle)", match: { EU24: /^LENS$|besoin d.europe|hayer/i, PR22T1: /macron/i, LG24T1: /^ENS$/i } },
  { id: "lr", label: "LR", match: { EU24: /^LLR$|bellamy|droite pour/i, PR22T1: /p[ée]cresse/i, LG24T1: /^LR$/i } },
  { id: "rn", label: "RN (et alliés)", match: { EU24: /^LRN$|bardella|rassemblement national|la france revient/i, PR22T1: /le pen/i, LG24T1: /^RN$|^UXD$/i } },
  { id: "rec", label: "Reconquête", match: { EU24: /^LREC$|marion mar[ée]chal|reconqu[êe]te/i, PR22T1: /zemmour/i, LG24T1: /^REC$/i } },
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
): { commune: number; median: number; n: number; ratio: number } | null {
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
  return { commune: own, median: m, n: vals.length, ratio: m ? own / m : NaN };
}

export type BvType = "bastion_a_mobiliser" | "bastion" | "reservoir_abstention" | "terrain_difficile";

export const BV_TYPE_LABELS: Record<BvType, string> = {
  bastion_a_mobiliser: "Vote LFI élevé et forte abstention",
  bastion: "Vote LFI élevé, participation élevée",
  reservoir_abstention: "Vote LFI modeste, forte abstention",
  terrain_difficile: "Vote LFI modeste, participation élevée",
};

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
  abst2Pct: number | null;
  potentiel: number;
  type: BvType;
  priorite: 1 | 2 | 3;
}

/**
 * Classement des bureaux d'une commune. `ref` : scrutin principal (E24 par défaut),
 * `second` : scrutin de comparaison (P22), apparié par numéro de bureau lorsque
 * les effectifs d'inscrits restent proches (±25 %), faute de quoi le découpage
 * est présumé avoir changé.
 */
export function rankBureaux(ref: BureauResult[], second: BureauResult[] | null, labels: Map<string, string>): BvRow[] {
  const eid = ref[0]?.election.id;
  const sid = second?.[0]?.election.id;
  const base = ref
    .map((b) => {
      const s = score(eid, b, "lfi");
      if (!s) return null;
      const ab = abstention(b);
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
        abst2Pct: same ? abstention(sb!).pct : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!base.length) return [];
  const zL = zscores(base.map((b) => b.lfiPctExp));
  const zA = zscores(base.map((b) => b.abstPct));
  const mL = median(base.map((b) => b.lfiPctExp))!;
  const mA = median(base.map((b) => b.abstPct))!;
  const withPot = base.map((b, i) => {
    const highL = b.lfiPctExp >= mL;
    const highA = b.abstPct >= mA;
    const type: BvType = highL && highA ? "bastion_a_mobiliser" : highL ? "bastion" : highA ? "reservoir_abstention" : "terrain_difficile";
    return { ...b, potentiel: (zL[i] + zA[i]) / 2, type };
  });
  const sorted = [...withPot].sort((a, b) => b.potentiel - a.potentiel);
  const n = sorted.length;
  return sorted.map((b, i) => ({ ...b, priorite: (i < Math.ceil(n / 3) ? 1 : i < Math.ceil((2 * n) / 3) ? 2 : 3) as 1 | 2 | 3 }));
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
  const days: Record<string, string> = { Mo: "lun.", Tu: "mar.", We: "mer.", Th: "jeu.", Fr: "ven.", Sa: "sam.", Su: "dim.", PH: "jours fériés" };
  return oh
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (d) => days[d])
    .replace(/,/g, ", ")
    .replace(/;/g, " ;")
    .replace(/\boff\b/g, "fermé");
}
