/**
 * Historique des député·es par circonscription (fichier interne « historique_deputations »,
 * frise de la fiche circo) : un siège par circonscription et par élection, de 1988 à 2024.
 *
 * Deux formats reconnus :
 *  - 1988-2007 (ancien découpage) : circo ; ancienne_circo ; part_pop_actuelle ; election ; groupe ; depute
 *    → pour chaque élection, l'ancienne circonscription qui couvre le plus la circonscription actuelle ;
 *  - 2012-2026 (découpage actuel) : circo ; election ; groupe ; depute ; debut ; fin
 *    → la personne élue en début de législature (première période).
 * Enregistré en CSV compact : circo;election;groupe;depute;part.
 */

export interface Deputation {
  election: number;
  groupe: string;
  depute: string;
  /** Part de la population actuelle couverte par l'ancienne circonscription (1 après 2012). */
  part: number;
}

const num = (v: unknown) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** Lignes brutes (l'un ou l'autre format) → une ligne par circonscription et par élection. */
export function deputationsRows(rows: Record<string, string>[]): { circo: string; d: Deputation }[] {
  const best = new Map<string, { circo: string; d: Deputation; rank: number }>();
  for (const r of rows) {
    const circo = String(r.circo ?? "").trim();
    const election = num(r.election);
    const groupe = String(r.groupe ?? "").trim();
    if (!/^\w{2,3}-\d{2}$/.test(circo) || !election || !groupe) continue;
    const ancien = "ancienne_circo" in r || "part_pop_actuelle" in r;
    const part = "part" in r ? (num(r.part) ?? 1) : ancien ? (num(r.part_pop_actuelle) ?? 0) : 1;
    // Ancien découpage : la plus grande part ; découpage actuel : le mandat le plus ancien (élu·e en juin).
    const rank = ancien ? part : -Date.parse(String(r.debut || r.periode_debut || "")) || 0;
    const k = `${circo}|${election}`;
    const prev = best.get(k);
    if (!prev || rank > prev.rank) best.set(k, { circo, d: { election, groupe, depute: String(r.depute ?? "").trim(), part }, rank });
  }
  return [...best.values()].map(({ circo, d }) => ({ circo, d })).sort((a, b) => a.circo.localeCompare(b.circo) || a.d.election - b.d.election);
}

export function deputationsToCsv(rows: { circo: string; d: Deputation }[]): string {
  const esc = (s: string) => s.replace(/[;\n\r]/g, " ");
  return ["circo;election;groupe;depute;part", ...rows.map(({ circo, d }) => `${circo};${d.election};${esc(d.groupe)};${esc(d.depute)};${d.part}`)].join("\n") + "\n";
}

/** CSV compact → historique par circonscription (« 57-06 »). */
export function parseDeputations(rows: Record<string, string>[]): Map<string, Deputation[]> {
  const m = new Map<string, Deputation[]>();
  for (const { circo, d } of deputationsRows(rows)) m.set(circo, [...(m.get(circo) ?? []), d]);
  return m;
}

/** Clé de circonscription du fichier : « 57-06 », « 2A-01 », « 971-02 ». */
export const circoKey = (dep: string, circo: number) => `${dep.length === 1 ? `0${dep}` : dep}-${String(circo).padStart(2, "0")}`;

type Famille = "lfi" | "gauche" | "centre" | "droite" | "extreme_droite" | "divers";
const FAMILLE: [RegExp, Famille][] = [
  [/^LFI/i, "lfi"],
  [/^(PS|PCF|GDR|SOC|RRDP|RCV|EcoSoc|Écolo|Écologistes|EELV|Socialiste)/i, "gauche"],
  [/^(LREM|LaREM|Renaissance|EPR|MoDem|Dem|Horizons|HOR|Agir)/i, "centre"],
  [/^(RPR|UMP|LR|DR|UDI|UDF|DL|NC|R-UMP|UDC|LC)/i, "droite"],
  [/^(RN|FN|UDR)/i, "extreme_droite"],
];
export const familleOf = (g: string): Famille => FAMILLE.find(([re]) => re.test(g.trim()))?.[1] ?? "divers";
const LIB: Record<Famille, string> = { lfi: "LFI", gauche: "de gauche", centre: "du camp présidentiel", droite: "de droite", extreme_droite: "d'extrême droite", divers: "divers ou non inscrit" };

const joinFr = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} et ${xs[xs.length - 1]}`);

/**
 * « La 6e circonscription de la Moselle a élu un·e député·e de gauche en 1988, 1997 et 2012, de droite en
 * 1993, 2002 et 2007, du camp présidentiel en 2017, puis d'extrême droite depuis 2022. »
 */
export function deputationsPhrase(h: Deputation[], circoNom: string): string {
  if (h.length < 2) return "";
  const xs = [...h].sort((a, b) => a.election - b.election);
  const last = xs[xs.length - 1];
  const fLast = familleOf(last.groupe);
  // Dernière série continue d'une même famille (« depuis 2022 »).
  let i = xs.length - 1;
  while (i > 0 && familleOf(xs[i - 1].groupe) === fLast) i--;
  const avant = xs.slice(0, i);
  // Années d'une même famille ; trois élections consécutives ou plus : « de 1988 à 2012 ».
  const parFam = new Map<Famille, number[]>();
  avant.forEach((d, k) => parFam.set(familleOf(d.groupe), [...(parFam.get(familleOf(d.groupe)) ?? []), k]));
  const quand = (ks: number[]) => {
    const runs: number[][] = [];
    for (const k of ks) (runs.length && runs[runs.length - 1][runs[runs.length - 1].length - 1] === k - 1 ? runs[runs.length - 1].push(k) : runs.push([k]));
    const bouts: string[] = [];
    let seuls: number[] = [];
    const flush = () => {
      if (seuls.length) bouts.push(`en ${joinFr(seuls.map(String))}`);
      seuls = [];
    };
    for (const r of runs) {
      if (r.length >= 3) {
        flush();
        bouts.push(`de ${avant[r[0]].election} à ${avant[r[r.length - 1]].election}`);
      } else seuls.push(...r.map((k) => avant[k].election));
    }
    flush();
    return joinFr(bouts);
  };
  const parts = [...parFam].map(([f, ks]) => `${LIB[f]} ${quand(ks)}`);
  const depuis = xs.length - i > 1 ? `depuis ${xs[i].election}` : `en ${xs[i].election}`;
  const fin = `${LIB[fLast]} ${depuis}`;
  const lfi = xs.some((d) => familleOf(d.groupe) === "lfi");
  const debut = xs[0].election;
  const corps = parts.length ? `${parts.join(", ")}, puis ${fin}` : fin;
  const ancien = xs.some((d) => d.election < 2012 && d.part < 0.75);
  return `Depuis ${debut}, la ${circoNom} a élu un·e député·e ${corps}${lfi ? "" : " ; jamais LFI"}.${ancien ? " Avant 2012, sur un découpage différent." : ""}`;
}

/** Député·es précédent·es (personnes différentes de l'actuel·le), du plus récent au plus ancien. */
export function precedents(h: Deputation[], actuel: string, n = 2, depuis = 2007): Deputation[] {
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]+/g, " ").trim();
  const out: Deputation[] = [];
  for (const d of [...h].filter((x) => x.election >= depuis).sort((a, b) => b.election - a.election)) {
    if (norm(d.depute) === norm(actuel) || out.some((x) => norm(x.depute) === norm(d.depute))) continue;
    out.push(d);
    if (out.length >= n) break;
  }
  return out;
}
