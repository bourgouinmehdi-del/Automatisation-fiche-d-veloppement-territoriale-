import fs from "node:fs";
import path from "node:path";
import type { CommuneInfo } from "../types";
import type { TrackedHttp } from "./context";

/**
 * Référentiel administratif.
 *
 * 1. Référentiel embarqué (@etalab/decoupage-administratif, COG 2026) :
 *    résolution code postal → communes, EPCI, département, région,
 *    population légale. Fonctionne sans réseau, ce qui garantit que la
 *    recherche par code postal reste disponible même si les API tombent.
 * 2. geo.api.gouv.fr : enrichissement géographique (surface, centre, contour)
 *    et communes du département avec leurs contours (cartes, voisinage).
 */

const DATA_DIR = path.join(process.cwd(), "node_modules", "@etalab", "decoupage-administratif", "data");
export const GEO_API = "https://geo.api.gouv.fr";

interface RawCommune {
  code: string;
  nom: string;
  type: "commune-actuelle" | "commune-deleguee" | "commune-associee" | "arrondissement-municipal";
  departement?: string;
  region?: string;
  arrondissement?: string;
  codesPostaux?: string[];
  population?: number;
  chefLieu?: string;
  commune?: string;
  siren?: string;
}
interface RawEpci {
  code: string;
  nom: string;
  type: string;
  populationMunicipale?: number;
  membres: { code: string; siren: string; nom: string }[];
}
interface RawNamed {
  code: string;
  nom: string;
  chefLieu?: string;
  region?: string;
  departement?: string;
}

let _ref: {
  communes: RawCommune[];
  byCode: Map<string, RawCommune>;
  epcis: RawEpci[];
  epciByCommune: Map<string, RawEpci>;
  /** Établissements publics territoriaux de la Métropole du Grand Paris. */
  eptByCommune: Map<string, RawEpci>;
  departements: Map<string, RawNamed>;
  regions: Map<string, RawNamed>;
  arrondissements: Map<string, RawNamed>;
} | null = null;

function load<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")) as T;
}

export function referentiel() {
  if (_ref) return _ref;
  const communes = load<RawCommune[]>("communes.json");
  const epcis = load<RawEpci[]>("epci.json");
  const byCode = new Map<string, RawCommune>();
  for (const c of communes) {
    // Une commune déléguée peut partager le code de sa commune nouvelle :
    // on privilégie toujours la commune actuelle.
    const prev = byCode.get(c.code);
    if (!prev || (prev.type !== "commune-actuelle" && c.type === "commune-actuelle")) byCode.set(c.code, c);
  }
  const epciByCommune = new Map<string, RawEpci>();
  for (const e of epcis) for (const m of e.membres) epciByCommune.set(m.code, e);
  const eptByCommune = new Map<string, RawEpci>();
  try {
    for (const e of load<RawEpci[]>("ept.json")) for (const m of e.membres) eptByCommune.set(m.code, e);
  } catch {
    /* référentiel sans EPT */
  }
  const toMap = (arr: RawNamed[]) => new Map(arr.map((x) => [x.code, x]));
  _ref = {
    communes,
    byCode,
    epcis,
    epciByCommune,
    eptByCommune,
    departements: toMap(load<RawNamed[]>("departements.json")),
    regions: toMap(load<RawNamed[]>("regions.json")),
    arrondissements: toMap(load<RawNamed[]>("arrondissements.json")),
  };
  return _ref;
}

export const POPULATION_VINTAGE = "2023";

export interface CommuneCandidate {
  code: string;
  nom: string;
  codesPostaux: string[];
  departement: string;
  departementNom: string;
  population: number | null;
  type: string;
  /** Correspondance trouvée par code INSEE ou par code postal (recherche sur 5 caractères). */
  via?: "insee" | "postal";
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bst\b/g, "saint")
    .replace(/\bste\b/g, "sainte")
    .trim();

function toCandidate(c: RawCommune): CommuneCandidate {
  const r = referentiel();
  return {
    code: c.code,
    nom: c.nom,
    codesPostaux: c.codesPostaux ?? [],
    departement: c.departement ?? "",
    departementNom: r.departements.get(c.departement ?? "")?.nom ?? "",
    population: c.population ?? null,
    type: c.type,
  };
}

