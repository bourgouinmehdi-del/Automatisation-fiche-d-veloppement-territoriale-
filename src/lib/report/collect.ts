import { prettyFr } from "../format";
import { fixAdr, numVoie } from "../collectors/rpls";
import * as turf from "@turf/turf";
import {
  referentiel,
  communeFromReferentiel,
  departementContour,
  departementGeo,
  epciInfo,
  epciMembers,
  intercoOf,
  enrichCommune,
  franceCentres,
  franceCommunes,
  POPULATION_VINTAGE,
  regionCommunes,
  departementCommunes,
} from "../collectors/admin";
import { CollectContext } from "../collectors/context";
import { collectDvf, DvfStat } from "../collectors/dvf";
import {
  BureauResult,
  collectBureaux,
  collectElection,
  ELECTIONS,
  HISTORICAL_ELECTIONS,
  ElectionConfig,
  ElectionResult,
} from "../collectors/elections";
import { BureauGeo, collectBureauxGeo } from "../collectors/bureaux-geo";
import { InternalData, loadInternalData } from "../collectors/interne";
import { loadStmt, type StmtSeries } from "../collectors/emploi";
import { CATALOGUE_URL, isPorteAPorte, loadCatalogue, residencesOf, residencesOfGeocoded, type ResidenceEtudiante } from "../collectors/residences-etudiantes";
import { circoCommunes, circoLabel, collectCirconscriptions, collectConvivialite, collectDepartementsVoisins, collectEquipementsOsm, collectFondOsm, collectGrandesSurfaces, collectStationsTC, fitAspect, type Bbox, type Circo, type FondOsm, type GrandeSurface, type EquipementOsm, type LieuConvivial, type StationTC, type Residence } from "../collectors/carto";
import { rankBureaux } from "../analysis/political";
import { collectRpls, type RplsResult } from "../collectors/rpls";
import { collectAdultes, type AdultesDep } from "../collectors/adultes";
import { plmInfo } from "../collectors/plm";
import { collectIris, collectQpv, Quartier } from "../collectors/quartiers";
import {
  collectMunicipales,
  collectMunicipalesDepartement,
  MunicipalResult,
} from "../collectors/municipales";
import { BpeResult, BPE_VINTAGE, collectBpe, readBpeNational } from "../collectors/bpe";
import { nationalServiceRefs, type ServicesRef } from "../analysis/services-ref";
import { collectTimetables, StationTimetable } from "../collectors/gtfs";
import { collectRoutes, Route } from "../collectors/routes";
import { config } from "../config";
import { Adresse, collectAdresses } from "../collectors/ban";
import { cachedExtract, heavyLane, rssMb } from "../runtime";
import { collectInsee, DATASETS, InseeResult } from "../collectors/insee-indicators";
import { prefetchMelodi } from "../collectors/insee";
import {
  collectCycleways,
  collectEquipments,
  collectNearest,
} from "../collectors/osm";
import {
  collectEntreprises,
  collectRisques,
  collectSchools,
  collectStations,
  Employer,
  RisquesResult,
  School,
  Station,
} from "../collectors/public-apis";
import { comparableCommunes, density, haversineKm } from "../analysis/stats";
import type {
  CommuneInfo,
  Focus,
  GeoRef,
  ProgressEvent,
  ReportQuery,
  Scope,
  SourceRef,
} from "../types";

/**
 * Collecte brute : orchestre les connecteurs et rassemble leurs résultats
 * dans une structure unique. Chaque étape est isolée (une source en panne
 * n'empêche pas les autres) et signale sa progression.
 */

export interface GeoSet {
  commune: GeoRef;
  epci: GeoRef | null;
  departement: GeoRef;
  region: GeoRef;
  france: GeoRef;
}

export interface Collected {
  query: ReportQuery;
  commune: CommuneInfo;
  focus: Focus;
  geos: GeoSet;
  perimeter: {
    label: string;
    communes: { code: string; nom: string; population: number | null }[];
  };
  /** Populations (référentiel embarqué) des territoires de référence. */
  populations: { geo: GeoRef; value: number; communes: number }[];
  popSource: SourceRef;
  geoSource?: SourceRef;
  depFeatures?: GeoJSON.FeatureCollection;
  depContour?: GeoJSON.Feature | null;
  neighbours: {
    code: string;
    nom: string;
    population: number | null;
    surfaceKm2: number | null;
  }[];
  poles: {
    code: string;
    nom: string;
    population: number;
    distanceKm: number;
  }[];
  /** Distance à vol d'oiseau à Paris (km). */
  parisKm?: number | null;
  polesSource?: SourceRef;
  insee: { geo: GeoRef; result: InseeResult }[];
  perimeterInsee: { code: string; nom: string; result: InseeResult }[];
  comparables: {
    code: string;
    nom: string;
    population: number | null;
    densite: number | null;
    departement: string;
    result?: InseeResult;
  }[];
  /** Périmètre de recherche des communes comparables quand la région n'en compte pas assez. */
  comparablesScope?: string;
  /** Adresses de la commune (BAN), pour les feuilles de porte-à-porte. */
  adresses?: { list: Adresse[]; source: SourceRef };
  dvf?: { stats: DvfStat[]; nSales: number; source: SourceRef };
  equipments?: {
    features: GeoJSON.Feature<GeoJSON.Point>[];
    source: SourceRef;
  };
  cycleways?: {
    lines: GeoJSON.Feature<GeoJSON.LineString>[];
    source: SourceRef;
  };
  nearest?: {
    label: string;
    name: string;
    distanceKm: number;
    lon: number;
    lat: number;
  }[];
  nearestSource?: SourceRef;
  schools?: { schools: School[]; source: SourceRef };
  stations?: { stations: Station[]; source: SourceRef };
  entreprises?: {
    bySection: { section: string; label: string; count: number }[];
    employers: Employer[];
    source: SourceRef;
  };
  risques?: { data: RisquesResult; source: SourceRef };
  elections: { results: ElectionResult[]; source: SourceRef }[];
  /** Résultats par bureau de vote, par scrutin. */
  bureaux: {
    election: ElectionConfig;
    results: BureauResult[];
    source: SourceRef;
  }[];
  bvGeo?: BureauGeo & { source: SourceRef };
  interne: InternalData;
  /** Adultes de nationalité française par IRIS (département) : estimation de la non-inscription. */
  adultes?: AdultesDep & { source: SourceRef };
  /** Logements sociaux (RPLS) : résidences et ensembles. */
  rpls?: RplsResult & { source: SourceRef };
  /** Cartes « affiche » (commune) : fond OpenStreetMap et résidences étudiantes. */
  fond?: FondOsm & { bbox: Bbox; source: SourceRef };
  /** Piscines et cinémas du département (OpenStreetMap), complément de la BPE. */
  equipOsm?: { list: EquipementOsm[]; source: SourceRef };
  /** Accès aux services de l'habitant moyen en France (référence nationale, par service). */
  servicesRef?: ServicesRef;
  /** Lieux pour un moment convivial (grands parcs, jardins à bière, grands bars). */
  convivialite?: { list: LieuConvivial[]; source: SourceRef };
  /** Hypermarchés et supermarchés des grands groupes desservis en transports en commun. */
  grandesSurfaces?: { list: GrandeSurface[]; source: SourceRef };
  /** Stations nommées (métro, RER, tram, gares) autour de la commune. */
  stationsTC?: { list: StationTC[]; source: SourceRef };
  residences?: { list: (ResidenceEtudiante & { porte: boolean })[]; source: SourceRef };
  /** Cartes « affiche » (département) : circonscriptions et départements voisins. */
  circos?: { list: Circo[]; source: SourceRef };
  /** Périmètre « circonscription » : part de chaque commune dans la circonscription (0 à 1). */
  circoShares?: Map<string, number>;
  depVoisins?: { features: GeoJSON.Feature[]; bbox: Bbox; source: SourceRef };
  /** Demandeurs d'emploi par mois : commune, département, France (fichiers déposés). */
  emploi?: StmtSeries & { source: SourceRef };
  /** Quartiers prioritaires et IRIS de la commune. */
  quartiers?: { qpv: Quartier[]; iris: Quartier[]; sources: SourceRef[] };
  /** Municipales 2026 (commune) et nuance de la majorité municipale (communes du département). */
  municipal?: MunicipalResult & { source: SourceRef };
  municipalDep?: {
    byCommune: Map<string, { nuance: string; tete: string; pct: number }>;
    source: SourceRef;
  };
  bpe?: BpeResult & { source: SourceRef };
  timetables?: { stations: StationTimetable[]; source: SourceRef };
  routes?: { routes: Route[]; source: SourceRef };
  /** Centre de Paris (temps de trajet). */
  parisCentre?: [number, number] | null;
  ctx: CollectContext;
  warnings: string[];
}

