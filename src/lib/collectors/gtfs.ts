import type { TrackedHttp } from "./context";
import { splitCsvLine, zipLines } from "./zip";
import { cachedExtract, heavyLane } from "../runtime";

/**
 * Horaires théoriques SNCF (TER, Intercités, TGV) au format GTFS, publiés par
 * SNCF sur data.gouv.fr (jeu « horaires-sncf »). Pour chaque gare de la
 * commune : nombre de départs un jour de semaine type, répartition horaire
 * (heures de pointe réelles) et temps de trajet direct vers Paris.
 *
 * Le fichier national est lu en flux, en plusieurs passes ; seules les lignes
 * concernant les gares étudiées et les gares parisiennes sont conservées.
 */

export const GTFS_URL = process.env.SNCF_GTFS_URL ?? "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip";

export interface StationTimetable {
  nom: string;
  /** Date de référence (AAAAMMJJ), un mardi. */
  date: string;
  departs: number;
  /** Départs par heure (0 à 23). */
  parHeure: number[];
  /** Plage de deux heures consécutives la plus chargée (ex. [17, 19]). */
  pointe: [number, number] | null;
  paris: { directs: number; minMinutes: number; medianMinutes: number } | null;
}

interface StationInput {
  nom: string;
  uic: string;
  lon: number | null;
  lat: number | null;
}

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

function parseHeader(line: string) {
  const cols = splitCsvLine(line, ",").map((c) => c.trim());
  return (name: string) => cols.indexOf(name);
}

