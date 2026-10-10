/**
 * SIMULATION DES API PUBLIQUES — DONNÉES FICTIVES, RÉSERVÉES AUX TESTS.
 *
 * Ce module remplace `fetch` pendant les tests d'intégration pour exercer
 * toute la chaîne (collecte → calculs → rendu → exports) sans réseau.
 * Les réponses reproduisent la FORME des réponses réelles telle que les
 * connecteurs l'attendent ; les VALEURS sont arbitraires et ne décrivent
 * aucun territoire réel. Elles ne doivent jamais être utilisées ailleurs.
 */

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

function melodi(ds: string, geo: string) {
  const f = geoFactor(geo);
  const scale = geo.includes("COM-60159") ? 1 : geo.includes("COM") ? 0.3 : 20;
  const G = { GEO: geo };
  switch (ds) {
    case "DS_POPULATIONS_REFERENCE":
      return [2006, 2011, 2016, 2021, 2022].map((y, i) => obs({ ...G, TIME_PERIOD: String(y), POPREF_MEASURE: "PMUN" }, Math.round(40000 * scale * (1 + (i * (f - 0.9)) / 10))));
    case "DS_RP_POPULATION_PRINC": {
      const ages = { Y_LT15: 7000, Y15T29: 9500, Y30T44: 7500, Y45T59: 7000, Y60T74: 6000, Y_GE75: 3700 * f };
      const out = [];
      let tot = 0;
      for (const [a, v] of Object.entries(ages)) {
        const val = Math.round(v * scale);
        tot += val;
        out.push(obs({ ...G, TIME_PERIOD: "2021", SEX: "_T", AGE: a, RP_MEASURE: "POP" }, val));
        out.push(obs({ ...G, TIME_PERIOD: "2021", SEX: "F", AGE: a, RP_MEASURE: "POP" }, Math.round(val * 0.52)));
        out.push(obs({ ...G, TIME_PERIOD: "2021", SEX: "M", AGE: a, RP_MEASURE: "POP" }, val - Math.round(val * 0.52)));
      }
      out.push(obs({ ...G, TIME_PERIOD: "2021", SEX: "_T", AGE: "_T", RP_MEASURE: "POP" }, tot));
      return out;
    }
    case "DS_FILOSOFI_CC":
      return [
        obs({ ...G, TIME_PERIOD: "2021", FILOSOFI_MEASURE: "MED_SL" }, Math.round(22000 * f)),
        obs({ ...G, TIME_PERIOD: "2021", FILOSOFI_MEASURE: "PR_MD60" }, 14 / f / f),
        obs({ ...G, TIME_PERIOD: "2021", FILOSOFI_MEASURE: "IR_D9_D1_SL" }, 3.4),
      ];
    case "DS_RP_LOGEMENT_PRINC": {
      const T = { ...G, TIME_PERIOD: "2021" };
      const n = (v: number) => Math.round(v * scale);
      return [
        obs({ ...T, OCS: "_T", TSH: "_T", TDW: "_T" }, n(22000)),
        obs({ ...T, OCS: "DW_MAIN", TSH: "_T", TDW: "_T" }, n(19500)),
        obs({ ...T, OCS: "DW_SEC_DW_OCC", TSH: "_T", TDW: "_T" }, n(500)),
        obs({ ...T, OCS: "DW_VAC", TSH: "_T", TDW: "_T" }, n(2000 * f)),
        obs({ ...T, OCS: "DW_MAIN", TSH: "OWN", TDW: "_T" }, n(7500)),
        obs({ ...T, OCS: "DW_MAIN", TSH: "RENT_PRIV", TDW: "_T" }, n(6500)),
        obs({ ...T, OCS: "DW_MAIN", TSH: "RENT_SOC", TDW: "_T" }, n(5000)),
        obs({ ...T, OCS: "DW_MAIN", TSH: "FREE", TDW: "_T" }, n(500)),
        obs({ ...T, OCS: "_T", TSH: "_T", TDW: "HOUSE" }, n(6000)),
        obs({ ...T, OCS: "_T", TSH: "_T", TDW: "FLAT" }, n(16000)),
      ];
    }
    case "DS_RP_EMPLOI_LR_PRINC":
      return [
        obs({ ...G, TIME_PERIOD: "2021", EMPSTA_ENQ: "_T" }, Math.round(26000 * scale)),
        obs({ ...G, TIME_PERIOD: "2021", EMPSTA_ENQ: "1" }, Math.round(16000 * scale)),
        obs({ ...G, TIME_PERIOD: "2021", EMPSTA_ENQ: "2" }, Math.round(2600 * scale * f)),
        obs({ ...G, TIME_PERIOD: "2021", EMPSTA_ENQ: "3" }, Math.round(7400 * scale)),
      ];
    case "DS_RP_EMPLOI_LT_PRINC":
      return [obs({ ...G, TIME_PERIOD: "2021" }, Math.round(24000 * scale))];
    case "DS_RP_DIPLOMES_PRINC":
      return [
        obs({ ...G, TIME_PERIOD: "2021", EDUC: "_T" }, Math.round(28000 * scale)),
        obs({ ...G, TIME_PERIOD: "2021", EDUC: "001T100_RP" }, Math.round(7000 * scale)),
        obs({ ...G, TIME_PERIOD: "2021", EDUC: "200_RP" }, Math.round(6000 * scale)),
        obs({ ...G, TIME_PERIOD: "2021", EDUC: "300_RP" }, Math.round(5000 * scale)),
        obs({ ...G, TIME_PERIOD: "2021", EDUC: "500_RP" }, Math.round(4000 * scale)),
        obs({ ...G, TIME_PERIOD: "2021", EDUC: "600_RP" }, Math.round(6000 * scale)),
      ];
    default:
      return null;
  }
}

