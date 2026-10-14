import { config } from "../config";
import type { TrackedHttp } from "./context";

/**
 * Connecteur OpenStreetMap via l'API Overpass.
 * Les équipements sont recherchés dans la limite administrative de la commune
 * (relation `boundary=administrative`, `admin_level=8`, `ref:INSEE`).
 *
 * Rappel méthodologique affiché dans le rapport : OSM est une base
 * contributive ; l'absence d'un objet ne prouve pas l'absence de l'équipement.
 */

export interface EquipCategory {
  id: string;
  label: string;
  group: "education" | "sante" | "services" | "commerce" | "sport_culture" | "enfance" | "seniors" | "transport";
  color: string;
  /** Filtres Overpass QL (sans le sélecteur de zone). */
  filters: string[];
}

export const CATEGORIES: EquipCategory[] = [
  { id: "ecole", label: "Écoles", group: "education", color: "#1d4ed8", filters: ['nwr["amenity"="school"]'] },
  { id: "creche", label: "Crèches et accueil petite enfance", group: "enfance", color: "#7c3aed", filters: ['nwr["amenity"="childcare"]', 'nwr["amenity"="kindergarten"]'] },
  { id: "superieur", label: "Enseignement supérieur", group: "education", color: "#1e3a8a", filters: ['nwr["amenity"~"^(university|college)$"]'] },
  { id: "medecin", label: "Médecins et cabinets médicaux", group: "sante", color: "#dc2626", filters: ['nwr["amenity"="doctors"]', 'nwr["healthcare"="doctor"]'] },
  { id: "pharmacie", label: "Pharmacies", group: "sante", color: "#16a34a", filters: ['nwr["amenity"="pharmacy"]'] },
  { id: "hopital", label: "Hôpitaux et cliniques", group: "sante", color: "#991b1b", filters: ['nwr["amenity"~"^(hospital|clinic)$"]'] },
  { id: "dentiste", label: "Dentistes", group: "sante", color: "#f87171", filters: ['nwr["amenity"="dentist"]', 'nwr["healthcare"="dentist"]'] },
  { id: "mairie", label: "Mairie et services administratifs", group: "services", color: "#0f766e", filters: ['nwr["amenity"="townhall"]', 'nwr["office"="government"]'] },
  { id: "france_services", label: "France Services", group: "services", color: "#0d9488", filters: ['nwr["name"~"France Services",i]'] },
  { id: "poste", label: "Bureaux et agences postales", group: "services", color: "#ca8a04", filters: ['nwr["amenity"="post_office"]'] },
  { id: "securite", label: "Police, gendarmerie, secours", group: "services", color: "#334155", filters: ['nwr["amenity"~"^(police|fire_station)$"]'] },
  { id: "social", label: "Action sociale", group: "services", color: "#9333ea", filters: ['nwr["amenity"="social_facility"]["social_facility"!~"nursing_home|assisted_living"]', 'nwr["amenity"="community_centre"]'] },
  { id: "ehpad", label: "Établissements pour personnes âgées", group: "seniors", color: "#a16207", filters: ['nwr["social_facility"~"^(nursing_home|assisted_living)$"]'] },
  { id: "alimentaire", label: "Supermarchés et supérettes", group: "commerce", color: "#ea580c", filters: ['nwr["shop"~"^(supermarket|convenience)$"]'] },
  { id: "boulangerie", label: "Boulangeries", group: "commerce", color: "#f59e0b", filters: ['nwr["shop"="bakery"]'] },
  { id: "marche", label: "Marchés", group: "commerce", color: "#b45309", filters: ['nwr["amenity"="marketplace"]'] },
  { id: "sport", label: "Équipements sportifs", group: "sport_culture", color: "#0284c7", filters: ['nwr["leisure"~"^(sports_centre|stadium|swimming_pool|sports_hall)$"]'] },
  { id: "culture", label: "Équipements culturels", group: "sport_culture", color: "#c026d3", filters: ['nwr["amenity"~"^(library|theatre|cinema|arts_centre)$"]'] },
  { id: "gare", label: "Gares et haltes ferroviaires", group: "transport", color: "#111827", filters: ['nwr["railway"~"^(station|halt)$"]["usage"!="industrial"]'] },
  { id: "arret_bus", label: "Arrêts de bus", group: "transport", color: "#6b7280", filters: ['node["highway"="bus_stop"]'] },
  { id: "velo", label: "Stations vélos en libre-service", group: "transport", color: "#65a30d", filters: ['nwr["amenity"="bicycle_rental"]'] },
  { id: "recharge", label: "Bornes de recharge électrique", group: "transport", color: "#22c55e", filters: ['nwr["amenity"="charging_station"]'] },
];