/** Lit un fichier du GTFS ligne à ligne (en-tête puis rappel par ligne découpée). */
async function eachRow(file: string, entry: string, fn: (v: string[], col: (n: string) => number) => void, prefilter?: (line: string) => boolean) {
  let col: ((n: string) => number) | null = null;
  await zipLines(
    file,
    (n) => n.replace(/^.*\//, "") === entry,
    (_e, line, i) => {
      if (i === 0) {
        col = parseHeader(line);
        return;
      }
      if (prefilter && !prefilter(line)) return;
      fn(splitCsvLine(line, ","), col!);
    },
  );
}

const ymd = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

type Timetables = { stations: StationTimetable[]; url: string; retrievedAt: string };

/** Horaires des gares : 24 h sur disque (le GTFS national change chaque semaine). */
export function collectTimetables(http: TrackedHttp, stations: StationInput[], now = new Date()): Promise<Timetables> {
  const key = `gtfs|${now.toISOString().slice(0, 10)}|${stations.map((s) => JSON.stringify(s)).join("|")}`;
  return cachedExtract(key.length > 160 ? `gtfs|${now.toISOString().slice(0, 10)}|${hash(key)}` : key, 24, () => heavyLane.run(() => collectTimetablesFresh(http, stations, now)));
}

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

async function collectTimetablesFresh(http: TrackedHttp, stations: StationInput[], now: Date): Promise<Timetables> {
  if (!stations.length) return { stations: [], url: GTFS_URL, retrievedAt: new Date().toISOString() };
  const f = await http.file(GTFS_URL, { timeoutMs: 1800000, retries: 1 });
  const file = f.data;

  // 1. Arrêts : quais des gares étudiées (par code UIC, sinon à moins de 400 m) et gares parisiennes.
  const stationOf = new Map<string, number>();
  const paris = new Set<string>();
  const areas: { id: string; name: string; lon: number; lat: number }[] = [];
  const points: { id: string; parent: string; name: string }[] = [];
  await eachRow(file, "stops.txt", (v, col) => {
    const id = v[col("stop_id")];
    const name = v[col("stop_name")] ?? "";
    const parent = v[col("parent_station")] ?? "";
    const lt = Number(v[col("location_type")] ?? "0");
    if (lt === 1) areas.push({ id, name, lon: Number(v[col("stop_lon")]), lat: Number(v[col("stop_lat")]) });
    else points.push({ id, parent, name });
  });
  const near = (a: { lon: number; lat: number }, s: StationInput) => s.lon != null && s.lat != null && Math.hypot((a.lon - s.lon) * Math.cos((s.lat * Math.PI) / 180), a.lat - s.lat) * 111 < 0.4;
  stations.forEach((s, i) => {
    const uic = s.uic.replace(/\D/g, "").slice(0, 8);
    for (const a of areas) if ((uic.length >= 7 && a.id.includes(uic)) || near(a, s)) for (const p of points) if (p.parent === a.id) stationOf.set(p.id, i);
  });
  const parisAreas = new Set(areas.filter((a) => /^Paris[ -]/i.test(a.name)).map((a) => a.id));
  for (const p of points) if (parisAreas.has(p.parent) || /^Paris[ -]/i.test(p.name)) paris.add(p.id);
  if (!stationOf.size) throw new Error("Gares absentes des horaires SNCF (GTFS)");

  // 2. Jour de référence : le mardi le plus desservi des huit prochaines semaines.
  const tuesdays = new Set<string>();
  for (let k = 0; k < 60; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + k));
    if (d.getUTCDay() === 2) tuesdays.add(ymd(d));
  }
  const perDate = new Map<string, number>();
  await eachRow(file, "calendar_dates.txt", (v, col) => {
    const d = v[col("date")];
    if (tuesdays.has(d) && v[col("exception_type")] === "1") perDate.set(d, (perDate.get(d) ?? 0) + 1);
  });
  const date = [...perDate].sort((a, b) => b[1] - a[1])[0]?.[0] ?? [...tuesdays][0];
  const services = new Set<string>();
  await eachRow(file, "calendar_dates.txt", (v, col) => {
    if (v[col("date")] === date && v[col("exception_type")] === "1") services.add(v[col("service_id")]);
  });
  // Certains GTFS décrivent les services par calendar.txt (jours de semaine + période).
  try {
    await eachRow(file, "calendar.txt", (v, col) => {
      if (v[col("tuesday")] === "1" && v[col("start_date")] <= date && v[col("end_date")] >= date) services.add(v[col("service_id")]);
    });
  } catch {
    /* fichier absent */
  }

  // 3. Courses actives ce jour-là.
  const trips = new Set<string>();
  await eachRow(file, "trips.txt", (v, col) => {
    if (services.has(v[col("service_id")])) trips.add(v[col("trip_id")]);
  });

  // 4. Passages aux gares étudiées et à Paris.
  const byTrip = new Map<string, { st: number[]; times: Map<number, number>; paris: number[] }>();
  const watched = new Set([...stationOf.keys(), ...paris]);
  await eachRow(
    file,
    "stop_times.txt",
    (v, col) => {
      const stop = v[col("stop_id")];
      if (!watched.has(stop)) return;
      const trip = v[col("trip_id")];
      if (!trips.has(trip)) return;
      const t = toMin(v[col("departure_time")] || v[col("arrival_time")]);
      if (!byTrip.has(trip)) byTrip.set(trip, { st: [], times: new Map(), paris: [] });
      const e = byTrip.get(trip)!;
      const si = stationOf.get(stop);
      if (si != null) {
        e.st.push(si);
        e.times.set(si, t);
      }
      if (paris.has(stop)) e.paris.push(t);
    },
  );

  const out: StationTimetable[] = stations.map((s) => ({ nom: s.nom, date, departs: 0, parHeure: Array(24).fill(0), pointe: null, paris: null }));
  const durations: number[][] = stations.map(() => []);
  for (const e of byTrip.values()) {
    for (const si of new Set(e.st)) {
      const t = e.times.get(si)!;
      out[si].departs++;
      out[si].parHeure[Math.floor(t / 60) % 24]++;
      if (e.paris.length) durations[si].push(Math.min(...e.paris.map((p) => Math.abs(p - t))));
    }
  }
  out.forEach((o, i) => {
    let best = -1;
    for (let h = 5; h < 23; h++) {
      const n = o.parHeure[h] + o.parHeure[h + 1];
      if (best < 0 || n > o.parHeure[best] + o.parHeure[best + 1]) best = h;
    }
    o.pointe = best >= 0 && o.parHeure[best] + o.parHeure[best + 1] > 0 ? [best, best + 2] : null;
    const d = durations[i].filter((x) => x > 0).sort((a, b) => a - b);
    // Courses directes dans un sens ou dans l'autre (aller-retour comptés séparément).
    if (d.length) o.paris = { directs: d.length, minMinutes: d[0], medianMinutes: d[Math.floor(d.length / 2)] };
  });
  return { stations: out, url: GTFS_URL, retrievedAt: f.retrievedAt };
}

/* --------------------------------------------- trains entre villes (samedi) */

export interface TrainGroup {
  /** Identifiant du lieu (code INSEE). */
  key: string;
  stations: StationInput[];
}

export interface DirectTrains {
  /** Trajet direct le plus court (minutes) et nombre de trains directs, par paire « a|b » (a < b). */
  pairs: Record<string, { minutes: number; trains: number }>;
  date: string;
  url: string;
  retrievedAt: string;
}

/** Horaires SNCF d'un samedi : gares (zones d'arrêt) et courses (gares, arrivées, départs en minutes). */
export interface RailIndex {
  stations: { id: string; nom: string; lon: number; lat: number }[];
  trips: { s: number[]; a: number[]; d: number[] }[];
  date: string;
  url: string;
  retrievedAt: string;
}

/**
 * Toutes les courses SNCF (TGV, Intercités, TER, cars TER) d'un samedi de référence : le plus desservi
 * des huit prochaines semaines (les convois ont lieu le week-end). 24 h sur disque.
 */
