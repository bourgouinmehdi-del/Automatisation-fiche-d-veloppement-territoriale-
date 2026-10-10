import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cacheDir, config } from "./config";

/**
 * Cache disque clé/valeur pour les réponses HTTP.
 * Chaque entrée conserve l'URL, la date de récupération et le corps brut,
 * ce qui permet (1) d'éviter les téléchargements répétés, (2) de dater
 * précisément chaque donnée, (3) de servir une copie périmée si la source
 * devient indisponible (repli signalé comme « stale »).
 */
export interface CacheEntry {
  key: string;
  url: string;
  fetchedAt: string;
  status: number;
  body: string;
}

export function cacheKey(url: string, body?: string): string {
  return crypto.createHash("sha1").update(url + "\n" + (body ?? "")).digest("hex");
}

function entryPath(key: string) {
  return path.join(cacheDir(), key.slice(0, 2), key + ".json");
}

export async function readCache(key: string): Promise<CacheEntry | null> {
  try {
    const raw = await fs.readFile(entryPath(key), "utf8");
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

export async function writeCache(entry: CacheEntry): Promise<void> {
  const p = entryPath(entry.key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + "." + process.pid + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(entry));
  await fs.rename(tmp, p);
}

export function isFresh(entry: CacheEntry, ttlHours = config.cacheTtlHours): boolean {
  return Date.now() - new Date(entry.fetchedAt).getTime() < ttlHours * 3600_000;
}

export async function clearCache(): Promise<void> {
  await fs.rm(cacheDir(), { recursive: true, force: true });
}