/** Couleur par domaine (palette catégorielle ordonnée, 8 domaines = 8 teintes). */
export const GROUP_COLORS: Record<EquipCategory["group"], string> = {
  sante: "#e34948",
  education: "#2a78d6",
  services: "#1baf7a",
  commerce: "#eb6834",
  sport_culture: "#6250d6",
  enfance: "#e87ba4",
  seniors: "#eda100",
  transport: "#008300",
};

export const GROUP_LABELS: Record<EquipCategory["group"], string> = {
  education: "Enseignement",
  sante: "Santé",
  services: "Services publics et sociaux",
  commerce: "Commerces de proximité",
  sport_culture: "Sport et culture",
  enfance: "Petite enfance",
  seniors: "Personnes âgées",
  transport: "Transports",
};

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

export function buildEquipmentQuery(codeInsee: string): string {
  const parts = CATEGORIES.flatMap((c) => c.filters.map((f) => `${f}(area.a);`)).join("\n  ");
  return `[out:json][timeout:90];
area["boundary"="administrative"]["admin_level"="8"]["ref:INSEE"="${codeInsee}"]->.a;
(
  ${parts}
);
out center tags;`;
}

/** Classe un élément OSM dans la première catégorie dont les filtres correspondent. */
export function categorize(tags: Record<string, string>): EquipCategory | null {
  const has = (k: string, re: RegExp) => tags[k] != null && re.test(tags[k]);
  if (/France Services/i.test(tags.name ?? "")) return CATEGORIES.find((c) => c.id === "france_services")!;
  const rules: [string, boolean][] = [
    ["ehpad", has("social_facility", /^(nursing_home|assisted_living)$/)],
    ["ecole", has("amenity", /^school$/)],
    ["creche", has("amenity", /^(childcare|kindergarten)$/)],
    ["superieur", has("amenity", /^(university|college)$/)],
    ["hopital", has("amenity", /^(hospital|clinic)$/)],
    ["pharmacie", has("amenity", /^pharmacy$/)],
    ["dentiste", has("amenity", /^dentist$/) || has("healthcare", /^dentist$/)],
    ["medecin", has("amenity", /^doctors$/) || has("healthcare", /^doctor$/)],
    ["mairie", has("amenity", /^townhall$/) || has("office", /^government$/)],
    ["poste", has("amenity", /^post_office$/)],
    ["securite", has("amenity", /^(police|fire_station)$/)],
    ["social", has("amenity", /^(social_facility|community_centre)$/)],
    ["alimentaire", has("shop", /^(supermarket|convenience)$/)],
    ["boulangerie", has("shop", /^bakery$/)],
    ["marche", has("amenity", /^marketplace$/)],
    ["sport", has("leisure", /^(sports_centre|stadium|swimming_pool|sports_hall)$/)],
    ["culture", has("amenity", /^(library|theatre|cinema|arts_centre)$/)],
    ["gare", has("railway", /^(station|halt)$/)],
    ["arret_bus", has("highway", /^bus_stop$/)],
    ["velo", has("amenity", /^bicycle_rental$/)],
    ["recharge", has("amenity", /^charging_station$/)],
  ];
  const hit = rules.find(([, ok]) => ok);
  return hit ? CATEGORIES.find((c) => c.id === hit[0]) ?? null : null;
}