export function collectRailIndex(http: TrackedHttp, now = new Date()): Promise<RailIndex> {
  return cachedExtract(`sncfidx|${now.toISOString().slice(0, 10)}`, 24, () => heavyLane.run(() => collectRailIndexFresh(http, now)));
}

async function collectRailIndexFresh(http: TrackedHttp, now: Date): Promise<RailIndex> {
  const f = await http.file(GTFS_URL, { timeoutMs: 1800000, retries: 1 });
  const file = f.data;
  const areas = new Map<string, number>();
  const stations: RailIndex["stations"] = [];
  const points: { id: string; parent: string; nom: string; lon: number; lat: number }[] = [];
  await eachRow(file, "stops.txt", (v, col) => {
    const id = v[col("stop_id")];
    const nom = v[col("stop_name")] ?? "";
    const lon = Number(v[col("stop_lon")]);
    const lat = Number(v[col("stop_lat")]);
    if (Number(v[col("location_type")] ?? "0") === 1) {
      areas.set(id, stations.length);
      stations.push({ id, nom, lon, lat });
    } else points.push({ id, parent: v[col("parent_station")] ?? "", nom, lon, lat });
  });
  const stationOf = new Map<string, number>();
  for (const p of points) {
    let i = areas.get(p.parent);
    if (i == null) {
      i = stations.length;
      stations.push({ id: p.id, nom: p.nom, lon: p.lon, lat: p.lat });
    }
    stationOf.set(p.id, i);
  }
  const saturdays = new Set<string>();
  for (let k = 0; k < 60; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + k));
    if (d.getUTCDay() === 6) saturdays.add(ymd(d));
  }
  const perDate = new Map<string, number>();
  await eachRow(file, "calendar_dates.txt", (v, col) => {
    const d = v[col("date")];
    if (saturdays.has(d) && v[col("exception_type")] === "1") perDate.set(d, (perDate.get(d) ?? 0) + 1);
  });
  const date = [...perDate].sort((a, b) => b[1] - a[1])[0]?.[0] ?? [...saturdays][0];
  const services = new Set<string>();
  const removed = new Set<string>();
  await eachRow(file, "calendar_dates.txt", (v, col) => {
    if (v[col("date")] !== date) return;
    if (v[col("exception_type")] === "1") services.add(v[col("service_id")]);
    else removed.add(v[col("service_id")]);
  });
  try {
    await eachRow(file, "calendar.txt", (v, col) => {
      const id = v[col("service_id")];
      if (v[col("saturday")] === "1" && v[col("start_date")] <= date && v[col("end_date")] >= date && !removed.has(id)) services.add(id);
    });
  } catch {
    /* fichier absent */
  }
  const active = new Set<string>();
  await eachRow(file, "trips.txt", (v, col) => {
    if (services.has(v[col("service_id")])) active.add(v[col("trip_id")]);
  });
  const seq = new Map<string, { q: number; s: number; a: number; d: number }[]>();
  await eachRow(file, "stop_times.txt", (v, col) => {
    const trip = v[col("trip_id")];
    if (!active.has(trip)) return;
    const s = stationOf.get(v[col("stop_id")]);
    if (s == null) return;
    const a = toMin(v[col("arrival_time")] || v[col("departure_time")]);
    const d = toMin(v[col("departure_time")] || v[col("arrival_time")]);
    if (!seq.has(trip)) seq.set(trip, []);
    seq.get(trip)!.push({ q: Number(v[col("stop_sequence")]), s, a, d });
  });
  const trips: RailIndex["trips"] = [];
  for (const xs of seq.values()) {
    if (xs.length < 2) continue;
    xs.sort((x, y) => x.q - y.q);
    trips.push({ s: xs.map((x) => x.s), a: xs.map((x) => x.a), d: xs.map((x) => x.d) });
  }
  if (!trips.length) throw new Error("Aucun train ce samedi dans les horaires SNCF (GTFS)");
  // Index compact : seules les gares desservies ce jour-là.
  const used = new Map<number, number>();
  const out: RailIndex["stations"] = [];
  for (const t of trips)
    t.s = t.s.map((i) => {
      if (!used.has(i)) {
        used.set(i, out.length);
        const st = stations[i];
        out.push({ id: st.id, nom: st.nom.replace(/^Gare de /, ""), lon: Math.round(st.lon * 1e5) / 1e5, lat: Math.round(st.lat * 1e5) / 1e5 });
      }
      return used.get(i)!;
    });
  return { stations: out, trips, date, url: GTFS_URL, retrievedAt: f.retrievedAt };
}