/** Recherche par code postal (5 chiffres) ou par nom de commune. */
export function searchCommunes(q: string, limit = 30): CommuneCandidate[] {
  const r = referentiel();
  const query = q.trim();
  const searchable = r.communes.filter((c) => c.type === "commune-actuelle" || c.type === "arrondissement-municipal");
  // Cinq caractères : code postal et/ou code INSEE (les deux peuvent coïncider pour des communes différentes).
  if (/^\d[\dAB]\d{3}$/i.test(query)) {
    const postal = /^\d{5}$/.test(query)
      ? searchable
          .filter((c) => c.codesPostaux?.includes(query))
          .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
          .map((c) => ({ ...toCandidate(c), via: "postal" as const }))
      : [];
    const insee = r.byCode.get(query.toUpperCase());
    const byInsee = insee && searchable.includes(insee) && !postal.some((p) => p.code === insee.code) ? [{ ...toCandidate(insee), via: "insee" as const }] : [];
    return [...postal, ...byInsee];
  }
  const nq = norm(query);
  if (nq.length < 2) return [];
  // Une commune déléguée recherchée par son nom renvoie vers sa commune nouvelle.
  const out = new Map<string, { c: RawCommune; score: number }>();
  for (const c of r.communes) {
    const n = norm(c.nom);
    let score = -1;
    if (n === nq) score = 3;
    else if (n.startsWith(nq)) score = 2;
    else if (n.includes(nq)) score = 1;
    if (score < 0) continue;
    let target = c;
    if ((c.type === "commune-deleguee" || c.type === "commune-associee") && c.chefLieu) {
      target = r.byCode.get(c.chefLieu) ?? c;
      score -= 0.5;
    }
    if (target.type !== "commune-actuelle" && target.type !== "arrondissement-municipal") continue;
    const prev = out.get(target.code);
    if (!prev || prev.score < score) out.set(target.code, { c: target, score });
  }
  return [...out.values()]
    .sort((a, b) => b.score - a.score || (b.c.population ?? 0) - (a.c.population ?? 0))
    .slice(0, limit)
    .map((x) => toCandidate(x.c));
}

/** Construit la fiche d'identité administrative à partir du référentiel embarqué. */
export function communeFromReferentiel(code: string): CommuneInfo | null {
  const r = referentiel();
  const c = r.byCode.get(code);
  if (!c) return null;
  const epci = r.epciByCommune.get(code);
  const dep = r.departements.get(c.departement ?? "");
  const reg = r.regions.get(c.region ?? "");
  const arr = c.arrondissement ? r.arrondissements.get(c.arrondissement) : undefined;
  const deleguees = r.communes
    .filter((x) => (x.type === "commune-deleguee" || x.type === "commune-associee") && x.chefLieu === code && x.code !== code)
    .map((x) => ({ code: x.code, nom: x.nom, type: x.type }));
  return {
    code: c.code,
    nom: c.nom,
    codesPostaux: c.codesPostaux ?? [],
    population: c.population ?? null,
    surfaceKm2: null,
    departement: { code: c.departement ?? "", nom: dep?.nom ?? "" },
    region: { code: c.region ?? "", nom: reg?.nom ?? "" },
    epci: epci ? { code: epci.code, nom: epci.nom, type: epci.type } : null,
    arrondissement: arr ? { code: arr.code, nom: arr.nom } : null,
    centre: null,
    contour: null,
    siren: c.siren,
    communesDeleguees: deleguees,
  };
}

/** Communes membres d'un EPCI (référentiel embarqué). */
export function epciMembers(epciCode: string) {
  const r = referentiel();
  const e = r.epcis.find((x) => x.code === epciCode);
  if (!e) return [];
  return e.membres.map((m) => ({ code: m.code, nom: m.nom, population: r.byCode.get(m.code)?.population ?? null }));
}

/**
 * Intercommunalité « de travail » d'une commune : son établissement public
 * territorial (EPT) dans la Métropole du Grand Paris — ex. Ivry-sur-Seine →
 * Grand-Orly Seine Bièvre —, sinon son EPCI à fiscalité propre.
 */
