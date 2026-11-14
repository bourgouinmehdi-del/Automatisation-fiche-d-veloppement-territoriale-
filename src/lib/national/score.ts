/**
 * Classement national des communes (commande de Menal) : trois facteurs notés sur 100, pondérables.
 *
 *  1. Potentiel pour un convoi, à parts égales :
 *     - vote insoumis : Mélenchon 2022 et européennes 2024, en part des exprimés (une commune où LFI est
 *       faible ne doit pas finir en tête sur la seule réserve de voix, retour sur une petite commune
 *       classée première mais « terrain difficile » sur sa fiche) ;
 *     - réserve de voix : électeurs mobilisables du modèle de Damien, ou à défaut réservoir provisoire
 *       (abstentionnistes de 2022 × part de Mélenchon chez les votants + moitié des voix Roussel, Hidalgo,
 *       Jadot). 60 % volume (log des voix : des portes à frapper pour une journée de convoi), 40 % taux.
 *  2. Disponibilité militante (déficit) : peu d'actions et peu de soutiens JLM2027 pour 1 000 voix
 *     Mélenchon 2022, pas de groupe d'action actif. Plus la note est haute, plus il manque de militants.
 *     Un groupe actif ailleurs dans l'intercommunalité peut venir : note réduite (couronnes des villes militantes).
 *  3. Circonscription serrée : écart projeté (projections internes) ou, à défaut, écart du 1er tour des
 *     législatives 2024 entre l'union de la gauche et le premier adversaire. Au-delà de 25 points
 *     (circonscription très perdue ou très gagnée), la note est nulle.
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
  /** Groupes d'action actifs dans les autres communes de l'intercommunalité (null sans bilan). */
  gaInterco: number | null;
  /** Mélenchon 2022 en part des exprimés. */
  melExpPct: number;
  /* Sous-notes du potentiel (0 à 100) */
  noteVote: number;
  noteReserve: number;
  /** Pourquoi la commune ressort, en quelques mots. */
  raisons: string[];
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

/**
 * Communes nouvelles : le jeu national (construit avant la correction) garde parfois l'ancienne commune à part,
 * sans circonscription ni bilan militant (rattachés à la commune nouvelle). On additionne ses résultats à ceux
 * de la commune nouvelle ; nom et circonscription sont ceux de la commune nouvelle.
 */
export function fusionnerCommunes(cs: NatCommune[], actuelle: (code: string) => string, nomDe?: (code: string) => string | undefined): NatCommune[] {
  const groupes = new Map<string, NatCommune[]>();
  for (const c of cs) {
    const k = actuelle(c.code);
    groupes.set(k, [...(groupes.get(k) ?? []), c]);
  }
  const out: NatCommune[] = [];
  for (const [k, g] of groupes) {
    if (g.length === 1 && g[0].code === k) {
      out.push(g[0]);
      continue;
    }
    const tete = g.find((c) => c.code === k) ?? [...g].sort((a, b) => (b.pr22?.inscrits ?? 0) - (a.pr22?.inscrits ?? 0))[0];
    const somme = <T extends Record<string, number>>(xs: (T | null)[]): T | null => {
      const ok = xs.filter((x): x is T => !!x);
      if (!ok.length) return null;
      const r = {} as Record<string, number>;
      for (const x of ok) for (const [f, v] of Object.entries(x)) r[f] = (r[f] ?? 0) + v;
      return r as T;
    };
    const lg = g.map((c) => c.lg24).filter((x): x is NonNullable<NatCommune["lg24"]> => !!x);
    out.push({
      ...tete,
      code: k,
      nom: nomDe?.(k) ?? tete.nom,
      pop: g.reduce((s, c) => s + (c.pop ?? 0), 0) || null,
      circo: tete.circo ?? g.find((c) => c.circo)?.circo ?? null,
      circoPart: tete.circo ? tete.circoPart : (g.find((c) => c.circo)?.circoPart ?? null),
      pr22: somme(g.map((c) => c.pr22)),
      eu24: somme(g.map((c) => c.eu24)),
      lg24: lg.length ? { inscrits: lg.reduce((s, x) => s + x.inscrits, 0), exprimes: lg.reduce((s, x) => s + x.exprimes, 0), nfp: lg.reduce((s, x) => s + x.nfp, 0), adv: somme(lg.map((x) => x.adv))! } : null,
    });
  }
  return out;
}