type Progress = (e: Omit<ProgressEvent, "at">) => void;

/** Ordre canonique des étapes (progression et journal de collecte). */
const STEP_ORDER = [
  "identite",
  "geographie",
  "insee",
  "perimetre",
  "comparables",
  "immobilier",
  "equipements",
  "education",
  "transports",
  "gtfs",
  "entreprises",
  "risques",
  "elections",
  "bureaux",
  "bureaux_geo",
  "adresses",
  "quartiers",
  "municipales",
  "bpe",
  "services",
  "acces",
  "rpls",
  "adultes",
  "cartes",
];

/** Nombre d'étapes suivies (identité, géographie, 18 étapes parallèles) + 3 étapes d'analyse. */
/** Périmètres de ciblage (comparaison des communes d'un territoire) plutôt que fiche communale. */
export const territorial = (s: Scope) => s === "departement" || s === "circonscription" || s === "epci";

export const PROGRESS_TOTAL = 2 + 21 + 3;

export async function collect(
  query: ReportQuery,
  progress: Progress = () => {},
): Promise<Collected> {
  const ctx = new CollectContext();
  const now = new Date().toISOString();
  const log = (m: string) =>
    console.log(`[génération ${query.codeInsee}] ${m}`);
  let done = 0;
  const total = PROGRESS_TOTAL;
  const mem = () => rssMb();
  const step = (id: string, label: string) => {
    log(`début ${id} (mémoire ${mem()} Mo)`);
    progress({ step: id, label, done, total, status: "running", mem: mem() });
  };
  /** Étape suivie : événement de début, puis de fin (les étapes tournent en parallèle). */
  const track = async (id: string, label: string, fn: () => Promise<void>) => {
    step(id, label);
    const t0 = Date.now();
    try {
      await fn();
    } finally {
      done++;
      log(
        `fin ${id} en ${((Date.now() - t0) / 1000).toFixed(1)} s (mémoire ${mem()} Mo)`,
      );
      progress({ step: id, label, done, total, status: "done", mem: mem() });
    }
  };

  /* 1. Identité (référentiel embarqué, sans réseau) */
  step(
    "identite",
    "Identification de la commune et de ses périmètres administratifs",
  );
  const commune = communeFromReferentiel(query.codeInsee);
  if (!commune) throw new Error(`Code INSEE inconnu : ${query.codeInsee}`);
  const popSource = ctx.ref(
    "cog",
    "https://github.com/etalab/decoupage-administratif",
    now,
    { vintage: POPULATION_VINTAGE },
  );
  ctx.runs.push({
    sourceId: "cog",
    name: "Découpage administratif (référentiel embarqué)",
    step: "identite",
    status: "ok",
    durationMs: 0,
    requests: 0,
    fromCache: 0,
    retrievedAt: now,
  });

  const geos: GeoSet = {
    commune: { level: "commune", code: commune.code, name: commune.nom },
    epci: commune.epci
      ? { level: "epci", code: commune.epci.code, name: commune.epci.nom }
      : null,
    departement: {
      level: "departement",
      code: commune.departement.code,
      name: commune.departement.nom,
    },
    region: {
      level: "region",
      code: commune.region.code,
      name: commune.region.nom,
    },
    france: { level: "france", code: "FR", name: "France" },
  };

  // Périmètre d'analyse
  let focus: Focus = {
    level: "commune",
    code: commune.code,
    name: commune.nom,
  };
  let perimeter = {
    label: commune.nom,
    communes: [
      { code: commune.code, nom: commune.nom, population: commune.population },
    ],
  };
  const interco = query.scope === "epci" ? intercoOf(commune.code) : null;
  if (interco) {
    // Intercommunalité : EPT dans la Métropole du Grand Paris, sinon EPCI.
    focus = { level: "epci", code: interco.code, name: interco.nom };
    perimeter = { label: interco.nom, communes: interco.membres };
  } else if (territorial(query.scope)) {
    focus = {
      level: "departement",
      code: commune.departement.code,
      name: commune.departement.nom,
    };
    perimeter = {
      label: query.scope === "circonscription" && query.circo ? circoLabel(query.circo, commune.departement.nom) : commune.departement.nom,
      communes: departementCommunes(commune.departement.code),
    };
  } else if (query.scope === "custom" && query.customCommunes?.length) {
    const list = [...new Set([commune.code, ...query.customCommunes])]
      .map((c) => communeFromReferentiel(c))
      .filter((c): c is CommuneInfo => !!c)
      .map((c) => ({ code: c.code, nom: c.nom, population: c.population }));
    perimeter = {
      label: `Territoire personnalisé (${list.length} communes)`,
      communes: list,
    };
  }

  const extraDeps = territorial(query.scope)
    ? [...new Set(perimeter.communes.map((m) => communeFromReferentiel(m.code)?.departement.code).filter((d): d is string => !!d && d !== commune.departement.code))]
    : [];
  const sum = (arr: { population: number | null }[]) =>
    arr.reduce((s, c) => s + (c.population ?? 0), 0);
  const populations: Collected["populations"] = [];
  populations.push({
    geo: geos.commune,
    value: commune.population ?? NaN,
    communes: 1,
  });
  if (commune.epci && geos.epci) {
    const m = epciMembers(commune.epci.code);
    populations.push({
      geo: geos.epci,
      value: epciInfo(commune.epci.code)?.populationMunicipale ?? sum(m),
      communes: m.length,
    });
  }
  const depC = departementCommunes(commune.departement.code);
  populations.push({
    geo: geos.departement,
    value: sum(depC),
    communes: depC.length,
  });
  const regC = regionCommunes(commune.region.code);
  populations.push({
    geo: geos.region,
    value: sum(regC),
    communes: regC.length,
  });
  const frC = franceCommunes().filter(
    (c) => !/^(975|977|978|986|987|988)/.test(c.code),
  );
  populations.push({ geo: geos.france, value: sum(frC), communes: frC.length });
  if (query.scope === "custom" && perimeter.communes.length > 1)
    populations.push({
      geo: { level: "commune", code: "CUSTOM", name: perimeter.label },
      value: sum(perimeter.communes),
      communes: perimeter.communes.length,
    });

  const c: Collected = {
    query,
    commune,
    focus,
    geos,
    perimeter,
    populations,
    popSource,
    neighbours: [],
    poles: [],
    insee: [],
    perimeterInsee: [],
    comparables: [],
    elections: [],
    bureaux: [],
    interne: { parrains: new Map(), groupes: [], files: [] },
    ctx,
    warnings: [],
  };

  let densityByCode = new Map<string, number | null>();

  /* 2. Géographie */
  step("geographie", "Contours, surfaces et voisinage (geo.api.gouv.fr)");
  await ctx.step(
    "geoapi",
    "geographie",
    async (http) => {
      const e = await enrichCommune(http, commune);
      commune.surfaceKm2 = e.surfaceKm2;
      commune.centre = e.centre;
      commune.contour = e.contour;
      c.geoSource = ctx.ref("geoapi", e.url, e.retrievedAt);
      const dep = await departementGeo(http, commune.departement.code);
      c.depFeatures = dep.fc ?? undefined;
      // Intercommunalité à cheval sur plusieurs départements (ex. Grand-Orly Seine Bièvre : 91 et 94).
      for (const d of extraDeps) {
        const x = await departementGeo(http, d).catch(() => null);
        if (x?.fc && c.depFeatures) c.depFeatures.features.push(...x.fc.features);
      }
      const contour = await departementContour(
        http,
        commune.departement.code,
      ).catch(() => null);
      c.depContour = contour?.feature ?? null;
      if (commune.contour && c.depFeatures) {
        const target = turf.feature(commune.contour as GeoJSON.Polygon);
        const bb = turf.bbox(target);
        for (const f of c.depFeatures.features) {
          const p = f.properties as {
            code: string;
            nom: string;
            population?: number;
            surface?: number;
          };
          if (p.code === commune.code || !f.geometry) continue;
          // Arrondissement : la ville qui le contient n'est pas une « commune limitrophe ».
          if (plmInfo(commune.code)?.parent === p.code) continue;
          const fb = turf.bbox(f);
          if (fb[0] > bb[2] || fb[2] < bb[0] || fb[1] > bb[3] || fb[3] < bb[1])
            continue;
          try {
            if (
              turf.booleanIntersects(
                target,
                f as GeoJSON.Feature<GeoJSON.Polygon>,
              )
            )
              c.neighbours.push({
                code: p.code,
                nom: p.nom,
                population: p.population ?? null,
                surfaceKm2: p.surface != null ? p.surface / 100 : null,
              });
          } catch {
            /* géométrie invalide : ignorée */
          }
        }
        // Les voisins situés dans un autre département ne sont pas couverts ici (limite documentée).
        c.neighbours.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
      }
      const fc = await franceCentres(http);
      c.polesSource = ctx.ref("geoapi", fc.url, fc.retrievedAt);
      if (commune.centre) {
        c.poles = fc.communes
          .filter(
            (x) =>
              x.code !== commune.code &&
              x.code !== plmInfo(commune.code)?.parent &&
              (x.population ?? 0) >= 20000 &&
              x.centre,
          )
          .map((x) => ({
            code: x.code,
            nom: x.nom,
            population: x.population!,
            distanceKm: haversineKm(commune.centre!, x.centre!.coordinates),
          }))
          .filter((x) => x.distanceKm <= 80)
          .sort((a, b) => a.distanceKm - b.distanceKm)
          .slice(0, 10);
      }
      const paris = fc.communes.find((x) => x.code === "75056");
      if (paris?.centre && commune.centre && commune.code !== "75056")
        c.parisKm = haversineKm(commune.centre, paris.centre.coordinates);
      c.parisCentre =
        (paris?.centre?.coordinates as [number, number] | undefined) ?? null;
      // Densités des communes de France (sélection de communes comparables).
      densityByCode = new Map(
        fc.communes.map(
          (x) =>
            [
              x.code,
              density(
                x.population ?? null,
                x.surface != null ? x.surface / 100 : null,
              ),
            ] as const,
        ),
      );
    },
    { theme: "identite", label: "Contours, surface, densité et voisinage" },
  );
  done += 2;
  progress({
    step: "geographie",
    label: "Contours, surfaces et voisinage (geo.api.gouv.fr)",
    done,
    total,
    status: "done",
    mem: mem(),
  });

  const enabled = (id: string) => !config.disabledSources.has(id);

  /* 3. INSEE */
  const run_insee = async () => {
    const kinds: [GeoRef | null, "COM" | "EPCI" | "DEP" | "REG" | "FRANCE"][] =
      [
        [geos.commune, "COM"],
        [geos.epci, "EPCI"],
        [geos.departement, "DEP"],
        [geos.region, "REG"],
        [geos.france, "FRANCE"],
      ];
    // Requêtes regroupées (tous les territoires d'un coup, jeu par jeu) : moins d'attente imposée par l'API.
    await ctx.step("insee_melodi", "insee:regroupement", (http) =>
      prefetchMelodi(http, DATASETS, kinds.filter(([g]) => !!g).map(([g, kind]) => ({ kind, code: g!.code }))),
    );
    for (const [g, kind] of kinds) {
      if (!g) continue;
      const res = await ctx.step(
        "insee_melodi",
        `insee:${g.level}`,
        (http) => collectInsee(ctx, http, kind, g.code, g),
        {
          theme: "demographie",
          label: `Statistiques INSEE — ${g.name}`,
        },
      );
      if (res) c.insee.push({ geo: g, result: res });
    }
  };

  /* 4. Communes du périmètre (EPCI de la commune ou périmètre personnalisé) */
  const run_perimetre = async () => {
    const perimeterList =
      query.scope === "custom"
        ? perimeter.communes
        : commune.epci
          ? epciMembers(commune.epci.code)
          : [];
    if (perimeterList.length > 1 && perimeterList.length <= 40) {
      await ctx.step("insee_melodi", "insee:perimetre", async (http) => {
        await prefetchMelodi(http, ["DS_FILOSOFI_CC", "DS_RP_LOGEMENT_PRINC"], perimeterList.filter((m) => m.code !== commune.code).map((m) => ({ kind: "COM" as const, code: m.code })));
        for (const m of perimeterList) {
          const g: GeoRef = { level: "commune", code: m.code, name: m.nom };
          try {
            const r =
              m.code === commune.code
                ? c.insee.find((x) => x.geo.code === m.code)?.result
                : await collectInsee(ctx, http, "COM", m.code, g, {
                    datasets: ["DS_FILOSOFI_CC", "DS_RP_LOGEMENT_PRINC"],
                  });
            if (r)
              c.perimeterInsee.push({ code: m.code, nom: m.nom, result: r });
          } catch (e) {
            http.partial = true;
            http.notes.push(e instanceof Error ? e.message : String(e));
          }
        }
        if (!c.perimeterInsee.length)
          throw new Error(http.notes[0] ?? "Aucune donnée communale obtenue");
      });
    } else if (perimeterList.length > 40) {
      ctx.skip(
        "insee_melodi",
        "insee:perimetre",
        "Périmètre de plus de 40 communes : indicateurs communaux non collectés (limite de débit INSEE)",
      );
    }
  };

  /* 5. Communes comparables */
  const run_comparables = async () => {
    const candidates = franceCommunes()
      .filter((x) => x.region === commune.region.code)
      .map((x) => ({ ...x, densite: densityByCode.get(x.code) ?? null }));
    const targetDens = densityByCode.get(commune.code) ?? null;
    let comps = comparableCommunes(candidates, commune, 0.3, 40);
    // Arrondissement : comparé aux autres arrondissements de Paris, Lyon et Marseille
    // (une grande ville entière n'a ni la densité ni le profil d'un arrondissement).
    const plmC = plmInfo(commune.code);
    if (plmC) {
      const arrs = referentiel()
        .communes.filter((x) => x.type === "arrondissement-municipal" && x.code !== commune.code)
        .map((x) => ({ code: x.code, nom: x.nom, population: x.population ?? null, departement: x.departement ?? "", region: x.region ?? "", densite: densityByCode.get(x.code) ?? null }));
      comps = comparableCommunes(arrs, commune, 0.5, 8);
      c.comparablesScope = "arrondissements de Paris, Lyon et Marseille";
    }
    if (targetDens != null)
      comps = comps.filter(
        (x) =>
          x.densite == null ||
          (x.densite >= targetDens * 0.5 && x.densite <= targetDens * 2),
      );
    if (comps.length < 5 && !plmC) {
      // Élargissement national : France métropolitaine pour une commune métropolitaine,
      // outre-mer pour une commune d'outre-mer (contextes non comparables).
      const dom = (code: string) => code.startsWith("97");
      // Mayotte (976) à part : recensement et revenus non publiés comme ailleurs (jeux INSEE absents).
      const may = (code: string) => code.startsWith("976");
      const nat = franceCommunes().filter((x) => dom(x.code) === dom(commune.code) && may(x.code) === may(commune.code)).map((x) => ({
        ...x,
        densite: densityByCode.get(x.code) ?? null,
      }));
      const natComps = comparableCommunes(nat, commune, 0.2, 40);
      comps = natComps.filter(
        (x) =>
          targetDens == null ||
          x.densite == null ||
          (x.densite >= targetDens * 0.5 && x.densite <= targetDens * 2),
      );
      // Commune très dense (Pointe-à-Pitre) : trop peu de communes de densité voisine, on garde la taille seule.
      if (comps.length < 3) comps = natComps;
      c.comparablesScope = commune.code.startsWith("97") ? "outre-mer" : "France métropolitaine";
    }
    c.comparables = comps
      .slice(0, 8)
      .map((x) => ({
        code: x.code,
        nom: x.nom,
        population: x.population,
        densite: x.densite,
        departement: x.departement,
      }));
    if (c.comparables.length) {
      await ctx.step("insee_melodi", "insee:comparables", async (http) => {
        await prefetchMelodi(http, ["DS_FILOSOFI_CC", "DS_RP_EMPLOI_LR_PRINC", "DS_RP_LOGEMENT_PRINC"], c.comparables.map((cp) => ({ kind: "COM" as const, code: cp.code })));
        for (const cp of c.comparables) {
          try {
            cp.result = await collectInsee(
              ctx,
              http,
              "COM",
              cp.code,
              { level: "commune", code: cp.code, name: cp.nom },
              {
                datasets: [
                  "DS_FILOSOFI_CC",
                  "DS_RP_EMPLOI_LR_PRINC",
                  "DS_RP_LOGEMENT_PRINC",
                ],
              },
            );
          } catch (e) {
            http.partial = true;
            http.notes.push(e instanceof Error ? e.message : String(e));
          }
        }
        if (!c.comparables.some((x) => x.result))
          throw new Error(
            http.notes[0] ??
              "Aucune donnée obtenue pour les communes comparables",
          );
      });
    }
  };

  /* 6. Marché immobilier */
  const run_immobilier = async () => {
    await ctx.step(
      "dvf",
      "immobilier",
      async (http) => {
        const d = await collectDvf(
          http,
          commune.code,
          commune.departement.code,
        );
        c.dvf = {
          stats: d.stats,
          nSales: d.nSales,
          source: ctx.ref("dvf", d.urls[0], d.retrievedAt, {
            vintage: d.stats.length
              ? `${d.stats[0].year}-${d.stats[d.stats.length - 1].year}`
              : undefined,
          }),
        };
      },
      { theme: "immobilier", label: "Prix immobiliers (DVF)" },
    );
  };

  /* 7. Équipements */
  const run_equipements = async () => {
    await ctx.step(
      "osm",
      "equipements",
      async (http) => {
        const e = await collectEquipments(http, commune.code);
        c.equipments = {
          features: e.features,
          source: ctx.ref("osm", e.url, e.retrievedAt),
        };
        try {
          const cw = await collectCycleways(http, commune.code);
          c.cycleways = {
            lines: cw.lines,
            source: ctx.ref("osm", cw.url, cw.retrievedAt),
          };
        } catch {
          http.partial = true;
          http.notes.push("Aménagements cyclables indisponibles");
        }
        if (commune.centre) {
          try {
            const n = await collectNearest(
              http,
              commune.centre[0],
              commune.centre[1],
            );
            c.nearestSource = ctx.ref("osm", n.url, n.retrievedAt);
            const groups: [string, (t: Record<string, string>) => boolean][] = [
              [
                "Service d'urgences hospitalières",
                (t) => t.amenity === "hospital" && t.emergency === "yes",
              ],
              ["Hôpital ou clinique", (t) => t.amenity === "hospital"],
              ["Gare ferroviaire", (t) => t.railway === "station"],
              [
                "Lycée",
                (t) =>
                  t.amenity === "school" && /3/.test(t["isced:level"] ?? ""),
              ],
              [
                "Établissement d'enseignement supérieur",
                (t) => t.amenity === "university",
              ],
            ];
            c.nearest = [];
            for (const [label, pred] of groups) {
              let best: {
                name: string;
                d: number;
                lon: number;
                lat: number;
              } | null = null;
              for (const el of n.elements) {
                const lat = el.lat ?? el.center?.lat;
                const lon = el.lon ?? el.center?.lon;
                if (lat == null || lon == null || !el.tags || !pred(el.tags))
                  continue;
                const d = haversineKm(commune.centre!, [lon, lat]);
                if (!best || d < best.d)
                  best = { name: el.tags.name ?? label, d, lon, lat };
              }
              if (best)
                c.nearest.push({
                  label,
                  name: best.name,
                  distanceKm: best.d,
                  lon: best.lon,
                  lat: best.lat,
                });
            }
          } catch {
            http.partial = true;
            http.notes.push("Équipements structurants proches indisponibles");
          }
        }
      },
      {
        theme: "equipements",
        label: "Équipements et services (OpenStreetMap)",
      },
    );
  };

  /* 8. Éducation */
  const run_education = async () => {
    await ctx.step(
      "education",
      "education",
      async (http) => {
        const s = await collectSchools(http, commune.code);
        c.schools = {
          schools: s.schools,
          source: ctx.ref("education", s.url, s.retrievedAt),
        };
      },
      { theme: "education", label: "Établissements scolaires" },
    );
  };

  /* 9. Transports */
  const run_transports = async () => {
    await ctx.step(
      "sncf",
      "transports",
      async (http) => {
        const s = await collectStations(
          http,
          commune.code,
          commune.codesPostaux,
        );
        c.stations = {
          stations: s.stations,
          source: ctx.ref("sncf", s.urls[0], s.retrievedAt),
        };
      },
      { theme: "mobilite", label: "Gares et fréquentation" },
    );
  };

  /* 10. Entreprises */
  const run_entreprises = async () => {
    await ctx.step(
      "entreprises",
      "entreprises",
      async (http) => {
        const e = await collectEntreprises(http, commune.code);
        c.entreprises = {
          bySection: e.bySection,
          employers: e.employers,
          source: ctx.ref("entreprises", e.urls[0], e.retrievedAt),
        };
      },
      { theme: "economie", label: "Établissements et employeurs (SIRENE)" },
    );
  };

  /* 11. Risques */
  const run_risques = async () => {
    await ctx.step(
      "georisques",
      "risques",
      async (http) => {
        const r = await collectRisques(http, commune.code);
        c.risques = {
          data: r,
          source: ctx.ref("georisques", r.urls[0], r.retrievedAt),
        };
      },
      { theme: "risques", label: "Risques naturels et technologiques" },
    );
  };

  /* 14. Quartiers : QPV et IRIS */
  /* Population adulte de nationalité française (IRIS) : non-inscription. */
  const run_adultes = async () => {
    if (!enabled("iris") || territorial(query.scope)) return;
    await ctx.step(
      "iris",
      "adultes",
      async (http) => {
        const a = await collectAdultes(http, commune.departement.code);
        c.adultes = { ...a, source: ctx.ref("iris", a.url, a.retrievedAt, { vintage: a.annee ?? undefined }) };
      },
      { theme: "strategie", label: "Population adulte (estimation de la non-inscription)" },
    );
  };

  /* Logements sociaux (RPLS) : résidences HLM et nombre de logements. */
  const run_rpls = async () => {
    if (!enabled("rpls") || territorial(query.scope)) return;
    await ctx.step(
      "rpls",
      "rpls",
      async (http) => {
        const plmR = plmInfo(commune.code);
        const r = await collectRpls(http, commune.code, { parent: plmR?.parent, contour: commune.contour });
        // Noms lisibles (« Mal » → « Maréchal », « Allee » → « Allée »), y compris pour les extractions en cache.
        const pf = (t: string) => prettyFr(t, commune.nom);
        // Nom de programme égal au nom de la commune (« Grande-Synthe ») : n'apprend rien, on garde l'adresse.
        const bare = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
        const residences = r.residences.map((x) => {
          const adresse = pf(fixAdr(x.adresse));
          const nom = bare(x.nom) === bare(commune.nom) ? adresse : pf(x.nom);
          return { ...x, nom, adresse, ...(x.voie ? { voie: pf(x.voie) } : {}), ...(x.nums ? { nums: x.nums.map((n) => numVoie(n)) } : {}) };
        });
        // Coordonnées erronées dans le répertoire (Faches-Thumesnil : résidences placées près de Saint-Quentin) :
        // on écarte ce qui tombe à plus de 300 m de la commune.
        const inCommune = (lon: number, lat: number) => {
          if (!commune.contour) return true;
          try {
            return turf.booleanPointInPolygon([lon, lat], commune.contour as GeoJSON.Polygon) || turf.pointToPolygonDistance([lon, lat], commune.contour as GeoJSON.Polygon, { units: "kilometers" }) <= 0.3;
          } catch {
            return true;
          }
        };
        const kept = residences.filter((x) => inCommune(x.lon, x.lat));
        const horsCommune = residences.length - kept.length;
        if (horsCommune) http.notes.push(`${horsCommune} résidence${horsCommune > 1 ? "s" : ""} écartée${horsCommune > 1 ? "s" : ""} : coordonnées hors de la commune dans le répertoire`);
        const ensembles = r.ensembles.filter((x) => inCommune(x.lon, x.lat)).map((x) => ({ ...x, nom: pf(x.nom) }));
        if (r.total) c.rpls = { ...r, residences: kept, ensembles, source: ctx.ref("rpls", r.url, r.retrievedAt, { vintage: r.millesime ?? undefined }) };
        else http.notes.push("Aucun logement social recensé dans la commune");
      },
      { theme: "logement", label: "Résidences de logements sociaux (RPLS)" },
    );
  };

  const run_quartiers = async () => {
    const quartiers: NonNullable<Collected["quartiers"]> = {
      qpv: [],
      iris: [],
      sources: [],
    };
    if (enabled("qpv"))
      await ctx.step(
        "qpv",
        "quartiers:qpv",
        async (http) => {
          let q = await collectQpv(http, commune.code);
          // Arrondissement de Paris, Lyon ou Marseille : QPV parfois référencés au code de la
          // ville ; on garde ceux qui recoupent le contour de l'arrondissement.
          const plmQ = plmInfo(commune.code);
          if (plmQ && !q.quartiers.length && commune.contour) {
            const city = await collectQpv(http, plmQ.parent);
            const arr = turf.feature(commune.contour as GeoJSON.Polygon);
            const inArr = city.quartiers.filter((x) => {
              try {
                if (!x.geometry) return false;
                const g = turf.feature(x.geometry as GeoJSON.Polygon);
                if (!turf.booleanIntersects(arr, g)) return false;
                const inter = turf.intersect(turf.featureCollection([arr, g]) as never) as GeoJSON.Feature<GeoJSON.Polygon> | null;
                return !!inter && turf.area(inter) > 0.3 * turf.area(g);
              } catch {
                return false;
              }
            });
            q = { ...city, quartiers: inArr };
          }
          quartiers.qpv = q.quartiers;
          http.notes.push(...q.notes);
          if (q.quartiers.length) {
            quartiers.sources.push(
              ctx.ref("qpv", q.urls[0], q.retrievedAt, { vintage: "2024" }),
            );
            if (q.urls.length > 2)
              quartiers.sources.push(
                ctx.ref("insee_qpv", q.urls[q.urls.length - 1], q.retrievedAt, {
                  vintage: "2021-2022",
                }),
              );
          } else http.notes.push("Aucun quartier prioritaire dans la commune");
        },
        { theme: "strategie", label: "Quartiers prioritaires (QPV)" },
      );
    if (enabled("iris") && (commune.population ?? 0) >= 5000)
      await ctx.step(
        "iris",
        "quartiers:iris",
        async (http) => {
          const q = await collectIris(http, commune.code);
          quartiers.iris = q.quartiers;
          http.notes.push(...q.notes);
          if (q.quartiers.length)
            quartiers.sources.push(
              ctx.ref("iris", q.urls[0], q.retrievedAt, { vintage: "2021" }),
            );
          else http.notes.push("Commune non découpée en IRIS");
        },
        { theme: "strategie", label: "Quartiers IRIS" },
      );
    if (quartiers.qpv.length || quartiers.iris.length) c.quartiers = quartiers;
  };

  /* 15. Contexte municipal */
  const run_municipales = async () => {
    if (enabled("municipales")) {
      await ctx.step(
        "municipales",
        "municipales",
        async (http) => {
          const m = await collectMunicipales(
            http,
            commune.code,
            commune.departement.code,
          );
          c.municipal = {
            ...m,
            source: ctx.ref("municipales", m.urls[0], m.retrievedAt, {
              vintage: "2026",
            }),
          };
        },
        { theme: "elections", label: "Municipales 2026 et maire" },
      );
      if (territorial(query.scope))
        await ctx.step(
          "municipales",
          "municipales:departement",
          async (http) => {
            const m = await collectMunicipalesDepartement(
              http,
              commune.departement.code,
            );
            c.municipalDep = {
              byCommune: m.byCommune,
              source: ctx.ref("municipales", m.url, m.retrievedAt, {
                vintage: "2026",
              }),
            };
          },
        );
    }
  };

  /* 17. Temps de trajet routiers */
  const run_acces = async () => {
    if (enabled("osrm") && commune.centre) {
      await ctx.step("osrm", "acces:routes", async (http) => {
        const fc = await franceCentres(http);
        const centre = (code: string) =>
          fc.communes.find((x) => x.code === code)?.centre?.coordinates as
            [number, number] | undefined;
        const targets: { label: string; nom: string; to: [number, number] }[] =
          [];
        const add = (label: string, code: string, nom: string) => {
          const to = centre(code);
          if (
            to &&
            code !== commune.code &&
            !targets.some((t) => t.nom === nom)
          )
            targets.push({ label, nom, to });
        };
        // Pôle urbain le plus proche, grande ville la plus proche (100 000 hab. et plus), préfecture.
        const pole = c.poles[0];
        if (pole) add("Pôle urbain le plus proche", pole.code, pole.nom);
        const big = c.poles.find((p) => p.population >= 100000);
        if (big) add("Grande ville la plus proche", big.code, big.nom);
        const prefCode = referentiel().departements.get(
          commune.departement.code,
        )?.chefLieu;
        const pref = prefCode ? referentiel().byCode.get(prefCode) : null;
        if (pref) add("Préfecture", pref.code, pref.nom);
        // Paris seulement s'il reste à portée (moins de 250 km à vol d'oiseau).
        if (
          c.parisCentre &&
          c.parisKm != null &&
          c.parisKm <= 250 &&
          commune.code !== "75056"
        )
          targets.push({ label: "Paris", nom: "Paris", to: c.parisCentre });
        if (!targets.length) throw new Error("Aucune destination");
        const r = await collectRoutes(http, commune.centre!, targets);
        c.routes = {
          routes: r.routes,
          source: ctx.ref("osrm", r.url, r.retrievedAt),
        };
      });
    }
  };

  /* 12-13. Élections : scrutins en parallèle (fichiers lourds bornés par la file mémoire), ordre conservé. */
  const run_elections = async () => {
    const res = await Promise.all(
      ELECTIONS.map((e) =>
        ctx.step(
          "elections",
          `elections:${e.id}`,
          async (http) => {
            const r = await collectElection(
              http,
              e,
              commune.code,
              commune.departement.code,
            );
            // Communes du périmètre situées dans un autre département : résultats ajoutés au détail par commune.
            const depRes = r.find((x) => x.level === "departement");
            for (const d of extraDeps) {
              const first = perimeter.communes.find((m) => communeFromReferentiel(m.code)?.departement.code === d);
              if (!first || !depRes?.byCommune) continue;
              const x = await collectElection(http, e, first.code, d);
              depRes.byCommune.push(...(x.find((y) => y.level === "departement")?.byCommune ?? []));
            }
            return {
              results: r,
              source: ctx.ref("elections", r[0].sourceUrl, r[0].retrievedAt, {
                vintage: e.date.slice(0, 4),
                dataset: e.dataset,
              }),
            };
          },
          { theme: "elections", label: `Résultats — ${e.label}` },
        ),
      ),
    );
    for (const r of res) if (r) c.elections.push(r);
  };
  const run_bureaux = async () => {
    // Scrutins de 2017 et 2019 : bureaux seulement, pour mesurer l'évolution du vote.
    const res = await Promise.all(
      [...ELECTIONS, ...(enabled("elections_historiques") ? HISTORICAL_ELECTIONS : [])].map((e) =>
        ctx.step(
          "elections",
          `bureaux:${e.id}`,
          async (http) => {
            const r = await collectBureaux(
              http,
              e,
              commune.code,
              commune.departement.code,
            );
            return {
              election: e,
              results: r,
              source: ctx.ref("elections", r[0].sourceUrl, r[0].retrievedAt, {
                vintage: e.date.slice(0, 4),
                dataset: e.dataset,
              }),
            };
          },
          {
            theme: "elections",
            label: `Résultats par bureau de vote — ${e.label}`,
          },
        ),
      ),
    );
    for (const r of res) if (r) c.bureaux.push(r);
  };
  const run_adresses = async () => {
    // Utile seulement si les bureaux ont des contours (rattachement des adresses).
    if (!enabled("ban") || !c.bvGeo?.features.length || territorial(query.scope)) return;
    await ctx.step(
      "ban",
      "adresses",
      async (http) => {
        const a = await collectAdresses(http, commune.code, commune.departement.code);
        c.adresses = { list: a.adresses, source: ctx.ref("ban", a.url, a.retrievedAt) };
      },
      { theme: "strategie", label: "Adresses par bureau de vote (porte-à-porte)" },
    );
  };
  const run_bureaux_geo = async () => {
    if (!c.bureaux.length) return;
    await ctx.step(
      "bureaux_geo",
      "bureaux:geo",
      async (http) => {
        const g = await collectBureauxGeo(http, commune.code);
        if (!g)
          throw new Error(
            "Aucune géographie des bureaux de vote disponible (fournir data/interne/bv-<code>.geojson)",
          );
        c.bvGeo = {
          ...g,
          source: {
            id: "bureaux_geo",
            name: g.sourceName,
            url: g.url,
            retrievedAt: g.retrievedAt || new Date().toISOString(),
          },
        };
      },
      { theme: "elections", label: "Contours / libellés des bureaux de vote" },
    );
  };

  /* 16. Services (BPE) et horaires de train (GTFS, après les gares) */
  const run_bpe = async () => {
    if (!enabled("bpe")) return;
    await ctx.step(
      "bpe",
      "services:bpe",
      async (http) => {
        const b = await collectBpe(
          http,
          commune.code,
          commune.departement.code,
        );
        c.bpe = {
          ...b,
          source: ctx.ref("bpe", b.url, b.retrievedAt, {
            vintage: BPE_VINTAGE,
          }),
        };
      },
      { theme: "equipements", label: "Base permanente des équipements" },
    );
    // Référence nationale (habitant moyen en France) : calculée une fois pour toute la France, 30 jours.
    await ctx.step("bpe", "services:reference-nationale", async (http) => {
      c.servicesRef = await cachedExtract(`servicesref|${BPE_VINTAGE}`, 24 * 30, () =>
        heavyLane.run(async () => {
          const [fr, bpe] = await Promise.all([franceCentres(http), readBpeNational(http)]);
          const communes = fr.communes.flatMap((x) => (x.centre ? [{ code: x.code, lon: x.centre.coordinates[0], lat: x.centre.coordinates[1], pop: x.population ?? 0 }] : []));
          return nationalServiceRefs(communes, bpe);
        }),
      );
    });
  };
  const run_gtfs = async () => {
    if (!enabled("gtfs") || !c.stations?.stations.length) return;
    await ctx.step(
      "gtfs",
      "services:gtfs",
      async (http) => {
        const t = await collectTimetables(http, c.stations!.stations);
        c.timetables = {
          stations: t.stations,
          source: ctx.ref("gtfs", t.url, t.retrievedAt),
        };
      },
      { theme: "mobilite", label: "Horaires des trains (GTFS SNCF)" },
    );
  };

  /*
   * Orchestration : les sources indépendantes tournent en parallèle. L'INSEE
   * reste séquentiel (limite de débit) ; les fichiers nationaux passent par
   * une file bornée et sensible à la mémoire (heavyLane).
   */
  await Promise.all([
    (async () => {
      await track(
        "insee",
        "Statistiques INSEE (recensement, revenus) pour le territoire et ses références",
        run_insee,
      );
      await track(
        "perimetre",
        "Indicateurs des communes du périmètre intercommunal",
        run_perimetre,
      );
      await track(
        "comparables",
        "Sélection et profil de communes comparables",
        run_comparables,
      );
    })(),
    (async () => {
      await track(
        "elections",
        "Résultats électoraux officiels (agrégés)",
        run_elections,
      );
      await track("bureaux", "Résultats par bureau de vote", run_bureaux);
      await track(
        "bureaux_geo",
        "Contours et libellés des bureaux de vote",
        run_bureaux_geo,
      );
      await track("adresses", "Adresses des bureaux de vote (Base adresse nationale)", run_adresses);
    })(),
    track("immobilier", "Transactions immobilières (DVF)", run_immobilier),
    track(
      "equipements",
      "Équipements et services (OpenStreetMap)",
      run_equipements,
    ),
    track(
      "education",
      "Établissements scolaires (Annuaire de l'éducation)",
      run_education,
    ),
    (async () => {
      await track(
        "transports",
        "Gares et fréquentation (SNCF Open Data)",
        run_transports,
      );
      await track("gtfs", "Horaires SNCF (GTFS)", run_gtfs);
    })(),
    track(
      "entreprises",
      "Tissu économique et principaux employeurs (SIRENE)",
      run_entreprises,
    ),
    track(
      "risques",
      "Risques naturels et technologiques (Géorisques)",
      run_risques,
    ),
    track(
      "quartiers",
      "Quartiers prioritaires et IRIS (ANCT, INSEE, IGN)",
      run_quartiers,
    ),
    track(
      "municipales",
      "Élections municipales 2026 et maire (ministère de l'Intérieur)",
      run_municipales,
    ),
    track("bpe", "Équipements (BPE)", run_bpe),
    track("rpls", "Logements sociaux (RPLS)", run_rpls),
    track("adultes", "Population adulte (inscription sur les listes)", run_adultes),
    track("acces", "Temps de trajet routiers (OSRM)", run_acces),
  ]);
  /* Cartes « affiche » : fond de plan et résidences étudiantes (commune),
     circonscriptions et départements voisins (département). */
  const run_cartes = async () => {
    if (territorial(query.scope)) {
      if (!c.depFeatures?.features.length) return;
      const bb = fitAspect(turf.bbox(c.depFeatures) as Bbox, 0.04);
      await ctx.step("circonscriptions", "cartes:circonscriptions", async (http) => {
        const r = await collectCirconscriptions(http, commune.departement.code);
        c.circos = { list: r.circos, source: ctx.ref("circonscriptions", r.url, r.retrievedAt) };
        // Circonscription : communes situées (au moins en partie) dans la circonscription choisie.
        const circo = query.scope === "circonscription" ? r.circos.find((x) => x.num === query.circo) : null;
        if (query.scope === "circonscription") {
          if (!circo) throw new Error(`Circonscription n° ${query.circo} introuvable dans le département ${commune.departement.code}`);
          c.circoShares = circoCommunes(c.depFeatures!.features, circo);
          c.perimeter.communes = c.perimeter.communes.filter((x) => c.circoShares!.has(x.code));
        }
      });
      await ctx.step("contours_admin", "cartes:departements", async (http) => {
        const r = await collectDepartementsVoisins(http, commune.departement.code, bb);
        c.depVoisins = { features: r.features, bbox: bb, source: ctx.ref("contours_admin", r.url, r.retrievedAt) };
      });
      return;
    }
    // Résidences étudiantes et foyers de jeunes travailleurs (catalogue « Mon Logement Étudiant »).
    await ctx.step("residences_etudiantes", "cartes:residences", async (http) => {
      const cat = await loadCatalogue();
      // Positions du catalogue parfois arrondies (≈ 1 km) : précisées par la Base adresse nationale.
      const list = enabled("ban") ? await residencesOfGeocoded(http, cat.list, commune) : residencesOf(cat.list, commune);
      c.residences = {
        list: list.map((r) => ({ ...r, nom: prettyFr(r.nom, commune.nom), porte: isPorteAPorte(r) })),
        source: ctx.ref("residences_etudiantes", CATALOGUE_URL, cat.retrievedAt || new Date().toISOString(), {
          dataset: cat.origin === "interne" ? "classeur déposé dans « Données internes »" : "copie embarquée dans l'application",
        }),
      };
    });
    if (!enabled("osm") || !commune.contour) return;
    const cb = turf.bbox(turf.feature(commune.contour as GeoJSON.Polygon)) as Bbox;
    // Moment convivial (fin de journée, pique-nique) : grands parcs et lieux sûrs de la commune.
    await ctx.step("osm", "cartes:convivialite", async (http) => {
      const r = await collectConvivialite(http, cb);
      const poly = turf.feature(commune.contour as GeoJSON.Polygon);
      const inside = r.list.filter((x) => {
        try {
          return turf.booleanPointInPolygon([x.lon, x.lat], poly as GeoJSON.Feature<GeoJSON.Polygon>);
        } catch {
          return false;
        }
      });
      c.convivialite = { list: inside, source: ctx.ref("osm", r.url, r.retrievedAt) };
    });
    // Piscines et cinémas du département : complètent la BPE pour l'accès aux services.
    if (c.depFeatures?.features.length)
      await ctx.step("osm", "services:piscines-cinemas", async (http) => {
        const r = await collectEquipementsOsm(http, turf.bbox(c.depFeatures!) as Bbox);
        c.equipOsm = { list: r.list, source: ctx.ref("osm", r.url, r.retrievedAt) };
      });
    // Stations de métro, RER, tram et gares (points de rendez-vous du convoi), un peu au-delà de la commune.
    await ctx.step("osm", "cartes:transports", async (http) => {
      const r = await collectStationsTC(http, [cb[0] - 0.008, cb[1] - 0.006, cb[2] + 0.008, cb[3] + 0.006]);
      c.stationsTC = { list: r.list, source: ctx.ref("osm", r.url, r.retrievedAt) };
    });
    // Grandes surfaces des grands groupes, desservies en transports en commun (tractage du samedi).
    await ctx.step("osm", "cartes:grandes-surfaces", async (http) => {
      const r = await collectGrandesSurfaces(http, cb);
      const poly = turf.feature(commune.contour as GeoJSON.Polygon);
      const inside = r.list.filter((x) => {
        try {
          return turf.booleanPointInPolygon([x.lon, x.lat], poly as GeoJSON.Feature<GeoJSON.Polygon>);
        } catch {
          return false;
        }
      });
      c.grandesSurfaces = { list: inside, source: ctx.ref("osm", r.url, r.retrievedAt) };
    });
    // Emprise : les lieux de la carte (bureaux prioritaires, quartiers prioritaires,
    // résidences, marchés, gares), plutôt que toute la commune (forêts, champs).
    const pts: [number, number][] = [];
    const corners = (g: GeoJSON.Feature | GeoJSON.Geometry) => {
      try {
        const b = turf.bbox(g as GeoJSON.Feature);
        pts.push([b[0], b[1]], [b[2], b[3]]);
      } catch {
        /* géométrie invalide */
      }
    };
    const ref = c.bureaux.find((b) => b.election.id === "EU24") ?? c.bureaux.find((b) => b.election.id === "PR22T1");
    const sec = c.bureaux.find((b) => b.election.id === "PR22T1" && b !== ref);
    if (ref && c.bvGeo?.features.length) {
      const prio = new Set(rankBureaux(ref.results, sec?.results ?? null, new Map(), c.bureaux.find((b) => b.election.id === "LG24T1")?.results).filter((b) => b.priorite === 1).map((b) => b.bv));
      for (const f of c.bvGeo.features) if (prio.has(String(f.properties?.bv))) corners(f);
    }
    for (const q of c.quartiers?.qpv ?? []) if (q.geometry) corners(q.geometry);
    for (const r of c.residences?.list ?? []) if (r.porte) pts.push([r.lon, r.lat]);
    // Grands ensembles HLM (100 logements et plus) : zones de porte-à-porte de la carte.
    for (const e of (c.rpls?.ensembles ?? []).filter((x) => x.logements >= 100).slice(0, 8)) pts.push([e.lon, e.lat]);
    const inBox = (lon: number, lat: number) => lon >= cb[0] && lon <= cb[2] && lat >= cb[1] && lat <= cb[3];
    for (const f of c.equipments?.features ?? []) if (f.properties?.category === "marche") pts.push(f.geometry.coordinates as [number, number]);
    for (const st of c.stations?.stations ?? []) if (st.lon != null && st.lat != null && inBox(st.lon, st.lat)) pts.push([st.lon, st.lat]);
    // Grande surface et lieu convivial retenus en premier : visibles sur la carte.
    for (const x of [c.grandesSurfaces?.list[0], c.convivialite?.list[0]]) if (x && inBox(x.lon, x.lat)) pts.push([x.lon, x.lat]);
    let fb: Bbox = cb;
    if (pts.length >= 2) {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      fb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      // Au moins 1,2 km de côté.
      const minDeg = 0.011;
      if (fb[3] - fb[1] < minDeg) (fb[1] -= minDeg / 2), (fb[3] += minDeg / 2);
      if (fb[2] - fb[0] < minDeg * 1.5) (fb[0] -= minDeg * 0.75), (fb[2] += minDeg * 0.75);
    }
    const bb = fitAspect(fb, 0.18);
    await ctx.step("osm", "cartes:fond", async (http) => {
      const r = await collectFondOsm(http, bb);
      c.fond = { ...r, bbox: bb, source: ctx.ref("osm_fond", r.url, r.retrievedAt) };
    });
  };
  await track("cartes", "Fond de plan et contours des cartes", run_cartes);

  // Journal dans un ordre stable, indépendant de l'ordre d'arrivée.
  const order = (st: string) => {
    const i = STEP_ORDER.findIndex((p) => st === p || st.startsWith(p + ":"));
    return i < 0 ? STEP_ORDER.length : i;
  };
  ctx.runs.sort((x, y) => order(x.step) - order(y.step));

  /* 18. Données internes facultatives */
  c.interne = await loadInternalData();
  if (c.interne.files.length)
    ctx.runs.push({
      sourceId: "interne",
      name: "Données militantes internes (fichiers fournis)",
      step: "interne",
      status: "ok",
      message: c.interne.files.join(", "),
      durationMs: 0,
      requests: 0,
      fromCache: 0,
      retrievedAt: new Date().toISOString(),
    });

  /* 19. Demandeurs d'emploi (fichiers France Travail déposés, facultatifs) */
  if (!territorial(query.scope)) {
    try {
      const t0 = Date.now();
      // Paris, Lyon, Marseille : la ville = somme de ses arrondissements.
      const plmCity = { "75056": ["751", 20], "69123": ["6938", 9], "13055": ["132", 16] } as Record<string, [string, number]>;
      const pc = plmCity[commune.code];
      const codes = pc ? Array.from({ length: pc[1] }, (_, i) => `${pc[0]}${String(i + 1).padStart(pc[0].length === 4 ? 1 : 2, "0")}`) : [commune.code];
      const s = await loadStmt(codes, commune.departement.code);
      if (s?.commune.length) {
        const last = s.commune[s.commune.length - 1].mois;
        c.emploi = {
          ...s,
          source: { id: "interne_stmt", name: "Demandeurs d'emploi inscrits à France Travail par commune (fichiers fournis)", url: "data/interne/demandeurs-emploi", retrievedAt: new Date().toISOString(), vintage: `${last.slice(4)}/${last.slice(0, 4)}` },
        };
        ctx.runs.push({ sourceId: "interne_stmt", name: "Demandeurs d'emploi (France Travail, fichiers fournis)", step: "emploi", status: "ok", message: `${s.commune.length} mois`, durationMs: Date.now() - t0, requests: 0, fromCache: 0, retrievedAt: new Date().toISOString() });
      }
    } catch (e) {
      c.warnings.push(`Demandeurs d'emploi : lecture impossible (${(e as Error).message}).`);
    }
  }

  log(`collecte terminée (mémoire ${mem()} Mo)`);
  progress({
    step: "collecte",
    label: "Collecte terminée",
    done,
    total,
    status: "running",
    mem: mem(),
  });
  return c;
}
