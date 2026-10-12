import { booleanPointInPolygon } from "@turf/turf";
import { promises as fs } from "node:fs";
import path from "node:path";
import { reportsDir } from "../config";
import type { FieldPlace, ProgressEvent, Report, ReportQuery } from "../types";
import { buildReport, reportId } from "./build";

/**
 * Stockage des rapports (fichiers JSON) et suivi des générations en cours.
 * Le stockage fichier suffit au prototype ; l'interface (get/save/list) est
 * prévue pour être remplacée par PostgreSQL/PostGIS sans toucher au reste.
 */

interface Job {
  id: string;
  query: ReportQuery;
  events: ProgressEvent[];
  status: "running" | "done" | "error";
  error?: string;
}

const g = globalThis as unknown as { __jobs?: Map<string, Job> };
const jobs = (g.__jobs ??= new Map<string, Job>());

const file = (id: string) =>
  path.join(reportsDir(), `${id.replace(/[^\w-]/g, "")}.json`);

export async function saveReport(r: Report) {
  await fs.mkdir(reportsDir(), { recursive: true });
  const prev = await getReport(r.id);
  if (prev) {
    r.version = prev.version + 1;
    r.createdAt = prev.createdAt;
    // Les retours du terrain survivent à la régénération.
    r.fieldNotes ??= prev.fieldNotes;
    r.fieldPlaces ??= prev.fieldPlaces;
  }
  await fs.writeFile(file(r.id), JSON.stringify(r));
}

