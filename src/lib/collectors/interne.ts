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

export const INTERNAL_FILES = ["parrains.csv", "groupes.csv", "action-populaire.csv", "bilan.csv"] as const;

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
  const byCp = new Map<string, string[]>();
  for (const [code, x] of b) {
    if (!x.estime || x.ga <= 0) continue;
    for (const cp of ref.byCode.get(code)?.codesPostaux ?? []) {
      if (!byCp.has(cp)) byCp.set(cp, []);
      byCp.get(cp)!.push(code);
    }
  }
  const out = new Map(b);
  for (const [code, x] of b) {
    if (!x.estime || x.ga <= 0) continue;
    const sib = [...new Set((ref.byCode.get(code)?.codesPostaux ?? []).flatMap((cp) => byCp.get(cp) ?? []))].filter((k) => k !== code);
    // Plus grand voisin du même code postal avec au moins autant de groupes : les groupes sont les siens.
    const owner = sib.find((k) => {
      const y = b.get(k)!;
      return y.ga >= x.ga && (y.inscrits > x.inscrits || (y.inscrits === x.inscrits && k < code));
    });
    if (owner) out.set(code, { ...x, ga: 0 });
  }
  return out;
}

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
    const rows = await readCsv(path.join(dir, "bilan.csv"));
    const b = new Map<string, Bilan>();
    for (const r of rows) {
      const code = String(r.code_insee ?? "").trim();
      const x = { actions: num(r.nb_actions) ?? 0, ga: num(r.nb_ga_actifs) ?? 0, parrains: num(r.nb_parrains) ?? 0, inscrits: num(r.inscrits) ?? 0, estime: r.estime === "1" };
      if (code && x.inscrits) b.set(code, x);
    }
    if (b.size) {
      out.bilan = dedupeBilanGa(b);
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
