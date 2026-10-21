/**
 * SIMULATION DES API PUBLIQUES — DONNÉES FICTIVES, RÉSERVÉES AUX TESTS.
 *
 * Ce module remplace `fetch` pendant les tests d'intégration pour exercer
 * toute la chaîne (collecte → calculs → rendu → exports) sans réseau.
 * Les réponses reproduisent la FORME des réponses réelles telle que les
 * connecteurs l'attendent ; les VALEURS sont arbitraires et ne décrivent
 * aucun territoire réel. Elles ne doivent jamais être utilisées ailleurs.
 */

import { mockExtra } from "./mock-extra";

const square = (lon: number, lat: number, d = 0.04): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]],
});

// Grille fictive de communes : 60159 au centre, entourée de 8 voisines.
const GRID = [
  ["60159", "Compiègne", 40761, 0, 0],
  ["60382", "Margny-lès-Compiègne", 8677, -1, 0],
  ["60338", "Lacroix-Saint-Ouen", 5415, 0, -1],
  ["60667", "Venette", 2758, -1, -1],
  ["60151", "Choisy-au-Bac", 3449, 0, 1],
  ["60156", "Clairoix", 2208, -1, 1],
  ["60325", "Janville", 640, 1, 1],
  ["60665", "Vieux-Moulin", 593, 1, 0],
  ["60057", "Beauvais", 56000, 1, -1],
] as const;
const LON0 = 2.8;
const LAT0 = 49.4;

function depFeatures() {
  return {
    type: "FeatureCollection",
    features: GRID.map(([code, nom, pop, dx, dy]) => ({
      type: "Feature",
      geometry: square(LON0 + dx * 0.04, LAT0 + dy * 0.04),
      properties: { code, nom, population: pop, surface: 1600, codeEpci: code === "60057" ? "200067999" : "200067965" },
    })),
  };
}

const geoFactor = (geo: string) => (geo.includes("COM-60159") ? 1 : geo.includes("EPCI") ? 0.9 : geo.includes("DEP") ? 0.8 : geo.includes("REG") ? 0.85 : geo.includes("FRANCE") ? 0.95 : 1.1);

function obs(dims: Record<string, string>, value: number) {
  return { dimensions: dims, measures: { OBS_VALUE_NIVEAU: { value } } };
}

/**
 * Structure calquée sur l'API Melodi réelle (dimensions et modalités relevées
 * par `npm run check:sources -- --insee 60159` en octobre 2026) ; valeurs fictives.
 */
