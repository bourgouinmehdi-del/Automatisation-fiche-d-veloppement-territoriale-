import { cacheKey, isFresh, readCache, writeCache } from "./cache";
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
  const cached = opts.noCache ? null : await readCache(key);
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
      const body = await res.text();
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

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<FetchResult<T>> {
  const r = await fetchText(url, opts);
  try {
    return { ...r, data: (r.data === "" ? null : JSON.parse(r.data)) as T };
  } catch {
    throw new HttpError("Réponse JSON invalide", undefined, url);
  }
}