/** Enregistre les retours du terrain d'une fiche (sans changer de version). */
export async function saveFieldNotes(id: string, text: string) {
  const r = await getReport(id);
  if (!r) return null;
  r.fieldNotes = {
    text: text.slice(0, 20000),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(file(r.id), JSON.stringify(r));
  return r.fieldNotes;
}

export async function getReport(id: string): Promise<Report | null> {
  try {
    return JSON.parse(await fs.readFile(file(id), "utf8")) as Report;
  } catch {
    return null;
  }
}

export async function listReports() {
  try {
    const files = (await fs.readdir(reportsDir())).filter((f) =>
      f.endsWith(".json"),
    );
    const out = [];
    for (const f of files) {
      const r = JSON.parse(
        await fs.readFile(path.join(reportsDir(), f), "utf8"),
      ) as Report;
      out.push({
        id: r.id,
        nom:
          r.query.scope === "departement"
            ? `Ciblage ${r.commune.departement.nom}`
            : r.commune.nom,
        departement: r.commune.departement.nom,
        scope: r.query.scope,
        updatedAt: r.updatedAt,
        version: r.version,
      });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

const jobsDir = () => path.join(path.dirname(reportsDir()), "jobs");
const jobFile = (id: string) =>
  path.join(jobsDir(), `${id.replace(/[^\w-]/g, "")}.json`);

/**
 * L'état de chaque génération est aussi écrit sur disque : si le serveur
 * redémarre en cours de route (manque de mémoire, redéploiement), la page de
 * progression peut le signaler au lieu d'attendre indéfiniment.
 */
let writing: Promise<void> = Promise.resolve();
function persistJob(job: Job) {
  const snapshot = JSON.stringify({
    ...job,
    pid: process.pid,
    bootId: BOOT_ID,
    updatedAt: new Date().toISOString(),
  });
  writing = writing
    .then(async () => {
      await fs.mkdir(jobsDir(), { recursive: true });
      const tmp = jobFile(job.id) + "." + process.pid + ".tmp";
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, jobFile(job.id));
    })
    .catch(() => {});
}
const BOOT_ID = `${process.pid}-${Date.now()}`;

/**
 * File d'attente : les générations s'exécutent une par une (réglable par
 * GENERATION_CONCURRENCY). Deux générations simultanées doublent la mémoire
 * utilisée et font redémarrer les petits hébergements.
 */
const MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.GENERATION_CONCURRENCY ?? 1) || 1,
);
let active = 0;
const waiting: (() => void)[] = [];
async function acquireSlot(onWait: () => void) {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  onWait();
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}
function releaseSlot() {
  active--;
  waiting.shift()?.();
}

/** Lance (ou relance) la génération en tâche de fond et renvoie l'identifiant. */
export function startJob(query: ReportQuery): string {
  const id = reportId(query);
  const existing = jobs.get(id);
  if (existing?.status === "running") return id;
  const job: Job = { id, query, events: [], status: "running" };
  jobs.set(id, job);
  persistJob(job);
  let last = 0;
  acquireSlot(() => {
    job.events.push({
      step: "attente",
      label: "En attente : une autre génération est en cours sur le serveur",
      done: 0,
      total: 1,
      status: "running",
      at: new Date().toISOString(),
    });
    persistJob(job);
  })
    .then(() =>
      buildReport(
        query,
        (e) => {
          job.events.push(e);
          // Écriture limitée à une toutes les 2 s environ.
          if (Date.now() - last > 2000) {
            last = Date.now();
            persistJob(job);
          }
        },
        id,
      ),
    )
    .then(async (r) => {
      job.events.push({
        step: "enregistrement",
        label: "Enregistrement de la fiche",
        done: 1,
        total: 1,
        status: "done",
        at: new Date().toISOString(),
      });
      await saveReport(r);
      job.status = "done";
      persistJob(job);
    })
    .catch((e) => {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
      job.events.push({
        step: "erreur",
        label: job.error,
        done: 0,
        total: 1,
        status: "error",
        at: new Date().toISOString(),
      });
      persistJob(job);
    })
    .finally(releaseSlot);
  return id;
}

export function getJob(id: string) {
  return jobs.get(id) ?? null;
}

/**
 * Génération connue sur disque mais absente de la mémoire de ce processus :
 * le serveur a redémarré pendant qu'elle tournait (statut « interrupted »).
 */
export async function getStoredJob(
  id: string,
): Promise<(Job & { updatedAt?: string }) | null> {
  try {
    const j = JSON.parse(await fs.readFile(jobFile(id), "utf8")) as Job & {
      bootId?: string;
      updatedAt?: string;
    };
    if (j.status === "running" && j.bootId !== BOOT_ID) {
      j.status = "error";
      j.error = "interrupted";
    }
    return j;
  } catch {
    return null;
  }
}

/**
 * Enregistre les lieux d'action signalés par les militants : chaque adresse est
 * géolocalisée (Base adresse nationale) puis rattachée à son bureau de vote à
 * partir des contours de la fiche.
 */
export async function saveFieldPlaces(id: string, items: FieldPlace[]) {
  const r = await getReport(id);
  if (!r) return null;
  const bvMap = r.maps.find((m) => m.id === "lfi_map_bv");
  const polys = (bvMap?.layers.flatMap((l) => l.data.features) ?? []).filter((f) => f.geometry && /Polygon/.test(f.geometry.type) && f.properties?.bv != null);
  const prio = new Set(
    (r.tables.find((t) => t.id === "lfi_bureaux")?.rows ?? []).filter((row) => row.priorite === 1).map((row) => String(row.bv)),
  );
  const prev = new Map((r.fieldPlaces?.items ?? []).map((p) => [`${p.adresse}|${p.nom}`, p]));
  const out: FieldPlace[] = [];
  for (const raw of items.slice(0, 60)) {
    const p: FieldPlace = {
      type: String(raw.type ?? "Autre").slice(0, 40),
      nom: String(raw.nom ?? "").slice(0, 120),
      horaires: String(raw.horaires ?? "").slice(0, 160),
      adresse: String(raw.adresse ?? "").slice(0, 200),
    };
    if (!p.nom.trim() && !p.adresse.trim()) continue;
    const old = prev.get(`${p.adresse}|${p.nom}`);
    if (old?.lon != null && old.lat != null) {
      p.lon = old.lon;
      p.lat = old.lat;
    } else if (p.adresse.trim()) {
      try {
        const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(p.adresse)}&citycode=${r.commune.code}&limit=1`, { signal: AbortSignal.timeout(8000) });
        const g = (await res.json()) as { features?: GeoJSON.Feature<GeoJSON.Point>[] };
        const pt = g.features?.[0]?.geometry.coordinates;
        if (pt) [p.lon, p.lat] = pt as [number, number];
      } catch {
        /* adresse non trouvée : le lieu reste sans bureau */
      }
    }
    if (p.lon != null && p.lat != null) {
      const hit = polys.find((f) => booleanPointInPolygon([p.lon!, p.lat!], f as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>));
      p.bv = hit ? String(hit.properties!.bv) : null;
      p.prioritaire = p.bv ? prio.has(p.bv) : false;
    }
    out.push(p);
  }
  r.fieldPlaces = { items: out, updatedAt: new Date().toISOString() };
  await fs.writeFile(file(r.id), JSON.stringify(r));
  return r.fieldPlaces;
}