/** Gares de l'index correspondant à des gares SNCF (code UIC, sinon à moins de 400 m). */
export function railStations(index: RailIndex, stations: StationInput[]): Set<number> {
  const out = new Set<number>();
  for (const s of stations) {
    const uic = s.uic.replace(/\D/g, "").slice(0, 8);
    index.stations.forEach((a, i) => {
      if ((uic.length >= 7 && a.id.includes(uic)) || (s.lon != null && s.lat != null && Math.hypot((a.lon - s.lon) * Math.cos((s.lat * Math.PI) / 180), a.lat - s.lat) * 111 < 0.4)) out.add(i);
    });
  }
  return out;
}

/** Trains directs (sans correspondance) entre des villes, un samedi : durée la plus courte et nombre de trains par paire. */
export async function collectDirectTrains(http: TrackedHttp, groups: TrainGroup[], now = new Date()): Promise<DirectTrains & { index: RailIndex }> {
  const index = await collectRailIndex(http, now);
  return { ...directTrains(index, groups), index };
}

export function directTrains(index: RailIndex, groups: TrainGroup[]): DirectTrains {
  const groupOf = new Map<number, number>();
  groups.forEach((g, gi) => {
    for (const i of railStations(index, g.stations)) groupOf.set(i, gi);
  });
  if (!groupOf.size) throw new Error("Gares absentes des horaires SNCF (GTFS)");
  const pairs: DirectTrains["pairs"] = {};
  for (const t of index.trips) {
    const m = new Map<number, number>();
    t.s.forEach((s, k) => {
      const gi = groupOf.get(s);
      if (gi != null && !m.has(gi)) m.set(gi, t.d[k]);
    });
    const gs = [...m.keys()];
    for (let i = 0; i < gs.length; i++)
      for (let j = i + 1; j < gs.length; j++) {
        const [a, b] = [groups[gs[i]].key, groups[gs[j]].key].sort();
        const d = Math.abs(m.get(gs[i])! - m.get(gs[j])!);
        if (d <= 0) continue;
        const p = (pairs[`${a}|${b}`] ??= { minutes: d, trains: 0 });
        p.minutes = Math.min(p.minutes, d);
        p.trains++;
      }
  }
  return { pairs, date: index.date, url: index.url, retrievedAt: index.retrievedAt };
}

/* Trains avec correspondance (algorithme « connection scan »). */

/** Temps minimal de correspondance dans une même gare (minutes). */
export const RAIL_CHANGE_MIN = 8;
/**
 * Changement de gare dans une même ville (Paris Gare de Lyon → Paris Montparnasse, Lille Flandres →
 * Lille Europe) : 15 min plus 4 min par km. À pied jusqu'à 500 m.
 */
const cityTransfer = (km: number) => (km <= 0.5 ? Math.round((km * 1000) / 80) + 3 : Math.round(15 + 4 * km));

interface RailGraph {
  from: Int32Array;
  to: Int32Array;
  dep: Int32Array;
  arr: Int32Array;
  trip: Int32Array;
  transfers: { to: number; m: number }[][];
}
const railGraphs = new WeakMap<RailIndex, RailGraph>();

function railGraph(index: RailIndex): RailGraph {
  const g0 = railGraphs.get(index);
  if (g0) return g0;
  const cs: [number, number, number, number, number][] = [];
  index.trips.forEach((t, ti) => {
    for (let k = 0; k + 1 < t.s.length; k++) if (t.s[k] !== t.s[k + 1]) cs.push([t.s[k], t.s[k + 1], t.d[k], Math.max(t.d[k], t.a[k + 1]), ti]);
  });
  cs.sort((x, y) => x[2] - y[2] || x[3] - y[3]);
  const n = cs.length;
  const g: RailGraph = { from: new Int32Array(n), to: new Int32Array(n), dep: new Int32Array(n), arr: new Int32Array(n), trip: new Int32Array(n), transfers: index.stations.map(() => []) };
  cs.forEach((c, i) => {
    g.from[i] = c[0];
    g.to[i] = c[1];
    g.dep[i] = c[2];
    g.arr[i] = c[3];
    g.trip[i] = c[4];
  });
  // Gares d'une même ville : même premier mot (« Paris », « Lille », « Lyon »), à moins de 7 km ; ou à moins de 500 m.
  const city = (nom: string) => nom.toLowerCase().split(/[\s-]+/)[0];
  const cell = 0.1;
  const grid = new Map<string, number[]>();
  index.stations.forEach((s, i) => {
    const k = `${Math.floor(s.lon / cell)}|${Math.floor(s.lat / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  index.stations.forEach((s, i) => {
    const gx = Math.floor(s.lon / cell);
    const gy = Math.floor(s.lat / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${gx + dx}|${gy + dy}`) ?? []) {
          if (j === i) continue;
          const t = index.stations[j];
          const km = Math.hypot((t.lon - s.lon) * Math.cos((s.lat * Math.PI) / 180), t.lat - s.lat) * 111;
          if (km <= 0.5 || (km <= 7 && city(s.nom).length >= 4 && city(s.nom) === city(t.nom))) g.transfers[i].push({ to: j, m: cityTransfer(km) });
        }
  });
  railGraphs.set(index, g);
  return g;
}

