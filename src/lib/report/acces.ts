import * as turf from "@turf/turf";
import { GEO_API } from "../collectors/admin";
import { fitAspect, type Bbox } from "../collectors/carto";
import { collectDirectTrains, type TrainGroup } from "../collectors/gtfs";
import { SNCF } from "../collectors/public-apis";
import { fmtDuration, OSRM_URL } from "../collectors/routes";
import { fmtNumber } from "../format";
import type { Block, DataTable, MapSpec, SourceRef } from "../types";
import type { Collected } from "./collect";

/**
 * Ciblage : temps de trajet vers chaque territoire proposé depuis les « villes militantes »
 * proches (au moins 2 groupes d'action actifs ou 200 parrains d'après le bilan LFI), en
 * voiture (OSRM) et en train direct un samedi (horaires SNCF). Sert à choisir le lieu
 * le plus facile à rejoindre pour un convoi.
 */

export const HUB_MIN_GA = 2;
export const HUB_MIN_PARRAINS = 200;
const HUB_MAX = 6;
const HUB_MAX_KM = 90;

interface Lieu {
  code: string;
  nom: string;
  lon: number;
  lat: number;
}
export interface AccesTarget {
  nom: string;
  codes: string[];
  color: string;
}

type GeoCommune = { code: string; nom: string; centre?: { coordinates: [number, number] }; population?: number };

