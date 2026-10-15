import { createWriteStream, promises as fsp } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { bodyPath as bodyFile, cacheKey, commitCacheFile, isFresh, readCache, readCacheMeta, tempCachePath, writeCache } from "./cache";
import { config } from "./config";

/**
 * Client HTTP commun à tous les connecteurs :
 *  - délai maximal par requête,
 *  - nouvelles tentatives avec attente exponentielle sur erreurs réseau, 429 et 5xx,
 *  - cache disque avec durée de vie,
 *  - repli sur une copie périmée du cache si la source ne répond pas,
 *  - mode hors ligne (aucune requête sortante),
 *  - limitation de débit simple par hôte.
 */

export interface FetchResult<T> {
  data: T;
  url: string;
  retrievedAt: string;
  fromCache: boolean;
  stale: boolean;
}

export class HttpError extends Error {
  constructor(message: string, public status?: number, public url?: string) {
    super(message);
  }
}

export interface FetchOptions {
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  ttlHours?: number;
  retries?: number;
  timeoutMs?: number;
  /** Intervalle minimal entre deux requêtes vers le même hôte (ms). */
  minIntervalMs?: number;
  /** Ne pas mettre en cache (ex. réponses volumineuses non réutilisées). */
  noCache?: boolean;
  /** Traiter un 404 comme une réponse vide plutôt qu'une erreur. */
  allow404?: boolean;
  /** Décoder en ISO-8859-1 si le contenu n'est pas de l'UTF-8 valide (fichiers CSV anciens). */
  decodeLatin1?: boolean;
  /**
   * Contrôle du contenu : une réponse 200 jugée invalide (ex. Overpass
   * « runtime error: timed out ») n'est ni mise en cache ni renvoyée ;
   * elle compte comme un échec (nouvelle tentative, puis erreur).
   */
  validate?: (body: string) => string | null;
}

const lastCallByHost = new Map<string, number>();

/**
 * Coupe-circuit : après deux échecs réseau consécutifs (pas de réponse HTTP)
 * vers un même hôte, celui-ci est considéré indisponible pendant 5 minutes
 * afin de ne pas allonger inutilement la génération.
 */