export interface RailRoute {
  /** Durée du trajet, du départ du premier train à l'arrivée. */
  minutes: number;
  /** Heure de départ (minutes depuis minuit). */
  depart: number;
  /** Gares de correspondance, dans l'ordre (« Lyon Part-Dieu », « Paris Gare de Lyon → Paris Montparnasse »). */
  changes: string[];
}

/**
 * Trajet en train le plus court un samedi, correspondances comprises (3 au plus), entre deux ensembles
 * de gares, en partant entre `from` et `until` (par défaut 5 h – 14 h : arrivée pour la journée).
 */
export function routeRail(index: RailIndex, origins: Set<number>, targets: Set<number>, o: { earliest?: number; latest?: number; maxMinutes?: number } = {}): RailRoute | null {
  if (!origins.size || !targets.size) return null;
  const g = railGraph(index);
  const NS = index.stations.length;
  const NT = index.trips.length;
  const earliest = o.earliest ?? 5 * 60;
  const latest = o.latest ?? 14 * 60;
  const departs = [...new Set(Array.from(g.dep).filter((d, i) => origins.has(g.from[i]) && d >= earliest && d <= latest))].sort((a, b) => a - b);
  const ready = new Float64Array(NS);
  const arr = new Float64Array(NS);
  const readyFrom = new Int32Array(NS);
  const reachedBy = new Int32Array(NS);
  const tripBoard = new Int32Array(NT);
  let best: RailRoute | null = null;
  let bound = o.maxMinutes ?? 240;
  for (const tau of departs) {
    ready.fill(Infinity);
    arr.fill(Infinity);
    readyFrom.fill(-1);
    reachedBy.fill(-1);
    tripBoard.fill(-1);
    for (const s of origins) {
      ready[s] = tau;
      arr[s] = tau;
      readyFrom[s] = -2;
    }
    // Premier départ à cette heure.
    let lo = 0;
    let hi = g.dep.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (g.dep[mid] < tau) lo = mid + 1;
      else hi = mid;
    }
    for (let c = lo; c < g.dep.length && g.dep[c] < tau + bound; c++) {
      const t = g.trip[c];
      const f = g.from[c];
      if (tripBoard[t] < 0) {
        if (ready[f] > g.dep[c]) continue;
        tripBoard[t] = f;
      }
      const to = g.to[c];
      const a = g.arr[c];
      if (a >= arr[to]) continue;
      arr[to] = a;
      reachedBy[to] = t;
      if (a + RAIL_CHANGE_MIN < ready[to]) {
        ready[to] = a + RAIL_CHANGE_MIN;
        readyFrom[to] = to;
      }
      for (const w of g.transfers[to])
        if (a + w.m < ready[w.to]) {
          ready[w.to] = a + w.m;
          readyFrom[w.to] = to;
        }
      if (targets.has(to) && a - tau < bound) {
        // Reconstitution : trains successifs, gares de correspondance.
        const changes: string[] = [];
        let e = to;
        let ok = true;
        for (let k = 0; k < 6; k++) {
          const b = tripBoard[reachedBy[e]];
          const prev = readyFrom[b];
          if (prev === -2) break;
          if (prev < 0) {
            ok = false;
            break;
          }
          changes.unshift(prev === b ? index.stations[b].nom : `${index.stations[prev].nom} → ${index.stations[b].nom}`);
          e = prev;
          if (k === 5) ok = false;
        }
        if (ok && changes.length <= 3) {
          bound = a - tau;
          best = { minutes: a - tau, depart: tau, changes };
        }
      }
    }
  }
  return best;
}

/* ------------------------------------------- métro, RER, tram (Île-de-France) */

export const IDFM_GTFS_URL = process.env.IDFM_GTFS_URL ?? "https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip";

export interface TcStation {
  nom: string;
  lon: number;
  lat: number;
}
export interface TcPattern {
  /** « RER B », « métro 9 », « tram T3 », « Transilien P ». */
  ligne: string;
  /** Index des gares (dans `stations`) dans l'ordre de passage, avec l'heure (minutes depuis minuit). */
  stops: number[];
  t: number[];
}
export interface TcIndex {
  stations: TcStation[];
  patterns: TcPattern[];
  url: string;
  retrievedAt: string;
}

/**
 * Lignes de métro, de RER, de train et de tram d'Île-de-France (horaires IDFM) : pour chaque ligne et
 * chaque sens, les différentes dessertes (branches) avec les temps de parcours entre gares. Le fichier
 * (≈ 150 Mo, bus compris) est lu une fois par jour ; seul cet index compact est gardé.
 */
