import Papa from "papaparse";
import proj4 from "proj4";
import * as turf from "@turf/turf";
import type { TrackedHttp } from "./context";
import { detectDelimiter } from "./elections";
import { cachedExtract } from "../runtime";

/**
 * Logements sociaux : Répertoire des logements locatifs des bailleurs sociaux
 * (RPLS, SDES), données détaillées au logement, interrogées commune par commune
 * sur l'API DiDo du ministère. Chaque ligne est un logement, avec son adresse,
 * le nom du programme (résidence) et ses coordonnées.
 *
 * Les logements sont regroupés en résidences (même programme, ou même adresse),
 * puis les résidences proches en « ensembles » (moins de 120 m entre deux
 * résidences), qui sont les zones de porte-à-porte de la carte.
 */

export const RPLS_DATAFILE = process.env.RPLS_DATAFILE ?? "f3c2f2cb-8fb1-40fd-8733-964247744c9a";
export const DIDO = "https://data.statistiques.developpement-durable.gouv.fr/dido/api/v1";
const COLUMNS = ["DEPCOM", "NUMVOIE", "INDREP", "TYPVOIE", "NOMVOIE", "COMPLGEO", "PLG_QP24", "QPV_CODE", "X", "Y", "EPSG", "CONSTRUCT"];

// Systèmes de coordonnées du RPLS (métropole et outre-mer).
proj4.defs("EPSG:2154", "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:5490", "+proj=utm +zone=20 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:2972", "+proj=utm +zone=22 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:2975", "+proj=utm +zone=40 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:4471", "+proj=utm +zone=38 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

export interface Residence {
  nom: string;
  adresse: string;
  logements: number;
  lon: number;
  lat: number;
  qpv: string | null;
  /** Année de construction la plus fréquente. */
  annee: number | null;
  /** Voie (« Allée Nicolas Copernic ») et numéros de la résidence. */
  voie?: string;
  nums?: string[];
}

/** Rue regroupant plusieurs résidences proches (porte-à-porte rue par rue). */
export interface RueHlm {
  voie: string;
  nums: string[];
  logements: number;
  lon: number;
  lat: number;
  qpv: string | null;
  /** Noms de programme (résidences nommées) de la rue. */
  noms: string[];
}

export interface Ensemble {
  nom: string;
  logements: number;
  residences: number;
  /** Positions des résidences (pour dessiner la zone). */
  points: [number, number][];
  lon: number;
  lat: number;
  qpv: string | null;
}

export interface RplsResult {
  total: number;
  residences: Residence[];
  ensembles: Ensemble[];
  url: string;
  retrievedAt: string;
  millesime: string | null;
}

const clean = (s: unknown) => String(s ?? "").trim();

// Types de voie abrégés du répertoire.
const TYPVOIE: Record<string, string> = { AV: "Avenue", AVE: "Avenue", BD: "Boulevard", BLD: "Boulevard", ALL: "Allée", ALLE: "Allée", CHE: "Chemin", CHEM: "Chemin", IMP: "Impasse", PL: "Place", SQ: "Square", RTE: "Route", R: "Rue", RES: "Résidence", CRS: "Cours", QU: "Quai", QUA: "Quai", PROM: "Promenade", LOT: "Lotissement", HAM: "Hameau", PAS: "Passage", FG: "Faubourg", FBG: "Faubourg", CITE: "Cité", CTRE: "Centre", MAIL: "Mail", SEN: "Sente", VLA: "Villa", ESP: "Esplanade", RPT: "Rond-point" };

/**
 * Nom de programme exploitable (« Les Musiciens »), et non un code de gestion
 * (« A.h. », « 0401-03-5 », « Bat F/28 », « D09 »).
 */
export function isProgName(prog: string): boolean {
  const p = prog.trim();
  if (!p) return false;
  if (/^(r[ée]sidence|immeuble|logements?|programme)$/i.test(p)) return false;
  if (/^(b[aâ]t(iment)?|imm(euble)?|esc(alier)?|entr[ée]e|bloc|lot|cage|logt?|pav(illon)?|ilot|îlot|tranche|tr|lgt|log)\b\.?/i.test(p)) return false;
  const letters = (p.match(/[a-zà-ÿ]/gi) ?? []).length;
  const digits = (p.match(/\d/g) ?? []).length;
  if (letters < 4 || digits > 2 || letters < 0.7 * p.replace(/\s/g, "").length) return false;
  // Au moins un mot de quatre lettres (pas une suite d'initiales).
  return /[a-zà-ÿ]{4,}/i.test(p);
}

/** « Cité des Perrieres M,j » → « Cité des Perrieres » (suffixes de bâtiments). */
const tidyProg = (p: string) => p.replace(/[\s,-]+([A-Z](\s*[,/.-]\s*[A-Z])*\.?|\d+[A-Z]?|[A-Z]\d+)$/i, "").trim();
const title = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|[\s'-])([a-zà-ÿ])/g, (_m, a: string, c: string) => a + c.toUpperCase())
    .replace(/\b(De|Du|Des|La|Le|Les|Et|D|L|Sur|Sous|En|Aux?)\b/g, (w) => w.toLowerCase())
    .replace(/^./, (c) => c.toUpperCase())
    // Accents absents des fichiers en capitales (mots fréquents).
    .replace(/\b(Cite|Residence|Republique|General|Generale|Liberte|Egalite|Fraternite|Ecole|Eglise|Prefecture|Marechal|Hopital|Theatre)\b/g, (w) =>
      ({ Cite: "Cité", Residence: "Résidence", Republique: "République", General: "Général", Generale: "Générale", Liberte: "Liberté", Egalite: "Égalité", Fraternite: "Fraternité", Ecole: "École", Eglise: "Église", Prefecture: "Préfecture", Marechal: "Maréchal", Hopital: "Hôpital", Theatre: "Théâtre" })[w] ?? w,
    );

/** Coordonnées WGS84 d'un logement (selon le système déclaré, ou deviné). */
export function toLonLat(x: number, y: number, epsg: string): [number, number] | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return [x, y];
  const code = epsg.replace(/\D/g, "");
  const def = code && proj4.defs(`EPSG:${code}`) ? `EPSG:${code}` : x > 50000 && x < 1300000 && y > 6000000 && y < 7200000 ? "EPSG:2154" : null;
  if (!def) return null;
  try {
    return proj4(def, "WGS84", [x, y]) as [number, number];
  } catch {
    return null;
  }
}

const sortNums = (xs: string[]) => [...new Set(xs)].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));

