import { promises as fs } from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { config } from "../config";
import { searchCommunes } from "./admin";
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

export interface InternalData {
  parrains: Map<string, number>;
  groupes: Groupe[];
  files: string[];
  /** Lignes non rattachées à une commune (export Action Populaire). */
  unmatched?: number;
}

export const INTERNAL_FILES = ["parrains.csv", "groupes.csv", "action-populaire.csv"] as const;

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
  return { files, parrains: d.parrains.size, groupes: d.groupes.length, unmatched: d.unmatched ?? 0 };
}
