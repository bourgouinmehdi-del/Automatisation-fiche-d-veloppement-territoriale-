/**
 * Classement national des communes (commande de Menal) : trois facteurs notés sur 100, pondérables.
 *
 *  1. Potentiel de progression à la présidentielle (provisoire, en attendant la méthode de Damien) :
 *     réservoir de voix = abstentionnistes de 2022 × part de Mélenchon chez les votants (ils ressemblent aux
 *     votants de la commune) + la moitié des voix de gauche hors LFI en 2022 (Roussel, Hidalgo, Jadot).
 *     Note : moitié volume (log des voix), moitié taux (part des inscrits).
 *  2. Disponibilité militante (déficit) : peu d'actions et peu de soutiens JLM2027 au regard de ce réservoir,
 *     pas de groupe d'action actif. Plus la note est haute, plus il manque de militants.
 *  3. Circonscription serrée : écart projeté (fichier des négos) ou, à défaut, écart du 1er tour des
 *     législatives 2024 entre l'union de la gauche et le premier adversaire (provisoire).
 *
 * Chaque indicateur est converti en rang centile (0 à 100) parmi les communes classées : la note dit
 * « mieux que X % des communes », lisible et insensible aux valeurs extrêmes.
 */

export interface NatCommune {
  code: string;
  nom: string;
  dep: string;
  reg: string;
  pop: number | null;
  /** Circonscription majoritaire (« 57-06 ») et part de la commune qui s'y trouve. */
  circo: string | null;
  circoPart: number | null;
  pr22: { inscrits: number; votants: number; exprimes: number; lfi: number; gauche: number } | null;
  eu24: { inscrits: number; votants: number; exprimes: number; lfi: number } | null;
  lg24: { inscrits: number; exprimes: number; nfp: number; adv: Record<string, number> } | null;
}

export interface Militant {
  ga: number;
  actions: number;
  soutiens: number;
}

export interface Ligne {
  code: string;
  nom: string;
  dep: string;
  reg: string;
  inscrits: number;
  circo: string | null;
  /* Indicateurs bruts */
  melPct: number;
  eu24Pct: number | null;
  abst22Pct: number;
  reservoir: number;
  reservoirPct: number;
  ga: number | null;
  actions: number | null;
  soutiens: number | null;
  actionsPour1000: number | null;
  soutiensPour1000: number | null;
  ecartCirco: number | null;
  ecartSource: "negos" | "lg24" | null;
  /* Notes sur 100 */
  f1: number;
  f2: number | null;
  f3: number | null;
}

/** Rang centile (0 à 100) ; ex aequo : rang moyen. */
export function centiles(v: (number | null)[]): (number | null)[] {
  const idx = v.map((x, i) => ({ x, i })).filter((p): p is { x: number; i: number } => p.x != null && Number.isFinite(p.x));
  const out: (number | null)[] = v.map(() => null);
  if (!idx.length) return out;
  idx.sort((a, b) => a.x - b.x);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].x === idx[k].x) j++;
    const r = idx.length === 1 ? 100 : (100 * (k + j)) / 2 / (idx.length - 1);
    for (let m = k; m <= j; m++) out[idx[m].i] = r;
    k = j + 1;
  }
  return out;
}

/** Écart projeté par circonscription à partir des législatives 2024 (union de la gauche − 1er adversaire, en points). */
export function ecartsLg24(cs: NatCommune[]): Map<string, number> {
  const agg = new Map<string, { exp: number; nfp: number; adv: Record<string, number> }>();
  for (const c of cs) {
    if (!c.circo || !c.lg24) continue;
    const w = c.circoPart ?? 1;
    const a = agg.get(c.circo) ?? { exp: 0, nfp: 0, adv: {} };
    a.exp += w * c.lg24.exprimes;
    a.nfp += w * c.lg24.nfp;
    for (const [k, v] of Object.entries(c.lg24.adv)) a.adv[k] = (a.adv[k] ?? 0) + w * v;
    agg.set(c.circo, a);
  }
  const out = new Map<string, number>();
  for (const [k, a] of agg) {
    if (!a.exp || !a.nfp) continue;
    const best = Math.max(0, ...Object.values(a.adv));
    out.set(k, (100 * (a.nfp - best)) / a.exp);
  }
  return out;
}

export interface Options {
  minInscrits: number;
  bilan?: Map<string, Militant> | null;
  negos?: Map<string, number> | null;
}

