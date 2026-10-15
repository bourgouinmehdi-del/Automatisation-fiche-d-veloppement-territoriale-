/**
 * SIMULATION DES SOURCES AJOUTÉES (QPV, IRIS, municipales, BPE, GTFS, OSRM) —
 * DONNÉES FICTIVES, RÉSERVÉES AUX TESTS. Les formats reprennent ceux relevés
 * sur les sources réelles en octobre 2026 ; les valeurs sont arbitraires.
 */
import { gzipSync, strToU8, zipSync } from "fflate";
import proj4 from "proj4";

proj4.defs("EPSG:2154", "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

const LON0 = 2.8;
const LAT0 = 49.4;
const rect = (x0: number, y0: number, x1: number, y1: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[LON0 + x0, LAT0 + y0], [LON0 + x1, LAT0 + y0], [LON0 + x1, LAT0 + y1], [LON0 + x0, LAT0 + y1], [LON0 + x0, LAT0 + y0]]],
});

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const bin = (u: Uint8Array) => new Response(new Uint8Array(u) as unknown as BodyInit, { status: 200, headers: { "Content-Type": "application/zip" } });
const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json" } });

// Un QPV fictif qui recouvre le bureau 2 (cf. adresses REU simulées).
const QPV = { code: "QN06099M", nom: "Quartier Fictif Nord", geom: rect(0.014, 0.002, 0.027, 0.018) };

const qpvZip = () =>
  zip({
    "QP2024_France_Hexagonale_Outre_Mer_WGS84.geojson": JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { code_qp: QPV.code, lib_qp: QPV.nom, insee_com: "60159" }, geometry: QPV.geom },
        { type: "Feature", properties: { code_qp: "QN99999M", lib_qp: "Ailleurs", insee_com: "99999" }, geometry: rect(1, 1, 1.01, 1.01) },
      ],
    }),
  });

const qpvFilosofi = () => zip({ "revenus_pauvrete_2021_qp24.csv": `CODGEO;LIBGEO;DISP_MED_A21;DISP_TP60_A21\n${QPV.code};${QPV.nom};14130;50\nQN99999M;Ailleurs;20000;20\n` });
const qpvRp = () =>
  zip({
    "meta_estimations_2022_QPV2024.csv": [
      "COD_VAR;LIB_VAR",
      "TX_CHOM;Taux de chômage (au sens du recensement)",
      "TX_CHOM_F;Taux de chômage des femmes",
      "P0014;Part des 0-14 ans dans la population",
      "P1524;Part des 15-24 ans dans la population",
      "P6074;Part des 60-74 ans dans la population",
      "P75P;Part des 75 ans et plus dans la population",
      "PLOC;Part des ménages locataires",
    ].join("\n"),
    "estimations_2022_QPV2024.csv": `CODGEO;TX_CHOM_F;TX_CHOM;P0014;P1524;P6074;P75P;PLOC\n${QPV.code};31;29;24;18;15;10;79\n`,
  });

// Quatre IRIS d'habitat (quadrants de la commune fictive 60159).
const IRIS = [
  ["601590101", "Centre", rect(0, 0, 0.02, 0.02)],
  ["601590102", "Est", rect(0.02, 0, 0.04, 0.02)],
  ["601590103", "Ouest", rect(0, 0.02, 0.02, 0.04)],
  ["601590104", "Nord", rect(0.02, 0.02, 0.04, 0.04)],
] as const;
const irisCsv = (head: string, row: (code: string, i: number) => string) => zip({ "base.csv": [head, ...IRIS.map(([c], i) => row(c, i)), "999990101;99999;1;1"].join("\n") });