export function collectIdfmIndex(http: TrackedHttp, now = new Date()): Promise<TcIndex> {
  return cachedExtract(`idfmtc2|${now.toISOString().slice(0, 10)}`, 24, () => heavyLane.run(() => collectTcIndexFresh(http, IDFM_GTFS_URL, true)));
}

/** Réseau urbain hors Île-de-France (métro, tram, funiculaire), à partir de son GTFS. 24 h sur disque. */
export function collectUrbanIndex(http: TrackedHttp, url: string, now = new Date()): Promise<TcIndex> {
  return cachedExtract(`urbtc|${now.toISOString().slice(0, 10)}|${hash(url)}`, 24, () => heavyLane.run(() => collectTcIndexFresh(http, url, false)));
}

/** Type de ligne GTFS (types de base et types étendus). */
const kindOf = (t: number) => (t === 0 || (t >= 900 && t < 1000) ? "tram" : t === 1 || (t >= 400 && t < 500) ? "metro" : t === 2 || (t >= 100 && t < 200) ? "train" : t === 5 || t === 7 || t === 12 || t === 1400 ? "funi" : null);

async function collectTcIndexFresh(http: TrackedHttp, url: string, idf: boolean): Promise<TcIndex> {
  const f = await http.file(url, { timeoutMs: 1800000, retries: 1, ...(idf ? {} : { ttlHours: 24 * 7 }) });
  const file = f.data;
  // 1. Lignes ferrées, de métro et de tram.
  const routes = new Map<string, string>();
  await eachRow(file, "routes.txt", (v, col) => {
    const kind = kindOf(Number(v[col("route_type")]));
    if (!kind) return;
    const short = (v[col("route_short_name")] ?? "").trim();
    const long = (v[col("route_long_name")] ?? "").trim();
    const name = short || long;
    const ligne = idf
      ? kind === "metro"
        ? `métro ${name}`
        : kind === "tram"
          ? `tram ${name.replace(/^T?/, "T")}`
          : /^[A-E]$/.test(name)
            ? `RER ${name}`
            : /^[HJKLNPRUV]$/.test(name)
              ? `Transilien ${name}`
              : `train ${name}`
      : kind === "metro"
        ? `métro ${name}`
        : kind === "tram"
          ? `tram ${name}`
          : kind === "funi"
            ? `funiculaire ${name}`
            : `train ${name}`;
    routes.set(v[col("route_id")], ligne);
  });
  if (!routes.size) throw new Error("Aucune ligne de métro ou de tram dans ces horaires");
  // 2. Courses de ces lignes : 40 au plus par ligne et par sens (assez pour voir toutes les branches).
  const perKey = new Map<string, number>();
  const tripRoute = new Map<string, string>();
  await eachRow(file, "trips.txt", (v, col) => {
    const r = v[col("route_id")];
    if (!routes.has(r)) return;
    const k = `${r}|${v[col("direction_id")] ?? ""}`;
    const n = perKey.get(k) ?? 0;
    if (n >= 40) return;
    perKey.set(k, n + 1);
    tripRoute.set(v[col("trip_id")], r);
  });
  // 3. Passages de ces courses.
  const seq = new Map<string, { s: number; stop: string; t: number }[]>();
  await eachRow(file, "stop_times.txt", (v, col) => {
    const trip = v[col("trip_id")];
    if (!tripRoute.has(trip)) return;
    const t = toMin(v[col("departure_time")] || v[col("arrival_time")]);
    if (!seq.has(trip)) seq.set(trip, []);
    seq.get(trip)!.push({ s: Number(v[col("stop_sequence")]), stop: v[col("stop_id")], t });
  });
  // 4. Gares : quais regroupés sous leur gare (parent_station).
  const used = new Set<string>();
  for (const xs of seq.values()) for (const x of xs) used.add(x.stop);
  const parentOf = new Map<string, string>();
  const info = new Map<string, TcStation>();
  await eachRow(file, "stops.txt", (v, col) => {
    const id = v[col("stop_id")];
    const parent = v[col("parent_station")] ?? "";
    const st = { nom: v[col("stop_name")] ?? "", lon: Number(v[col("stop_lon")]), lat: Number(v[col("stop_lat")]) };
    info.set(id, st);
    if (used.has(id)) parentOf.set(id, parent || id);
  });
  const stations: TcStation[] = [];
  const idx = new Map<string, number>();
  const stationIdx = (stop: string) => {
    const p = parentOf.get(stop) ?? stop;
    if (!idx.has(p)) {
      const st = info.get(p) ?? info.get(stop);
      if (!st || !Number.isFinite(st.lon)) return -1;
      idx.set(p, stations.length);
      stations.push({ nom: st.nom, lon: Math.round(st.lon * 1e5) / 1e5, lat: Math.round(st.lat * 1e5) / 1e5 });
    }
    return idx.get(p)!;
  };
  // 5. Dessertes distinctes (même ligne, même suite de gares) : une seule gardée.
  const seen = new Set<string>();
  const patterns: TcPattern[] = [];
  for (const [trip, xs] of seq) {
    xs.sort((a, b) => a.s - b.s);
    const stops = xs.map((x) => stationIdx(x.stop));
    if (stops.some((s) => s < 0) || stops.length < 2) continue;
    const ligne = routes.get(tripRoute.get(trip)!)!;
    const sig = `${ligne}|${stops.join(",")}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    patterns.push({ ligne, stops, t: xs.map((x) => x.t) });
  }
  if (!patterns.length) throw new Error("Aucune ligne de métro, RER ou tram dans ces horaires");
  return { stations, patterns, url, retrievedAt: f.retrievedAt };
}

/**
 * Trajet direct le plus court (sans correspondance) entre deux ensembles de gares, et la ligne.
 */
export function directTc(index: TcIndex, from: Set<number>, to: Set<number>): { minutes: number; ligne: string } | null {
  let best: { minutes: number; ligne: string } | null = null;
  for (const p of index.patterns) {
    let ia = -1;
    for (let i = 0; i < p.stops.length; i++) {
      if (from.has(p.stops[i])) ia = i;
      else if (ia >= 0 && to.has(p.stops[i])) {
        const m = p.t[i] - p.t[ia];
        if (m > 0 && (!best || m < best.minutes)) best = { minutes: m, ligne: p.ligne };
      }
    }
    // Sens inverse dans la même desserte (lignes décrites dans un seul sens).
    ia = -1;
    for (let i = 0; i < p.stops.length; i++) {
      if (to.has(p.stops[i])) ia = i;
      else if (ia >= 0 && from.has(p.stops[i])) {
        const m = p.t[i] - p.t[ia];
        if (m > 0 && (!best || m < best.minutes)) best = { minutes: m, ligne: p.ligne };
      }
    }
  }
  return best;
}

/* Itinéraire avec correspondances (métro, RER, train, tram). */

/** Minutes ajoutées à chaque montée dans une rame (attente moyenne, correspondance). */
export const TC_BOARD_MIN = 5;
/** Minutes ajoutées à chaque correspondance (descente avant la destination) : couloirs, quais. */
export const TC_TRANSFER_MIN = 3;
/** Correspondance à pied entre deux gares proches (≤ 300 m) : 80 m par minute. */
const WALK_MAX_M = 300;

interface TcGraph {
  lignes: string[];
  /** Arcs en rame : état (gare, ligne) → état suivant, durée minimale observée. */
  ride: Map<number, { to: number; m: number }[]>;
  /** Lignes desservant chaque gare. */
  linesAt: number[][];
  /** Correspondances à pied entre gares proches. */
  walk: { to: number; m: number }[][];
}

const graphs = new WeakMap<TcIndex, TcGraph>();

function tcGraph(index: TcIndex): TcGraph {
  const cached = graphs.get(index);
  if (cached) return cached;
  const lignes: string[] = [];
  const lid = new Map<string, number>();
  const L = (l: string) => {
    if (!lid.has(l)) lid.set(l, lignes.push(l) - 1);
    return lid.get(l)!;
  };
  for (const p of index.patterns) L(p.ligne);
  const NL = lignes.length;
  const key = (s: number, l: number) => s * NL + l;
  const best = new Map<string, number>();
  const linesAt: Set<number>[] = index.stations.map(() => new Set());
  for (const p of index.patterns) {
    const l = L(p.ligne);
    for (let i = 0; i + 1 < p.stops.length; i++) {
      const a = p.stops[i];
      const b = p.stops[i + 1];
      if (a === b) continue;
      const m = Math.max(1, p.t[i + 1] - p.t[i]);
      linesAt[a].add(l);
      linesAt[b].add(l);
      // Les deux sens (certaines lignes ne sont décrites que dans un sens dans l'échantillon).
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        const k = `${key(x, l)}>${key(y, l)}`;
        if (!best.has(k) || m < best.get(k)!) best.set(k, m);
      }
    }
  }
  const ride = new Map<number, { to: number; m: number }[]>();
  for (const [k, m] of best) {
    const [a, b] = k.split(">").map(Number);
    if (!ride.has(a)) ride.set(a, []);
    ride.get(a)!.push({ to: b, m });
  }
  // Gares proches (grille de ~300 m).
  const walk: { to: number; m: number }[][] = index.stations.map(() => []);
  const cell = 0.004;
  const grid = new Map<string, number[]>();
  index.stations.forEach((s, i) => {
    const g = `${Math.floor(s.lon / cell)}|${Math.floor(s.lat / cell)}`;
    if (!grid.has(g)) grid.set(g, []);
    grid.get(g)!.push(i);
  });
  index.stations.forEach((s, i) => {
    const gx = Math.floor(s.lon / cell);
    const gy = Math.floor(s.lat / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${gx + dx}|${gy + dy}`) ?? []) {
          if (j === i) continue;
          const t = index.stations[j];
          const d = Math.hypot((t.lon - s.lon) * Math.cos((s.lat * Math.PI) / 180), t.lat - s.lat) * 111000;
          if (d <= WALK_MAX_M) walk[i].push({ to: j, m: Math.round(d / 80) + 1 });
        }
  });
  const g = { lignes, ride, linesAt: linesAt.map((x) => [...x]), walk };
  graphs.set(index, g);
  return g;
}

