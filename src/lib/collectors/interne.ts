import { promises as fs } from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { config } from "../config";
import { referentiel, searchCommunes } from "./admin";
import { detectDelimiter, findCol } from "./elections";

/**
 * Données militantes internes, FACULTATIVES, fournies par l'utilisateur
 * dans `data/interne/` (jamais versionnées : voir .gitignore), ou déposées
 * depuis la page « Données internes » de l'application :
 *
 *  parrains.csv          — code_commune ; parrains
 *  groupes.csv           — code_commune ; nom ; membres ; statut ; description
 *  action-populaire.csv  — export brut des groupes d'action d'Action Populaire :
 *                          colonnes reconnues par leur intitulé (nom, code
 *                          postal, ville, membres, date de création, type,
 *                          certification, description, nombre d'actions…) ;
 *                          la commune est retrouvée par code postal et ville.
 *  bilan.csv             — bilan militant par commune (classeur « bilan_par_commune »
 *                          converti au dépôt) : actions, groupes d'action actifs,
 *                          parrains et inscrits ; complète parrains.csv.
 *
 * Seuls des agrégats par commune ou par groupe sont utilisés : les colonnes
 * nominatives éventuelles (animateurs, contacts) sont ignorées.
 * Séparateur « ; » ou « , » détecté automatiquement.
 */

export interface Groupe {
  code: string;
  nom: string;
  membres: number | null;
  statut: string;
  description: string;
  creation?: string;
  type?: string;
  certifie?: boolean | null;
  actions?: number | null;
  derniereAction?: string;
  source?: string;
}

/** Bilan militant d'une commune (estimations pour les petites communes). */
export interface Bilan {
  actions: number;
  ga: number;
  parrains: number;
  inscrits: number;
  /** Vrai quand les chiffres sont estimés (fourchette basse et haute différentes). */
  estime: boolean;
}

export interface InternalData {
  parrains: Map<string, number>;
  bilan?: Map<string, Bilan>;
  /** Totaux France entière du bilan (pour les moyennes nationales). */
  bilanFrance?: Omit<Bilan, "estime">;
  /** Totaux par taille de commune (inscrits) : point de comparaison des communes de même taille. */
  bilanTranches?: (Omit<Bilan, "estime"> & { min: number; max: number; communes: number })[];
  groupes: Groupe[];
  /** Municipales 2026 : listes soutenues par LFI, par commune (classeur interne). */
  listesLfi?: Map<string, ListeLfi[]>;
  files: string[];
  /** Lignes non rattachées à une commune (export Action Populaire). */
  unmatched?: number;
}

/** Tailles de commune (en inscrits) pour comparer le bilan militant. */
export const BILAN_TRANCHES: [number, number][] = [
  [0, 1000],
  [1000, 3500],
  [3500, 10000],
  [10000, 30000],
  [30000, 100000],
  [100000, Infinity],
];

export const INTERNAL_FILES = ["parrains.csv", "groupes.csv", "action-populaire.csv", "bilan.csv", "municipales-lfi.csv"] as const;

export const internalDir = () => path.join(config.dataDir, "interne");

export function parseCsv(text: string) {
  const t = text.replace(/^﻿/, "");
  return Papa.parse<Record<string, string>>(t, { header: true, skipEmptyLines: true, delimiter: detectDelimiter(t) }).data;
}

async function readCsv(file: string) {
  return parseCsv(await fs.readFile(file, "utf8"));
}