function bpeZip() {
  const lines = ["DEP;DEPCOM;TYPEQU;NOMRS;LONGITUDE;LATITUDE;QP2024"];
  lines.push(`60;60159;D265;Cabinet A;${LON0 + 0.01};${LAT0 + 0.01};CSZ`);
  lines.push(`60;60159;D265;Cabinet B;${LON0 + 0.012};${LAT0 + 0.012};${QPV.code}`);
  lines.push(`60;60159;B105;Supermarché fictif;${LON0 + 0.02};${LAT0 + 0.008};${QPV.code}`);
  lines.push(`60;60159;A128;France Services fictive;${LON0 + 0.006};${LAT0 + 0.025};CSZ`);
  lines.push(`60;60159;A122;Agence France Travail fictive;${LON0 + 0.008};${LAT0 + 0.022};CSZ`);
  for (let i = 0; i < 520; i++) lines.push(`60;60382;D265;Médecin ${i};${LON0 - 0.03};${LAT0 + 0.01};CSZ`);
  lines.push(`02;02001;D265;Hors département;3;49;CSZ`);
  return zip({ "BPE25.csv": lines.join("\n") });
}

function gtfsZip(now = new Date()) {
  const dates: string[] = [];
  for (let k = 0; k < 60; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + k));
    dates.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`);
  }
  const trips = Array.from({ length: 30 }, (_, i) => `T${i}`);
  const st: string[] = ["trip_id,arrival_time,departure_time,stop_id,stop_sequence"];
  trips.forEach((t, i) => {
    // Pointe le soir : 12 trains entre 17 h et 19 h, les autres répartis dans la journée.
    const h = i < 12 ? 17 + Math.floor(i / 6) : 6 + (i % 11);
    const m = (i * 7) % 60;
    const hh = (x: number) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}:00`;
    st.push(`${t},${hh(h * 60 + m)},${hh(h * 60 + m)},StopPoint:OCETrain TER-87276006,1`);
    st.push(`${t},${hh(h * 60 + m + 52)},${hh(h * 60 + m + 52)},StopPoint:OCETrain TER-87271007,2`);
  });
  return zip({
    "stops.txt": [
      "stop_id,stop_name,stop_desc,stop_lat,stop_lon,zone_id,stop_url,location_type,parent_station",
      `StopArea:OCE87276006,Gare (fictive),,${LAT0 + 0.01},${LON0 + 0.03},,,1,`,
      `StopPoint:OCETrain TER-87276006,Gare (fictive),,${LAT0 + 0.01},${LON0 + 0.03},,,0,StopArea:OCE87276006`,
      "StopArea:OCE87271007,Paris Nord,,48.88,2.355,,,1,",
      "StopPoint:OCETrain TER-87271007,Paris Nord,,48.88,2.355,,,0,StopArea:OCE87271007",
    ].join("\n"),
    "calendar_dates.txt": ["service_id,date,exception_type", ...dates.map((d) => `S1,${d},1`)].join("\n"),
    "trips.txt": ["route_id,service_id,trip_id", ...trips.map((t) => `R1,S1,${t}`)].join("\n"),
    "stop_times.txt": st.join("\n"),
  });
}

/** Lignes municipales au format « large » du ministère (blocs par liste). */
function muniRow(code: string, dep: string, tour: 1 | 2) {
  const base = { "Code département": dep, "Code commune": code, "Libellé commune": "Commune fictive", Inscrits: 28000, Votants: 14000, Abstentions: 14000, Exprimés: 13500, Blancs: 300, Nuls: 200 };
  const lists =
    tour === 1
      ? [
          ["DURAND", "Alice", "LDVD", "Ensemble pour la ville", 5400, ""],
          ["MARTIN", "Bruno", "LUG", "La gauche unie", 4050, ""],
          ["PETIT", "Chloé", "LRN", "Le renouveau", 4050, ""],
        ]
      : [
          ["DURAND", "Alice", "LDVD", "Ensemble pour la ville", 6750, 33],
          ["MARTIN", "Bruno", "LUG", "La gauche unie", 6750, 6],
        ];
  const o: Record<string, unknown> = { ...base };
  lists.forEach(([nom, prenom, nu, lib, voix, sieges], i) => {
    const n = i + 1;
    Object.assign(o, { [`Nom candidat ${n}`]: nom, [`Prénom candidat ${n}`]: prenom, [`Nuance liste ${n}`]: nu, [`Libellé de liste ${n}`]: lib, [`Voix ${n}`]: voix, [`Sièges au CM ${n}`]: sieges, [`Elu ${n}`]: "" });
  });
  return o;
}