export interface Options {
  minInscrits: number;
  bilan?: Map<string, Militant> | null;
  negos?: Map<string, number> | null;
  /** Électeurs mobilisables par commune (modèle de Damien, Devoirs maison) : remplace le réservoir provisoire. */
  mobilisables?: Map<string, number> | null;
  /** Intercommunalité (EPT à Paris et petite couronne) d'une commune. */
  interco?: (code: string) => string | null;
}

/** Écart au-delà duquel une circonscription n'est plus « serrée » (note nulle). */
export const ECART_MAX = 25;

export function classer(cs: NatCommune[], o: Options): Ligne[] {
  const proxy = ecartsLg24(cs);
  // Groupes actifs par intercommunalité (toutes les communes du bilan, classées ou non).
  const gaParInterco = new Map<string, number>();
  if (o.bilan && o.interco)
    for (const [k, m] of o.bilan) {
      const i = o.interco(k);
      if (i && m.ga > 0) gaParInterco.set(i, (gaParInterco.get(i) ?? 0) + m.ga);
    }
  const mob = o.mobilisables?.size ? o.mobilisables : null;
  const base = cs
    .filter((c) => c.pr22 && c.pr22.inscrits >= o.minInscrits && c.pr22.exprimes > 0 && (!mob || mob.has(c.code)))
    .map((c) => {
      const p = c.pr22!;
      const abst = Math.max(0, p.inscrits - p.votants);
      const melPartVotants = p.lfi / p.exprimes;
      // Modèle de Damien quand il est déposé : abstentionnistes conjoncturels × part de gauche du votant marginal.
      const reservoir = mob ? mob.get(c.code)! : abst * melPartVotants + 0.5 * p.gauche;
      const m = o.bilan ? (o.bilan.get(c.code) ?? { ga: 0, actions: 0, soutiens: 0 }) : null;
      const neg = c.circo ? o.negos?.get(c.circo) : undefined;
      const ic = o.interco?.(c.code) ?? null;
      const gaInterco = m && o.interco ? Math.max(0, (ic ? (gaParInterco.get(ic) ?? 0) : 0) - m.ga) : null;
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
          // Pour 1 000 voix Mélenchon : comparable d'une source de réserve à l'autre (les mobilisables de
          // Damien sont parfois très peu nombreux dans les grandes villes, ce qui gonflait le ratio).
          actionsPour1000: m ? (1000 * m.actions) / Math.max(p.lfi, 1) : null,
          soutiensPour1000: m ? (1000 * m.soutiens) / Math.max(p.lfi, 1) : null,
          ecartCirco: neg ?? prox ?? null,
          ecartSource: neg != null ? ("negos" as const) : prox != null ? ("lg24" as const) : null,
          gaInterco,
          melExpPct: (100 * p.lfi) / p.exprimes,
          noteVote: 0,
          noteReserve: 0,
          raisons: [],
          f1: 0,
          f2: null,
          f3: null,
        } as Ligne,
      };
    });
  // Facteur 1 : vote insoumis (présidentielle 2022, européennes 2024) et réserve de voix (volume, taux).
  const mel = centiles(base.map((b) => b.l.melExpPct));
  const eu = centiles(base.map((b) => (b.c.eu24 && b.c.eu24.exprimes ? b.c.eu24.lfi / b.c.eu24.exprimes : null)));
  const vote = centiles(base.map((_, i) => (eu[i] == null ? mel[i]! : 0.6 * mel[i]! + 0.4 * eu[i]!)));
  const vol = centiles(base.map((b) => Math.log1p(b.reservoir)));
  const taux = centiles(base.map((b) => b.l.reservoirPct));
  const reserve = centiles(base.map((_, i) => 0.6 * vol[i]! + 0.4 * taux[i]!));
  const f1 = centiles(base.map((_, i) => 0.5 * vote[i]! + 0.5 * reserve[i]!));
  // Facteur 2 : déficit militant (moins d'actions, de soutiens, pas de groupe actif).
  const act = o.bilan ? centiles(base.map((b) => -Math.log1p(b.l.actionsPour1000!))) : null;
  const sou = o.bilan ? centiles(base.map((b) => -Math.log1p(b.l.soutiensPour1000!))) : null;
  // Sans groupe dans la commune mais avec un groupe actif ailleurs dans l'interco : il peut venir, déficit réduit.
  const f2 = o.bilan
    ? centiles(base.map((b, i) => (0.5 * act![i]! + 0.3 * sou![i]! + 0.2 * (b.l.ga ? 0 : 100)) * (!b.l.ga && b.l.gaInterco ? 0.6 : 1)))
    : null;
  // Facteur 3 : plus l'écart est faible, plus la note est haute ; nulle au-delà de ECART_MAX points.
  const f3 = centiles(base.map((b) => (b.l.ecartCirco == null ? null : -Math.abs(b.l.ecartCirco)))).map((v, i) =>
    v != null && Math.abs(base[i].l.ecartCirco!) > ECART_MAX ? 0 : v,
  );
  return base.map((b, i) => {
    const l: Ligne = { ...b.l, noteVote: vote[i]!, noteReserve: reserve[i]!, f1: f1[i]!, f2: f2 ? f2[i] : null, f3: f3[i] };
    return { ...l, raisons: raisons(l, !!mob) };
  });
}

