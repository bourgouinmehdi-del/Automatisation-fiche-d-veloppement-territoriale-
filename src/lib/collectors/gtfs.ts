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

/* --------------------------------------------- trajets directs entre villes */

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

/**
 * Trains directs (sans correspondance) entre des villes, un samedi de référence :
 * pour chaque paire, la durée la plus courte et le nombre de trains. 24 h sur disque.
 */
export function collectDirectTrains(http: TrackedHttp, groups: TrainGroup[], now = new Date()): Promise<DirectTrains> {
  const key = `gtfsdirect|${now.toISOString().slice(0, 10)}|${hash(JSON.stringify(groups))}`;
  return cachedExtract(key, 24, () => heavyLane.run(() => collectDirectTrainsFresh(http, groups, now)));
}

async function collectDirectTrainsFresh(http: TrackedHttp, groups: TrainGroup[], now: Date): Promise<DirectTrains> {
  const f = await http.file(GTFS_URL, { timeoutMs: 1800000, retries: 1 });
  const file = f.data;
  const groupOf = new Map<string, number>();
  const areas: { id: string; lon: number; lat: number }[] = [];
  const points: { id: string; parent: string }[] = [];
  await eachRow(file, "stops.txt", (v, col) => {
    const lt = Number(v[col("location_type")] ?? "0");
    if (lt === 1) areas.push({ id: v[col("stop_id")], lon: Number(v[col("stop_lon")]), lat: Number(v[col("stop_lat")]) });
    else points.push({ id: v[col("stop_id")], parent: v[col("parent_station")] ?? "" });
  });
  const near = (a: { lon: number; lat: number }, s: StationInput) => s.lon != null && s.lat != null && Math.hypot((a.lon - s.lon) * Math.cos((s.lat * Math.PI) / 180), a.lat - s.lat) * 111 < 0.4;
  groups.forEach((g, gi) => {
    for (const s of g.stations) {
      const uic = s.uic.replace(/\D/g, "").slice(0, 8);
      for (const a of areas) if ((uic.length >= 7 && a.id.includes(uic)) || near(a, s)) for (const p of points) if (p.parent === a.id) groupOf.set(p.id, gi);
    }
  });
  if (!groupOf.size) throw new Error("Gares absentes des horaires SNCF (GTFS)");
  // Samedi de référence : le plus desservi des huit prochaines semaines (les convois ont lieu le week-end).
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
  await eachRow(file, "calendar_dates.txt", (v, col) => {
    if (v[col("date")] === date && v[col("exception_type")] === "1") services.add(v[col("service_id")]);
  });
  try {
    await eachRow(file, "calendar.txt", (v, col) => {
      if (v[col("saturday")] === "1" && v[col("start_date")] <= date && v[col("end_date")] >= date) services.add(v[col("service_id")]);
    });
  } catch {
    /* fichier absent */
  }
  const trips = new Set<string>();
  await eachRow(file, "trips.txt", (v, col) => {
    if (services.has(v[col("service_id")])) trips.add(v[col("trip_id")]);
  });
  const byTrip = new Map<string, Map<number, number>>();
  await eachRow(file, "stop_times.txt", (v, col) => {
    const gi = groupOf.get(v[col("stop_id")]);
    if (gi == null) return;
    const trip = v[col("trip_id")];
    if (!trips.has(trip)) return;
    const t = toMin(v[col("departure_time")] || v[col("arrival_time")]);
    if (!byTrip.has(trip)) byTrip.set(trip, new Map());
    const m = byTrip.get(trip)!;
    if (!m.has(gi)) m.set(gi, t);
  });
  const pairs: DirectTrains["pairs"] = {};
  for (const m of byTrip.values()) {
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
  return { pairs, date, url: GTFS_URL, retrievedAt: f.retrievedAt };
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
  return cachedExtract(`idfmtc2|${now.toISOString().slice(0, 10)}`, 24, () => heavyLane.run(() => collectIdfmIndexFresh(http)));
}

async function collectIdfmIndexFresh(http: TrackedHttp): Promise<TcIndex> {
  const f = await http.file(IDFM_GTFS_URL, { timeoutMs: 1800000, retries: 1 });
  const file = f.data;
  // 1. Lignes ferrées, de métro et de tram (types GTFS 0, 1, 2).
  const routes = new Map<string, string>();
  await eachRow(file, "routes.txt", (v, col) => {
    const type = Number(v[col("route_type")]);
    if (![0, 1, 2].includes(type)) return;
    const short = (v[col("route_short_name")] ?? "").trim();
    const long = (v[col("route_long_name")] ?? "").trim();
    const name = short || long;
    const ligne = type === 1 ? `métro ${name}` : type === 0 ? `tram ${name.replace(/^T?/, "T")}` : /^[A-E]$/.test(name) ? `RER ${name}` : /^[HJKLNPRUV]$/.test(name) ? `Transilien ${name}` : `train ${name}`;
    routes.set(v[col("route_id")], ligne);
  });
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
  if (!patterns.length) throw new Error("Aucune ligne de métro, RER ou tram dans les horaires IDFM");
  return { stations, patterns, url: IDFM_GTFS_URL, retrievedAt: f.retrievedAt };
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
      push(s, d, st); // descendre
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