export function toFeatures(elements: OverpassElement[]): GeoJSON.Feature<GeoJSON.Point>[] {
  const out: GeoJSON.Feature<GeoJSON.Point>[] = [];
  const seen = new Set<string>();
  for (const e of elements) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat == null || lon == null || !e.tags) continue;
    const cat = categorize(e.tags);
    if (!cat) continue;
    const key = `${e.type}/${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        osm: key,
        category: cat.id,
        categoryLabel: cat.label,
        group: cat.group,
        name: e.tags.name ?? cat.label,
        opening_hours: e.tags.opening_hours ?? null,
        shop: e.tags.shop ?? null,
        color: GROUP_COLORS[cat.group],
      },
    });
  }
  return out;
}


/**
 * Instances Overpass essayées dans l'ordre : l'instance principale répond
 * souvent 504 (surcharge) ; on bascule alors sur des instances miroirs.
 */
export const OVERPASS_MIRRORS = [config.overpassUrl, ...(process.env.OVERPASS_MIRRORS ?? "https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter").split(",")]
  .map((u) => u.trim())
  .filter((u, i, a) => u && a.indexOf(u) === i);

export async function overpass<T>(http: TrackedHttp, query: string): Promise<{ data: T | null; retrievedAt: string; url: string }> {
  let last: unknown = null;
  for (const url of OVERPASS_MIRRORS) {
    try {
      const r = await http.json<T>(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeoutMs: 120000,
        minIntervalMs: 1000,
        retries: 1,
      });
      if (url !== OVERPASS_MIRRORS[0]) http.notes.push(`Overpass : instance de secours ${new URL(url).host}`);
      return { data: r.data, retrievedAt: r.retrievedAt, url };
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("Overpass indisponible");
}

export async function collectEquipments(http: TrackedHttp, codeInsee: string) {
  const query = buildEquipmentQuery(codeInsee);
  const r = await overpass<{ elements?: OverpassElement[]; remark?: string }>(http, query);
  const url = r.url;
  if (r.data?.remark && !r.data.elements?.length) throw new Error("Overpass : " + r.data.remark);
  const features = toFeatures(r.data?.elements ?? []);
  return { url: `${url}?data=${encodeURIComponent(query)}`, retrievedAt: r.retrievedAt, features };
}

/** Linéaire d'aménagements cyclables (km) dans la commune. */
export async function collectCycleways(http: TrackedHttp, codeInsee: string) {
  const query = `[out:json][timeout:90];
area["boundary"="administrative"]["admin_level"="8"]["ref:INSEE"="${codeInsee}"]->.a;
(
  way["highway"="cycleway"](area.a);
  way["cycleway"~"^(lane|track)$"](area.a);
  way["cycleway:left"~"^(lane|track)$"](area.a);
  way["cycleway:right"~"^(lane|track)$"](area.a);
  way["cycleway:both"~"^(lane|track)$"](area.a);
);
out geom;`;
  const r = await overpass<{ elements?: OverpassElement[] }>(http, query);
  const url = r.url;
  const lines: GeoJSON.Feature<GeoJSON.LineString>[] = (r.data?.elements ?? [])
    .filter((e) => e.geometry && e.geometry.length > 1)
    .map((e) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: e.geometry!.map((p) => [p.lon, p.lat]) },
      properties: { osm: `way/${e.id}`, kind: e.tags?.highway === "cycleway" ? "Piste cyclable" : "Bande ou piste sur voirie" },
    }));
  return { url: `${url}?data=${encodeURIComponent(query)}`, retrievedAt: r.retrievedAt, lines };
}

/** Équipements structurants les plus proches (rayon de 30 km autour du centre communal). */
export async function collectNearest(http: TrackedHttp, lon: number, lat: number) {
  const around = `(around:30000,${lat},${lon})`;
  const query = `[out:json][timeout:90];
(
  nwr["amenity"="hospital"]["emergency"="yes"]${around};
  nwr["amenity"="hospital"]${around};
  nwr["railway"="station"]["usage"!="industrial"]${around};
  nwr["amenity"="school"]["isced:level"~"3"]${around};
  nwr["amenity"="university"]${around};
);
out center tags;`;
  const r = await overpass<{ elements?: OverpassElement[] }>(http, query);
  const url = r.url;
  return { url: `${url}?data=${encodeURIComponent(query)}`, retrievedAt: r.retrievedAt, elements: r.data?.elements ?? [] };
}