/** « n° 2, 4 et 6 », « n° 2 à 18 » (plus de quatre numéros). */
/** Numéro lisible : « 0004 » → « 4 », « 4BIS » + « BIS » → « 4 bis », « 12 B » → « 12 bis ». */
export function numVoie(numvoie: string, indrep = ""): string {
  const IND: Record<string, string> = { B: "bis", BIS: "bis", T: "ter", TER: "ter", Q: "quater", QUATER: "quater", C: "quinquies" };
  const m = numvoie.trim().match(/^0*(\d+)\s*([A-Za-z]*)(?:\s+([A-Za-z]+))?$/);
  if (!m) return [numvoie.trim(), indrep.trim().toLowerCase()].filter(Boolean).join(" ");
  const suf = (m[2] || m[3] || indrep.trim()).toUpperCase();
  const ind = suf ? (IND[suf] ?? suf.toLowerCase()) : "";
  return ind ? `${m[1]} ${ind}` : m[1];
}

/** Adresse dont le numéro est mal formé (« 0004 Rue… », « 4BIS BIS Rue… »). */
export function fixAdr(adr: string): string {
  return adr.replace(/^0*(\d+)\s*(bis|ter|quater|[btq])?(?:\s+(bis|ter|quater|[btq]))?(?=\s)/i, (_m, n: string, a?: string, b?: string) => numVoie(n, a || b || ""));
}

export function numsLabel(nums: string[]): string {
  if (!nums.length) return "";
  if (nums.length === 1) return `n° ${nums[0]}`;
  if (nums.length > 4) return `n° ${nums[0]} à ${nums[nums.length - 1]}`;
  return `n° ${nums.slice(0, -1).join(", ")} et ${nums[nums.length - 1]}`;
}

/**
 * Logements sociaux regroupés par rue : résidences d'une même voie à moins
 * de 250 m les unes des autres (une longue avenue peut donner deux groupes).
 */
