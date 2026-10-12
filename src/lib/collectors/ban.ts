import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import type { TrackedHttp } from "./context";
import { guessSep, splitCsvLine } from "./zip";
import { cachedExtract, heavyLane } from "../runtime";

/**
 * Base adresse nationale (BAN) : adresses d'une commune (numéro, voie,
 * position), lues dans le fichier départemental compressé, en flux. Elles
 * servent à dresser, pour chaque bureau de vote prioritaire, la liste des rues
 * et numéros à couvrir en porte-à-porte.
 */

export const BAN_URL = (dep: string) => process.env.BAN_URL?.replace("{dep}", dep) ?? `https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-${dep}.csv.gz`;

export interface Adresse {
  numero: number | null;
  rep: string;
  voie: string;
  lon: number;
  lat: number;
}

export interface AdressesResult {
  adresses: Adresse[];
  url: string;
  retrievedAt: string;
}

/** Adresses de la commune, gardées 30 jours sur disque. */
export function collectAdresses(http: TrackedHttp, codeInsee: string, dep: string): Promise<AdressesResult> {
  return cachedExtract(`ban|${codeInsee}`, 24 * 30, () => heavyLane.run(() => readAdresses(http, codeInsee, dep)), (v) => v.adresses.length > 0);
}

async function readAdresses(http: TrackedHttp, codeInsee: string, dep: string): Promise<AdressesResult> {
  const url = BAN_URL(dep);
  const f = await http.file(url, { timeoutMs: 600000, retries: 1 });
  const adresses = await parseBanFile(f.data, codeInsee);
  if (!adresses.length) throw new Error(`Aucune adresse de la commune ${codeInsee} dans la BAN (${dep})`);
  return { adresses, url, retrievedAt: f.retrievedAt };
}

/** Lecture en flux d'un fichier BAN (.csv.gz ou .csv) ; seules les lignes de la commune sont gardées. */
export async function parseBanFile(file: string, codeInsee: string): Promise<Adresse[]> {
  const input = createReadStream(file);
  const gz = file.endsWith(".gz") || (await isGzip(file));
  const rl = readline.createInterface({ input: gz ? input.pipe(createGunzip()) : input, crlfDelay: Infinity });
  let head: string[] | null = null;
  let sep = ";";
  let idx = { numero: -1, rep: -1, voie: -1, insee: -1, lon: -1, lat: -1 };
  const out: Adresse[] = [];
  for await (const line of rl) {
    if (!head) {
      sep = guessSep(line);
      head = splitCsvLine(line.replace(/^﻿/, ""), sep).map((h) => h.trim().toLowerCase());
      const at = (...names: string[]) => head!.findIndex((h) => names.includes(h));
      idx = { numero: at("numero"), rep: at("rep", "suffixe"), voie: at("nom_voie", "voie_nom"), insee: at("code_insee", "commune_insee"), lon: at("lon", "long"), lat: at("lat") };
      if (idx.insee < 0 || idx.voie < 0 || idx.lon < 0 || idx.lat < 0) throw new Error("Colonnes de la BAN non reconnues");
      continue;
    }
    if (!line.includes(codeInsee)) continue;
    const v = splitCsvLine(line, sep);
    if (v[idx.insee] !== codeInsee) continue;
    const lon = Number(v[idx.lon]);
    const lat = Number(v[idx.lat]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const num = idx.numero >= 0 ? Number(v[idx.numero]) : NaN;
    // Numéro 99999 : convention BAN pour un lieu-dit sans numéro.
    out.push({ numero: Number.isFinite(num) && num > 0 && num < 99999 ? num : null, rep: idx.rep >= 0 ? (v[idx.rep] ?? "").trim() : "", voie: (v[idx.voie] ?? "").trim(), lon, lat });
  }
  return out;
}

async function isGzip(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createReadStream(file, { start: 0, end: 1 });
    s.once("data", (b) => resolve((b as Buffer)[0] === 0x1f && (b as Buffer)[1] === 0x8b));
    s.once("error", () => resolve(false));
    s.once("end", () => resolve(false));
  });
}