/**
 * Trajet le plus rapide entre deux ensembles de gares, correspondances comprises (Dijkstra) :
 * temps en rame, + 5 min à chaque montée (attente, correspondance), marche entre gares proches.
 */
export function routeTc(index: TcIndex, from: Set<number>, to: Set<number>): { minutes: number; lignes: string[] } | null {
  const g = tcGraph(index);
  const NL = g.lignes.length;
  const NS = index.stations.length;
  // États : gare à quai (sans ligne) = s ; dans une rame de la ligne l = NS + s * NL + l.
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const heap: [number, number][] = [];
  const push = (st: number, d: number, p: number | null) => {
    if (dist.has(st) && dist.get(st)! <= d) return;
    dist.set(st, d);
    if (p != null) prev.set(st, p);
    heap.push([d, st]);
    let i = heap.length - 1;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (heap[q][0] <= heap[i][0]) break;
      [heap[q], heap[i]] = [heap[i], heap[q]];
      i = q;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const s of from) push(s, 0, null);
  let end: number | null = null;
  while (heap.length) {
    const [d, st] = pop();
    if (d > (dist.get(st) ?? Infinity)) continue;
    if (st < NS) {
      if (to.has(st)) {
        end = st;
        break;
      }
      for (const l of g.linesAt[st]) push(NS + st * NL + l, d + TC_BOARD_MIN, st);
      for (const w of g.walk[st]) push(w.to, d + w.m, st);
    } else {
      const s = Math.floor((st - NS) / NL);
      push(s, d + (to.has(s) ? 0 : TC_TRANSFER_MIN), st); // descendre (correspondance : couloirs, quais)
      for (const e of g.ride.get(st - NS) ?? []) push(NS + e.to, d + e.m, st);
    }
  }
  if (end == null) return null;
  const lignes: string[] = [];
  for (let st: number | undefined = end; st != null; st = prev.get(st)) {
    if (st >= NS) {
      const l = g.lignes[(st - NS) % NL];
      if (lignes[0] !== l) lignes.unshift(l);
    }
  }
  return { minutes: dist.get(end)!, lignes };
}

