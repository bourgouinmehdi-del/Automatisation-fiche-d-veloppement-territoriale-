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
