import * as turf from "@turf/turf";
import {
  communeFromReferentiel,
  departementContour,
  departementGeo,
  epciInfo,
  epciMembers,
  enrichCommune,
  franceCentres,
  franceCommunes,
  POPULATION_VINTAGE,
  regionCommunes,
  departementCommunes,
} from "../collectors/admin";
import { CollectContext } from "../collectors/context";
import { collectDvf, DvfStat } from "../collectors/dvf";
import { BureauResult, collectBureaux, collectElection, ELECTIONS, ElectionConfig, ElectionResult } from "../collectors/elections";
import { BureauGeo, collectBureauxGeo } from "../collectors/bureaux-geo";
import { InternalData, loadInternalData } from "../collectors/interne";
import { collectInsee, InseeResult } from "../collectors/insee-indicators";
import { collectCycleways, collectEquipments, collectNearest } from "../collectors/osm";
import { collectEntreprises, collectRisques, collectSchools, collectStations, Employer, RisquesResult, School, Station } from "../collectors/public-apis";
import { comparableCommunes, density, haversineKm } from "../analysis/stats";
import type { CommuneInfo, Focus, GeoRef, ProgressEvent, ReportQuery, SourceRef } from "../types";

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
  perimeter: { label: string; communes: { code: string; nom: string; population: number | null }[] };
  /** Populations (référentiel embarqué) des territoires de référence. */
  populations: { geo: GeoRef; value: number; communes: number }[];
  popSource: SourceRef;
  geoSource?: SourceRef;
  depFeatures?: GeoJSON.FeatureCollection;
  depContour?: GeoJSON.Feature | null;
  neighbours: { code: string; nom: string; population: number | null; surfaceKm2: number | null }[];
  poles: { code: string; nom: string; population: number; distanceKm: number }[];
  polesSource?: SourceRef;
  insee: { geo: GeoRef; result: InseeResult }[];
  perimeterInsee: { code: string; nom: string; result: InseeResult }[];
  comparables: { code: string; nom: string; population: number | null; densite: number | null; departement: string; result?: InseeResult }[];
  dvf?: { stats: DvfStat[]; nSales: number; source: SourceRef };
  equipments?: { features: GeoJSON.Feature<GeoJSON.Point>[]; source: SourceRef };
  cycleways?: { lines: GeoJSON.Feature<GeoJSON.LineString>[]; source: SourceRef };
  nearest?: { label: string; name: string; distanceKm: number; lon: number; lat: number }[];
  nearestSource?: SourceRef;
  schools?: { schools: School[]; source: SourceRef };
  stations?: { stations: Station[]; source: SourceRef };
  entreprises?: { bySection: { section: string; label: string; count: number }[]; employers: Employer[]; source: SourceRef };
  risques?: { data: RisquesResult; source: SourceRef };
  elections: { results: ElectionResult[]; source: SourceRef }[];
  /** Résultats par bureau de vote, par scrutin. */
  bureaux: { election: ElectionConfig; results: BureauResult[]; source: SourceRef }[];
  bvGeo?: BureauGeo & { source: SourceRef };
  interne: InternalData;
  ctx: CollectContext;
  warnings: string[];
}

type Progress = (e: Omit<ProgressEvent, "at">) => void;

