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

/**
 * Le corps de la réponse est stocké à part (fichier `.body`) : les fichiers
 * nationaux (résultats par bureau de vote, plusieurs centaines de Mo) ne
 * passent ainsi jamais par JSON.stringify / JSON.parse.
 */
export async function readCache(key: string): Promise<CacheEntry | null> {
  try {
    const meta = JSON.parse(await fs.readFile(entryPath(key), "utf8")) as CacheEntry;
    if (meta.body == null) meta.body = await fs.readFile(entryPath(key).replace(/\.json$/, ".body"), "utf8");
    return meta;
  } catch {
    return null;
  }
}

/** Chemin du corps brut d'une entrée (lecture en flux des gros fichiers). */
export function bodyPath(key: string) {
  return entryPath(key).replace(/\.json$/, ".body");
}

/** Métadonnées seules, sans charger le corps en mémoire. */
export async function readCacheMeta(key: string): Promise<Omit<CacheEntry, "body"> | null> {
  try {
    const meta = JSON.parse(await fs.readFile(entryPath(key), "utf8")) as CacheEntry;
    await fs.access(bodyPath(key));
    return meta;
  } catch {
    return null;
  }
}

/** Enregistre une entrée dont le corps a déjà été écrit dans `tmpBody`. */
export async function commitCacheFile(meta: Omit<CacheEntry, "body">, tmpBody: string): Promise<string> {
  const p = entryPath(meta.key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.rename(tmpBody, bodyPath(meta.key));
  const tmp = p + "." + process.pid + "." + Date.now() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(meta));
  await fs.rename(tmp, p);
  return bodyPath(meta.key);
}

/** Fichier temporaire dans le dossier du cache (même volume que la destination). */
export async function tempCachePath(key: string): Promise<string> {
  const p = entryPath(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  return p + "." + process.pid + "." + Date.now() + ".download";
}

export async function writeCache(entry: CacheEntry): Promise<void> {
  const p = entryPath(entry.key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + "." + process.pid + "." + Date.now() + ".tmp";
  const bodyPath = p.replace(/\.json$/, ".body");
  await fs.writeFile(tmp + ".body", entry.body);
  await fs.rename(tmp + ".body", bodyPath);
  const { body: _omit, ...meta } = entry;
  void _omit;
  await fs.writeFile(tmp, JSON.stringify(meta));
  await fs.rename(tmp, p);
}

export function isFresh(entry: CacheEntry, ttlHours = config.cacheTtlHours): boolean {
  return Date.now() - new Date(entry.fetchedAt).getTime() < ttlHours * 3600_000;
}

export async function clearCache(): Promise<void> {
  await fs.rm(cacheDir(), { recursive: true, force: true });
}