const num = (v: unknown) => {
  const s = String(v ?? "").replace(/\s/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const yes = (v: string) => (v ? /^(oui|yes|true|1|vrai|certifi[ée])$/i.test(v.trim()) : null);

/** Commune d'un groupe : code INSEE si présent, sinon code postal + ville. */
export function communeOf(r: Record<string, string>, cols: string[]): string | null {
  const cCode = findCol(cols, /^code_?(commune|insee)$/i, /insee/i);
  if (cCode && /^\d[\dAB]\d{3}$/i.test(String(r[cCode]).trim().padStart(5, "0"))) return String(r[cCode]).trim().padStart(5, "0");
  const cCp = findCol(cols, /code.?postal|^cp$|zip/i);
  const cVille = findCol(cols, /^ville$|^commune$|city|localit/i);
  const cp = cCp ? String(r[cCp] ?? "").trim().padStart(5, "0") : "";
  const ville = cVille ? String(r[cVille] ?? "").trim() : "";
  if (/^\d{5}$/.test(cp)) {
    const cands = searchCommunes(cp);
    if (cands.length === 1) return cands[0].code;
    if (ville) {
      const n = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\bst\b/g, "saint").trim();
      const hit = cands.find((c) => n(c.nom) === n(ville)) ?? cands.find((c) => n(ville).includes(n(c.nom)) || n(c.nom).includes(n(ville)));
      if (hit) return hit.code;
    }
    if (cands.length) return cands[0].code;
  }
  if (ville) {
    const c = searchCommunes(ville, 2);
    if (c.length === 1) return c[0].code;
  }
  return null;
}

export function parseGroupes(rows: Record<string, string>[], source: string): { groupes: Groupe[]; unmatched: number } {
  const groupes: Groupe[] = [];
  let unmatched = 0;
  for (const r of rows) {
    const cols = Object.keys(r);
    const code = communeOf(r, cols);
    const g = (...res: RegExp[]) => {
      const c = findCol(cols, ...res);
      return c ? String(r[c] ?? "").trim() : "";
    };
    const nom = g(/^nom( du groupe)?$/i, /^name$/i, /^titre$/i, /^nom/i);
    if (!nom) continue;
    if (!code) {
      unmatched++;
      continue;
    }
    groupes.push({
      code,
      nom,
      membres: num(g(/membres|participants|inscrits|members|abonn/i)),
      statut: g(/statut|[ée]tat|status/i),
      description: g(/descr|note|comment/i).slice(0, 300),
      creation: g(/cr[ée]ation|cr[ée][ée] le|created/i) || undefined,
      type: g(/^type|sous.?type|subtype|cat[ée]gorie/i) || undefined,
      certifie: yes(g(/certifi/i)),
      actions: num(g(/nombre d.?(actions|[ée]v[ée]nements)|^(actions|events)$/i)),
      derniereAction: g(/derni[èe]re? (action|[ée]v[ée]nement)|last.?event/i) || undefined,
      source,
    });
  }
  return { groupes, unmatched };
}

/** Colonnes du bilan, reconnues par leur intitulé. */
export function parseBilan(rows: Record<string, string>[]) {
  const out = new Map<string, Bilan>();
  if (!rows.length) return out;
  const cols = Object.keys(rows[0]);
  const col = (...res: RegExp[]) => findCol(cols, ...res);
  const cCode = col(/^code_?(insee|commune)$/i);
  const cAct = col(/^nb_actions.*estime$/i, /^nb_actions/i, /^actions$/i);
  const cActB = col(/^nb_actions.*_bas$/i);
  const cActH = col(/^nb_actions.*_haut$/i);
  const cGa = col(/^nb_ga/i, /groupes?.*actifs?/i, /^ga$/i);
  const cPar = col(/^nb_parrains.*estime$/i, /^nb_parrains/i, /^parrains$/i);
  const cParB = col(/^nb_parrains.*_bas$/i);
  const cParH = col(/^nb_parrains.*_haut$/i);
  const cIns = col(/^inscrits/i);
  if (!cCode || !cIns || !(cAct || cGa || cPar)) return out;
  for (const r of rows) {
    const code = String(r[cCode] ?? "").trim().padStart(5, "0");
    const inscrits = num(r[cIns]);
    if (!/^\d[\dAB]\d{3}$/i.test(code) || !inscrits) continue;
    const v = (c: string | null) => (c ? (num(r[c]) ?? 0) : 0);
    out.set(code, {
      actions: v(cAct),
      ga: v(cGa),
      parrains: v(cPar),
      inscrits,
      estime: (!!cActB && v(cActB) !== v(cActH)) || (!!cParB && v(cParB) !== v(cParH)),
    });
  }
  return out;
}

/**
 * Groupes d'action du bilan, communes estimées : le bilan recopie le nombre de groupes d'un code postal
 * sur chaque commune de ce code postal (par exemple toutes les communes du 07100 autour d'Annonay).
 * On ne garde le nombre que pour la commune la plus grande (en inscrits) du code postal,
 * celle où se trouvent en général les groupes ; les autres passent à 0. Communes non estimées : inchangées.
 */
export function dedupeBilanGa(b: Map<string, Bilan>): Map<string, Bilan> {
  let ref: ReturnType<typeof referentiel>;
  try {
    ref = referentiel();
  } catch {
    return b;
  }
  const cpsOf = (code: string) => ref.byCode.get(code)?.codesPostaux ?? [];
  // 1. Nombre de groupes de chaque code postal : celui des communes qui n'ont que ce code postal (le plus
  //    fréquent). Une commune sur deux codes postaux a la somme des deux (Porte-de-Seine, 27100 et 27430).
  const vals = new Map<string, number[]>();
  const membres = new Map<string, string[]>();
  for (const [code, x] of b) {
    if (!x.estime) continue;
    const cps = cpsOf(code);
    for (const cp of cps) membres.set(cp, [...(membres.get(cp) ?? []), code]);
    if (cps.length === 1) vals.set(cps[0], [...(vals.get(cps[0]) ?? []), x.ga]);
  }
  const mode = (xs: number[]) => {
    const n = new Map<number, number>();
    for (const v of xs) n.set(v, (n.get(v) ?? 0) + 1);
    return [...n].sort((a, c) => c[1] - a[1] || a[0] - c[0])[0]?.[0] ?? 0;
  };
  const cpGa = (cp: string) => {
    if (vals.has(cp)) return mode(vals.get(cp)!);
    // Code postal sans commune « simple » : valeur d'une commune qui l'a, moins ses autres codes postaux connus.
    const xs = (membres.get(cp) ?? []).map((k) => b.get(k)!.ga - cpsOf(k).filter((o) => o !== cp && vals.has(o)).reduce((t, o) => t + mode(vals.get(o)!), 0));
    return xs.length ? Math.max(0, Math.min(...xs)) : 0;
  };
  // 2. Les groupes de chaque code postal vont à sa commune la plus grande (en inscrits).
  const out = new Map(b);
  for (const [code, x] of b) if (x.estime) out.set(code, { ...x, ga: 0 });
  for (const [cp, ks] of membres) {
    const g = cpGa(cp);
    if (!g) continue;
    const owner = [...ks].sort((a, c) => b.get(c)!.inscrits - b.get(a)!.inscrits || a.localeCompare(c))[0];
    const o = out.get(owner)!;
    out.set(owner, { ...o, ga: o.ga + g });
  }
  return out;
}

/**
 * Communes estimées : quand l'export Action Populaire donne le nombre d'actions des groupes, le nombre de
 * groupes actifs (5 actions ou plus) est compté commune par commune (code INSEE retrouvé par code postal et
 * ville), plus fiable que la répartition par code postal du bilan.
 */
export function gaFromGroupes(b: Map<string, Bilan>, groupes: Groupe[]): Map<string, Bilan> {
  const withActions = groupes.filter((g) => g.actions != null);
  if (withActions.length < 10) return b;
  const n = new Map<string, number>();
  for (const g of withActions) if ((g.actions ?? 0) >= 5) n.set(g.code, (n.get(g.code) ?? 0) + 1);
  const out = new Map(b);
  for (const [code, x] of b) if (x.estime) out.set(code, { ...x, ga: n.get(code) ?? 0 });
  return out;
}

/**
 * Municipales 2026, listes soutenues par LFI (classeur de synthèse interne) : un onglet par situation
 * (liste LFI, union de la gauche menée par LFI, tête de liste d'une autre organisation avec LFI…),
 * une ligne par commune ; la 1re colonne donne le statut. Seules les lignes « Ok » comptent
 * (« En attente » et « Planté », en orange et rouge dans le classeur : pas investies).
 */
export interface ListeLfi {
  code: string;
  situation: string;
  statut: string;
  /** Têtes de liste « Prénom NOM » (une ou deux). */
  tdl: string[];
}

/** Situation (phrase de la fiche) d'après le nom de l'onglet. */
export function situationOf(sheet: string): string {
  const s = sheet.trim();
  if (/^liste\s*&\s*tdl\s*fi$/i.test(s)) return "liste LFI";
  if (/^ug\s*tdl\s*fi$/i.test(s)) return "liste d'union de la gauche menée par LFI";
  if (/dvg|se\b|cit/i.test(s) && /^tdl/i.test(s)) return "liste divers gauche, sans étiquette ou citoyenne, avec LFI";
  if (/eelv|[ée]colo/i.test(s)) return "liste menée par les Écologistes, avec LFI";
  if (/pcf/i.test(s)) return "liste menée par le PCF, avec LFI";
  if (/g\.?\s*s\b|g[ée]n[ée]ration/i.test(s)) return "liste menée par Génération.s, avec LFI";
  if (/\bps\b/i.test(s)) return "liste menée par le PS, avec LFI";
  if (/non identifi/i.test(s)) return "liste avec LFI (tête de liste non identifiée)";
  return "liste soutenue par LFI";
}

/** Onglets « ## Sheet name: … » (export texte d'un classeur Google) → onglets en lignes. */
export function splitSheetsText(text: string): { name: string; rows: string[][] }[] {
  const parts = text.replace(/^\uFEFF/, "").split(/^## Sheet name:\s*/m).filter((x) => x.trim());
  return parts.map((p) => {
    const nl = p.indexOf("\n");
    const name = (nl < 0 ? p : p.slice(0, nl)).trim();
    const body = nl < 0 ? "" : p.slice(nl + 1);
    const rows = Papa.parse<string[]>(body, { header: false, skipEmptyLines: true, delimiter: detectDelimiter(body) || "," }).data;
    return { name, rows };
  });
}

/** Secteurs de Paris et de Marseille → codes des arrondissements. */
const MARSEILLE_SECTEURS: Record<number, number[]> = { 1: [1, 7], 2: [2, 3], 3: [4, 5], 4: [6, 8], 5: [9, 10], 6: [11, 12], 7: [13, 14], 8: [15, 16] };
export function arrondissementsOf(nom: string): string[] {
  const m = nom.match(/^marseille\s+(\d)\s*(?:er|e|ème)?\s+secteur/i);
  if (m) return (MARSEILLE_SECTEURS[Number(m[1])] ?? []).map((a) => `132${String(a).padStart(2, "0")}`);
  const p = nom.match(/^paris\s+([\d,\s]+(?:et\s+\d+)?)\s*(?:e|er|ème)?\s*$/i);
  if (p) return [...p[1].matchAll(/\d+/g)].map((x) => Number(x[0])).filter((a) => a >= 1 && a <= 20).map((a) => `751${String(a).padStart(2, "0")}`);
  return [];
}

export function parseMunicipalesLfi(sheets: { name: string; rows: string[][] }[]): { listes: ListeLfi[]; unmatched: string[] } {
  const listes: ListeLfi[] = [];
  const unmatched: string[] = [];
  const n = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/œ/g, "oe").replace(/\bst\b/g, "saint").replace(/[^a-z0-9]+/g, " ").trim();
  const strip = (x: string) => x.replace(/^(le|la|les|l) /, "");
  for (const sh of sheets) {
    const hi = sh.rows.findIndex((r) => r.some((c) => /^commune$/i.test(c.trim())));
    if (hi < 0) continue;
    const head = sh.rows[hi].map((c) => c.trim());
    const ix = (re: RegExp) => head.findIndex((c) => re.test(c));
    const cCom = ix(/^commune$/i);
    const cDep = ix(/^d[ée]partement$/i);
    const cPop = ix(/^population$/i);
    const tdl = [1, 2].map((k) => [ix(new RegExp(`^tdl ${k} pr[ée]nom$`, "i")), ix(new RegExp(`^tdl ${k} nom$`, "i"))] as const);
    const situation = situationOf(sh.name);
    const tdlOf = (r: string[]) => tdl.map(([a, b]) => [a >= 0 ? r[a] : "", b >= 0 ? r[b] : ""].map((x) => (x ?? "").trim()).filter(Boolean).join(" ")).filter(Boolean);
    for (const r of sh.rows.slice(hi + 1)) {
      const nom = (r[cCom] ?? "").trim();
      if (!nom) continue;
      const depRaw = cDep >= 0 ? (r[cDep] ?? "").trim() : "";
      const dep = (depRaw.match(/^(\d[\dAB]\d?)\b/i)?.[1] ?? "").toUpperCase().padStart(2, "0");
      const pop = cPop >= 0 ? Number(String(r[cPop] ?? "").replace(/\s/g, "")) : NaN;
      // Paris (« Paris 1, 2, 3 et 4 ») et Marseille (« Marseille 3e secteur ») : les arrondissements du secteur.
      const arr = arrondissementsOf(nom);
      if (arr.length) {
        for (const code of arr) listes.push({ code, situation, statut: (r[0] ?? "").trim(), tdl: tdlOf(r) });
        continue;
      }
      let cands = searchCommunes(nom, 30).filter((c) => !dep || c.departement === dep || (dep.length === 2 && c.departement.startsWith(dep)));
      let exact = cands.filter((c) => n(c.nom) === n(nom) || strip(n(c.nom)) === strip(n(nom)));
      // Département mal saisi (« Vichy, 63 ») : nom exact et unique en France.
      if (!exact.length) {
        const all = searchCommunes(nom, 30).filter((c) => n(c.nom) === n(nom) || strip(n(c.nom)) === strip(n(nom)));
        if (all.length === 1) (exact = all), (cands = all);
      }
      const pick = (exact.length ? exact : cands).sort((a, b) => (Number.isFinite(pop) ? Math.abs((a.population ?? 0) - pop) - Math.abs((b.population ?? 0) - pop) : (b.population ?? 0) - (a.population ?? 0)))[0];
      if (!pick || (!exact.length && cands.length !== 1)) {
        unmatched.push(`${nom}${depRaw ? ` (${depRaw})` : ""}`);
        continue;
      }
      listes.push({
        code: pick.code,
        situation,
        statut: (r[0] ?? "").trim(),
        tdl: tdlOf(r),
      });
    }
  }
  return { listes, unmatched };
}

/** Listes → CSV compact enregistré dans data/interne/municipales-lfi.csv. */
export function listesLfiToCsv(listes: ListeLfi[]): string {
  const q = (x: string) => (/[;"\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
  return ["code_insee;situation;statut;tdl", ...listes.map((l) => [l.code, l.situation, l.statut, l.tdl.join(" / ")].map(q).join(";"))].join("\n") + "\n";
}

/** Statut « Ok » : liste investie (les autres ne comptent pas comme listes LFI). */
export const investie = (l: ListeLfi) => /^ok$/i.test(l.statut.trim());

/** Classeur ou CSV du bilan → CSV compact enregistré dans data/interne/bilan.csv. */
export function bilanToCsv(rows: Record<string, string>[]) {
  const b = parseBilan(rows);
  const lines = ["code_insee;nb_actions;nb_ga_actifs;nb_parrains;inscrits;estime"];
  for (const [k, x] of b) lines.push([k, x.actions, x.ga, x.parrains, x.inscrits, x.estime ? 1 : 0].join(";"));
  return { csv: lines.join("\n") + "\n", n: b.size };
}

export async function loadInternalData(dir = internalDir()): Promise<InternalData> {
  const out: InternalData = { parrains: new Map(), groupes: [], files: [], unmatched: 0 };
  try {
    const rows = await readCsv(path.join(dir, "parrains.csv"));
    for (const r of rows) {
      const cols = Object.keys(r);
      const cCode = findCol(cols, /^code_?(commune|insee)$/i, /code/i);
      const cN = findCol(cols, /^parrains?$/i, /parrain/i, /nombre/i);
      if (!cCode || !cN) continue;
      const v = num(r[cN]);
      if (v != null) out.parrains.set(String(r[cCode]).trim().padStart(5, "0"), v);
    }
    out.files.push("parrains.csv");
  } catch {
    /* fichier absent */
  }
  try {
    const rows = await readCsv(path.join(dir, "municipales-lfi.csv"));
    const m = new Map<string, ListeLfi[]>();
    for (const r of rows) {
      const code = String(r.code_insee ?? "").trim();
      if (!code) continue;
      const l: ListeLfi = { code, situation: String(r.situation ?? ""), statut: String(r.statut ?? ""), tdl: String(r.tdl ?? "").split(" / ").map((x) => x.trim()).filter(Boolean) };
      m.set(code, [...(m.get(code) ?? []), l]);
    }
    if (m.size) out.listesLfi = m;
    out.files.push("municipales-lfi.csv");
  } catch {
    /* fichier absent */
  }
  try {
    const rows = await readCsv(path.join(dir, "bilan.csv"));
    const b = new Map<string, Bilan>();
    for (const r of rows) {
      const code = String(r.code_insee ?? "").trim();
      const x = { actions: num(r.nb_actions) ?? 0, ga: num(r.nb_ga_actifs) ?? 0, parrains: num(r.nb_parrains) ?? 0, inscrits: num(r.inscrits) ?? 0, estime: r.estime === "1" };
      if (code && x.inscrits) b.set(code, x);
    }
    if (b.size) {
      out.bilan = dedupeBilanGa(b);
      // Parrains manquants (pas de parrains.csv, ou commune absente) : repris du bilan.
      for (const [k, x] of b) if (!out.parrains.has(k)) out.parrains.set(k, Math.round(x.parrains));
      out.files.push("bilan.csv");
    }
  } catch {
    /* fichier absent */
  }
  for (const f of ["groupes.csv", "action-populaire.csv"]) {
    try {
      const p = parseGroupes(await readCsv(path.join(dir, f)), f);
      // Un même groupe présent dans les deux fichiers n'est compté qu'une fois.
      for (const g of p.groupes) if (!out.groupes.some((x) => x.code === g.code && x.nom.toLowerCase() === g.nom.toLowerCase())) out.groupes.push(g);
      out.unmatched! += p.unmatched;
      out.files.push(f);
    } catch {
      /* fichier absent */
    }
  }
  if (out.bilan) {
    out.bilan = gaFromGroupes(out.bilan, out.groupes);
    const t = { actions: 0, ga: 0, parrains: 0, inscrits: 0 };
    for (const x of out.bilan.values()) {
      t.actions += x.actions;
      t.ga += x.ga;
      t.parrains += x.parrains;
      t.inscrits += x.inscrits;
    }
    out.bilanFrance = t;
    // Les groupes d'action sont rattachés à beaucoup de petites communes : la moyenne nationale
    // n'est pas comparable d'une taille de commune à l'autre.
    out.bilanTranches = BILAN_TRANCHES.map(([min, max]) => {
      const z = { min, max, communes: 0, actions: 0, ga: 0, parrains: 0, inscrits: 0 };
      for (const x of out.bilan!.values())
        if (x.inscrits >= min && x.inscrits < max) {
          z.communes++;
          z.actions += x.actions;
          z.ga += x.ga;
          z.parrains += x.parrains;
          z.inscrits += x.inscrits;
        }
      return z;
    });
  }
  return out;
}

/** Résumé des fichiers internes présents (page « Données internes »). */
export async function internalSummary(dir = internalDir()) {
  const d = await loadInternalData(dir);
  const files = [];
  for (const f of INTERNAL_FILES) {
    try {
      const st = await fs.stat(path.join(dir, f));
      files.push({ name: f, size: st.size, updatedAt: st.mtime.toISOString() });
    } catch {
      /* absent */
    }
  }
  return { files, parrains: d.parrains.size, groupes: d.groupes.length, unmatched: d.unmatched ?? 0, bilan: d.bilan?.size ?? 0 };
}