export async function ciblageAcces(c: Collected, targets: AccesTarget[]): Promise<{ tables: DataTable[]; maps: MapSpec[]; blocks: Block[] } | null> {
  const bilan = c.interne.bilan;
  if (!bilan || !targets.length) return null;
  const ctx = c.ctx;
  const dep = c.commune.departement.code;
  const deps = [dep, ...(c.depVoisins?.features ?? []).map((f) => String((f.properties as { code?: string }).code ?? "")).filter(Boolean)];

  // 1. Communes du département et des départements voisins (centre, nom).
  const communes = new Map<string, GeoCommune>();
  let geoSrc = null as SourceRef | null;
  await ctx.step("geoapi", "ciblage:acces:communes", async (http) => {
    for (const d of deps) {
      const url = `${GEO_API}/departements/${d}/communes?fields=nom,code,centre,population&format=json`;
      const r = await http.json<GeoCommune[]>(url, { ttlHours: 24 * 30 });
      for (const x of r.data ?? []) communes.set(x.code, x);
      geoSrc ??= ctx.ref("geoapi", url, r.retrievedAt);
    }
  });
  const at = (code: string): Lieu | null => {
    const x = communes.get(code);
    return x?.centre ? { code, nom: x.nom, lon: x.centre.coordinates[0], lat: x.centre.coordinates[1] } : null;
  };
  const tgt = targets
    .map((t) => {
      // Groupement : la commune la plus peuplée sert de point d'arrivée.
      const main = [...t.codes].sort((a, b) => (communes.get(b)?.population ?? 0) - (communes.get(a)?.population ?? 0))[0];
      const l = at(main);
      return l ? { ...t, at: l } : null;
    })
    .filter((x): x is AccesTarget & { at: Lieu } => !!x);
  if (!tgt.length) return null;

  // 2. Villes militantes proches : au moins 2 groupes d'action actifs ou 200 parrains.
  const targetCodes = new Set(targets.flatMap((t) => t.codes));
  const hubs = [...bilan]
    .filter(([code, b]) => !targetCodes.has(code) && (b.ga >= HUB_MIN_GA || b.parrains >= HUB_MIN_PARRAINS))
    .map(([code, b]) => ({ l: at(code), b }))
    .filter((x): x is { l: Lieu; b: (typeof x)["b"] } => !!x.l)
    .map((x) => ({ ...x, km: Math.min(...tgt.map((t) => turf.distance([x.l.lon, x.l.lat], [t.at.lon, t.at.lat]))) }))
    .filter((x) => x.km <= HUB_MAX_KM)
    .sort((a, b) => b.b.parrains - a.b.parrains)
    .slice(0, HUB_MAX);
  if (!hubs.length) return null;

  // 3. Voiture : une matrice OSRM (villes militantes → territoires).
  const car = new Map<string, number>();
  let osrmSrc = null as SourceRef | null;
  await ctx.step("osrm", "ciblage:acces:voiture", async (http) => {
    const pts = [...hubs.map((h) => h.l), ...tgt.map((t) => t.at)];
    const url = `${OSRM_URL}/table/v1/driving/${pts.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";")}?sources=${hubs.map((_, i) => i).join(";")}&destinations=${tgt.map((_, j) => hubs.length + j).join(";")}&annotations=duration`;
    const r = await http.json<{ code?: string; durations?: (number | null)[][] }>(url, { minIntervalMs: 1100, ttlHours: 24 * 30 });
    if (r.data?.code !== "Ok" || !r.data.durations) throw new Error("Matrice OSRM indisponible");
    r.data.durations.forEach((row, i) => row.forEach((d, j) => d != null && car.set(`${hubs[i].l.code}|${tgt[j].at.code}`, Math.round(d / 60))));
    osrmSrc = ctx.ref("osrm", url, r.retrievedAt);
  });

  // 4. Train direct un samedi (gares SNCF des villes et des territoires).
  const train = new Map<string, { minutes: number; trains: number }>();
  let gtfsSrc = null as SourceRef | null;
  await ctx.step("gtfs", "ciblage:acces:train", async (http) => {
    const codes = [...new Set([...hubs.map((h) => h.l.code), ...tgt.flatMap((t) => t.codes)])];
    const where = `codeinsee in (${codes.map((k) => `"${k}"`).join(",")})`;
    const gUrl = `${SNCF}/gares-de-voyageurs/records?where=${encodeURIComponent(where)}&limit=100`;
    const g = await http.json<{ results?: Record<string, unknown>[] }>(gUrl, { ttlHours: 24 * 30 });
    const byCode = new Map<string, TrainGroup["stations"]>();
    for (const s of g.data?.results ?? []) {
      const code = String(s.codeinsee ?? "");
      const pos = s.position_geographique as { lon?: number; lat?: number } | undefined;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code)!.push({ nom: String(s.nom ?? ""), uic: String(s.codes_uic ?? s.code_uic ?? ""), lon: pos?.lon ?? null, lat: pos?.lat ?? null });
    }
    const groups: TrainGroup[] = [
      ...hubs.filter((h) => byCode.has(h.l.code)).map((h) => ({ key: h.l.code, stations: byCode.get(h.l.code)! })),
      ...tgt.map((t) => ({ key: t.at.code, stations: t.codes.flatMap((k) => byCode.get(k) ?? []) })).filter((x) => x.stations.length),
    ];
    if (groups.length < 2) return;
    const r = await collectDirectTrains(http, groups);
    for (const [k, v] of Object.entries(r.pairs)) train.set(k, v);
    gtfsSrc = ctx.ref("gtfs", r.url, r.retrievedAt, { vintage: `samedi ${r.date.slice(6, 8)}/${r.date.slice(4, 6)}/${r.date.slice(0, 4)}` });
  });
  if (!car.size && !train.size) return null;

  // 5. Tableau : une ligne par territoire, une colonne par ville militante.
  const tr = (a: string, b: string) => train.get([a, b].sort().join("|"));
  const cell = (h: string, t: string) => {
    const v = car.get(`${h}|${t}`);
    const r = tr(h, t);
    return [v != null ? fmtDuration(v) : "", r ? `train ${fmtDuration(r.minutes)}` : ""].filter(Boolean).join(" ; ") || "—";
  };
  const moy = (t: string) => {
    const xs = hubs.map((h) => car.get(`${h.l.code}|${t}`)).filter((x): x is number => x != null);
    return xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null;
  };
  const rows = tgt.map((t) => ({
    territoire: t.nom,
    ...Object.fromEntries(hubs.map((h) => [`h${h.l.code}`, cell(h.l.code, t.at.code)])),
    moyenne: moy(t.at.code) != null ? fmtDuration(moy(t.at.code)!) : "",
  }));
  const ranked = tgt.map((t, i) => ({ i, m: moy(t.at.code) })).filter((x) => x.m != null).sort((a, b) => a.m! - b.m!);
  const sources = [geoSrc, osrmSrc, gtfsSrc].filter((s): s is SourceRef => !!s);
  const table: DataTable = {
    id: "ciblage_acces",
    title: "Temps de trajet depuis les villes militantes proches",
    theme: "strategie",
    columns: [
      { key: "territoire", label: "Territoire proposé", wide: true },
      ...hubs.map((h) => ({ key: `h${h.l.code}`, label: `Depuis ${h.l.nom}` })),
      { key: "moyenne", label: "Moyenne en voiture", align: "right" as const },
    ],
    rows,
    highlight: ranked.length ? [ranked[0].i] : [],
    sources,
    note: `Villes militantes : au moins ${HUB_MIN_GA} groupes d'action actifs ou ${HUB_MIN_PARRAINS} parrains (bilan LFI), à moins de ${HUB_MAX_KM} km ; ${hubs.length} retenues, par nombre de parrains. Voiture : temps sans trafic (OSRM). Train : trajet direct le plus court un samedi (horaires SNCF), sans correspondance ; « — » : pas de calcul possible.`,
  };

  // 6. Carte : villes militantes, territoires proposés, liaisons.
  const pts = [...hubs.map((h) => [h.l.lon, h.l.lat]), ...tgt.map((t) => [t.at.lon, t.at.lat])];
  const bb0 = turf.bbox(turf.multiPoint(pts)) as Bbox;
  const bbox = fitAspect(bb0, 0.18);
  const tFeats = (c.depFeatures?.features ?? []).filter((f) => targetCodes.has(String((f.properties as { code?: string }).code)));
  const colorOf = new Map(targets.flatMap((t) => t.codes.map((k) => [k, t.color] as const)));
  const base = sources[0] ?? c.depVoisins?.source;
  const map: MapSpec = {
    id: "ciblage_acces_carte",
    title: "Villes militantes proches et territoires proposés",
    theme: "strategie",
    bbox,
    poster: { kicker: c.commune.departement.nom, title: "Rejoindre les territoires proposés", source: "Source : bilan LFI (villes militantes), OSRM, SNCF. Fonds : IGN." },
    layers: [
      ...(c.depVoisins?.features.length
        ? [{ id: "voisins", label: "Départements voisins", kind: "polygons" as const, data: turf.featureCollection(c.depVoisins.features), style: { fill: "#ece8df", stroke: "#b9b2a4", strokeWidth: 1 }, labelMode: "caps" as const, labelProperty: "nom", visible: true, source: c.depVoisins.source }]
        : []),
      ...(c.depFeatures?.features.length
        ? [{ id: "communes", label: "Communes", kind: "polygons" as const, data: c.depFeatures, style: { fill: "#fffcf4", stroke: "#e2dccd", strokeWidth: 0.4 }, visible: true, source: c.depVoisins?.source ?? base! }]
        : []),
      ...(tFeats.length
        ? [{ id: "cibles", label: "Territoires proposés", kind: "polygons" as const, data: turf.featureCollection(tFeats.map((f) => ({ ...f, properties: { ...(f.properties ?? {}), _fill: colorOf.get(String((f.properties as { code?: string }).code)) } }))), style: { fill: "#f3b51b", stroke: "#8a8170", strokeWidth: 0.6 }, legendItem: { label: "Territoire proposé", swatch: "fill" as const }, visible: true, source: c.depVoisins?.source ?? base! }]
        : []),
      {
        id: "liaisons",
        label: "Trajets",
        kind: "lines",
        data: turf.featureCollection(hubs.flatMap((h) => tgt.map((t) => turf.lineString([[h.l.lon, h.l.lat], [t.at.lon, t.at.lat]])))),
        style: { stroke: "#4c0297", strokeWidth: 0.8, dash: "4 4" },
        visible: true,
        source: base!,
      },
      {
        id: "arrivees",
        label: "Territoires proposés",
        kind: "points",
        data: turf.featureCollection(tgt.map((t) => turf.point([t.at.lon, t.at.lat], { nom: t.nom, sub: moy(t.at.code) != null ? `${fmtDuration(moy(t.at.code)!)} en moyenne` : "" }))),
        style: { fill: "#c98a00", stroke: "#ffffff", symbol: "circle", size: 12 },
        labelMode: "callout",
        labelProperty: "nom",
        sublabelProperty: "sub",
        labelColor: "#8a5a00",
        visible: true,
        source: base!,
      },
      {
        id: "villes",
        label: "Villes militantes",
        kind: "points",
        data: turf.featureCollection(hubs.map((h) => turf.point([h.l.lon, h.l.lat], { nom: h.l.nom, sub: [h.b.ga ? `${fmtNumber(h.b.ga)} groupe${h.b.ga > 1 ? "s" : ""}` : "", `${fmtNumber(Math.round(h.b.parrains))} parrains`].filter(Boolean).join(", ") }))),
        style: { fill: "#4c0297", stroke: "#ffffff", symbol: "diamond", size: 15 },
        labelMode: "callout",
        labelProperty: "nom",
        sublabelProperty: "sub",
        labelColor: "#4c0297",
        legendItem: { label: `Ville militante (${HUB_MIN_GA} groupes actifs ou ${HUB_MIN_PARRAINS} parrains)`, swatch: "diamond" },
        visible: true,
        source: base!,
      },
    ],
    note: "Liaisons en pointillé : trajets calculés (voir le tableau).",
  };

  const best = ranked[0] ? tgt[ranked[0].i] : null;
  const worst = ranked.length > 1 ? tgt[ranked[ranked.length - 1].i] : null;
  const blocks: Block[] = [
    { type: "heading", text: "Rejoindre les territoires proposés" },
    ...(best
      ? [
          {
            type: "paragraph" as const,
            text: `**Le plus facile à rejoindre : ${best.nom}**, à ${fmtDuration(ranked[0].m!)} en moyenne en voiture des villes militantes proches${worst && ranked[ranked.length - 1].m! - ranked[0].m! >= 10 ? ` (${worst.nom} : ${fmtDuration(ranked[ranked.length - 1].m!)})` : ""}.`,
          },
        ]
      : []),
    { type: "map", mapId: map.id },
    { type: "table", tableId: table.id },
  ];
  return { tables: [table], maps: [map], blocks };
}