function melodi(ds: string, geo: string) {
  const f = geoFactor(geo);
  const scale = geo.includes("COM-60159") ? 1 : geo.includes("COM") ? 0.3 : 20;
  const n = (v: number) => Math.round(v * scale);
  const G = { GEO: geo, FREQ: "A" };
  const years = ["2012", "2017", "2023"];
  switch (ds) {
    case "DS_POPULATIONS_REFERENCE":
      // Un seul millésime, comme l'API réelle : la série historique vient du recensement.
      return ["PTOT", "PMUN", "PCAP"].map((m, i) => obs({ ...G, TIME_PERIOD: "2023", POPREF_MEASURE: m }, n(41000 - i * 300)));
    case "DS_RP_POPULATION_PRINC": {
      // Partition fine : <15, 15-24, 25-39, 40-54, 55-64, 65-79, 80+ ; agrégats Y_LT20, Y20T64, Y_GE65.
      const fine: Record<string, number> = { Y_LT15: 7000, Y15T24: 6500, Y25T39: 8000, Y40T54: 7500, Y55T64: 4500, Y65T79: 5200, Y_GE80: 2000 * f };
      const out: ReturnType<typeof obs>[] = [];
      years.forEach((y, yi) => {
        const k = 1 + (yi - 2) * 0.02 * (f - 0.9) * 10;
        const v = Object.fromEntries(Object.entries(fine).map(([a, x]) => [a, n(x * k)]));
        const tot = Object.values(v).reduce((s2, x) => s2 + x, 0);
        const agg = { ...v, Y_LT20: Math.round(v.Y_LT15 + v.Y15T24 / 2), Y20T64: tot - v.Y_LT15 - v.Y65T79 - v.Y_GE80 - Math.round(v.Y15T24 / 2), Y_GE65: v.Y65T79 + v.Y_GE80, _T: tot };
        for (const [age, val] of Object.entries(agg)) {
          out.push(obs({ ...G, TIME_PERIOD: y, SEX: "_T", AGE: age, RP_MEASURE: "POP" }, val));
          out.push(obs({ ...G, TIME_PERIOD: y, SEX: "F", AGE: age, RP_MEASURE: "POP" }, Math.round(val * 0.52)));
          out.push(obs({ ...G, TIME_PERIOD: y, SEX: "M", AGE: age, RP_MEASURE: "POP" }, val - Math.round(val * 0.52)));
        }
      });
      return out;
    }
    case "DS_FILOSOFI_CC":
      return [
        obs({ ...G, TIME_PERIOD: "2021", UNIT_MEASURE: "EUR_YR", FILOSOFI_MEASURE: "MED_SL" }, Math.round(22000 * f)),
        obs({ ...G, TIME_PERIOD: "2021", UNIT_MEASURE: "EUR_YR", FILOSOFI_MEASURE: "D1_SL" }, Math.round(11000 * f)),
        obs({ ...G, TIME_PERIOD: "2021", UNIT_MEASURE: "PT", FILOSOFI_MEASURE: "PR_MD60" }, 14 / f / f),
        obs({ ...G, TIME_PERIOD: "2021", UNIT_MEASURE: "NR", FILOSOFI_MEASURE: "IR_D9_D1_SL" }, 3.4),
      ];
    case "DS_RP_LOGEMENT_PRINC": {
      const out: ReturnType<typeof obs>[] = [];
      for (const y of years) {
        const base = { CARS: "_T", BUILD_END: "_T", NRG_SRC: "_T", TDW: "_T", TSH: "_T", CARPARK: "_T", NOR: "_T", L_STAY: "_T", OCS: "_T" };
        const T = { ...G, TIME_PERIOD: y };
        const o = (dims: Record<string, string>, v: number, m = "DWELLINGS") => obs({ ...T, ...base, RP_MEASURE: m, ...dims }, n(v));
        out.push(
          o({}, 22000),
          o({}, 45000, "DWELLINGS_POPSIZE"), // autre mesure : ne doit jamais être mélangée aux logements
          o({ OCS: "DW_MAIN" }, 19500),
          o({ OCS: "DW_SEC_DW_OCC" }, 500),
          o({ OCS: "DW_VAC" }, 2000 * f),
          o({ OCS: "DW_MAIN", TSH: "100" }, 7500),
          o({ OCS: "DW_MAIN", TSH: "200" }, 11500),
          o({ OCS: "DW_MAIN", TSH: "211" }, 5800),
          o({ OCS: "DW_MAIN", TSH: "212_222" }, 700),
          o({ OCS: "DW_MAIN", TSH: "221" }, 5000),
          o({ OCS: "DW_MAIN", TSH: "300" }, 500),
          o({ TDW: "1" }, 6000),
          o({ TDW: "2" }, 15800),
          o({ TDW: "3T6" }, 200),
          o({ OCS: "DW_MAIN", CARS: "C0" }, 5000),
          o({ OCS: "DW_MAIN", CARS: "C1" }, 9500),
          o({ OCS: "DW_MAIN", CARS: "C_GE1" }, 14500),
          o({ OCS: "DW_MAIN", CARS: "C_GE2" }, 5000),
          o({ BUILD_END: "Y_LT1919" }, 2000),
          o({ BUILD_END: "Y1919T1945" }, 2000),
          o({ BUILD_END: "Y1946T1970" }, 6000),
          o({ BUILD_END: "Y1971T1990" }, 6000),
          o({ BUILD_END: "Y1991T2005" }, 3500),
          o({ BUILD_END: "Y2006TAAAA" }, 2500),
          o({ BUILD_END: "Y_LT1946" }, 4000), // modalité agrégée qui recouvre les deux premières
        );
      }
      return out;
    }
    case "DS_RP_EMPLOI_LR_PRINC": {
      const out: ReturnType<typeof obs>[] = [];
      for (const y of years)
        for (const [age, k] of [["Y15T64", 1], ["Y_GE15", 1.35], ["Y15T24", 0.2]] as const) {
          const o = (e: string, v: number) => obs({ ...G, TIME_PERIOD: y, SEX: "_T", EDUC: "_T", RP_MEASURE: "POP", AGE: age, EMPSTA_ENQ: e }, Math.round(n(v) * k));
          out.push(o("_T", 26000), o("1", 16000), o("2", 2600 * f), o("1T2", 16000 + 2600 * f), o("3", 7400 - 2600 * (f - 1)));
        }
      return out;
    }
    case "DS_RP_EMPLOI_LT_PRINC":
      return years.flatMap((y) => [
        obs({ ...G, TIME_PERIOD: y, SEX: "_T", EMPFORM: "_T", WKTIME: "_T", EMPSTA_ENQ: "1", RP_MEASURE: "NBEMP", AGE: "_T" }, n(24000)),
        obs({ ...G, TIME_PERIOD: y, SEX: "_T", EMPFORM: "_T", WKTIME: "_T", EMPSTA_ENQ: "1", RP_MEASURE: "NBEMP", AGE: "Y_GE15" }, n(23900)),
      ]);
    case "DS_RP_DIPLOMES_PRINC": {
      const v: Record<string, number> = { "001T100_RP": 5000, "200_RP": 2000, "300_RP": 5000, "350T351_RP": 6000, "500_RP": 3000, "600_RP": 3500, "700_RP": 3500 };
      const agg = { ...v, "500T702_RP": 10000, "600T702_RP": 7000, _T: 28000 };
      return Object.entries(agg).map(([e, x]) => obs({ ...G, TIME_PERIOD: "2023", SEX: "_T", RP_MEASURE: "POP", AGE: "Y_GE15", EDUC: e }, n(x)));
    }
    case "DS_RP_MENAGES_PRINC":
      return [
        obs({ ...G, TIME_PERIOD: "2023", CIVIL_STATUS: "_T", NOC: "_T", COUPLE: "_T", OCS: "_T", RP_MEASURE: "POP", AGE: "Y_GE15" }, n(34000)),
        obs({ ...G, TIME_PERIOD: "2023", CIVIL_STATUS: "_T", NOC: "_T", COUPLE: "_T", OCS: "_T", RP_MEASURE: "ONEPERS", AGE: "Y_GE15" }, n(6800)),
        obs({ ...G, TIME_PERIOD: "2023", CIVIL_STATUS: "_T", NOC: "_T", COUPLE: "_T", OCS: "_T", RP_MEASURE: "ONEPERS", AGE: "Y65T79" }, n(1500)),
      ];
    case "DS_RP_POPULATION_COMP": {
      const v: Record<string, number> = { "1": 50, "2": 1000, "3": 4500, "4": 5000, "5": 5500, "6": 3500, "7": 8000, "9": 6450 };
      const out = Object.entries(v).map(([p2, x]) => obs({ ...G, TIME_PERIOD: "2023", SEX: "_T", RP_MEASURE: "POP", AGE: "Y_GE15", PCS: p2 }, n(x)));
      out.push(obs({ ...G, TIME_PERIOD: "2023", SEX: "_T", RP_MEASURE: "POP", AGE: "Y_GE15", PCS: "_T" }, n(34000)));
      out.push(obs({ ...G, TIME_PERIOD: "2023", SEX: "_T", RP_MEASURE: "POP", AGE: "Y15T24", PCS: "_T" }, n(5000)));
      return out;
    }
    case "DS_RP_NAVETTES_PRINC": {
      const tr: Record<string, number> = { "1": 600, "2": 2400, "3": 500, "4": 300, "3T4": 800, "5": 9000, "6": 3200, _T: 16000 };
      const wa: Record<string, number> = { "10": 7000, "20_30": 9000, "21": 6000 };
      return [
        ...Object.entries(tr).map(([t, x]) => obs({ ...G, TIME_PERIOD: "2023", EMPSTA_ENQ: "1", RP_MEASURE: "POP", AGE: "Y_GE15", WORK_AREA: "_T", TRANS: t }, n(x))),
        ...Object.entries(wa).map(([w, x]) => obs({ ...G, TIME_PERIOD: "2023", EMPSTA_ENQ: "1", RP_MEASURE: "POP", AGE: "Y_GE15", WORK_AREA: w, TRANS: "_T" }, n(x))),
      ];
    }
    default:
      return null;
  }
}