const hostFailures = new Map<string, { count: number; until: number }>();
function hostIsDown(url: string) {
  const h = hostFailures.get(new URL(url).host);
  return !!h && h.count >= 2 && Date.now() < h.until;
}
function markHost(url: string, ok: boolean) {
  const host = new URL(url).host;
  if (ok) hostFailures.delete(host);
  else {
    const h = hostFailures.get(host) ?? { count: 0, until: 0 };
    hostFailures.set(host, { count: h.count + 1, until: Date.now() + 5 * 60_000 });
  }
}
export function resetCircuitBreakers() {
  hostFailures.clear();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(url: string, minIntervalMs: number) {
  if (!minIntervalMs) return;
  const host = new URL(url).host;
  const last = lastCallByHost.get(host) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  lastCallByHost.set(host, Math.max(Date.now(), last + minIntervalMs));
  if (wait > 0) await sleep(wait);
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<FetchResult<string>> {
  const key = cacheKey(url, opts.body);
  let cached = opts.noCache ? null : await readCache(key);
  // Une copie en cache invalide (enregistrée avant l'ajout du contrôle) est ignorée.
  if (cached && opts.validate && opts.validate(cached.body)) cached = null;
  if (cached && isFresh(cached, opts.ttlHours)) {
    return { data: cached.body, url, retrievedAt: cached.fetchedAt, fromCache: true, stale: false };
  }
  if (config.offline) {
    if (cached) return { data: cached.body, url, retrievedAt: cached.fetchedAt, fromCache: true, stale: true };
    throw new HttpError("Mode hors ligne : aucune copie en cache", undefined, url);
  }

  if (hostIsDown(url)) {
    if (cached) return { data: cached.body, url, retrievedAt: cached.fetchedAt, fromCache: true, stale: true };
    throw new HttpError(`Hôte injoignable (${new URL(url).host})`, undefined, url);
  }

  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    await throttle(url, opts.minIntervalMs ?? 0);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? config.httpTimeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        body: opts.body,
        headers: { "User-Agent": config.userAgent, Accept: "application/json, text/csv, */*", ...opts.headers },
        signal: ctrl.signal,
      });
      markHost(url, true);
      if (res.status === 404 && opts.allow404) {
        const retrievedAt = new Date().toISOString();
        if (!opts.noCache) await writeCache({ key, url, fetchedAt: retrievedAt, status: 404, body: "" });
        return { data: "", url, retrievedAt, fromCache: false, stale: false };
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(`HTTP ${res.status}`, res.status, url);
        continue;
      }
      if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status, url);
      const body = opts.decodeLatin1 ? decodeBody(new Uint8Array(await res.arrayBuffer())) : await res.text();
      const invalid = opts.validate?.(body);
      if (invalid) {
        lastErr = new HttpError(invalid, res.status, url);
        continue;
      }
      const retrievedAt = new Date().toISOString();
      if (!opts.noCache) await writeCache({ key, url, fetchedAt: retrievedAt, status: res.status, body });
      return { data: body, url, retrievedAt, fromCache: false, stale: false };
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status && e.status < 500 && e.status !== 429) break;
      if (!(e instanceof HttpError)) {
        markHost(url, false);
        if (hostIsDown(url)) break;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  if (cached) {
    return { data: cached.body, url, retrievedAt: cached.fetchedAt, fromCache: true, stale: true };
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new HttpError(`Échec de la requête (${msg})`, lastErr instanceof HttpError ? lastErr.status : undefined, url);
}

/**
 * Télécharge une ressource volumineuse directement sur disque (dans le cache)
 * sans jamais la charger en mémoire, et renvoie le chemin du fichier.
 * Indispensable sur les hébergements à mémoire limitée : les fichiers
 * nationaux de résultats par bureau de vote pèsent plusieurs centaines de Mo.
 */
const STALL_MS = Number(process.env.DOWNLOAD_STALL_MS ?? 120_000);

export async function fetchToFile(url: string, opts: FetchOptions = {}): Promise<FetchResult<string>> {
  const key = cacheKey(url);
  const cached = await readCacheMeta(key);
  const fromCached = (stale: boolean) => ({ data: bodyFile(key), url, retrievedAt: cached!.fetchedAt, fromCache: true, stale });
  if (cached && isFresh({ ...cached, body: "" }, opts.ttlHours)) return fromCached(false);
  if (config.offline) {
    if (cached) return fromCached(true);
    throw new HttpError("Mode hors ligne : aucune copie en cache", undefined, url);
  }
  if (hostIsDown(url)) {
    if (cached) return fromCached(true);
    throw new HttpError(`Hôte injoignable (${new URL(url).host})`, undefined, url);
  }
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(2000 * 2 ** (attempt - 1));
    await throttle(url, opts.minIntervalMs ?? 0);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 600_000);
    const tmp = await tempCachePath(key);
    try {
      const res = await fetch(url, { headers: { "User-Agent": config.userAgent, Accept: "text/csv, */*", ...opts.headers }, signal: ctrl.signal });
      markHost(url, true);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(`HTTP ${res.status}`, res.status, url);
        continue;
      }
      if (!res.ok || !res.body) throw new HttpError(`HTTP ${res.status}`, res.status, url);
      // Transfert bloqué (aucun octet reçu pendant STALL_MS) : abandon puis nouvel essai,
      // plutôt que d'attendre le délai total (jusqu'à 30 min pour les gros fichiers).
      let idle = setTimeout(() => ctrl.abort(new Error("transfert bloqué")), STALL_MS);
      const watchdog = new Transform({
        transform(chunk, _enc, cb) {
          clearTimeout(idle);
          idle = setTimeout(() => ctrl.abort(new Error("transfert bloqué")), STALL_MS);
          cb(null, chunk);
        },
        flush(cb) {
          clearTimeout(idle);
          cb();
        },
      });
      try {
        await pipeline(Readable.fromWeb(res.body as unknown as NodeWebStream), watchdog, createWriteStream(tmp));
      } finally {
        clearTimeout(idle);
      }
      const retrievedAt = new Date().toISOString();
      const file = await commitCacheFile({ key, url, fetchedAt: retrievedAt, status: res.status }, tmp);
      return { data: file, url, retrievedAt, fromCache: false, stale: false };
    } catch (e) {
      lastErr = e;
      await fsp.rm(tmp, { force: true });
      if (e instanceof HttpError && e.status && e.status < 500 && e.status !== 429) break;
      if (!(e instanceof HttpError)) {
        markHost(url, false);
        if (hostIsDown(url)) break;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  if (cached) return fromCached(true);
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new HttpError(`Échec du téléchargement (${msg})`, lastErr instanceof HttpError ? lastErr.status : undefined, url);
}

function decodeBody(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<FetchResult<T>> {
  const r = await fetchText(url, opts);
  try {
    return { ...r, data: (r.data === "" ? null : JSON.parse(r.data)) as T };
  } catch {
    throw new HttpError("Réponse JSON invalide", undefined, url);
  }
}
