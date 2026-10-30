import * as turf from "@turf/turf";
import { GEO_API } from "../collectors/admin";
import { fitAspect, type Bbox } from "../collectors/carto";
import { collectIdfmIndex, collectRailIndex, directTrains, collectUrbanIndex, pickUrbanGtfs, railStations, RAIL_CHANGE_MIN, routeRail, routeTc, TC_BOARD_MIN, TC_TRANSFER_MIN, TRANSPORT_API, type TcIndex, type TrainGroup } from "../collectors/gtfs";
import { SNCF } from "../collectors/public-apis";
import { fmtDuration, OSRM_URL } from "../collectors/routes";
import { dansDep, deDep, fmtNumber } from "../format";

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const joinList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} et ${xs[xs.length - 1]}`);
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
/** Fiche commune : une ligne par ville, on peut en montrer davantage. */
const HUB_MAX_FICHE = 10;
const IDF = new Set(["75", "77", "78", "91", "92", "93", "94", "95"]);
const range = (a: number, b: number, f: (i: number) => string) => Array.from({ length: b - a + 1 }, (_, i) => f(a + i));
/** Arrondissements de Paris, Marseille et Lyon (codes des gares SNCF). */
const ARRONDISSEMENTS: Record<string, string[]> = {
  "75056": range(1, 20, (i) => `751${String(i).padStart(2, "0")}`),
  "13055": range(1, 16, (i) => `132${String(i).padStart(2, "0")}`),
  "69123": range(1, 9, (i) => `6938${i}`),
};
const HUB_MAX_KM = 90;
/** Grandes villes militantes (2 000 parrains et plus : Paris, Lyon, Marseille…) : jusqu'à 130 km. */
const BIG_HUB_PARRAINS = 2000;
const BIG_HUB_MAX_KM = 130;
/** Communes voisines avec un groupe d'action actif, quelle que soit leur taille. */
const LOCAL_GA_KM = 25;
/** … et au moins 25 parrains : un groupe déclaré actif dans une commune presque sans soutiens ne fera pas venir de monde. */
const LOCAL_MIN_PARRAINS = 25;
const parrainsTxt = (n: number) => `${fmtNumber(Math.round(n))} soutien${Math.round(n) > 1 ? "s" : ""} JLM2027`;

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

/**
 * Deux villes militantes à moins de 6 km : même agglomération (Lagord et Périgny pour La Rochelle).
 * Pas en Île-de-France, où chaque ville de banlieue a ses propres groupes et ses propres transports.
 */
const AGGLO_KM = 6;

/**
 * Choix des villes militantes (max places) :
 * 1. une seule par agglomération (hors Île-de-France) : la commune qui a le plus de parrains, les voisines à moins de 6 km
 *    sont écartées (elles prendraient des places pour un même point de départ) ;
 * 2. la moitié des places aux plus proches des territoires ;
 * 3. puis les villes militantes (2 groupes ou 200 parrains) les plus proches ;
 * 4. la dernière à la grande ville (2 000 parrains et plus) la plus proche — Bordeaux plutôt que Nantes
 *    pour la Charente-Maritime —, à défaut à la ville qui a le plus de parrains.
 */
export function chooseHubs<T extends { l: { code: string; lon: number; lat: number }; b: { ga: number; parrains: number }; km: number }>(all: T[], max: number, dep?: string): T[] {
  const idf = (code: string) => IDF.has(code.slice(0, 2));
  const cands = all.filter((x) => idf(x.l.code) || !all.some((y) => y !== x && !idf(y.l.code) && (y.b.parrains > x.b.parrains || (y.b.parrains === x.b.parrains && y.l.code < x.l.code)) && turf.distance([x.l.lon, x.l.lat], [y.l.lon, y.l.lat]) < AGGLO_KM));
  const estVille = (x: T) => x.b.ga >= HUB_MIN_GA || x.b.parrains >= HUB_MIN_PARRAINS;
  // Fiche commune : les villes du département d'abord (convois organisés par la boucle départementale) —
  // une ville d'un autre département compte comme si elle était 20 km plus loin.
  const sameDep = (x: T) => !dep || x.l.code.startsWith(dep.length === 3 ? dep : dep.padStart(2, "0"));
  const kmPref = (x: T) => x.km + (sameDep(x) ? 0 : 20);
  const nearest = [...cands].sort((a, b) => kmPref(a) - kmPref(b)).slice(0, Math.ceil(max / 2));
  const reste = cands.filter((x) => !nearest.includes(x) && estVille(x));
  const grandes = reste.filter((x) => x.b.parrains >= BIG_HUB_PARRAINS).sort((a, b) => a.km - b.km);
  const grande = grandes[0] ?? [...reste].sort((a, b) => b.b.parrains - a.b.parrains)[0];
  const villes = reste.filter((x) => x !== grande).sort((a, b) => a.km - b.km).slice(0, Math.max(0, max - nearest.length - 1));
  return [...nearest, ...villes, ...(grande && nearest.length + villes.length < max ? [grande] : [])];
}

export async function ciblageAcces(
  c: Collected,
  targets: AccesTarget[],
  opts: { fiche?: boolean } = {},
): Promise<{ tables: DataTable[]; maps: MapSpec[]; blocks: Block[]; detail?: Block[] } | null> {
  const bilan = c.interne.bilan;
  if (!bilan || !targets.length) return null;
  const ctx = c.ctx;

  // 1. Centre de toutes les communes (une requête nationale, gardée 30 jours) : villes militantes
  // de n'importe quel département voisin (Toulouse pour l'Ariège).
  const communes = new Map<string, GeoCommune>();
  let geoSrc = null as SourceRef | null;
  await ctx.step("geoapi", "acces:communes", async (http) => {
    const url = `${GEO_API}/communes?fields=nom,code,centre,population&format=json`;
    const r = await http.json<GeoCommune[]>(url, { ttlHours: 24 * 30, timeoutMs: 120000 });
    for (const x of r.data ?? []) communes.set(x.code, x);
    geoSrc = ctx.ref("geoapi", url, r.retrievedAt);
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

  // 2. Villes militantes proches : au moins 2 groupes d'action actifs ou 200 parrains, et les communes
  // voisines (moins de 25 km) qui ont un groupe actif. On garde d'abord les plus proches, puis les plus grandes.
  const targetCodes = new Set(targets.flatMap((t) => t.codes));
  const cands = [...bilan]
    .filter(([code, b]) => !targetCodes.has(code) && b.ga >= 1)
    .map(([code, b]) => ({ l: at(code), b }))
    .filter((x): x is { l: Lieu; b: (typeof x)["b"] } => !!x.l)
    .map((x) => ({ ...x, km: Math.min(...tgt.map((t) => turf.distance([x.l.lon, x.l.lat], [t.at.lon, t.at.lat]))) }))
    .filter((x) => {
      const ville = x.b.ga >= HUB_MIN_GA || x.b.parrains >= HUB_MIN_PARRAINS;
      return (ville && (x.km <= HUB_MAX_KM || (x.b.parrains >= BIG_HUB_PARRAINS && x.km <= BIG_HUB_MAX_KM))) || (x.km <= LOCAL_GA_KM && x.b.parrains >= LOCAL_MIN_PARRAINS);
    });
  const max = opts.fiche ? HUB_MAX_FICHE : HUB_MAX;
  const hubs = chooseHubs(cands, max, opts.fiche ? c.commune.departement.code : undefined);
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
  // Avec correspondance (depuis la ville militante, départ entre 5 h et 14 h).
  const trainVia = new Map<string, { minutes: number; changes: string[]; depart: number }>();
  /** Gare utilisée quand la commune n'en a pas (nom). */
  const gareProche = new Map<string, string>();
  let gtfsSrc = null as SourceRef | null;
  await ctx.step("gtfs", "ciblage:acces:train", async (http) => {
    const codes = [...new Set([...hubs.map((h) => h.l.code), ...tgt.flatMap((t) => t.codes)])];
    // Paris, Lyon, Marseille : les gares sont rattachées aux arrondissements (Marseille Saint-Charles : 13201).
    const arrOf = new Map<string, string>();
    for (const k of codes) for (const a of ARRONDISSEMENTS[k] ?? []) arrOf.set(a, k);
    const where = `codeinsee in (${[...codes, ...arrOf.keys()].map((k) => `"${k}"`).join(",")})`;
    const gUrl = `${SNCF}/gares-de-voyageurs/records?where=${encodeURIComponent(where)}&limit=100`;
    const results: Record<string, unknown>[] = [];
    for (let off = 0; off < 1000; off += 100) {
      const g = await http.json<{ results?: Record<string, unknown>[] }>(`${gUrl}&offset=${off}`, { ttlHours: 24 * 30 });
      results.push(...(g.data?.results ?? []));
      if ((g.data?.results ?? []).length < 100) break;
    }
    const byCode = new Map<string, TrainGroup["stations"]>();
    for (const s of results) {
      const raw = String(s.codeinsee ?? "");
      const code = arrOf.get(raw) ?? raw;
      const pos = s.position_geographique as { lon?: number; lat?: number } | undefined;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code)!.push({ nom: String(s.nom ?? ""), uic: String(s.codes_uic ?? s.code_uic ?? ""), lon: pos?.lon ?? null, lat: pos?.lat ?? null });
    }
    const groups: TrainGroup[] = [
      ...hubs.filter((h) => byCode.has(h.l.code)).map((h) => ({ key: h.l.code, stations: byCode.get(h.l.code)! })),
      ...tgt.map((t) => ({ key: t.at.code, stations: t.codes.flatMap((k) => byCode.get(k) ?? []) })).filter((x) => x.stations.length),
    ];
    const r = await collectRailIndex(http);
    if (groups.length >= 2) for (const [k, v] of Object.entries(directTrains(r, groups).pairs)) train.set(k, v);
    // Sans gare dans la commune : la gare la plus proche (5 km au plus pour la commune visée, 3 km pour la ville de départ),
    // ex. Decazeville → gare de Viviez-Decazeville.
    const gareSet = (key: string, lon: number, lat: number, km: number) => {
      const g = groups.find((x) => x.key === key);
      const own = g ? railStations(r, g.stations) : new Set<number>();
      // Île-de-France : le RER et le métro (calculés à part) font le travail ; pas de détour par une gare parisienne.
      if (own.size || IDF.has(key.slice(0, 2))) return own;
      const near = r.stations.map((st, i) => ({ i, d: turf.distance([lon, lat], [st.lon, st.lat]) })).filter((x) => x.d <= km).sort((a, b) => a.d - b.d);
      if (near.length) gareProche.set(key, r.stations[near[0].i].nom);
      return new Set(near.slice(0, 1).map((x) => x.i));
    };
    const fromOf = new Map(hubs.map((h) => [h.l.code, gareSet(h.l.code, h.l.lon, h.l.lat, 3)]));
    for (const t of tgt) {
      const to = gareSet(t.at.code, t.at.lon, t.at.lat, 5);
      if (!to.size) continue;
      for (const h of hubs) {
        const from = fromOf.get(h.l.code);
        if (!from?.size) continue;
        const v = routeRail(r, from, to);
        if (v) trainVia.set(`${h.l.code}|${t.at.code}`, v);
      }
    }
    gtfsSrc = ctx.ref("gtfs", r.url, r.retrievedAt, { vintage: `samedi ${r.date.slice(6, 8)}/${r.date.slice(4, 6)}/${r.date.slice(0, 4)}` });
  });
  // 5. Île-de-France : métro, RER, tram en trajet direct (horaires IDFM), depuis le centre de la ville militante.
  const tc = new Map<string, { minutes: number; ligne: string }>();
  let tcSrc = null as SourceRef | null;
  const urbanSrc: SourceRef[] = [];
  const idf = (code: string) => IDF.has(code.slice(0, 2));
  // Le réseau d'Île-de-France déborde (Transilien R jusqu'à Montargis, P jusqu'à Château-Thierry…) :
  // calcul dès qu'une ville militante est en Île-de-France, si la commune visée a une gare de ce réseau.
  if (hubs.some((h) => idf(h.l.code)))
    await ctx.step("gtfs", "acces:metro-rer", async (http) => {
      const index = await collectIdfmIndex(http);
      const near = (lon: number, lat: number, km: number) => new Set(index.stations.flatMap((st, i) => (turf.distance([lon, lat], [st.lon, st.lat]) <= km ? [i] : [])));
      const contourOf = (codes: string[]) => (c.depFeatures?.features ?? []).filter((f) => codes.includes(String((f.properties as { code?: string }).code))).concat(codes.includes(c.commune.code) && c.commune.contour ? [turf.feature(c.commune.contour as GeoJSON.Polygon)] : []);
      for (const t of tgt) {
        const polys = contourOf(t.codes);
        const inside = polys.length
          ? new Set(index.stations.flatMap((st, i) => (polys.some((p) => turf.booleanPointInPolygon([st.lon, st.lat], p as GeoJSON.Feature<GeoJSON.Polygon>)) ? [i] : [])))
          : idf(t.at.code)
            ? near(t.at.lon, t.at.lat, 1.5)
            : new Set<number>();
        if (!inside.size) continue;
        for (const h of hubs.filter((x) => idf(x.l.code))) {
          // Stations déjà dans la commune visée : pas de trajet (« 0 min à pied ») ; on part des autres.
          const from = new Set([...near(h.l.lon, h.l.lat, 1.2)].filter((i) => !inside.has(i)));
          const r = from.size ? routeTc(index, from, inside) : null;
          // Lignes : « métro 7 », « métro 9, puis RER C », « métro 9, RER A, puis tram T3 ».
          if (r) tc.set(`${h.l.code}|${t.at.code}`, { minutes: r.minutes, ligne: r.lignes.length > 1 ? `${r.lignes.slice(0, -1).join(", ")}, puis ${r.lignes[r.lignes.length - 1]}` : (r.lignes[0] ?? "à pied") });
        }
      }
      tcSrc = ctx.ref("idfm_gtfs", index.url, index.retrievedAt);
    });
  // 6. Ailleurs : métro et tram des réseaux urbains (horaires publiés sur transport.data.gouv.fr),
  // pour les villes militantes à moins de 40 km d'un territoire hors Île-de-France.
  const URBAN_KM = 40;
  const urbanPairs = tgt.flatMap((t) => hubs.filter((h) => !idf(h.l.code) && !tc.has(`${h.l.code}|${t.at.code}`) && turf.distance([h.l.lon, h.l.lat], [t.at.lon, t.at.lat]) <= URBAN_KM).map((h) => ({ h, t })));
  if (urbanPairs.length)
    await ctx.step("transport", "acces:reseaux-urbains", async (http) => {
      const r = await http.json<unknown[]>(TRANSPORT_API, { ttlHours: 24 * 7, timeoutMs: 120000 });
      const list = Array.isArray(r.data) ? r.data : [];
      const indexes = new Map<string, TcIndex | null>();
      const contourOf = (codes: string[]) => (c.depFeatures?.features ?? []).filter((f) => codes.includes(String((f.properties as { code?: string }).code))).concat(codes.includes(c.commune.code) && c.commune.contour ? [turf.feature(c.commune.contour as GeoJSON.Polygon)] : []);
      for (const t of tgt) {
        const pairs = urbanPairs.filter((p) => p.t === t);
        if (!pairs.length) continue;
        const picks = pickUrbanGtfs(list, { codes: [...t.codes, ...pairs.map((p) => p.h.l.code)], names: [t.at.nom, ...pairs.map((p) => p.h.l.nom)] });
        for (const pk of picks) {
          if (!indexes.has(pk.url)) indexes.set(pk.url, await collectUrbanIndex(http, pk.url).catch(() => null));
          const index = indexes.get(pk.url);
          if (!index) continue;
          const polys = contourOf(t.codes);
          const inside = polys.length
            ? new Set(index.stations.flatMap((st, i) => (polys.some((p) => turf.booleanPointInPolygon([st.lon, st.lat], p as GeoJSON.Feature<GeoJSON.Polygon>)) ? [i] : [])))
            : new Set(index.stations.flatMap((st, i) => (turf.distance([t.at.lon, t.at.lat], [st.lon, st.lat]) <= 1.5 ? [i] : [])));
          if (!inside.size) continue;
          for (const { h } of pairs) {
            const key = `${h.l.code}|${t.at.code}`;
            const from = new Set(index.stations.flatMap((st, i) => (!inside.has(i) && turf.distance([h.l.lon, h.l.lat], [st.lon, st.lat]) <= 1.2 ? [i] : [])));
            const v = from.size ? routeTc(index, from, inside) : null;
            if (v && (!tc.has(key) || v.minutes < tc.get(key)!.minutes)) tc.set(key, { minutes: v.minutes, ligne: v.lignes.length > 1 ? `${v.lignes.slice(0, -1).join(", ")}, puis ${v.lignes[v.lignes.length - 1]}` : (v.lignes[0] ?? "à pied") });
          }
          urbanSrc.push(ctx.ref("transport", pk.url, index.retrievedAt, { vintage: pk.title }));
        }
      }
    });
  if (!car.size && !train.size && !trainVia.size && !tc.size) return null;

  // Train : direct (nombre de trains), sinon avec correspondance ; la correspondance est signalée
  // aussi quand elle fait gagner au moins un quart d'heure.
  const viaTxt = (v: { minutes: number; changes: string[] }) => `${fmtDuration(v.minutes)}, ${v.changes.length ? `changement${v.changes.length > 1 ? "s" : ""} à ${v.changes.join(", ")}` : "direct"}`;
  // Un train bien plus long que la voiture (Lezennes → Faches par Douai : 2 h 17 contre 11 min) n'est pas une option.
  const utile = (h: string, t: string, m: number | undefined) => {
    const v = car.get(`${h}|${t}`);
    return m != null && (v == null || m <= v * 2 + 15);
  };
  const trainTxt = (h: string, t: string, short = false) => {
    const r0 = train.get([h, t].sort().join("|"));
    const v0 = trainVia.get(`${h}|${t}`);
    const r = r0 && utile(h, t, r0.minutes) ? r0 : undefined;
    const v = v0 && utile(h, t, v0.minutes) ? v0 : undefined;
    const g = gareProche.get(t);
    const jusqua = g ? ` jusqu'à ${g}` : "";
    const pre = short ? "train " : "";
    if (r) {
      const d = short ? `train ${fmtDuration(r.minutes)}` : `${fmtDuration(r.minutes)} direct (${r.trains} train${r.trains > 1 ? "s" : ""})`;
      return v && v.changes.length && v.minutes + 15 <= r.minutes ? `${d} ; ${pre}${viaTxt(v)}` : d;
    }
    return v ? `${pre}${viaTxt(v)}${jusqua}` : "";
  };
  const trainMin = (h: string, t: string) => {
    const m = Math.min(train.get([h, t].sort().join("|"))?.minutes ?? Infinity, trainVia.get(`${h}|${t}`)?.minutes ?? Infinity);
    return utile(h, t, m) ? m : Infinity;
  };

  // Carte : villes militantes, territoires visés, liaisons (fiche commune et ciblage).
  type Hub = (typeof hubs)[number];
  type Tgt = (typeof tgt)[number];
  const mapOf = (o: { id: string; title: string; posterTitle: string; kicker?: string; subTarget: (t: Tgt) => string; subHub: (h: Hub) => string; sources: SourceRef[] }): MapSpec => {
  const pts = [...hubs.map((h) => [h.l.lon, h.l.lat]), ...tgt.map((t) => [t.at.lon, t.at.lat])];
  const bb0 = turf.bbox(turf.multiPoint(pts)) as Bbox;
  const bbox = fitAspect(bb0, 0.18);
  let tFeats = (c.depFeatures?.features ?? []).filter((f) => targetCodes.has(String((f.properties as { code?: string }).code)));
  if (!tFeats.length && c.commune.contour && targetCodes.has(c.commune.code)) tFeats = [turf.feature(c.commune.contour as GeoJSON.Polygon, { code: c.commune.code, nom: c.commune.nom })];
  const colorOf = new Map(targets.flatMap((t) => t.codes.map((k) => [k, t.color] as const)));
  const base = o.sources[0] ?? c.depVoisins?.source;
  const map: MapSpec = {
    id: o.id,
    title: o.title,
    theme: "strategie",
    bbox,
    poster: { kicker: o.kicker ?? c.commune.departement.nom, title: o.posterTitle, source: "Source : bilan LFI (villes militantes), OSRM, SNCF. Fonds : IGN." },
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
        data: turf.featureCollection(tgt.map((t) => turf.point([t.at.lon, t.at.lat], { nom: t.nom, sub: o.subTarget(t) }))),
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
        data: turf.featureCollection(hubs.map((h) => turf.point([h.l.lon, h.l.lat], { nom: h.l.nom, sub: o.subHub(h) }))),
        style: { fill: "#4c0297", stroke: "#ffffff", symbol: "diamond", size: 15 },
        labelMode: "callout",
        labelProperty: "nom",
        sublabelProperty: "sub",
        labelColor: "#4c0297",
        legendItem: { label: "Ville avec un groupe d'action actif", swatch: "diamond" },
        visible: true,
        source: base!,
      },
    ],
    note: "Liaisons en pointillé : trajets calculés (voir le tableau).",
  };
  return map;

  };

  // Fiche commune : une ligne par ville militante (voiture, train direct).
  if (opts.fiche) {
    const t = tgt[0];
    const trOf = (h: string) => train.get([h, t.at.code].sort().join("|"));
    const inDep = (code: string) => {
      const d = c.commune.departement.code;
      return code.startsWith(d.length === 3 ? d : d.padStart(2, "0"));
    };
    const rowsF = hubs
      .map((h) => ({ h, car: car.get(`${h.l.code}|${t.at.code}`) ?? null, tr: trOf(h.l.code) }))
      // Le département d'abord, puis les autres ; les plus proches en premier.
      .sort((a, b) => Number(!inDep(a.h.l.code)) - Number(!inDep(b.h.l.code)) || (a.car ?? 999) - (b.car ?? 999));
    const sourcesF = [geoSrc, osrmSrc, gtfsSrc, tcSrc, ...urbanSrc].filter((x): x is SourceRef => !!x);
    const tableF: DataTable = {
      id: "commune_acces",
      title: `Venir à ${t.nom} depuis les villes militantes proches`,
      theme: "strategie",
      columns: [
        { key: "ville", label: "Depuis", wide: true },
        { key: "militants", label: "Militants (bilan LFI)" },
        { key: "voiture", label: "Voiture", align: "right" as const },
        // Colonne masquée quand aucun trajet n'a été trouvé (commune sans gare proche).
        ...(rowsF.some(({ h }) => trainTxt(h.l.code, t.at.code)) ? [{ key: "train", label: gareProche.get(t.at.code) ? `Train (samedi, gare de ${gareProche.get(t.at.code)})` : "Train (samedi)", align: "right" as const }] : []),
        ...(tc.size ? [{ key: "tc", label: "Métro, RER, tram", align: "right" as const }] : []),
      ],
      rows: rowsF.map(({ h, car: v, tr: r }) => ({
        ville: h.l.nom,
        militants: [h.b.ga ? `${fmtNumber(h.b.ga)} groupe${h.b.ga > 1 ? "s" : ""} actif${h.b.ga > 1 ? "s" : ""}` : "", parrainsTxt(h.b.parrains)].filter(Boolean).join(", "),
        voiture: v != null ? fmtDuration(v) : "—",
        train: trainTxt(h.l.code, t.at.code).replace(/ jusqu'à .*$/, "") || "—",
        tc: tc.get(`${h.l.code}|${t.at.code}`) ? `${fmtDuration(tc.get(`${h.l.code}|${t.at.code}`)!.minutes)} (${tc.get(`${h.l.code}|${t.at.code}`)!.ligne})` : "—",
      })),
      sources: sourcesF,
      note: `Villes militantes : communes à moins de ${LOCAL_GA_KM} km avec un groupe d'action actif et ${LOCAL_MIN_PARRAINS} soutiens JLM2027 au moins, et villes de ${HUB_MIN_GA} groupes ou ${HUB_MIN_PARRAINS} soutiens JLM2027 (bilan LFI) à moins de ${HUB_MAX_KM} km (${BIG_HUB_MAX_KM} km pour celles de ${fmtNumber(BIG_HUB_PARRAINS)} soutiens et plus) ; une seule par agglomération (moins de 6 km, hors Île-de-France), les plus proches d'abord, puis la grande ville la plus proche. Voiture : temps sans trafic (OSRM). Train : trajet le plus court un samedi, départ entre 5 h et 14 h (horaires SNCF) ; pour un train direct, nombre de trains directs dans la journée, aller et retour ; avec correspondance, ${RAIL_CHANGE_MIN} min au moins dans une même gare, et changement de gare dans une même ville estimé (15 min plus 4 min par km).${tc.size ? ` Métro, RER, tram : trajet le plus rapide, correspondances comprises, depuis une station à moins de 1,2 km du centre de la ville (horaires Île-de-France Mobilités ou du réseau urbain) ; ${TC_BOARD_MIN} min comptées à chaque montée (attente) et ${TC_TRANSFER_MIN} min à chaque correspondance.` : ""}${gareProche.get(t.at.code) && rowsF.some(({ h }) => trainTxt(h.l.code, t.at.code)) ? ` Pas de gare dans la commune : gare la plus proche, ${gareProche.get(t.at.code)}.` : ""} « — » : pas de trajet trouvé.`,
    };
    const mapF = mapOf({
      id: "commune_acces_carte",
      title: `Villes militantes proches de ${t.nom}`,
      posterTitle: "Venir depuis les villes militantes proches",
      kicker: t.nom,
      subTarget: () => "",
      subHub: (h) => {
        const v = car.get(`${h.l.code}|${t.at.code}`);
        return [v != null ? `${fmtDuration(v)} en voiture` : "", `${fmtNumber(h.b.ga)} groupe${h.b.ga > 1 ? "s" : ""}`].filter(Boolean).join(", ");
      },
      sources: sourcesF,
    });
    const first = rowsF.find((x) => x.car != null);
    const depNom = c.commune.departement.nom;
    const dansDepRows = rowsF.filter((x) => inDep(x.h.l.code));
    const blocksF: Block[] = [
      {
        type: "paragraph",
        text: first
          ? `**Qui peut venir aider** : la ville militante la plus proche est **${first.h.l.nom}**, à ${fmtDuration(first.car!)} en voiture${Number.isFinite(trainMin(first.h.l.code, t.at.code)) ? ` (${fmtDuration(trainMin(first.h.l.code, t.at.code))} en train${first.tr && first.tr.minutes === trainMin(first.h.l.code, t.at.code) ? " direct" : ""})` : tc.get(`${first.h.l.code}|${t.at.code}`) ? ` (${fmtDuration(tc.get(`${first.h.l.code}|${t.at.code}`)!.minutes)} en ${tc.get(`${first.h.l.code}|${t.at.code}`)!.ligne})` : ""}.${rowsF.length > 1 ? " La carte et le tableau donnent les temps de trajet depuis les autres villes où LFI a des militants." : ""}`
          : "**Qui peut venir aider** : villes où LFI a des militants, avec les temps de trajet.",
      },
      // Département d'abord (retour de Menal) : les convois passent par la boucle départementale.
      {
        type: "paragraph",
        text: `**${cap(dansDep(depNom))}** : ${dansDepRows.length ? `${joinList(dansDepRows.slice(0, 5).map((x) => `${x.h.l.nom}${x.car != null ? ` (${fmtDuration(x.car)})` : ""}`))} ; ` : "pas de ville militante proche dans le département ; "}le convoi s'organise avec la boucle départementale ${deDep(depNom)}.`,
      },
      { type: "map", mapId: mapF.id },
      { type: "table", tableId: tableF.id },
    ];
    return { tables: [tableF], maps: [mapF], blocks: blocksF };
  }

  // 5. Tableau : une ligne par territoire, une colonne par ville militante.
  const cell = (h: string, t: string) => {
    const v = car.get(`${h}|${t}`);
    const m = tc.get(`${h}|${t}`);
    return [v != null ? fmtDuration(v) : "", trainTxt(h, t, true), m ? `${m.ligne} ${fmtDuration(m.minutes)}` : ""].filter(Boolean).join(" ; ") || "—";
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
  const sources = [geoSrc, osrmSrc, gtfsSrc, tcSrc, ...urbanSrc].filter((s): s is SourceRef => !!s);
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
    note: `Villes militantes : communes à moins de ${LOCAL_GA_KM} km avec un groupe d'action actif et ${LOCAL_MIN_PARRAINS} soutiens JLM2027 au moins, et villes de ${HUB_MIN_GA} groupes ou ${HUB_MIN_PARRAINS} soutiens JLM2027 (bilan LFI) à moins de ${HUB_MAX_KM} km (${BIG_HUB_MAX_KM} km pour celles de ${fmtNumber(BIG_HUB_PARRAINS)} soutiens et plus) ; ${hubs.length} retenues, une par agglomération (moins de 6 km, hors Île-de-France) : les plus proches, puis la grande ville la plus proche. Voiture : temps sans trafic (OSRM). Train : trajet le plus court un samedi, départ entre 5 h et 14 h (horaires SNCF), direct ou avec correspondance (${RAIL_CHANGE_MIN} min au moins dans une même gare).${tc.size ? ` Métro, RER, tram : correspondances comprises, ${TC_BOARD_MIN} min comptées à chaque montée et ${TC_TRANSFER_MIN} min à chaque correspondance.` : ""} « — » : pas de calcul possible.`,
  };

  const map = mapOf({
    id: "ciblage_acces_carte",
    title: "Villes militantes proches et territoires proposés",
    posterTitle: "Rejoindre les territoires proposés",
    subTarget: (t) => (moy(t.at.code) != null ? `${fmtDuration(moy(t.at.code)!)} en moyenne` : ""),
    subHub: (h) => [h.b.ga ? `${fmtNumber(h.b.ga)} groupe${h.b.ga > 1 ? "s" : ""}` : "", parrainsTxt(h.b.parrains)].filter(Boolean).join(", "),
    sources,
  });

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
