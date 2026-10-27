import type { TrackedHttp } from "./context";
import { num } from "./datagouv";
import { splitCsvLine, zipCsvRows, zipLines } from "./zip";
import { cachedExtract, heavyLane } from "../runtime";

/**
 * Base permanente des équipements (INSEE, BPE 2025) : services de santé,
 * services publics et commerces, géolocalisés. Remplace les comptages
 * OpenStreetMap pour qualifier l'offre de services (désert médical,
 * fermetures de services publics). Fichier national (≈ 136 Mo) lu en flux ;
 * seules les lignes du département et des types retenus sont conservées.
 */

export const BPE_URL = process.env.INSEE_BPE_URL ?? "https://www.insee.fr/fr/statistiques/fichier/8217525/BPE25.zip";
export const BPE_VINTAGE = "2025";

/** Types d'équipements retenus (codes TYPEQU de la BPE 2025). */
export type BpeGroup = "sante" | "public" | "commerce" | "education" | "securite" | "transport" | "culture";
export const BPE_TYPES: Record<string, { label: string; group: BpeGroup }> = {
  D265: { label: "Médecins généralistes", group: "sante" },
  D277: { label: "Chirurgiens-dentistes", group: "sante" },
  D281: { label: "Infirmiers", group: "sante" },
  D307: { label: "Pharmacies", group: "sante" },
  D108: { label: "Centres de santé", group: "sante" },
  D106: { label: "Urgences", group: "sante" },
  D107: { label: "Maternités", group: "sante" },
  D502: { label: "Crèches", group: "education" },
  D509: { label: "Micro-crèches", group: "education" },
  A128: { label: "France Services", group: "public" },
  A122: { label: "Agences France Travail", group: "public" },
  A206: { label: "Bureaux de poste", group: "public" },
  A207: { label: "Relais poste", group: "public" },
  A208: { label: "Agences postales", group: "public" },
  A203: { label: "Banques", group: "public" },
  A101: { label: "Commissariats de police", group: "securite" },
  A140: { label: "Police", group: "securite" },
  A104: { label: "Gendarmeries", group: "securite" },
  B104: { label: "Hypermarchés", group: "commerce" },
  B105: { label: "Supermarchés", group: "commerce" },
  C101: { label: "Écoles maternelles", group: "education" },
  C104: { label: "Écoles élémentaires", group: "education" },
  C107: { label: "Écoles maternelles", group: "education" },
  C108: { label: "Écoles élémentaires", group: "education" },
  C109: { label: "Écoles primaires", group: "education" },
  C201: { label: "Collèges", group: "education" },
  C301: { label: "Lycées généraux et technologiques", group: "education" },
  C302: { label: "Lycées professionnels", group: "education" },
  C303: { label: "Lycées agricoles", group: "education" },
  E107: { label: "Gares d'intérêt national", group: "transport" },
  E108: { label: "Gares d'intérêt régional", group: "transport" },
  E109: { label: "Gares d'intérêt local", group: "transport" },
  F307: { label: "Bibliothèques", group: "culture" },
  F101: { label: "Piscines", group: "culture" },
  F303: { label: "Cinémas", group: "culture" },
};

export interface BpeEquipement {
  type: string;
  nom: string;
  commune: string;
  lon: number | null;
  lat: number | null;
  qp: string | null;
  adresse: string;
}

/**
 * La BPE diffusée est « anonymisée » : le nom de certains établissements
 * privés est masqué. On le remplace alors par le type et l'adresse.
 */
export const isMaskedName = (n: string) => !n.trim() || /anonym|annonim|^n\.?d\.?$|^x+$|^confidentiel/i.test(n.trim());

export interface BpeResult {
  /** Équipements de la commune. */
  commune: BpeEquipement[];
  /** Équipements du département (accessibilité : le plus proche peut être dans la commune voisine). */
  departement?: BpeEquipement[];
  /** Comptes par type et par commune du département. */
  countsByCommune: Map<string, Record<string, number>>;
  /** Comptes par type pour le département. */
  countsDep: Record<string, number>;
  url: string;
  retrievedAt: string;
}

type BpeDep = Omit<BpeResult, "commune"> & { all: BpeEquipement[] };