export function hlmByStreet<T extends Residence>(residences: T[], keyOf?: (r: T) => string): (RueHlm & { items: T[] })[] {
  const byVoie = new Map<string, T[]>();
  for (const r of residences) {
    const v = `${(r.voie ?? r.adresse.replace(/^\d+\s*\w?\s+/, "")).toUpperCase()}|${keyOf ? keyOf(r) : ""}`;
    if (!byVoie.has(v)) byVoie.set(v, []);
    byVoie.get(v)!.push(r);
  }
  const out: (RueHlm & { items: T[] })[] = [];
  for (const rs of byVoie.values()) {
    const groups: T[][] = [];
    for (const r of [...rs].sort((a, b) => b.logements - a.logements)) {
      const g = groups.find((g) => g.some((x) => turf.distance([x.lon, x.lat], [r.lon, r.lat], { units: "kilometers" }) <= 0.25));
      if (g) g.push(r);
      else groups.push([r]);
    }
    for (const g of groups) {
      const n = g.reduce((s, r) => s + r.logements, 0);
      out.push({
        voie: g[0].voie ?? g[0].adresse.replace(/^\d+\s*\w?\s+/, ""),
        nums: sortNums(g.flatMap((r) => r.nums ?? [])),
        logements: n,
        lon: g.reduce((s, r) => s + r.lon * r.logements, 0) / n,
        lat: g.reduce((s, r) => s + r.lat * r.logements, 0) / n,
        qpv: g.find((r) => r.qpv)?.qpv ?? null,
        noms: [...new Set(g.filter((r) => r.nom !== r.adresse).map((r) => r.nom))],
        items: g,
      });
    }
  }
  return out.sort((a, b) => b.logements - a.logements);
}

