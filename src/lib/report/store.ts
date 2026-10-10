import { promises as fs } from "node:fs";
import path from "node:path";
import { reportsDir } from "../config";
import type { ProgressEvent, Report, ReportQuery } from "../types";
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

const file = (id: string) => path.join(reportsDir(), `${id.replace(/[^\w-]/g, "")}.json`);

export async function saveReport(r: Report) {
  await fs.mkdir(reportsDir(), { recursive: true });
  const prev = await getReport(r.id);
  if (prev) {
    r.version = prev.version + 1;
    r.createdAt = prev.createdAt;
  }
  await fs.writeFile(file(r.id), JSON.stringify(r));
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
    const files = (await fs.readdir(reportsDir())).filter((f) => f.endsWith(".json"));
    const out = [];
    for (const f of files) {
      const r = JSON.parse(await fs.readFile(path.join(reportsDir(), f), "utf8")) as Report;
      out.push({ id: r.id, nom: r.commune.nom, departement: r.commune.departement.nom, scope: r.query.scope, updatedAt: r.updatedAt, version: r.version });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

const jobsDir = () => path.join(path.dirname(reportsDir()), "jobs");
const jobFile = (id: string) => path.join(jobsDir(), `${id.replace(/[^\w-]/g, "")}.json`);

/**
 * L'état de chaque génération est aussi écrit sur disque : si le serveur
 * redémarre en cours de route (manque de mémoire, redéploiement), la page de
 * progression peut le signaler au lieu d'attendre indéfiniment.
 */
let writing: Promise<void> = Promise.resolve();
function persistJob(job: Job) {
  const snapshot = JSON.stringify({ ...job, pid: process.pid, bootId: BOOT_ID, updatedAt: new Date().toISOString() });
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

/** Lance (ou relance) la génération en tâche de fond et renvoie l'identifiant. */
export function startJob(query: ReportQuery): string {
  const id = reportId(query);
  const existing = jobs.get(id);
  if (existing?.status === "running") return id;
  const job: Job = { id, query, events: [], status: "running" };
  jobs.set(id, job);
  persistJob(job);
  let last = 0;
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
  )
    .then(async (r) => {
      job.events.push({ step: "enregistrement", label: "Enregistrement de la fiche", done: 1, total: 1, status: "done", at: new Date().toISOString() });
      await saveReport(r);
      job.status = "done";
      persistJob(job);
    })
    .catch((e) => {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
      job.events.push({ step: "erreur", label: job.error, done: 0, total: 1, status: "error", at: new Date().toISOString() });
      persistJob(job);
    });
  return id;
}

export function getJob(id: string) {
  return jobs.get(id) ?? null;
}

/**
 * Génération connue sur disque mais absente de la mémoire de ce processus :
 * le serveur a redémarré pendant qu'elle tournait (statut « interrupted »).
 */
export async function getStoredJob(id: string): Promise<(Job & { updatedAt?: string }) | null> {
  try {
    const j = JSON.parse(await fs.readFile(jobFile(id), "utf8")) as Job & { bootId?: string; updatedAt?: string };
    if (j.status === "running" && j.bootId !== BOOT_ID) {
      j.status = "error";
      j.error = "interrupted";
    }
    return j;
  } catch {
    return null;
  }
}