export function classer(cs: NatCommune[], o: Options): Ligne[] {
  const proxy = ecartsLg24(cs);
  const base = cs
    .filter((c) => c.pr22 && c.pr22.inscrits >= o.minInscrits && c.pr22.exprimes > 0)
    .map((c) => {
      const p = c.pr22!;
      const abst = Math.max(0, p.inscrits - p.votants);
      const melPartVotants = p.lfi / p.exprimes;
      const reservoir = abst * melPartVotants + 0.5 * p.gauche;
      const m = o.bilan ? (o.bilan.get(c.code) ?? { ga: 0, actions: 0, soutiens: 0 }) : null;
      const neg = c.circo ? o.negos?.get(c.circo) : undefined;
      const prox = c.circo ? proxy.get(c.circo) : undefined;
      return {
        c,
        reservoir,
        l: {
          code: c.code,
          nom: c.nom,
          dep: c.dep,
          reg: c.reg,
          inscrits: p.inscrits,
          circo: c.circo,
          melPct: (100 * p.lfi) / p.inscrits,
          eu24Pct: c.eu24 && c.eu24.inscrits ? (100 * c.eu24.lfi) / c.eu24.inscrits : null,
          abst22Pct: (100 * abst) / p.inscrits,
          reservoir: Math.round(reservoir),
          reservoirPct: (100 * reservoir) / p.inscrits,
          ga: m ? m.ga : null,
          actions: m ? m.actions : null,
          soutiens: m ? m.soutiens : null,
          actionsPour1000: m ? (1000 * m.actions) / Math.max(reservoir, 1) : null,
          soutiensPour1000: m ? (1000 * m.soutiens) / Math.max(reservoir, 1) : null,
          ecartCirco: neg ?? prox ?? null,
          ecartSource: neg != null ? ("negos" as const) : prox != null ? ("lg24" as const) : null,
          f1: 0,
          f2: null,
          f3: null,
        } as Ligne,
      };
    });
  // Facteur 1 : volume (log) et taux du réservoir.
  const vol = centiles(base.map((b) => Math.log1p(b.reservoir)));
  const taux = centiles(base.map((b) => b.l.reservoirPct));
  const f1 = centiles(base.map((_, i) => 0.5 * vol[i]! + 0.5 * taux[i]!));
  // Facteur 2 : déficit militant (moins d'actions, de soutiens, pas de groupe actif).
  const act = o.bilan ? centiles(base.map((b) => -Math.log1p(b.l.actionsPour1000!))) : null;
  const sou = o.bilan ? centiles(base.map((b) => -Math.log1p(b.l.soutiensPour1000!))) : null;
  const f2 = o.bilan ? centiles(base.map((b, i) => 0.5 * act![i]! + 0.3 * sou![i]! + 0.2 * (b.l.ga ? 0 : 100))) : null;
  // Facteur 3 : plus l'écart est faible, plus la note est haute.
  const f3 = centiles(base.map((b) => (b.l.ecartCirco == null ? null : -Math.abs(b.l.ecartCirco))));
  return base.map((b, i) => ({ ...b.l, f1: f1[i]!, f2: f2 ? f2[i] : null, f3: f3[i] }));
}

/** Score pondéré (0 à 100) ; un facteur absent ne compte pas, les autres poids sont rééchelonnés. */
export function scoreOf(l: Pick<Ligne, "f1" | "f2" | "f3">, w: { p: number; m: number; c: number }): number {
  const parts: [number | null, number][] = [
    [l.f1, w.p],
    [l.f2, w.m],
    [l.f3, w.c],
  ];
  const ok = parts.filter(([v, k]) => v != null && k > 0);
  const tot = ok.reduce((s, [, k]) => s + k, 0);
  return tot ? ok.reduce((s, [v, k]) => s + v! * k, 0) / tot : 0;
}

/** Fichier des négos : une ligne par circonscription, un écart projeté en points. */
export function parseNegos(rows: Record<string, string>[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!rows.length) return out;
  const cols = Object.keys(rows[0]);
  const find = (re: RegExp) => cols.find((c) => re.test(c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()));
  const cCirco = find(/circo/);
  const cDep = find(/^(code_?)?dep/);
  const cNum = find(/^(num|n°|numero)/);
  const cEcart = find(/ecart|marge|diff|delta/);
  if (!cEcart || (!cCirco && !(cDep && cNum))) return out;
  for (const r of rows) {
    const v = Number(String(r[cEcart] ?? "").replace("%", "").replace(",", ".").trim());
    if (!Number.isFinite(v)) continue;
    let key = "";
    const raw = String(cCirco ? r[cCirco] : "").trim();
    const m = raw.match(/^(\w{1,3})[-_ ]0*(\d{1,2})$/);
    if (m) key = `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    else if (/^\d{4,5}$/.test(raw)) key = `${raw.slice(0, raw.length - 2).padStart(2, "0")}-${raw.slice(-2)}`;
    else if (cDep && cNum) key = `${String(r[cDep]).trim().padStart(2, "0")}-${String(r[cNum]).trim().padStart(2, "0")}`;
    if (/^\w{2,3}-\d{2}$/.test(key)) out.set(key, v);
  }
  return out;
}
