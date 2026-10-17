import { deDep } from "../format";
import { promises as fs } from "node:fs";
import * as turf from "@turf/turf";
import type { TrackedHttp } from "./context";
import { DATAGOUV, type DgResource } from "./datagouv";
import { geoJsonFeatures, scanFile } from "./json-stream";
import { overpass } from "./osm";
import { cachedExtract, heavyLane } from "../runtime";

/**
 * Données des cartes « affiche » :
 *  - circonscriptions législatives d'un département (contours data.gouv.fr) ;
 *  - départements voisins (contours administratifs Etalab, simplifiés à 100 m) ;
 *  - fond de plan OpenStreetMap d'une emprise (voies, voies ferrées, eau) ;
 *  - résidences étudiantes (OpenStreetMap).
 */

export type Bbox = [number, number, number, number];

/* ------------------------------------------------------------- circonscriptions */

export interface Circo {
  code: string;
  num: number;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

/** Département et numéro d'une circonscription, quel que soit l'intitulé des propriétés. */
export function circoOf(p: Record<string, unknown>): { dep: string; num: number } | null {
  const entries = Object.entries(p ?? {}).map(([k, v]) => [k, String(v ?? "").trim()] as const);
  const depProp = entries.find(([k, v]) => /d[ée]p/i.test(k) && /code|^dep$|^code_?dep/i.test(k) && /^\d{1,3}$|^2[AB]$/i.test(v))?.[1];
  const codeProp = entries.find(([k, v]) => /circ/i.test(k) && /code|id|ref/i.test(k) && /^[\dAB]{3,6}([-_ ]\d{1,2})?$/i.test(v))?.[1] ?? entries.find(([k, v]) => /^(id|code|ref)$/i.test(k) && /^[\dAB]{3,6}([-_ ]\d{1,2})?$/i.test(v))?.[1];
  if (codeProp) {
    const m = codeProp.match(/^([\dAB]{2,3})[-_ ](\d{1,2})$/i);
    if (m) return { dep: normDep(m[1]), num: Number(m[2]) };
    const c = codeProp.toUpperCase();
    // « 0101 », « 2A01 », « 97101 », « 01001 » (code sur 5 avec département sur 3).
    if (c.length === 4) return { dep: normDep(c.slice(0, 2)), num: Number(c.slice(2)) };
    if (c.length === 5) return { dep: normDep(c.slice(0, 3)), num: Number(c.slice(3)) };
  }
  const numProp = entries.find(([k, v]) => /num|circ/i.test(k) && /^\d{1,2}$/.test(v))?.[1];
  if (depProp && numProp) return { dep: normDep(depProp), num: Number(numProp) };
  return null;
}
const normDep = (d: string) => {
  const u = d.toUpperCase().replace(/^0(?=\d{2}$)/, "").replace(/^0(?=2[AB]$)/, "");
  return /^\d$/.test(u) ? `0${u}` : u;
};

export async function collectCirconscriptions(http: TrackedHttp, dep: string): Promise<{ circos: Circo[]; url: string; retrievedAt: string }> {
  return cachedExtract(
    `circos|${dep}`,
    24 * 60,
    () =>
      heavyLane.run(async () => {
        const d = await http.json<{ resources?: DgResource[] }>(`${DATAGOUV}/datasets/contours-geographiques-des-circonscriptions-legislatives/`);
        const res = (d.data?.resources ?? []).filter((r) => /geo\s*json/i.test(r.format ?? "") || /\.geojson$/i.test(r.url ?? "")).sort((a, b) => (a.filesize ?? 0) - (b.filesize ?? 0))[0];
        if (!res?.url) throw new Error("Contours des circonscriptions introuvables sur data.gouv.fr");
        const f = await http.file(res.url, { timeoutMs: 300000, retries: 1 });
        const circos: Circo[] = [];
        await scanFile(f.data, geoJsonFeatures, (t) => {
          try {
            const feat = JSON.parse(t) as GeoJSON.Feature;
            const c = circoOf(feat.properties as Record<string, unknown>);
            if (c && c.dep === dep && feat.geometry && /Polygon/.test(feat.geometry.type)) circos.push({ code: `${dep}-${String(c.num).padStart(2, "0")}`, num: c.num, geometry: feat.geometry as GeoJSON.Polygon });
          } catch {
            /* entité illisible */
          }
        });
        return { circos: circos.sort((a, b) => a.num - b.num), url: res.url, retrievedAt: f.retrievedAt };
      }),
    (v) => v.circos.length > 0,
  );
}

/**
 * Part de la surface de chaque commune située dans une circonscription
 * (0 à 1). Une commune est retenue dès que 20 % de sa surface, ou son point
 * central, est dans la circonscription : les grandes villes partagées entre
 * plusieurs circonscriptions y figurent avec une part inférieure à 1.
 */
export function circoCommunes(features: GeoJSON.Feature[], circo: Pick<Circo, "geometry">): Map<string, number> {
  const out = new Map<string, number>();
  const cf = turf.feature(circo.geometry);
  const cb = turf.bbox(cf);
  for (const f of features) {
    const code = (f.properties as { code?: string })?.code;
    if (!code || !f.geometry || !/Polygon/.test(f.geometry.type)) continue;
    const fb = turf.bbox(f);
    if (fb[0] > cb[2] || fb[2] < cb[0] || fb[1] > cb[3] || fb[3] < cb[1]) continue;
    const poly = f as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
    let share = 0;
    try {
      const inter = turf.intersect(turf.featureCollection([poly, cf]));
      share = inter ? Math.min(1, turf.area(inter) / (turf.area(poly) || 1)) : 0;
    } catch {
      share = turf.booleanPointInPolygon(turf.pointOnFeature(poly), cf) ? 1 : 0;
    }
    let centre = false;
    try {
      centre = turf.booleanPointInPolygon(turf.pointOnFeature(poly), cf);
    } catch {
      /* géométrie invalide */
    }
    if (share >= 0.2 || centre) out.set(code, share >= 0.98 ? 1 : Math.max(share, 0.01));
  }
  return out;
}

export const ordinalCirco = (n: number) => (n === 1 ? "1re" : `${n}e`);

/** « 2e circonscription de l'Oise ». */
export function circoLabel(num: number, depNom: string): string {
  return `${ordinalCirco(num)} circonscription ${deDep(depNom)}`;
}

/* ---------------------------------------------------------- départements voisins */

export const DEPARTEMENTS_URL = "https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2024/geojson/departements-100m.geojson";

export async function collectDepartementsVoisins(http: TrackedHttp, dep: string, bbox: Bbox) {
  return cachedExtract(
    `depvoisins|${dep}`,
    24 * 90,
    async () => {
      const f = await http.file(DEPARTEMENTS_URL, { timeoutMs: 120000, retries: 1 });
      const fc = JSON.parse(await fs.readFile(f.data, "utf8")) as GeoJSON.FeatureCollection;
      const w = bbox[2] - bbox[0];
      const h = bbox[3] - bbox[1];
      const big: Bbox = [bbox[0] - w, bbox[1] - h, bbox[2] + w, bbox[3] + h];
      const features = fc.features
        .filter((x) => {
          const p = x.properties as { code?: string };
          if (!x.geometry || p.code === dep) return false;
          const b = turf.bbox(x);
          return !(b[0] > big[2] || b[2] < big[0] || b[1] > big[3] || b[3] < big[1]);
        })
        .map((x) => ({ type: "Feature" as const, geometry: x.geometry, properties: { code: (x.properties as { code: string }).code, nom: (x.properties as { nom: string }).nom } }));
      return { features, url: DEPARTEMENTS_URL, retrievedAt: f.retrievedAt };
    },
    (v) => v.features.length > 0,
  );
}

/* ------------------------------------------------------------------ fond OSM */

interface El {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

/** Réassemble des tronçons de contour (membres « outer » d'une relation) en anneaux fermés. */
export function stitchRings(parts: [number, number][][]): [number, number][][] {
  const rings: [number, number][][] = [];
  const left = parts.filter((p) => p.length > 1).map((p) => [...p]);
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (left.length) {
    let ring = left.shift()!;
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        const end = ring[ring.length - 1];
        if (same(end, p[0])) ring = ring.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) ring = ring.concat([...p].reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

const ROAD_CLASS: Record<string, number> = { motorway: 1, trunk: 1, motorway_link: 2, trunk_link: 2, primary: 2, primary_link: 3, secondary: 3, secondary_link: 3, tertiary: 4, unclassified: 5, residential: 5, living_street: 5, pedestrian: 5 };

export interface FondOsm {
  roads: GeoJSON.Feature<GeoJSON.LineString>[];
  rail: GeoJSON.Feature<GeoJSON.LineString>[];
  waterLines: GeoJSON.Feature<GeoJSON.LineString>[];
  water: GeoJSON.Feature<GeoJSON.Polygon>[];
  url: string;
  retrievedAt: string;
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const line = (g: { lat: number; lon: number }[], props: Record<string, unknown>): GeoJSON.Feature<GeoJSON.LineString> => {
  const f = turf.lineString(g.map((p) => [r5(p.lon), r5(p.lat)]), props);
  return turf.simplify(f, { tolerance: 0.00004 });
};

/**
 * Fond de plan d'une emprise : voies hiérarchisées (sans les rues de desserte
 * lorsque l'emprise dépasse une quinzaine de kilomètres), voies ferrées, cours
 * et plans d'eau. Gardé 30 jours sur disque.
 */
export async function collectFondOsm(http: TrackedHttp, bbox: Bbox): Promise<FondOsm> {
  const key = bbox.map((v) => v.toFixed(3)).join(",");
  return cachedExtract(
    `fondosm2|${key}`,
    24 * 30,
    async () => {
      const [w, s, e, n] = bbox;
      const b = `(${s},${w},${n},${e})`;
      const wide = turf.distance([w, s], [e, n]) > 15;
      const roads = wide ? "motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link" : Object.keys(ROAD_CLASS).join("|");
      const q = `[out:json][timeout:120];
(
  way["highway"~"^(${roads})$"]${b};
  way["railway"~"^(rail|light_rail)$"]["service"!~"."]${b};
  way["waterway"~"^(river|canal)$"]${b};
  way["natural"="water"]${b};
  relation["natural"="water"]${b};
  way["waterway"="riverbank"]${b};
);
out geom qt;`;
      const r = await overpass<{ elements?: El[] }>(http, q);
      const out: FondOsm = { roads: [], rail: [], waterLines: [], water: [], url: `${r.url}?data=${encodeURIComponent(q)}`, retrievedAt: r.retrievedAt };
      for (const el of r.data?.elements ?? []) {
        const t = el.tags ?? {};
        if (el.type === "way" && el.geometry && el.geometry.length > 1) {
          // Nom de la voie (étiquettes des grands axes et des rues à cibler).
          if (t.highway) out.roads.push(line(el.geometry, { c: ROAD_CLASS[t.highway] ?? 5, ...(t.name ? { n: t.name } : {}) }));
          else if (t.railway) out.rail.push(line(el.geometry, {}));
          else if (t.waterway === "river" || t.waterway === "canal") out.waterLines.push(line(el.geometry, { nom: t.name ?? "" }));
          else if (t.natural === "water" || t.waterway === "riverbank") {
            const ring = el.geometry.map((p) => [r5(p.lon), r5(p.lat)] as [number, number]);
            if (ring.length >= 4) out.water.push(turf.polygon([ring.concat(ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? [] : [ring[0]])], {}));
          }
        } else if (el.type === "relation" && el.members) {
          const outers = el.members.filter((m) => m.role !== "inner" && m.geometry).map((m) => m.geometry!.map((p) => [r5(p.lon), r5(p.lat)] as [number, number]));
          for (const ring of stitchRings(outers)) out.water.push(turf.polygon([ring], {}));
        }
      }
      return out;
    },
    (v) => v.roads.length > 0,
  );
}

/* ------------------------------------------------------- résidences étudiantes */

export interface Residence {
  nom: string;
  lon: number;
  lat: number;
  logements: number | null;
  crous: boolean;
}

export async function collectResidences(http: TrackedHttp, bbox: Bbox): Promise<{ list: Residence[]; url: string; retrievedAt: string }> {
  const key = bbox.map((v) => v.toFixed(3)).join(",");
  return cachedExtract(`residences|${key}`, 24 * 30, async () => {
    const [w, s, e, n] = bbox;
    const b = `(${s},${w},${n},${e})`;
    const q = `[out:json][timeout:60];
(
  nwr["building"="dormitory"]${b};
  nwr["amenity"="dormitory"]${b};
  nwr["residential"="university"]${b};
  nwr["operator"~"crous",i]["building"]${b};
);
out center tags;`;
    const r = await overpass<{ elements?: El[] }>(http, q);
    const list: Residence[] = [];
    for (const el of r.data?.elements ?? []) {
      const t = el.tags ?? {};
      if (/restaurant|cafe|fast_food|canteen/.test(t.amenity ?? "")) continue;
      // Internats scolaires : hors champ (porte-à-porte en résidence étudiante).
      if (/lyc[ée]e|coll[èe]ge|internat/i.test(t.name ?? "") && !/crous/i.test(`${t.operator ?? ""} ${t.name ?? ""}`)) continue;
      const lon = el.lon ?? el.center?.lon;
      const lat = el.lat ?? el.center?.lat;
      if (lon == null || lat == null) continue;
      const nb = Number(t.capacity ?? t["building:flats"] ?? t.rooms ?? "");
      const crous = /crous/i.test(`${t.operator ?? ""} ${t.name ?? ""}`);
      const nom = t.name ?? (crous ? "Résidence du Crous" : "Résidence étudiante");
      // Bâtiments d'une même résidence : une seule entrée (même nom, à moins de 250 m).
      const dup = list.find((x) => x.nom === nom && turf.distance([x.lon, x.lat], [lon, lat]) < 0.25);
      if (dup) {
        if (Number.isFinite(nb) && nb > 0) dup.logements = (dup.logements ?? 0) + nb;
        continue;
      }
      list.push({ nom, lon, lat, logements: Number.isFinite(nb) && nb > 0 ? nb : null, crous });
    }
    return { list, url: `${r.url}?data=${encodeURIComponent(q)}`, retrievedAt: r.retrievedAt };
  });
}

/**
 * Emprise élargie aux proportions du cadre des cartes « affiche » (hauteur de
 * 0,62 à 1,25 fois la largeur, en projection de Mercator) : le fond couvre
 * alors tout le cadre.
 */
export function fitAspect(b: Bbox, pad = 0): Bbox {
  let [w, s, e, n] = b;
  const dx = (e - w) * pad;
  const dy = (n - s) * pad;
  w -= dx;
  e += dx;
  s -= dy;
  n += dy;
  const k = 1 / Math.cos((((s + n) / 2) * Math.PI) / 180);
  const ratio = ((n - s) * k) / (e - w || 1e-6);
  if (ratio > 1.25) {
    const want = ((n - s) * k) / 1.25;
    const add = (want - (e - w)) / 2;
    w -= add;
    e += add;
  } else if (ratio < 0.62) {
    const want = (0.62 * (e - w)) / k;
    const add = (want - (n - s)) / 2;
    s -= add;
    n += add;
  }
  return [w, s, e, n];
}

/* ------------------------------------------------- lieux de convivialité */

export interface LieuConvivial {
  kind: "parc" | "bar";
  nom: string;
  lon: number;
  lat: number;
  /** Surface approchée (parcs), en hectares. */
  ha: number | null;
  /** Capacité déclarée (bars), en places. */
  capacite: number | null;
}

/**
 * Lieux pour un moment convivial de fin de journée ou un pique-nique, retenus
 * seulement quand l'information est sûre : parcs et jardins publics nommés
 * d'au moins 2 hectares (emprise OpenStreetMap), jardins à bière nommés, bars
 * dont la capacité déclarée atteint 60 places.
 */
export async function collectConvivialite(http: TrackedHttp, bbox: Bbox): Promise<{ list: LieuConvivial[]; url: string; retrievedAt: string }> {
  const key = bbox.map((v) => v.toFixed(3)).join(",");
  return cachedExtract(`convivial2|${key}`, 24 * 30, async () => {
    const [w, s, e, n] = bbox;
    const b = `(${s},${w},${n},${e})`;
    const q = `[out:json][timeout:60];
(
  way["leisure"~"^(park|garden)$"]["name"]["access"!~"private|no"]${b};
  relation["leisure"~"^(park|garden)$"]["name"]["access"!~"private|no"]${b};
  nwr["amenity"="biergarten"]["name"]${b};
  nwr["amenity"~"^(bar|pub)$"]["name"]["capacity"]${b};
);
out tags bb;`;
    const r = await overpass<{ elements?: El[] }>(http, q);
    const list: LieuConvivial[] = [];
    for (const el of r.data?.elements ?? []) {
      const t = el.tags ?? {};
      // « out bb » : emprise des chemins et relations (une seule option de géométrie par sortie Overpass).
      const lon = el.lon ?? el.center?.lon ?? (el.bounds ? (el.bounds.minlon + el.bounds.maxlon) / 2 : undefined);
      const lat = el.lat ?? el.center?.lat ?? (el.bounds ? (el.bounds.minlat + el.bounds.maxlat) / 2 : undefined);
      if (lon == null || lat == null || !t.name) continue;
      if (/park|garden/.test(t.leisure ?? "")) {
        if (t.garden && /private|residential|botanical/.test(t["garden:type"] ?? "")) continue;
        const bb = el.bounds;
        // Emprise rectangulaire × 0,6 : ordre de grandeur de la surface du parc.
        const ha = bb ? (0.6 * turf.distance([bb.minlon, bb.minlat], [bb.maxlon, bb.minlat]) * turf.distance([bb.minlon, bb.minlat], [bb.minlon, bb.maxlat]) * 1e6) / 1e4 : null;
        if (ha == null || ha < 2) continue;
        list.push({ kind: "parc", nom: t.name, lon, lat, ha: Math.round(ha), capacite: null });
      } else {
        const cap = Number(t.capacity);
        if (t.amenity !== "biergarten" && !(Number.isFinite(cap) && cap >= 60)) continue;
        list.push({ kind: "bar", nom: t.name, lon, lat, ha: null, capacite: Number.isFinite(cap) ? cap : null });
      }
    }
    // Un même parc peut être découpé en plusieurs objets : un seul par nom.
    const seen = new Set<string>();
    const uniq = list.filter((x) => (seen.has(`${x.kind}|${x.nom}`) ? false : (seen.add(`${x.kind}|${x.nom}`), true)));
    return { list: uniq.sort((a, b) => (b.ha ?? 0) - (a.ha ?? 0)), url: `${r.url}?data=${encodeURIComponent(q)}`, retrievedAt: r.retrievedAt };
  });
}

/* ---------------------------------------------------- grandes surfaces */

export interface GrandeSurface {
  nom: string;
  enseigne: string;
  hyper: boolean;
  adresse: string;
  lon: number;
  lat: number;
  /** Arrêts de transport en commun à moins de 400 m. */
  arrets: number;
}

// Enseignes des grands groupes ; formats de proximité (City, Express, Proxi…) écartés.
const HYPER = /^(e\.?\s?leclerc|leclerc|auchan|carrefour|hyper u|g[ée]ant( casino)?|cora)$/i;
const SUPER = /^(lidl|aldi|intermarch[ée]( (super|hyper|contact))?|super u|carrefour market|netto|leader price|casino( supermarch[ée])?|supermarch[ée] casino|super casino|match|supermarch[ée]s? match|monoprix|auchan supermarch[ée])$/i;
const PROXI = /(city|express|contact|proxi|piéton|pi[ée]ton|drive|vival|spar|franprix|shopi|8 ?à ?huit|coccinelle)/i;

/**
 * Hypermarchés et supermarchés des grands groupes (OpenStreetMap, à jour des
 * fermetures), desservis par les transports en commun (arrêt à moins de 400 m).
 */
export async function collectGrandesSurfaces(http: TrackedHttp, bbox: Bbox): Promise<{ list: GrandeSurface[]; url: string; retrievedAt: string }> {
  const key = bbox.map((v) => v.toFixed(3)).join(",");
  return cachedExtract(`gsurfaces|${key}`, 24 * 14, async () => {
    const [w, s, e, n] = bbox;
    const b = `(${s},${w},${n},${e})`;
    const q = `[out:json][timeout:60];
nwr["shop"="supermarket"]${b}->.s;
.s out tags center;
(
  node(around.s:400)["highway"="bus_stop"];
  node(around.s:400)["public_transport"="platform"];
  node(around.s:400)["railway"~"^(tram_stop|station|halt)$"];
);
out skel;`;
    const r = await overpass<{ elements?: El[] }>(http, q);
    const els = r.data?.elements ?? [];
    const stops = els.filter((x) => x.type === "node" && !x.tags).map((x) => [x.lon!, x.lat!] as [number, number]);
    const list: GrandeSurface[] = [];
    for (const el of els) {
      const t = el.tags;
      if (!t || t.shop !== "supermarket") continue;
      const lon = el.lon ?? el.center?.lon;
      const lat = el.lat ?? el.center?.lat;
      if (lon == null || lat == null) continue;
      const enseigne = (t.brand ?? t.name ?? "").trim();
      const full = `${t.brand ?? ""} ${t.name ?? ""}`;
      if (!enseigne || PROXI.test(full)) continue;
      const hyper = HYPER.test(enseigne) || /hyper/i.test(full);
      if (!hyper && !SUPER.test(enseigne)) continue;
      const arrets = stops.filter((p) => turf.distance(p, [lon, lat]) <= 0.4).length;
      if (!arrets) continue;
      const adresse = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
      list.push({ nom: t.name && t.name !== enseigne ? t.name : enseigne, enseigne, hyper, adresse, lon, lat, arrets });
    }
    return { list: list.sort((a, b) => Number(b.hyper) - Number(a.hyper) || b.arrets - a.arrets), url: `${r.url}?data=${encodeURIComponent(q)}`, retrievedAt: r.retrievedAt };
  });
}

/* ------------------------------------------------ stations de transport */

export interface StationTC {
  nom: string;
  /** « métro », « RER », « tram », « gare ». */
  mode: string;
  lon: number;
  lat: number;
}

/** Stations nommées de métro, RER, tram et gares (OpenStreetMap), pour les points de rendez-vous. */
export async function collectStationsTC(http: TrackedHttp, bbox: Bbox): Promise<{ list: StationTC[]; url: string; retrievedAt: string }> {
  const key = bbox.map((v) => v.toFixed(3)).join(",");
  return cachedExtract(`stationstc|${key}`, 24 * 30, async () => {
    const [w, s, e, n] = bbox;
    const b = `(${s},${w},${n},${e})`;
    const q = `[out:json][timeout:60];
(
  node["railway"~"^(station|halt|tram_stop)$"]["name"]${b};
  node["public_transport"="station"]["name"]${b};
);
out tags;`;
    const r = await overpass<{ elements?: El[] }>(http, q);
    const list: StationTC[] = [];
    for (const el of r.data?.elements ?? []) {
      const t = el.tags ?? {};
      if (el.lon == null || el.lat == null || !t.name) continue;
      const mode =
        t.station === "subway" || t.subway === "yes"
          ? "métro"
          : /\bRER\b/.test(`${t.network ?? ""} ${t.line ?? ""}`)
            ? "RER"
            : t.railway === "tram_stop" || t.tram === "yes" || t.station === "light_rail"
              ? "tram"
              : t.railway === "station" || t.railway === "halt" || t.train === "yes"
                ? "gare"
                : "";
      if (!mode) continue;
      if (list.some((x) => x.nom === t.name && x.mode === mode)) continue;
      list.push({ nom: t.name, mode, lon: el.lon, lat: el.lat });
    }
    return { list, url: `${r.url}?data=${encodeURIComponent(q)}`, retrievedAt: r.retrievedAt };
  });
}

/** Station la plus proche d'un point, à moins de `maxKm` : « métro Mairie de Clichy (250 m) ». */
export function nearestStation(list: StationTC[], lon: number, lat: number, maxKm = 0.8): (StationTC & { m: number }) | null {
  let best: (StationTC & { m: number }) | null = null;
  for (const st of list) {
    const m = Math.round(turf.distance([lon, lat], [st.lon, st.lat]) * 1000);
    if (m <= maxKm * 1000 && (!best || m < best.m)) best = { ...st, m };
  }
  return best;
}