/** Renvoie une réponse simulée, ou null si l'URL ne relève pas de ces sources. */
export function mockExtra(url: URL): Response | null {
  const h = url.host;
  const p = url.pathname;
  // Logements sociaux (RPLS, API DiDo) : une grande résidence dans le bureau 2, deux petites ailleurs.
  if (h === "data.statistiques.developpement-durable.gouv.fr" && /\/datafiles\/[^/]+$/.test(p)) return json({ millesimes: [{ millesime: "2024-01" }, { millesime: "2025-01" }] });
  if (h === "data.statistiques.developpement-durable.gouv.fr" && p.endsWith("/csv")) {
    const com = (url.searchParams.get("DEPCOM") ?? "").replace(/^eq:/, "");
    if (com !== "60159") return new Response("DEPCOM;NUMVOIE\n", { status: 200 });
    const l93 = (lon: number, lat: number) => proj4("WGS84", "EPSG:2154", [LON0 + lon, LAT0 + lat]).map((v) => v.toFixed(1));
    const lines = ["DEPCOM;NUMVOIE;INDREP;TYPVOIE;NOMVOIE;COMPLGEO;PLG_QP24;X;Y;EPSG;CONSTRUCT"];
    const add = (n: number, num: string, voie: string, prog: string, qp: string, lon: number, lat: number) => {
      const [x, y] = l93(lon, lat);
      for (let i = 0; i < n; i++) lines.push(`60159;${num};;RUE;${voie};${prog};${qp};${x};${y};2154;1968`);
    };
    add(320, "12", "DES ROSES", "LES MUSICIENS", "QN06099M", 0.02, 0.01);
    add(180, "4", "DES ROSES", "CLOS DES ROSES", "QN06099M", 0.0206, 0.0104);
    add(24, "7", "DU MARCHE", "", "", 0.005, 0.03);
    return new Response(lines.join("\n"), { status: 200, headers: { "Content-Type": "text/csv" } });
  }
  // Cartes « affiche » : circonscriptions (deux moitiés du département fictif) et départements voisins.
  if (h === "www.data.gouv.fr" && p === "/api/1/datasets/contours-geographiques-des-circonscriptions-legislatives/")
    return json({ resources: [{ id: "circ-p10", title: "circonscriptions-legislatives-p10.geojson", format: "geojson", filesize: 1000, url: "https://static.data.gouv.fr/circonscriptions-legislatives-p10.geojson" }] });
  if (h === "static.data.gouv.fr" && p === "/circonscriptions-legislatives-p10.geojson")
    return json({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { codeDepartement: "60", codeCirconscription: "6001", nomCirconscription: "1ère circonscription" }, geometry: rect(-0.05, -0.05, 0.02, 0.09) },
        { type: "Feature", properties: { codeDepartement: "60", codeCirconscription: "6002", nomCirconscription: "2e circonscription" }, geometry: rect(0.02, -0.05, 0.09, 0.09) },
        { type: "Feature", properties: { codeDepartement: "02", codeCirconscription: "0201" }, geometry: rect(0.09, -0.05, 0.2, 0.09) },
      ],
    });
  if (h === "etalab-datasets.geo.data.gouv.fr" && p.endsWith("/departements-100m.geojson"))
    return json({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { code: "60", nom: "Oise" }, geometry: rect(-0.05, -0.05, 0.09, 0.09) },
        { type: "Feature", properties: { code: "02", nom: "Aisne" }, geometry: rect(0.09, -0.1, 0.25, 0.15) },
        { type: "Feature", properties: { code: "80", nom: "Somme" }, geometry: rect(-0.1, 0.09, 0.09, 0.25) },
        { type: "Feature", properties: { code: "13", nom: "Bouches-du-Rhône" }, geometry: rect(-5, -6, -4.9, -5.9) },
      ],
    });
  if (h === "www.data.gouv.fr" && p === "/api/1/datasets/quartiers-prioritaires-de-la-politique-de-la-ville-qpv/")
    return json({
      slug: "quartiers-prioritaires-de-la-politique-de-la-ville-qpv",
      resources: [
        { id: "qpv-list", title: "Liste des quartiers prioritaires de la politique de la ville 2024 (format CSV)", format: "csv", url: "https://static.data.gouv.fr/qpv-list.csv", last_modified: "2026-07-21" },
        { id: "qpv-geojson", title: "Perimètre des quartiers prioritaires de la politique de la ville 2024 (format geojson)", format: "zip", url: "https://static.data.gouv.fr/qpv-2024-geojson.zip", last_modified: "2026-01-16" },
      ],
    });
  if (h === "static.data.gouv.fr" && p === "/qpv-2024-geojson.zip") return bin(qpvZip());
  // Municipales, 1er tour : comme en octobre 2026, la ressource n'est plus servie par l'API
  // tabulaire (HTTP 410) ; le fichier CSV national reste téléchargeable.
  if (h === "www.data.gouv.fr" && p === "/api/1/datasets/elections-municipales-2026-resultats-du-premier-tour/")
    return json({ resources: [{ id: "4feeef01-24f7-4d5a-914f-8aa806f31ec2", title: "Municipales 2026 - Résultats - Communes_2026-03-20.csv", format: "csv", url: "https://static.data.gouv.fr/municipales-2026-t1-communes.csv" }] });
  if (h === "static.data.gouv.fr" && p === "/municipales-2026-t1-communes.csv") {
    const rows = ["60159", "60382", "60338", "60667", "60151", "60156", "60057"].map((c) => muniRow(c, "60", 1));
    const head = Object.keys(rows[0]);
    return new Response([head.join(";"), ...rows.map((r) => head.map((k) => String(r[k] ?? "")).join(";"))].join("\n"), { status: 200 });
  }
  if (h === "tabular-api.data.gouv.fr") {
    const rid = p.split("/")[3];
    const one = url.searchParams.get("page_size") === "1";
    const reply = (rows: Record<string, unknown>[]) => json({ data: one ? rows.slice(0, 1) : rows, links: { next: null } });
    if (rid === "qpv-list") {
      const com = url.searchParams.get("insee_com__contains") ?? "";
      const all = [{ code_qp: QPV.code, lib_qp: QPV.nom, insee_dep: 60, insee_com: '="60159"', lib_com: "Compiègne" }];
      return reply(all.filter((r) => r.insee_com.includes(com)));
    }
    if (rid === "4feeef01-24f7-4d5a-914f-8aa806f31ec2") return new Response(JSON.stringify({ message: "Gone" }), { status: 410 });
    if (rid === "6ff67a28-01bf-459e-beca-dd7aa8132dc1") {
      const tour = rid.startsWith("4f") ? 1 : 2;
      const com = url.searchParams.get("Code commune__exact");
      const dep = url.searchParams.get("Code département__exact");
      const codes = ["60159", "60382", "60338", "60667", "60151", "60156", "60057"];
      const rows = codes.map((c) => muniRow(c, "60", tour as 1 | 2));
      return reply(com ? rows.filter((r) => r["Code commune"] === com) : dep ? rows.filter((r) => r["Code département"] === dep) : rows);
    }
    if (rid === "2876a346-d50c-4911-934e-19ee07b0e503") {
      const com = url.searchParams.get("Code de la commune__exact");
      return reply(com === "60159" ? [{ "Code de la commune": "60159", "Nom de l'élu": "DURAND", "Prénom de l'élu": "Alice", "Date de début de la fonction": "2026-03-27" }] : []);
    }
  }
  if (h === "www.insee.fr") {
    if (p.includes("revenus_pauvrete_2021_qp24")) return bin(qpvFilosofi());
    if (p.includes("estimations-demographiques_2022_QPV2024")) return bin(qpvRp());
    if (p.includes("BASE_TD_FILO_IRIS")) return bin(irisCsv("IRIS;LIBIRIS;COM;DISP_MED21;DISP_TP6021", (c, i) => `${c};Iris ${i};60159;${[16000, 21000, 25000, 27000][i]};${[33, 18, 11, 8][i]}`));
    if (p.includes("base-ic-evol-struct-pop"))
      // Effectifs ×12 (parts inchangées) et nationalité : base de l'estimation de la non-inscription ;
      // une ligne pour Beauvais (même département), où l'on est presque tous inscrits.
      return bin(
        zip({
          "base.csv": [
            "IRIS;COM;P21_POP;P21_POP0002;P21_POP0305;P21_POP0610;P21_POP1117;P21_POP1824;P21_POP0014;P21_POP1529;P21_POP6074;P21_POP75P;P21_POP_FR",
            ...IRIS.map(([c], i) => [c, "60159", 1000, 40, 40, 60, 90, [200, 100, 80, 60][i], 180, [300, 200, 160, 140][i], [150, 200, 220, 260][i], [80, 90, 100, 120][i], 850].map((v, j) => (j < 2 ? v : Number(v) * 12)).join(";")),
            "600570101;60057;60000;2400;2400;3600;5400;6000;10800;12000;9000;4800;58000",
            "999990101;99999;1;1",
          ].join("\n"),
        }),
      );
    if (p.includes("base-ic-logement")) return bin(irisCsv("IRIS;COM;P21_RP;P21_RP_LOC;P21_RP_LOCHLMV", (c, i) => `${c};60159;400;${[300, 200, 150, 100][i]};${[220, 60, 30, 10][i]}`));
    if (p.includes("base-ic-activite-residents")) return bin(irisCsv("IRIS;COM;P21_ACT1564;P21_CHOM1564", (c, i) => `${c};60159;500;${[110, 70, 50, 40][i]}`));
    if (p.includes("BPE25")) return bin(bpeZip());
  }
  if (h === "data.geopf.fr")
    return json({
      type: "FeatureCollection",
      features: IRIS.map(([code, nom, geom]) => ({ type: "Feature", geometry: geom, properties: { code_insee: "60159", code_iris: code, nom_iris: nom, type_iris: "H" } })),
    });
  if (h === "eu.ftp.opendatasoft.com") return bin(gtfsZip());
  if (h === "adresse.data.gouv.fr" && p.includes("adresses-60")) return bin(banGz());
  if (h === "router.project-osrm.org") return json({ code: "Ok", routes: [{ duration: url.pathname.includes("2.35") ? 5400 : 1500, distance: 60000 }] });
  return null;
}