/** Quelques mots sur ce qui fait ressortir (ou freine) la commune. */
export function raisons(l: Ligne, mob: boolean): string[] {
  const r: string[] = [];
  if (l.noteVote >= 75) r.push("vote LFI fort");
  else if (l.noteVote <= 30) r.push("vote LFI faible");
  if (l.noteReserve >= 75) r.push(mob ? "beaucoup à remobiliser" : "grosse réserve de voix");
  if (l.ga === 0 && l.gaInterco) r.push("groupe actif dans l'interco");
  else if (l.ga === 0) r.push("aucun groupe d'action");
  else if (l.f2 != null && l.f2 >= 75) r.push("peu d'actions");
  if (l.ecartCirco != null && Math.abs(l.ecartCirco) <= 5) r.push("circo serrée");
  return r;
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

const sansAccent = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Export de Damien (« communes par gisement de mobilisation ») : colonnes commune, dept, mobilisables (CSV du
 * dépôt elections_predictions_src), ou code_insee, mobilisables. Les communes sans code INSEE sont retrouvées
 * par leur nom dans le département (`nomVersCode`).
 */
export function parseMobilisables(rows: Record<string, string>[], nomVersCode: (nom: string, dep: string) => string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!rows.length) return out;
  const cols = Object.keys(rows[0]);
  const find = (re: RegExp) => cols.find((c) => re.test(sansAccent(c)));
  const cCode = find(/code( |_)?(insee|commune)|^insee$|^code$/);
  const cNom = find(/^(commune|libelle commune|nom)$/);
  const cDep = find(/^(dept|dep|departement|code departement)$/);
  const cMob = find(/^mobilisables?$/);
  if (!cMob || !(cCode || (cNom && cDep))) return out;
  for (const r of rows) {
    const v = Number(String(r[cMob] ?? "").replace(",", "."));
    if (!Number.isFinite(v)) continue;
    const code = cCode && /^\w{5}$/.test(String(r[cCode]).trim()) ? String(r[cCode]).trim().toUpperCase() : cNom && cDep ? nomVersCode(String(r[cNom]), String(r[cDep])) : null;
    if (code) out.set(code, (out.get(code) ?? 0) + v);
  }
  return out;
}

export const nomCle = sansAccent;