export function intercoOf(code: string): { code: string; nom: string; type: string; membres: { code: string; nom: string; population: number | null }[] } | null {
  const r = referentiel();
  const e = r.eptByCommune.get(code) ?? r.epciByCommune.get(code);
  if (!e) return null;
  return { code: e.code, nom: e.nom, type: r.eptByCommune.has(code) ? "EPT" : e.type, membres: e.membres.map((m) => ({ code: m.code, nom: m.nom, population: r.byCode.get(m.code)?.population ?? null })) };
}

export function epciInfo(epciCode: string) {
  return referentiel().epcis.find((x) => x.code === epciCode) ?? null;
}

/** Communes actuelles d'un département (référentiel embarqué). */
export function departementCommunes(dep: string) {
  return referentiel()
    .communes.filter((c) => c.type === "commune-actuelle" && c.departement === dep)
    .map((c) => ({ code: c.code, nom: c.nom, population: c.population ?? null }));
}

export function regionCommunes(reg: string) {
  return referentiel()
    .communes.filter((c) => c.type === "commune-actuelle" && c.region === reg)
    .map((c) => ({ code: c.code, nom: c.nom, population: c.population ?? null, departement: c.departement ?? "" }));
}

export function franceCommunes() {
  return referentiel()
    .communes.filter((c) => c.type === "commune-actuelle")
    .map((c) => ({ code: c.code, nom: c.nom, population: c.population ?? null, departement: c.departement ?? "", region: c.region ?? "" }));
}

/* --------------------------------------------------------- geo.api.gouv.fr */

interface GeoApiCommune {
  code: string;
  nom: string;
  population?: number;
  surface?: number; // hectares
  centre?: { type: "Point"; coordinates: [number, number] };
  contour?: GeoJSON.Geometry;
  codesPostaux?: string[];
}

/** Enrichit la fiche commune (surface, centre, contour). */
export async function enrichCommune(http: TrackedHttp, info: CommuneInfo) {
  const url = `${GEO_API}/communes/${info.code}?fields=nom,code,population,surface,centre,contour,codesPostaux&format=json&geometry=contour`;
  const r = await http.json<GeoApiCommune>(url, { minIntervalMs: 100 });
  const d = r.data;
  if (!d) throw new Error("Commune inconnue de geo.api.gouv.fr");
  return {
    url,
    retrievedAt: r.retrievedAt,
    surfaceKm2: d.surface != null ? d.surface / 100 : null,
    centre: d.centre?.coordinates ?? null,
    contour: d.contour ?? null,
    population: d.population ?? null,
  };
}

/**
 * Communes d'un département avec contour, centre, surface et population :
 * base des cartes de densité, du voisinage et des comparaisons infra-départementales.
 */
export async function departementGeo(http: TrackedHttp, dep: string) {
  const url = `${GEO_API}/departements/${dep}/communes?fields=nom,code,population,surface,centre,contour,codeEpci&format=geojson&geometry=contour`;
  const r = await http.json<GeoJSON.FeatureCollection>(url, { minIntervalMs: 100, timeoutMs: 60000 });
  return { url, retrievedAt: r.retrievedAt, fc: r.data };
}

/** Centres et populations de toutes les communes (pôles urbains proches). */
export async function franceCentres(http: TrackedHttp) {
  const url = `${GEO_API}/communes?fields=code,nom,population,centre,surface,codeDepartement&format=json`;
  const r = await http.json<GeoApiCommune[]>(url, { timeoutMs: 60000 });
  return { url, retrievedAt: r.retrievedAt, communes: r.data ?? [] };
}

/** Contour d'un département (carte de localisation départementale). */
export async function departementContour(http: TrackedHttp, dep: string) {
  const url = `${GEO_API}/departements/${dep}?fields=nom,code&format=geojson&geometry=contour`;
  const r = await http.json<GeoJSON.Feature>(url, { minIntervalMs: 100 });
  return { url, retrievedAt: r.retrievedAt, feature: r.data };
}
