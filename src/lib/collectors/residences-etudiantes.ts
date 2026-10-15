import { promises as fs } from "node:fs";
import path from "node:path";
import * as turf from "@turf/turf";
import { internalDir } from "./interne";
import { readXlsx, sheetObjects } from "./xlsx";
import embedded from "./data/residences-etudiantes.json";

/**
 * Catalogue des résidences étudiantes et foyers de jeunes travailleurs
 * (« Mon Logement Étudiant », Crous et hors Crous), relevé et mis en forme
 * par les militants (classeur Excel actualisé chaque mois).
 *
 * Ordre de lecture :
 *  1. classeur déposé depuis « Données internes »
 *     (data/interne/residences-etudiantes.xlsx) ;
 *  2. copie embarquée dans l'application (data/residences-etudiantes.json),
 *     produite par `npm run import:residences -- <fichier.xlsx>`.
 */

export interface ResidenceEtudiante {
  id: string;
  nom: string;
  adresse: string;
  cp: string;
  ville: string;
  logements: number | null;
  crous: boolean;
  categorie: string;
  gestionnaire: string;
  lat: number;
  lon: number;
}

export interface Catalogue {
  list: ResidenceEtudiante[];
  /** Date de relevé du catalogue (AAAA-MM-JJ). */
  retrievedAt: string;
  origin: "interne" | "embarque";
}

export const CATALOGUE_FILE = "residences-etudiantes.xlsx";
export const CATALOGUE_URL = "https://monlogementetudiant.beta.gouv.fr/trouver-un-logement-etudiant";

/**
 * Lieux où le porte-à-porte est systématiquement proposé : résidences
 * étudiantes du Crous et foyers de jeunes travailleurs.
 */
export function isPorteAPorte(r: Pick<ResidenceEtudiante, "categorie" | "gestionnaire">): boolean {
  return (/^r[ée]sidence [ée]tudiante$/i.test(r.categorie.trim()) && /crous/i.test(r.gestionnaire)) || /foyer de jeunes travailleurs/i.test(r.categorie);
}

const num = (v: string) => {
  const s = String(v ?? "").replace(/\s/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Date Excel (numéro de série) ou texte ISO → AAAA-MM-JJ. */
const isoDate = (v: string) => {
  const n = Number(v);
  if (v && Number.isFinite(n) && n > 20000) return new Date(Math.round((n - 25569) * 86400_000)).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "";
};

/** Colonne repérée par son intitulé (insensible à la casse et aux accents). */
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function col(row: Record<string, string>, re: RegExp): string {
  const k = Object.keys(row).find((x) => re.test(norm(x)));
  return k ? row[k] : "";
}

/** Lecture du classeur (onglets « Résidences » et « Adresses »). */
export function parseCatalogue(buf: Uint8Array): Omit<Catalogue, "origin"> {
  const sheets = readXlsx(buf);
  const find = (re: RegExp) => [...sheets.entries()].find(([n]) => re.test(norm(n)))?.[1] ?? [];
  const res = sheetObjects(find(/^residences/), /^ID r[ée]sidence$/i);
  const adr = sheetObjects(find(/^adresses/), /^ID r[ée]sidence$/i);
  const coords = new Map<string, { lat: number; lon: number }>();
  for (const a of adr) {
    const id = col(a, /^id residence/);
    const lat = num(col(a, /^latitude/));
    const lon = num(col(a, /^longitude/));
    if (!id || lat == null || lon == null) continue;
    // Adresse principale en priorité.
    if (!coords.has(id) || /principale/i.test(col(a, /principale \/ secondaire|^type d.adresse/))) coords.set(id, { lat, lon });
  }
  let retrievedAt = "";
  const list: ResidenceEtudiante[] = [];
  for (const r of res) {
    const id = col(r, /^id residence/);
    const pt = coords.get(id);
    if (!id || !pt) continue;
    const d = isoDate(col(r, /^date de recuperation/));
    if (d > retrievedAt) retrievedAt = d;
    list.push({
      id,
      nom: col(r, /^nom du logement/),
      adresse: col(r, /^adresse principale/),
      cp: col(r, /^code postal/).padStart(5, "0"),
      ville: col(r, /^ville/),
      logements: num(col(r, /^nombre total de logements/)),
      crous: /^crous$/i.test(col(r, /^crous ou hors crous/).trim()),
      categorie: col(r, /^categorie de residence/) || "Non renseignée",
      gestionnaire: col(r, /^gestionnaire/),
      lat: pt.lat,
      lon: pt.lon,
    });
  }
  return { list, retrievedAt };
}

let memo: { key: string; cat: Catalogue } | null = null;

export async function loadCatalogue(): Promise<Catalogue> {
  const file = path.join(internalDir(), CATALOGUE_FILE);
  try {
    const st = await fs.stat(file);
    const key = `${file}|${st.mtimeMs}`;
    if (memo?.key === key) return memo.cat;
    const cat: Catalogue = { ...parseCatalogue(new Uint8Array(await fs.readFile(file))), origin: "interne" };
    if (cat.list.length) {
      memo = { key, cat };
      return cat;
    }
  } catch {
    /* pas de classeur déposé ou classeur illisible : copie embarquée */
  }
  const e = embedded as { retrievedAt: string; list: ResidenceEtudiante[] };
  return { list: e.list, retrievedAt: e.retrievedAt, origin: "embarque" };
}

const simple = (s: string) => norm(s).replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Résidences d'une commune : position dans le contour communal, ou à défaut
 * code postal et nom de ville.
 */
export function residencesOf(list: ResidenceEtudiante[], commune: { nom: string; codesPostaux?: string[]; contour?: GeoJSON.Geometry | null }): ResidenceEtudiante[] {
  if (commune.contour && (commune.contour.type === "Polygon" || commune.contour.type === "MultiPolygon")) {
    const poly = turf.feature(commune.contour as GeoJSON.Polygon | GeoJSON.MultiPolygon);
    const bb = turf.bbox(poly);
    return list.filter((r) => r.lon >= bb[0] && r.lon <= bb[2] && r.lat >= bb[1] && r.lat <= bb[3] && turf.booleanPointInPolygon([r.lon, r.lat], poly));
  }
  const nom = simple(commune.nom);
  return list.filter((r) => simple(r.ville) === nom && (!commune.codesPostaux?.length || commune.codesPostaux.includes(r.cp)));
}