/* ------------------------------------------- réseaux urbains hors Île-de-France */

export const TRANSPORT_API = process.env.TRANSPORT_API_URL ?? "https://transport.data.gouv.fr/api/datasets";

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Jeux agrégés (régionaux, nationaux, cars) : trop gros, et sans intérêt pour le métro ou le tram. */
const AGGREGATE = /agr[eé]gat|aggregat|national|sncf|\bter\b|r[eé]gion|interurbain|scolaire|flixbus|blablacar|autocar|car[s]? r[eé]gion/i;

/**
 * Jeux de données « transport public » (transport.data.gouv.fr) dont la description cite une des
 * communes (code INSEE ou nom) et qui comptent un métro, un tram ou un funiculaire ; URL du GTFS.
 * Le jeu retenu est ensuite vérifié sur le terrain (gares proches des villes concernées).
 */
export function pickUrbanGtfs(datasets: unknown[], o: { codes: string[]; names: string[] }, max = 2): { title: string; url: string }[] {
  const names = o.names.map(norm).filter((n) => n.length >= 3);
  const scored: { title: string; url: string; score: number }[] = [];
  for (const d of datasets) {
    if (!d || typeof d !== "object") continue;
    const x = d as { type?: string; title?: string; resources?: { format?: string; url?: string; original_url?: string; is_available?: boolean; title?: string }[] };
    if (x.type && x.type !== "public-transit") continue;
    const title = String(x.title ?? "");
    if (AGGREGATE.test(title)) continue;
    const res = (x.resources ?? []).find((r) => /^gtfs$/i.test(String(r.format ?? "")) && r.is_available !== false && (r.url || r.original_url));
    if (!res) continue;
    const raw = JSON.stringify(d);
    const text = ` ${norm(raw)} `;
    if (!/\b(tram|tramway|metro|funiculaire|subway)\b/.test(text)) continue;
    let score = 0;
    for (const c of o.codes) if (raw.includes(`"${c}"`)) score += 3;
    for (const n of names) if (text.includes(` ${n} `)) score += 2;
    if (score) scored.push({ title, url: String(res.url || res.original_url), score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map(({ title, url }) => ({ title, url }));
}