const RANGE: Record<string, unknown> = {};

const DVF_HEAD = "id_mutation,date_mutation,numero_disposition,nature_mutation,valeur_fonciere,code_commune,type_local,surface_reelle_bati";
function dvf(year: number) {
  const rows = [DVF_HEAD];
  for (let i = 0; i < 40; i++) {
    rows.push(`${year}-A${i},${year}-03-01,1,Vente,${150000 + i * 2000},60159,Appartement,${50 + (i % 10)}`);
    rows.push(`${year}-M${i},${year}-05-01,1,Vente,${250000 + i * 3000},60159,Maison,${90 + (i % 15)}`);
  }
  rows.push(`${year}-X1,${year}-06-01,1,Vente,500000,60159,Appartement,60`, `${year}-X1,${year}-06-01,1,Vente,500000,60159,Appartement,70`); // vente multiple exclue
  rows.push(`${year}-D1,${year}-06-01,1,Vente,180000,60159,Appartement,55`, `${year}-D1,${year}-06-01,1,Vente,180000,60159,Dépendance,`);
  return rows.join("\n");
}

function overpass(body: string) {
  const q = decodeURIComponent(body.replace(/^data=/, ""));
  if (q.includes("around:")) {
    return {
      elements: [
        { type: "node", id: 1, lat: LAT0 + 0.02, lon: LON0 + 0.02, tags: { amenity: "hospital", emergency: "yes", name: "Centre hospitalier (fictif)" } },
        { type: "node", id: 2, lat: LAT0 + 0.01, lon: LON0 + 0.03, tags: { railway: "station", name: "Gare (fictive)" } },
        { type: "node", id: 3, lat: LAT0 + 0.5, lon: LON0 + 0.5, tags: { amenity: "university", name: "Université (fictive)" } },
      ],
    };
  }
  // Fond de plan (cartes « affiche ») : quelques voies, une voie ferrée, une rivière et un plan d'eau.
  if (q.includes("waterway")) {
    const g = (pts: [number, number][]) => pts.map(([x, y]) => ({ lon: LON0 + x, lat: LAT0 + y }));
    return {
      elements: [
        { type: "way", id: 501, tags: { highway: "primary", name: "Avenue de la République" }, geometry: g([[-0.01, 0.0], [0.05, 0.03]]) },
        { type: "way", id: 502, tags: { highway: "residential", name: "Rue des Roses" }, geometry: g([[0.0, 0.02], [0.04, 0.02], [0.04, 0.035]]) },
        { type: "way", id: 503, tags: { railway: "rail" }, geometry: g([[-0.01, 0.035], [0.05, 0.005]]) },
        { type: "way", id: 504, tags: { waterway: "river", name: "L'Oise" }, geometry: g([[-0.01, 0.04], [0.05, 0.041]]) },
        { type: "way", id: 505, tags: { natural: "water" }, geometry: g([[0.03, 0.03], [0.035, 0.03], [0.035, 0.034], [0.03, 0.03]]) },
      ],
    };
  }
  // Grandes surfaces : un hypermarché desservi, un supermarché de proximité (écarté), un hypermarché sans arrêt (écarté).
  if (q.includes('"shop"="supermarket"')) {
    return {
      elements: [
        { type: "way", id: 801, center: { lat: LAT0 + 0.006, lon: LON0 + 0.03 }, tags: { shop: "supermarket", brand: "E.Leclerc", name: "E.Leclerc", "addr:street": "Avenue fictive" } },
        { type: "node", id: 802, lat: LAT0 + 0.02, lon: LON0 + 0.02, tags: { shop: "supermarket", brand: "Carrefour City", name: "Carrefour City" } },
        { type: "node", id: 803, lat: LAT0 + 0.035, lon: LON0 + 0.035, tags: { shop: "supermarket", brand: "Auchan", name: "Auchan" } },
        { type: "node", id: 811, lat: LAT0 + 0.007, lon: LON0 + 0.031 },
        { type: "node", id: 812, lat: LAT0 + 0.0205, lon: LON0 + 0.0205 },
      ],
    };
  }
  // Stations (points de rendez-vous) : un métro près des bureaux prioritaires.
  if (q.includes('"public_transport"="station"')) {
    return {
      elements: [
        { type: "node", id: 901, lat: LAT0 + 0.016, lon: LON0 + 0.012, tags: { railway: "station", station: "subway", name: "Mairie fictive" } },
        { type: "node", id: 902, lat: LAT0 + 0.0065, lon: LON0 + 0.0305, tags: { railway: "tram_stop", name: "Centre commercial" } },
      ],
    };
  }
  // Moment convivial : un grand parc nommé, un bar de 80 places, un petit bar (écarté).
  if (q.includes("biergarten")) {
    return {
      elements: [
        { type: "way", id: 701, center: { lat: LAT0 + 0.026, lon: LON0 + 0.012 }, bounds: { minlat: LAT0 + 0.025, minlon: LON0 + 0.01, maxlat: LAT0 + 0.028, maxlon: LON0 + 0.015 }, tags: { leisure: "park", name: "Parc fictif" } },
        { type: "node", id: 702, lat: LAT0 + 0.012, lon: LON0 + 0.021, tags: { amenity: "bar", name: "Grand café fictif", capacity: "80" } },
        { type: "node", id: 703, lat: LAT0 + 0.013, lon: LON0 + 0.022, tags: { amenity: "pub", name: "Petit bar", capacity: "25" } },
      ],
    };
  }
  if (q.includes("dormitory")) {
    return { elements: [{ type: "way", id: 601, center: { lat: LAT0 + 0.01, lon: LON0 + 0.008 }, tags: { building: "dormitory", name: "Résidence Roberval", operator: "CROUS Amiens-Picardie", "building:flats": "385" } }] };
  }
  if (q.includes("cycleway")) {
    return { elements: [{ type: "way", id: 10, tags: { highway: "cycleway" }, geometry: [{ lat: LAT0 + 0.01, lon: LON0 + 0.01 }, { lat: LAT0 + 0.02, lon: LON0 + 0.03 }] }] };
  }
  const tagsList = [
    { amenity: "school", name: "École A" },
    { amenity: "school", name: "École B" },
    { amenity: "doctors", name: "Cabinet médical" },
    { amenity: "pharmacy", name: "Pharmacie" },
    { amenity: "townhall", name: "Mairie" },
    { shop: "supermarket", name: "Supermarché" },
    { highway: "bus_stop", name: "Arrêt" },
    { railway: "station", name: "Gare (fictive)" },
    { leisure: "sports_centre", name: "Gymnase" },
    { amenity: "library", name: "Médiathèque" },
  ];
  return { elements: tagsList.map((tags, i) => ({ type: "node", id: 100 + i, lat: LAT0 + 0.005 + i * 0.003, lon: LON0 + 0.005 + i * 0.003, tags })) };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Territoires demandés à chaque requête Melodi « data » (contrôle du regroupement). */
export const melodiCalls: string[][] = [];

export function mockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const p = url.pathname;
    const h = url.host;
    const extra = mockExtra(url);
    if (extra) return extra;
    if (h === "geo.api.gouv.fr") {
      if (p === "/communes/60159")
        return json({ code: "60159", nom: "Compiègne", population: 40761, surface: 5300, centre: { type: "Point", coordinates: [LON0 + 0.02, LAT0 + 0.02] }, contour: square(LON0, LAT0) });
      if (p === "/departements/60/communes" && url.searchParams.get("format") === "json")
        return json(GRID.map(([code, nom, pop, dx, dy]) => ({ code, nom, population: pop, centre: { type: "Point", coordinates: [LON0 + dx * 0.04 + 0.02, LAT0 + dy * 0.04 + 0.02] } })));
      if (p === "/departements/60/communes") return json(depFeatures());
      if (p === "/departements/60") return json({ type: "Feature", geometry: square(LON0 - 0.1, LAT0 - 0.1, 0.3), properties: { nom: "Oise" } });
      if (p === "/communes")
        return json(GRID.map(([code, nom, pop, dx, dy]) => ({ code, nom, population: pop, surface: code === "60159" ? 5300 : 1600, centre: { type: "Point", coordinates: [LON0 + dx * 0.3, LAT0 + dy * 0.3] } })));
    }
    if (h === "api.insee.fr") {
      const m = p.match(/\/melodi\/(data|range)\/(\w+)/);
      if (m?.[1] === "range") return RANGE[m[2]] ? json(RANGE[m[2]]) : json({}, 404);
      if (m?.[1] === "data") {
        // Plusieurs territoires possibles (paramètre GEO répété), comme l'API réelle.
        const geos = url.searchParams.getAll("GEO");
        melodiCalls.push(geos);
        const obs = geos.filter((geo) => /^(COM|EPCI|DEP|REG)-|^FRANCE-FM?$/.test(geo)).flatMap((geo) => melodi(m[2], geo) ?? []);
        if (!obs.length && geos.some((geo) => /^(COM|EPCI|DEP|REG)-|^FRANCE-FM?$/.test(geo)) && !melodi(m[2], "COM-60159")) return json({ message: "not found" }, 404);
        return json({ observations: obs, paging: { isLast: true } });
      }
    }
    if (h === "files.data.gouv.fr") {
      const y = Number(p.match(/\/(\d{4})\//)?.[1]);
      return y >= 2021 && y <= 2024 ? new Response(dvf(y), { status: 200 }) : new Response("", { status: 404 });
    }
    if (h === "overpass-api.de") return json(overpass(String(init?.body ?? "")));
    if (h === "georisques.gouv.fr") {
      if (p.endsWith("/gaspar/risques")) return json({ data: [{ risques_detail: [{ libelle_risque_long: "Inondation" }, { libelle_risque_long: "Mouvement de terrain" }] }] });
      if (p.endsWith("/gaspar/catnat"))
        return json({ data: Array.from({ length: 6 }, (_, i) => ({ libelle_risque_jo: i % 2 ? "Inondations et/ou Coulées de Boue" : "Mouvement de Terrain", date_debut_evt: `20${10 + i}-01-0${i + 1}`, date_publication_arrete: "2020-01-01" })) });
      if (p.endsWith("/zonage_sismique")) return json({ data: [{ zone_sismicite: "1 - TRES FAIBLE" }] });
      if (p.endsWith("/radon")) return json({ data: [{ classe_potentiel: "1" }] });
      if (p.endsWith("/installations_classees")) return json({ data: [{ raisonSociale: "Usine (fictive)", regime: "Autorisation", statutSeveso: "Non Seveso", longitude: LON0 + 0.01, latitude: LAT0 + 0.01 }] });
    }
    if (h === "data.education.gouv.fr")
      return json({
        total_count: 3,
        results: [
          { identifiant_de_l_etablissement: "1", nom_etablissement: "École (fictive)", type_etablissement: "Ecole", statut_public_prive: "Public", nombre_d_eleves: 200, appartenance_education_prioritaire: "REP", latitude: LAT0 + 0.01, longitude: LON0 + 0.01, etat: "OUVERT" },
          { identifiant_de_l_etablissement: "2", nom_etablissement: "Collège (fictif)", type_etablissement: "Collège", statut_public_prive: "Public", nombre_d_eleves: 500, latitude: LAT0 + 0.02, longitude: LON0 + 0.01, etat: "OUVERT" },
          { identifiant_de_l_etablissement: "3", nom_etablissement: "Lycée (fictif)", type_etablissement: "Lycée", statut_public_prive: "Privé", latitude: LAT0 + 0.02, longitude: LON0 + 0.02, etat: "OUVERT" },
        ],
      });
    if (h === "ressources.data.sncf.com") {
      if (p.includes("gares-de-voyageurs")) return json({ results: [{ nom: "Gare (fictive)", codes_uic: "87276006", segment_drg: "b", position_geographique: { lon: LON0 + 0.03, lat: LAT0 + 0.01 } }] });
      return json({ results: [{ nom_gare: "Gare (fictive)", code_uic_complet: "87276006", total_voyageurs_2019: 2000000, total_voyageurs_2023: 2300000 }] });
    }
    if (h === "recherche-entreprises.api.gouv.fr") {
      const s = url.searchParams.get("section_activite_principale");
      if (s) return json({ total_results: s === "G" ? 900 : s === "Q" ? 600 : s === "M" ? 500 : 50 });
      return json({ total_pages: 1, results: [{ nom_complet: "Entreprise (fictive)", section_activite_principale: "Q", activite_principale: "86.10Z", matching_etablissements: [{ siret: "00000000000000", commune: "60159", tranche_effectif_salarie: "42", activite_principale: "86.10Z" }] }] });
    }
    if (h === "api-adresse.data.gouv.fr")
      return json({ features: [{ type: "Feature", geometry: { type: "Point", coordinates: [LON0 + 0.01 + Math.random() * 0.02, LAT0 + 0.01 + Math.random() * 0.02] }, properties: { label: url.searchParams.get("q") } }] });
    if (h === "www.data.gouv.fr") {
      // Recherche plein texte : jeu REU (bureaux de vote et adresses) ; pas de contours.
      if (p === "/api/1/datasets/") {
        const q = url.searchParams.get("q") ?? "";
        if (/adresses/i.test(q))
          return json({
            data: [
              {
                slug: "bureaux-de-vote-et-adresses-de-leurs-electeurs",
                title: "Bureaux de vote et adresses de leurs électeurs",
                resources: [
                  { id: "reu-bv", title: "table-bv-reu.csv", format: "csv", url: "https://static.data.gouv.fr/reu-bv.csv" },
                  { id: "reu-adr", title: "table-adresses-reu.csv", format: "csv", url: "https://static.data.gouv.fr/reu-adr.csv" },
                ],
              },
            ],
          });
        return json({ data: [] });
      }
      const slug = p.split("/")[4];
      return json({
        slug,
        resources: [
          { id: "rid-" + slug, title: "Résultats définitifs par commune", format: "csv" },
          { id: "bv-" + slug, title: "Résultats définitifs par bureau de vote", format: "csv" },
        ],
      });
    }
    if (h === "tabular-api.data.gouv.fr") {
      const rid = p.split("/")[3];
      const one = url.searchParams.get("page_size") === "1";
      // REU : libellés et adresses géolocalisées des 6 bureaux fictifs de 60159.
      if (rid === "reu-bv") {
        const rows = Array.from({ length: 6 }, (_, i) => ({ code_commune_ref: "60159", id_bv: `60159_${i + 1}`, libelle_reu: `École fictive ${String.fromCharCode(65 + i)}`, num_voie_reu: String(i + 1), voie_reu: "rue fictive", cp_reu: "60200", commune_reu: "Compiègne" }));
        return json({ data: one ? rows.slice(0, 1) : rows, links: { next: null } });
      }
      if (rid === "reu-adr") {
        const rows = [];
        for (let i = 0; i < 6; i++)
          for (let k = 0; k < 5; k++)
            rows.push({ code_commune_ref: "60159", id_bv: `60159_${i + 1}`, longitude: LON0 + 0.005 + (i % 3) * 0.012 + (k % 2) * 0.006, latitude: LAT0 + 0.005 + Math.floor(i / 3) * 0.015 + Math.floor(k / 2) * 0.005 });
        return json({ data: one ? rows.slice(0, 1) : rows, links: { next: null } });
      }
      // Libellés réalistes selon le scrutin (le motif LFI doit les reconnaître).
      const lists = rid.includes("presidentielle")
        ? ["MÉLENCHON", "LE PEN", "MACRON"]
        : rid.includes("legislatives")
          ? ["UG", "RN", "ENS"]
          : ["LA FRANCE INSOUMISE - UNION POPULAIRE", "LA FRANCE REVIENT ! AVEC JORDAN BARDELLA ET MARINE LE PEN", "REVEILLER L'EUROPE"];
      const labelCol = rid.includes("presidentielle") ? "Nom candidat" : rid.includes("legislatives") ? "Nuance candidat" : "Libellé de la liste";
      // Scrutins antérieurs (2017, 2019) : vote LFI plus faible, pour tester l'évolution.
      const past = rid.includes("2019") ? 0.7 : rid.includes("2017") ? 0.85 : 1;
      const row = (code: string, ins: number, vot: number, lfiShare: number, bv?: string) => {
        const exp = vot - 70;
        const v1 = Math.round(exp * lfiShare * past);
        const v2 = Math.round(exp * 0.35);
        return {
          "Code département": "60",
          "Code commune": code,
          ...(bv ? { "Code BV": bv } : {}),
          Inscrits: ins,
          Votants: vot,
          Abstentions: ins - vot,
          Blancs: 50,
          Nuls: 20,
          Exprimés: exp,
          [`${labelCol} 1`]: lists[0],
          "Voix 1": v1,
          [`${labelCol} 2`]: lists[1],
          "Voix 2": v2,
          [`${labelCol} 3`]: lists[2],
          "Voix 3": exp - v1 - v2,
        };
      };
      let all;
      if (rid.startsWith("bv-")) {
        // 6 bureaux à Compiègne : vote LFI et abstention contrastés.
        all = [
          ...Array.from({ length: 6 }, (_, i) => row("60159", 1200, [700, 500, 760, 520, 640, 800][i], [0.2, 0.35, 0.12, 0.3, 0.18, 0.1][i], String(i + 1).padStart(4, "0"))),
          row("60382", 3000, 1600, 0.15, "0001"),
        ];
      } else all = GRID.map(([code, , pop], i) => row(code, Math.round(pop * 0.7), Math.round(pop * 0.7 * (0.45 + i * 0.03)), 0.12 + (code === "60159" ? 0.1 : 0)));
      const com = url.searchParams.get("Code commune__exact");
      const data = com ? all.filter((r) => r["Code commune"] === com) : all;
      return json({ data: one ? data.slice(0, 1) : data, links: { next: null } });
    }
    throw new TypeError(`fetch failed (hôte non simulé : ${h}${p})`);
  }) as typeof fetch;
}