/** Regroupe les lignes « logement » en résidences, puis en ensembles. */
export function groupRpls(rows: Record<string, unknown>[]): { total: number; residences: Residence[]; ensembles: Ensemble[] } {
  const res = new Map<string, { nom: string; adresse: string; voie: string; nums: Set<string>; n: number; xs: number[]; ys: number[]; qpv: string | null; years: Map<number, number> }>();
  let total = 0;
  for (const r of rows) {
    total++;
    const ll = toLonLat(Number(String(r.X ?? "").replace(",", ".")), Number(String(r.Y ?? "").replace(",", ".")), clean(r.EPSG));
    if (!ll) continue;
    const num = numVoie(clean(r.NUMVOIE), clean(r.INDREP));
    let typ = clean(r.TYPVOIE);
    let nomv = clean(r.NOMVOIE);
    // Numéro et type de voie parfois répétés dans le nom de voie (« 192 RUE 192 RUE … »).
    if (num) nomv = nomv.replace(new RegExp(`^${num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i"), "");
    typ = TYPVOIE[typ.toUpperCase().replace(/\.$/, "")] ?? typ;
    if (typ && nomv.toUpperCase().startsWith(`${typ.toUpperCase()} `)) typ = "";
    const voie = title([typ, nomv].filter(Boolean).join(" "));
    const adresse = [num, voie].filter(Boolean).join(" ");
    const prog = tidyProg(clean(r.COMPLGEO));
    // Programme nommé : une résidence par programme et par voie ; sinon une par adresse.
    const key = isProgName(prog) ? `p:${prog.toUpperCase()}|${voie.toUpperCase()}` : `a:${adresse.toUpperCase()}`;
    let e = res.get(key);
    if (!e) res.set(key, (e = { nom: key.startsWith("p:") ? title(prog) : "", adresse, voie, nums: new Set(), n: 0, xs: [], ys: [], qpv: clean(r.PLG_QP24 ?? r.QPV_CODE) || null, years: new Map() }));
    if (num) e.nums.add(num);
    e.n++;
    e.xs.push(ll[0]);
    e.ys.push(ll[1]);
    const y = Number(r.CONSTRUCT);
    if (Number.isFinite(y) && y > 1800) e.years.set(y, (e.years.get(y) ?? 0) + 1);
  }
  const residences: Residence[] = [...res.values()]
    .map((e) => ({
      nom: e.nom || e.adresse,
      // Programme sur plusieurs numéros : « 2, 4 Allée Nicolas Copernic ».
      adresse: e.nums.size > 1 ? `${sortNums([...e.nums]).slice(0, 4).join(", ")}${e.nums.size > 4 ? "…" : ""} ${e.voie}` : e.adresse,
      voie: e.voie,
      nums: sortNums([...e.nums]),
      logements: e.n,
      lon: e.xs.reduce((s, v) => s + v, 0) / e.xs.length,
      lat: e.ys.reduce((s, v) => s + v, 0) / e.ys.length,
      qpv: e.qpv && !/^(non|hors|0|n)$/i.test(e.qpv) ? e.qpv : null,
      annee: [...e.years].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }))
    .sort((a, b) => b.logements - a.logements);
  // Ensembles : résidences à moins de 120 m les unes des autres (liaison simple).
  const parent = residences.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cell = 0.002;
  const grid = new Map<string, number[]>();
  residences.forEach((r, i) => {
    const k = `${Math.floor(r.lon / cell)}|${Math.floor(r.lat / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  residences.forEach((r, i) => {
    const gx = Math.floor(r.lon / cell);
    const gy = Math.floor(r.lat / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${gx + dx}|${gy + dy}`) ?? []) {
          if (j <= i) continue;
          if (turf.distance([r.lon, r.lat], [residences[j].lon, residences[j].lat], { units: "kilometers" }) <= 0.12) parent[find(i)] = find(j);
        }
  });
  const groups = new Map<number, Residence[]>();
  residences.forEach((r, i) => {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  });
  const ensembles: Ensemble[] = [...groups.values()]
    .map((rs) => {
      const n = rs.reduce((s, r) => s + r.logements, 0);
      const main = [...rs].sort((a, b) => b.logements - a.logements)[0];
      const named = rs.filter((r) => r.nom !== r.adresse).sort((a, b) => b.logements - a.logements)[0];
      // Nom : programme principal, sinon la voie de la plus grande résidence.
      const voie = main.voie ?? main.adresse.replace(/^\d+\s*\w?\s+/, "");
      return {
        nom: named?.nom ?? voie,
        logements: n,
        residences: rs.length,
        points: rs.map((r) => [r.lon, r.lat] as [number, number]),
        lon: rs.reduce((s, r) => s + r.lon * r.logements, 0) / n,
        lat: rs.reduce((s, r) => s + r.lat * r.logements, 0) / n,
        qpv: rs.find((r) => r.qpv)?.qpv ?? null,
      };
    })
    .sort((a, b) => b.logements - a.logements);
  return { total, residences, ensembles };
}

async function fetchRows(http: TrackedHttp, code: string): Promise<{ rows: Record<string, unknown>[]; url: string; retrievedAt: string; millesime: string | null }> {
  // Millésime le plus récent, puis repli sur l'interrogation sans millésime.
  let millesime: string | null = null;
  try {
    const meta = await http.json<{ millesimes?: { millesime?: string }[] }>(`${DIDO}/datafiles/${RPLS_DATAFILE}`, { retries: 1 });
    millesime = (meta.data?.millesimes ?? []).map((m) => m.millesime ?? "").filter(Boolean).sort().pop() ?? null;
  } catch {
    /* métadonnées indisponibles : millésime par défaut */
  }
  const qs = new URLSearchParams({ withColumnName: "true", withColumnDescription: "false", withColumnUnit: "false", columns: COLUMNS.join(","), DEPCOM: `eq:${code}` });
  if (millesime) qs.set("millesime", millesime);
  const url = `${DIDO}/datafiles/${RPLS_DATAFILE}/csv?${qs}`;
  const r = await http.text(url, { timeoutMs: 180000, retries: 1 });
  const text = r.data.replace(/^﻿/, "");
  const rows = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true, delimiter: detectDelimiter(text) }).data.filter((x) => clean(x.DEPCOM).padStart(5, "0") === code || !("DEPCOM" in x));
  return { rows, url, retrievedAt: r.retrievedAt, millesime };
}

/**
 * Résidences et ensembles de logements sociaux d'une commune. Pour un
 * arrondissement de Paris, Lyon ou Marseille absent sous son propre code, les
 * logements de la ville sont filtrés par le contour de l'arrondissement.
 */
export function collectRpls(http: TrackedHttp, code: string, opts: { parent?: string; contour?: GeoJSON.Geometry | null } = {}): Promise<RplsResult> {
  return cachedExtract(
    `rpls2|${code}`,
    24 * 30,
    async () => {
      let f = await fetchRows(http, code);
      if (!f.rows.length && opts.parent && opts.contour) {
        const city = await fetchRows(http, opts.parent);
        const poly = turf.feature(opts.contour as GeoJSON.Polygon);
        const rows = city.rows.filter((r) => {
          const ll = toLonLat(Number(String(r.X ?? "").replace(",", ".")), Number(String(r.Y ?? "").replace(",", ".")), clean(r.EPSG));
          return !!ll && turf.booleanPointInPolygon(ll, poly);
        });
        f = { ...city, rows };
      }
      return { ...groupRpls(f.rows), url: f.url, retrievedAt: f.retrievedAt, millesime: f.millesime };
    },
    (v) => v.total > 0,
  );
}