export async function collect(query: ReportQuery, progress: Progress = () => {}): Promise<Collected> {
  const ctx = new CollectContext();
  const now = new Date().toISOString();
  const steps = [
    "identite",
    "geographie",
    "insee",
    "perimetre",
    "comparables",
    "immobilier",
    "equipements",
    "education",
    "transports",
    "entreprises",
    "risques",
    "elections",
    "bureaux",
  ];
  let done = 0;
  const step = (id: string, label: string) => progress({ step: id, label, done: done++, total: steps.length + 3, status: "running" });

  /* 1. Identité (référentiel embarqué, sans réseau) */
  step("identite", "Identification de la commune et de ses périmètres administratifs");
  const commune = communeFromReferentiel(query.codeInsee);
  if (!commune) throw new Error(`Code INSEE inconnu : ${query.codeInsee}`);
  const popSource = ctx.ref("cog", "https://github.com/etalab/decoupage-administratif", now, { vintage: POPULATION_VINTAGE });
  ctx.runs.push({ sourceId: "cog", name: "Découpage administratif (référentiel embarqué)", step: "identite", status: "ok", durationMs: 0, requests: 0, fromCache: 0, retrievedAt: now });

  const geos: GeoSet = {
    commune: { level: "commune", code: commune.code, name: commune.nom },
    epci: commune.epci ? { level: "epci", code: commune.epci.code, name: commune.epci.nom } : null,
    departement: { level: "departement", code: commune.departement.code, name: commune.departement.nom },
    region: { level: "region", code: commune.region.code, name: commune.region.nom },
    france: { level: "france", code: "FR", name: "France" },
  };

  // Périmètre d'analyse
  let focus: Focus = { level: "commune", code: commune.code, name: commune.nom };
  let perimeter = { label: commune.nom, communes: [{ code: commune.code, nom: commune.nom, population: commune.population }] };
  if (query.scope === "epci" && commune.epci) {
    focus = { level: "epci", code: commune.epci.code, name: commune.epci.nom };
    perimeter = { label: commune.epci.nom, communes: epciMembers(commune.epci.code) };
  } else if (query.scope === "departement") {
    focus = { level: "departement", code: commune.departement.code, name: commune.departement.nom };
    perimeter = { label: commune.departement.nom, communes: departementCommunes(commune.departement.code) };
  } else if (query.scope === "custom" && query.customCommunes?.length) {
    const list = [...new Set([commune.code, ...query.customCommunes])]
      .map((c) => communeFromReferentiel(c))
      .filter((c): c is CommuneInfo => !!c)
      .map((c) => ({ code: c.code, nom: c.nom, population: c.population }));
    perimeter = { label: `Territoire personnalisé (${list.length} communes)`, communes: list };
  }

  const sum = (arr: { population: number | null }[]) => arr.reduce((s, c) => s + (c.population ?? 0), 0);
  const populations: Collected["populations"] = [];
  populations.push({ geo: geos.commune, value: commune.population ?? NaN, communes: 1 });
  if (commune.epci && geos.epci) {
    const m = epciMembers(commune.epci.code);
    populations.push({ geo: geos.epci, value: epciInfo(commune.epci.code)?.populationMunicipale ?? sum(m), communes: m.length });
  }
  const depC = departementCommunes(commune.departement.code);
  populations.push({ geo: geos.departement, value: sum(depC), communes: depC.length });
  const regC = regionCommunes(commune.region.code);
  populations.push({ geo: geos.region, value: sum(regC), communes: regC.length });
  const frC = franceCommunes().filter((c) => !/^(975|977|978|986|987|988)/.test(c.code));
  populations.push({ geo: geos.france, value: sum(frC), communes: frC.length });
  if (query.scope === "custom" && perimeter.communes.length > 1)
    populations.push({ geo: { level: "commune", code: "CUSTOM", name: perimeter.label }, value: sum(perimeter.communes), communes: perimeter.communes.length });

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
      const contour = await departementContour(http, commune.departement.code).catch(() => null);
      c.depContour = contour?.feature ?? null;
      if (commune.contour && c.depFeatures) {
        const target = turf.feature(commune.contour as GeoJSON.Polygon);
        const bb = turf.bbox(target);
        for (const f of c.depFeatures.features) {
          const p = f.properties as { code: string; nom: string; population?: number; surface?: number };
          if (p.code === commune.code || !f.geometry) continue;
          const fb = turf.bbox(f);
          if (fb[0] > bb[2] || fb[2] < bb[0] || fb[1] > bb[3] || fb[3] < bb[1]) continue;
          try {
            if (turf.booleanIntersects(target, f as GeoJSON.Feature<GeoJSON.Polygon>))
              c.neighbours.push({ code: p.code, nom: p.nom, population: p.population ?? null, surfaceKm2: p.surface != null ? p.surface / 100 : null });
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
          .filter((x) => x.code !== commune.code && (x.population ?? 0) >= 20000 && x.centre)
          .map((x) => ({ code: x.code, nom: x.nom, population: x.population!, distanceKm: haversineKm(commune.centre!, x.centre!.coordinates) }))
          .filter((x) => x.distanceKm <= 80)
          .sort((a, b) => a.distanceKm - b.distanceKm)
          .slice(0, 10);
      }
      // Densités des communes de France (sélection de communes comparables).
      densityByCode = new Map(
        fc.communes.map((x) => [x.code, density(x.population ?? null, x.surface != null ? x.surface / 100 : null)] as const),
      );
    },
    { theme: "identite", label: "Contours, surface, densité et voisinage" },
  );

  /* 3. INSEE */
  step("insee", "Statistiques INSEE (recensement, revenus) pour le territoire et ses références");
  const kinds: [GeoRef | null, "COM" | "EPCI" | "DEP" | "REG" | "FRANCE"][] = [
    [geos.commune, "COM"],
    [geos.epci, "EPCI"],
    [geos.departement, "DEP"],
    [geos.region, "REG"],
    [geos.france, "FRANCE"],
  ];
  for (const [g, kind] of kinds) {
    if (!g) continue;
    const res = await ctx.step("insee_melodi", `insee:${g.level}`, (http) => collectInsee(ctx, http, kind, g.code, g), {
      theme: "demographie",
      label: `Statistiques INSEE — ${g.name}`,
    });
    if (res) c.insee.push({ geo: g, result: res });
  }

  /* 4. Communes du périmètre (EPCI de la commune ou périmètre personnalisé) */
  step("perimetre", "Indicateurs des communes du périmètre intercommunal");
  const perimeterList =
    query.scope === "custom" ? perimeter.communes : commune.epci ? epciMembers(commune.epci.code) : [];
  if (perimeterList.length > 1 && perimeterList.length <= 40) {
    await ctx.step("insee_melodi", "insee:perimetre", async (http) => {
      for (const m of perimeterList) {
        const g: GeoRef = { level: "commune", code: m.code, name: m.nom };
        try {
          const r = m.code === commune.code ? c.insee.find((x) => x.geo.code === m.code)?.result : await collectInsee(ctx, http, "COM", m.code, g, { datasets: ["DS_FILOSOFI_CC", "DS_RP_LOGEMENT_PRINC"] });
          if (r) c.perimeterInsee.push({ code: m.code, nom: m.nom, result: r });
        } catch (e) {
          http.partial = true;
          http.notes.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (!c.perimeterInsee.length) throw new Error(http.notes[0] ?? "Aucune donnée communale obtenue");
    });
  } else if (perimeterList.length > 40) {
    ctx.skip("insee_melodi", "insee:perimetre", "Périmètre de plus de 40 communes : indicateurs communaux non collectés (limite de débit INSEE)");
  }

  /* 5. Communes comparables */
  step("comparables", "Sélection et profil de communes comparables");
  const candidates = franceCommunes()
    .filter((x) => x.region === commune.region.code)
    .map((x) => ({ ...x, densite: densityByCode.get(x.code) ?? null }));
  const targetDens = densityByCode.get(commune.code) ?? null;
  let comps = comparableCommunes(candidates, commune, 0.3, 40);
  if (targetDens != null) comps = comps.filter((x) => x.densite == null || (x.densite >= targetDens * 0.5 && x.densite <= targetDens * 2));
  if (comps.length < 5) {
    const nat = franceCommunes().map((x) => ({ ...x, densite: densityByCode.get(x.code) ?? null }));
    comps = comparableCommunes(nat, commune, 0.2, 40).filter((x) => targetDens == null || x.densite == null || (x.densite >= targetDens * 0.5 && x.densite <= targetDens * 2));
  }
  c.comparables = comps.slice(0, 8).map((x) => ({ code: x.code, nom: x.nom, population: x.population, densite: x.densite, departement: x.departement }));
  if (c.comparables.length) {
    await ctx.step("insee_melodi", "insee:comparables", async (http) => {
      for (const cp of c.comparables) {
        try {
          cp.result = await collectInsee(ctx, http, "COM", cp.code, { level: "commune", code: cp.code, name: cp.nom }, {
            datasets: ["DS_FILOSOFI_CC", "DS_RP_EMPLOI_LR_PRINC", "DS_RP_LOGEMENT_PRINC"],
          });
        } catch (e) {
          http.partial = true;
          http.notes.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (!c.comparables.some((x) => x.result)) throw new Error(http.notes[0] ?? "Aucune donnée obtenue pour les communes comparables");
    });
  }

  /* 6. Marché immobilier */
  step("immobilier", "Transactions immobilières (DVF)");
  await ctx.step(
    "dvf",
    "immobilier",
    async (http) => {
      const d = await collectDvf(http, commune.code, commune.departement.code);
      c.dvf = { stats: d.stats, nSales: d.nSales, source: ctx.ref("dvf", d.urls[0], d.retrievedAt, { vintage: d.stats.length ? `${d.stats[0].year}-${d.stats[d.stats.length - 1].year}` : undefined }) };
    },
    { theme: "immobilier", label: "Prix immobiliers (DVF)" },
  );

  /* 7. Équipements */
  step("equipements", "Équipements et services (OpenStreetMap)");
  await ctx.step(
    "osm",
    "equipements",
    async (http) => {
      const e = await collectEquipments(http, commune.code);
      c.equipments = { features: e.features, source: ctx.ref("osm", e.url, e.retrievedAt) };
      try {
        const cw = await collectCycleways(http, commune.code);
        c.cycleways = { lines: cw.lines, source: ctx.ref("osm", cw.url, cw.retrievedAt) };
      } catch {
        http.partial = true;
        http.notes.push("Aménagements cyclables indisponibles");
      }
      if (commune.centre) {
        try {
          const n = await collectNearest(http, commune.centre[0], commune.centre[1]);
          c.nearestSource = ctx.ref("osm", n.url, n.retrievedAt);
          const groups: [string, (t: Record<string, string>) => boolean][] = [
            ["Service d'urgences hospitalières", (t) => t.amenity === "hospital" && t.emergency === "yes"],
            ["Hôpital ou clinique", (t) => t.amenity === "hospital"],
            ["Gare ferroviaire", (t) => t.railway === "station"],
            ["Lycée", (t) => t.amenity === "school" && /3/.test(t["isced:level"] ?? "")],
            ["Établissement d'enseignement supérieur", (t) => t.amenity === "university"],
          ];
          c.nearest = [];
          for (const [label, pred] of groups) {
            let best: { name: string; d: number; lon: number; lat: number } | null = null;
            for (const el of n.elements) {
              const lat = el.lat ?? el.center?.lat;
              const lon = el.lon ?? el.center?.lon;
              if (lat == null || lon == null || !el.tags || !pred(el.tags)) continue;
              const d = haversineKm(commune.centre!, [lon, lat]);
              if (!best || d < best.d) best = { name: el.tags.name ?? label, d, lon, lat };
            }
            if (best) c.nearest.push({ label, name: best.name, distanceKm: best.d, lon: best.lon, lat: best.lat });
          }
        } catch {
          http.partial = true;
          http.notes.push("Équipements structurants proches indisponibles");
        }
      }
    },
    { theme: "equipements", label: "Équipements et services (OpenStreetMap)" },
  );

  /* 8. Éducation */
  step("education", "Établissements scolaires (Annuaire de l'éducation)");
  await ctx.step(
    "education",
    "education",
    async (http) => {
      const s = await collectSchools(http, commune.code);
      c.schools = { schools: s.schools, source: ctx.ref("education", s.url, s.retrievedAt) };
    },
    { theme: "education", label: "Établissements scolaires" },
  );

  /* 9. Transports */
  step("transports", "Gares et fréquentation (SNCF Open Data)");
  await ctx.step(
    "sncf",
    "transports",
    async (http) => {
      const s = await collectStations(http, commune.code, commune.codesPostaux);
      c.stations = { stations: s.stations, source: ctx.ref("sncf", s.urls[0], s.retrievedAt) };
    },
    { theme: "mobilite", label: "Gares et fréquentation" },
  );

  /* 10. Entreprises */
  step("entreprises", "Tissu économique et principaux employeurs (SIRENE)");
  await ctx.step(
    "entreprises",
    "entreprises",
    async (http) => {
      const e = await collectEntreprises(http, commune.code);
      c.entreprises = { bySection: e.bySection, employers: e.employers, source: ctx.ref("entreprises", e.urls[0], e.retrievedAt) };
    },
    { theme: "economie", label: "Établissements et employeurs (SIRENE)" },
  );

  /* 11. Risques */
  step("risques", "Risques naturels et technologiques (Géorisques)");
  await ctx.step(
    "georisques",
    "risques",
    async (http) => {
      const r = await collectRisques(http, commune.code);
      c.risques = { data: r, source: ctx.ref("georisques", r.urls[0], r.retrievedAt) };
    },
    { theme: "risques", label: "Risques naturels et technologiques" },
  );

  /* 12. Élections */
  step("elections", "Résultats électoraux officiels (agrégés)");
  for (const e of ELECTIONS) {
    await ctx.step(
      "elections",
      `elections:${e.id}`,
      async (http) => {
        const res = await collectElection(http, e, commune.code, commune.departement.code);
        c.elections.push({ results: res, source: ctx.ref("elections", res[0].sourceUrl, res[0].retrievedAt, { vintage: e.date.slice(0, 4), dataset: e.dataset }) });
      },
      { theme: "elections", label: `Résultats — ${e.label}` },
    );
  }

  /* 13. Bureaux de vote */
  step("bureaux", "Résultats par bureau de vote et géographie des bureaux");
  for (const e of ELECTIONS) {
    await ctx.step(
      "elections",
      `bureaux:${e.id}`,
      async (http) => {
        const res = await collectBureaux(http, e, commune.code, commune.departement.code);
        c.bureaux.push({ election: e, results: res, source: ctx.ref("elections", res[0].sourceUrl, res[0].retrievedAt, { vintage: e.date.slice(0, 4), dataset: e.dataset }) });
      },
      { theme: "elections", label: `Résultats par bureau de vote — ${e.label}` },
    );
  }
  if (c.bureaux.length)
    await ctx.step(
      "bureaux_geo",
      "bureaux:geo",
      async (http) => {
        const g = await collectBureauxGeo(http, commune.code);
        if (!g) throw new Error("Aucune géographie des bureaux de vote disponible (fournir data/interne/bv-<code>.geojson)");
        c.bvGeo = { ...g, source: { id: "bureaux_geo", name: g.sourceName, url: g.url, retrievedAt: g.retrievedAt || new Date().toISOString() } };
      },
      { theme: "elections", label: "Contours / libellés des bureaux de vote" },
    );

  /* 14. Données internes facultatives */
  c.interne = await loadInternalData();
  if (c.interne.files.length)
    ctx.runs.push({ sourceId: "interne", name: "Données militantes internes (fichiers fournis)", step: "interne", status: "ok", message: c.interne.files.join(", "), durationMs: 0, requests: 0, fromCache: 0, retrievedAt: new Date().toISOString() });

  progress({ step: "collecte", label: "Collecte terminée", done: done, total: steps.length + 3, status: "running" });
  return c;
}