/** Base adresse nationale (CSV « ; » compressé) : adresses fictives autour des bureaux simulés. */
function banGz() {
  const head = "id;id_fantoir;numero;rep;nom_voie;code_postal;code_insee;nom_commune;code_insee_ancienne_commune;nom_ancienne_commune;x;y;lon;lat;type_position;alias;nom_ld;libelle_acheminement;nom_afnor;source_position;source_nom_voie;certification_commune;cad_parcelles";
  const lines = [head];
  for (let i = 0; i < 6; i++)
    for (let k = 0; k < 5; k++)
      for (let n = 1; n <= 4; n++) {
        const lon = LON0 + 0.005 + (i % 3) * 0.012 + (k % 2) * 0.006 + n * 0.0002;
        const lat = LAT0 + 0.005 + Math.floor(i / 3) * 0.015 + Math.floor(k / 2) * 0.005 + n * 0.0001;
        lines.push(`60159_x_${i}${k}${n};;${n + k * 2};;Rue Fictive ${String.fromCharCode(65 + i)}${k % 2};60200;60159;Compiègne;;;0;0;${lon.toFixed(6)};${lat.toFixed(6)};entrée;;;COMPIEGNE;;commune;commune;1;`);
      }
  lines.push("60382_x;;1;;Rue Ailleurs;60280;60382;Margny-lès-Compiègne;;;0;0;2.82;49.43;entrée;;;MARGNY;;commune;commune;1;");
  return gzipSync(strToU8(lines.join("\n") + "\n"));
}

