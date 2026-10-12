import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { cacheDir } from "./config";

/**
 * Outils d'exécution : mesure de la mémoire, file d'attente sensible à la
 * mémoire pour les traitements lourds, et cache disque des extractions
 * départementales (au lieu de caches en mémoire qui grossissaient à chaque
 * fiche jusqu'à faire redémarrer le serveur).
 */

/** Limite mémoire du conteneur (cgroup v2 / v1), en octets ; null si inconnue. */
export const memoryLimit: number | null = (() => {
  const env = Number(process.env.MEMORY_LIMIT_MB);
  if (env > 0) return env * 1024 * 1024;
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      const n = Number(v);
      // « max » ou valeur astronomique = pas de limite.
      if (Number.isFinite(n) && n > 0 && n < 1e15) return n;
    } catch {
      /* fichier absent */
    }
  }
  return null;
})();

export const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);

/** Seuil au-delà duquel un nouveau traitement lourd attend (60 % de la limite, sinon 700 Mo). */
const pressureBytes = () => (memoryLimit ? memoryLimit * 0.6 : 700 * 1048576);
const underPressure = () => process.memoryUsage().rss > pressureBytes();

/**
 * Sémaphore : au plus `max` tâches en même temps ; une tâche supplémentaire
 * attend aussi tant que la mémoire est sous pression (sauf si rien ne tourne,
 * pour ne jamais bloquer).
 */
export class Lane {
  private active = 0;
  private queue: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private max: number) {}

  private canStart() {
    return this.active < this.max && (this.active === 0 || !underPressure());
  }

  private pump() {
    while (this.queue.length && this.canStart()) {
      this.active++;
      this.queue.shift()!();
    }
    // Sous pression avec des tâches en attente : nouvel essai un peu plus tard.
    if (this.queue.length && this.active < this.max && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, 500);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
    try {
      return await fn();
    } finally {
      this.active--;
      this.pump();
    }
  }
}

/** Traitements lourds (fichiers nationaux) : 2 à la fois par défaut. */
export const heavyLane = new Lane(Math.max(1, Number(process.env.HEAVY_CONCURRENCY ?? 2) || 2));

/* ------------------------------------------------ cache disque des extractions */

const extractsDir = () => path.join(cacheDir(), "extracts");
const safe = (key: string) => key.replace(/[^\w.-]+/g, "_").slice(0, 180);

/** Petit cache mémoire (2 entrées) devant le cache disque. */
const recent: { key: string; value: unknown }[] = [];
const remember = (key: string, value: unknown) => {
  const i = recent.findIndex((x) => x.key === key);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift({ key, value });
  recent.length = Math.min(recent.length, 2);
};

/**
 * Extraction mise en cache sur disque : `compute` n'est appelé que si aucune
 * copie de moins de `ttlHours` n'existe. Les Map sont sérialisées.
 */
export async function cachedExtract<T>(key: string, ttlHours: number, compute: () => Promise<T>, shouldCache: (v: T) => boolean = () => true): Promise<T> {
  const hit = recent.find((x) => x.key === key);
  if (hit) return hit.value as T;
  const file = path.join(extractsDir(), `${safe(key)}.json`);
  try {
    const st = await fsp.stat(file);
    if (Date.now() - st.mtimeMs < ttlHours * 3600_000) {
      const value = JSON.parse(await fsp.readFile(file, "utf8"), reviver) as T;
      remember(key, value);
      return value;
    }
  } catch {
    /* absent ou illisible : recalcul */
  }
  const value = await compute();
  // Résultat incomplet (une sous-source en panne) : pas de mise en cache, pour
  // retenter la prochaine fois au lieu de figer un manque de données.
  if (!shouldCache(value)) return value;
  try {
    await fsp.mkdir(extractsDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, replacer));
    await fsp.rename(tmp, file);
  } catch {
    /* disque plein ou en lecture seule : on continue sans cache */
  }
  remember(key, value);
  return value;
}

function replacer(_k: string, v: unknown) {
  return v instanceof Map ? { __map: [...v.entries()] } : v;
}
function reviver(_k: string, v: unknown) {
  return v && typeof v === "object" && "__map" in (v as object) ? new Map((v as { __map: [unknown, unknown][] }).__map) : v;
}