const RANGE: Record<string, unknown> = {
  DS_RP_DIPLOMES_PRINC: {
    range: [
      {
        dimension: { id: "EDUC" },
        values: [
          { code: "_T", label: { fr: "Total" } },
          { code: "001T100_RP", label: { fr: "Aucun diplôme ou certificat d'études primaires" } },
          { code: "200_RP", label: { fr: "BEPC, brevet des collèges, DNB" } },
          { code: "300_RP", label: { fr: "CAP, BEP ou équivalent" } },
          { code: "500_RP", label: { fr: "Baccalauréat, brevet professionnel ou équivalent" } },
          { code: "600_RP", label: { fr: "Diplôme de l'enseignement supérieur" } },
        ],
      },
    ],
  },
};

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

export function mockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const p = url.pathname;
    const h = url.host;
    if (h === "geo.api.gouv.fr") {
      if (p === "/communes/60159")
        return json({ code: "60159", nom: "Compiègne", population: 40761, surface: 5300, centre: { type: "Point", coordinates: [LON0 + 0.02, LAT0 + 0.02] }, contour: square(LON0, LAT0) });
      if (p === "/departements/60/communes") return json(depFeatures());
      if (p === "/departements/60") return json({ type: "Feature", geometry: square(LON0 - 0.1, LAT0 - 0.1, 0.3), properties: { nom: "Oise" } });
      if (p === "/communes")
        return json(GRID.map(([code, nom, pop, dx, dy]) => ({ code, nom, population: pop, surface: code === "60159" ? 5300 : 1600, centre: { type: "Point", coordinates: [LON0 + dx * 0.3, LAT0 + dy * 0.3] } })));
    }
    if (h === "api.insee.fr") {
      const m = p.match(/\/melodi\/(data|range)\/(\w+)/);
      if (m?.[1] === "range") return RANGE[m[2]] ? json(RANGE[m[2]]) : json({}, 404);
      if (m?.[1] === "data") {
        const geo = url.searchParams.get("GEO") ?? "";
        if (!/^(COM|EPCI|DEP|REG)-|^FRANCE-F$/.test(geo)) return json({ observations: [] });
        const o = melodi(m[2], geo);
        return o ? json({ observations: o, paging: { isLast: true } }) : json({ message: "not found" }, 404);
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
    if (h === "www.data.gouv.fr") return json({ resources: [{ id: "rid-" + p.split("/")[4], title: "Résultats définitifs par commune", format: "csv" }] });
    if (h === "tabular-api.data.gouv.fr") {
      const row = (code: string, ins: number, vot: number) => ({ "Code département": "60", "Code commune": code, Inscrits: ins, Votants: vot, Abstentions: ins - vot, Blancs: 50, Nuls: 20, Exprimés: vot - 70, "Libellé de la liste 1": "Liste A", "Voix 1": Math.round((vot - 70) * 0.4), "Libellé de la liste 2": "Liste B", "Voix 2": Math.round((vot - 70) * 0.35), "Libellé de la liste 3": "Liste C", "Voix 3": vot - 70 - Math.round((vot - 70) * 0.4) - Math.round((vot - 70) * 0.35) });
      const all = GRID.map(([code, , pop], i) => row(code, Math.round(pop * 0.7), Math.round(pop * 0.7 * (0.45 + i * 0.03))));
      const com = url.searchParams.get("Code commune__exact");
      const data = com ? all.filter((r) => r["Code commune"] === com) : all;
      return json({ data: url.searchParams.get("page_size") === "1" ? data.slice(0, 1) : data, links: { next: null } });
    }
    throw new TypeError(`fetch failed (hôte non simulé : ${h}${p})`);
  }) as typeof fetch;
}
