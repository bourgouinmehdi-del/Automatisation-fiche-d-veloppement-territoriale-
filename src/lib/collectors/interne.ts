import { promises as fs } from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { config } from "../config";
import { detectDelimiter, findCol } from "./elections";

/**
 * Données militantes internes, FACULTATIVES, fournies par l'utilisateur
 * dans `data/interne/` (jamais versionnées : voir .gitignore) :
 *
 *  parrains.csv  — code_commune ; parrains
 *                  (nombre de parrainages par commune, ex. JLM27)
 *  groupes.csv   — code_commune ; nom ; membres ; statut ; description
 *                  (groupes d'action locaux, ex. export Action Populaire)
 *
 * Seuls des agrégats par commune sont attendus : aucun nom de personne.
 * Séparateur « ; » ou « , » détecté automatiquement.
 */

export interface InternalData {
  parrains: Map<string, number>;
  groupes: { code: string; nom: string; membres: number | null; statut: string; description: string }[];
  files: string[];
}

async function readCsv(file: string) {
  const text = await fs.readFile(file, "utf8");
  return Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: true, delimiter: detectDelimiter(text) }).data;
}

const num = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export async function loadInternalData(dir = path.join(config.dataDir, "interne")): Promise<InternalData> {
  const out: InternalData = { parrains: new Map(), groupes: [], files: [] };
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
    const rows = await readCsv(path.join(dir, "groupes.csv"));
    for (const r of rows) {
      const cols = Object.keys(r);
      const cCode = findCol(cols, /^code_?(commune|insee)$/i, /code/i);
      if (!cCode) continue;
      const g = (re: RegExp) => {
        const c = findCol(cols, re);
        return c ? String(r[c] ?? "").trim() : "";
      };
      out.groupes.push({ code: String(r[cCode]).trim().padStart(5, "0"), nom: g(/^nom/i), membres: num(g(/membre|inscrit/i)), statut: g(/statut|etat|état/i), description: g(/descr|note|comment/i) });
    }
    out.files.push("groupes.csv");
  } catch {
    /* fichier absent */
  }
  return out;
}