export async function collectBpe(http: TrackedHttp, codeInsee: string, dep: string): Promise<BpeResult> {
  const d = await cachedExtract<BpeDep>(`bpe3|${BPE_VINTAGE}|${dep}`, 24 * 30, () => heavyLane.run(() => bpeDepartement(http, dep)));
  return { commune: d.all.filter((e) => e.commune === codeInsee), departement: d.all, countsByCommune: d.countsByCommune, countsDep: d.countsDep, url: d.url, retrievedAt: d.retrievedAt };
}

async function bpeDepartement(http: TrackedHttp, dep: string): Promise<BpeDep> {
  {
    const f = await http.file(BPE_URL, { timeoutMs: 1800000, retries: 1 });
    const { rows } = await zipCsvRows(
      f.data,
      (n) => /\.csv$/i.test(n) && !/varmod|dessin|meta/i.test(n),
      (r) => (r.DEP ?? r.DEPCOM?.slice(0, dep.length)) === dep && !!BPE_TYPES[r.TYPEQU],
      (line) => line.includes(dep) && Object.keys(BPE_TYPES).some((t) => line.includes(t)),
    );
    if (!rows.length) throw new Error(`Aucun équipement BPE lu pour le département ${dep}`);
    const all: BpeEquipement[] = rows.map((r) => ({
      type: r.TYPEQU,
      adresse: [r.NUMVOIE, r.INDREP, r.TYPVOIE, r.LIBVOIE].map((x) => (x ?? "").trim()).filter(Boolean).join(" ").toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()),
      nom: isMaskedName(r.NOMRS ?? "") ? (isMaskedName(r.CNOMRS ?? "") ? "" : r.CNOMRS.trim()) : r.NOMRS.trim(),
      commune: r.DEPCOM,
      lon: num(r.LONGITUDE),
      lat: num(r.LATITUDE),
      qp: r.QP2024 && !/^(CSZ|HZ|_Z)$/i.test(r.QP2024) ? r.QP2024 : null,
    }));
    const countsByCommune = new Map<string, Record<string, number>>();
    const countsDep: Record<string, number> = {};
    for (const e of all) {
      if (!countsByCommune.has(e.commune)) countsByCommune.set(e.commune, {});
      const c = countsByCommune.get(e.commune)!;
      c[e.type] = (c[e.type] ?? 0) + 1;
      countsDep[e.type] = (countsDep[e.type] ?? 0) + 1;
    }
    return { all, countsByCommune, countsDep, url: BPE_URL, retrievedAt: f.retrievedAt };
  }
}

/* ------------------------------------------------ toute la France (référence nationale) */

/** Équipements des types retenus, pour toute la France : coordonnées et commune, par type. */
export interface BpeNational {
  /** Par type : [lon, lat] (NaN si inconnues) et code commune, en tableaux parallèles. */
  byType: Record<string, { lon: number[]; lat: number[]; commune: string[] }>;
}

/** Lecture en flux du fichier national, sans garder les lignes entières (≈ 450 000 équipements). */
export async function readBpeNational(http: TrackedHttp): Promise<BpeNational & { url: string; retrievedAt: string }> {
  const f = await http.file(BPE_URL, { timeoutMs: 1800000, retries: 1 });
  const byType: BpeNational["byType"] = {};
  let col: Record<string, number> | null = null;
  const types = new Set(Object.keys(BPE_TYPES));
  await zipLines(
    f.data,
    (n) => /\.csv$/i.test(n) && !/varmod|dessin|meta/i.test(n),
    (_e, line, i) => {
      const v = splitCsvLine(line, ";").map((x) => x.replace(/^"|"$/g, ""));
      if (i === 0) {
        col = Object.fromEntries(v.map((h, k) => [h.trim(), k]));
        return;
      }
      const type = v[col!.TYPEQU];
      if (!types.has(type)) return;
      const t = (byType[type] ??= { lon: [], lat: [], commune: [] });
      const lon = num(v[col!.LONGITUDE]);
      const lat = num(v[col!.LATITUDE]);
      t.lon.push(lon ?? NaN);
      t.lat.push(lat ?? NaN);
      t.commune.push(v[col!.DEPCOM]);
    },
  );
  return { byType, url: BPE_URL, retrievedAt: f.retrievedAt };
}
