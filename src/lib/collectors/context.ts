import { fetchJson, fetchText, FetchOptions, FetchResult } from "../http";
import { SOURCES } from "./catalog";
import type { MissingItem, SourceRef, SourceRun, ThemeId } from "../types";

/**
 * Contexte d'exécution d'une collecte : journalise chaque appel de source
 * (durée, nombre de requêtes, part servie depuis le cache, échec éventuel)
 * et centralise la liste des données manquantes.
 */
export class CollectContext {
  runs: SourceRun[] = [];
  missing: MissingItem[] = [];

  ref(sourceId: string, url: string, retrievedAt: string, extra: Partial<SourceRef> = {}): SourceRef {
    return { id: sourceId, name: SOURCES[sourceId]?.name ?? sourceId, url, retrievedAt, ...extra };
  }

  addMissing(item: MissingItem) {
    if (!this.missing.some((m) => m.label === item.label && m.theme === item.theme)) this.missing.push(item);
  }

  /**
   * Exécute une étape de collecte. Les erreurs sont capturées : une source
   * indisponible n'interrompt jamais la génération du rapport.
   */
  async step<T>(
    sourceId: string,
    step: string,
    fn: (http: TrackedHttp) => Promise<T>,
    onFail?: { theme: ThemeId; label: string },
  ): Promise<T | null> {
    const t0 = Date.now();
    const http = new TrackedHttp();
    try {
      const out = await fn(http);
      this.runs.push({
        sourceId,
        name: SOURCES[sourceId]?.name ?? sourceId,
        step,
        status: http.stale > 0 ? "stale" : http.requests > 0 && http.fromCache === http.requests ? "cache" : http.partial ? "partial" : "ok",
        message: http.stale > 0 ? "Source indisponible : copie en cache périmée utilisée" : [...new Set(http.notes)].slice(0, 5).join(" ; ") || undefined,
        durationMs: Date.now() - t0,
        requests: http.requests,
        fromCache: http.fromCache,
        retrievedAt: http.lastRetrievedAt ?? new Date().toISOString(),
      });
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.runs.push({
        sourceId,
        name: SOURCES[sourceId]?.name ?? sourceId,
        step,
        status: "failed",
        message: msg,
        durationMs: Date.now() - t0,
        requests: http.requests,
        fromCache: http.fromCache,
        retrievedAt: new Date().toISOString(),
      });
      if (onFail) this.addMissing({ theme: onFail.theme, label: onFail.label, reason: `Source indisponible : ${msg}`, sourceId });
      return null;
    }
  }

  skip(sourceId: string, step: string, message: string) {
    this.runs.push({
      sourceId,
      name: SOURCES[sourceId]?.name ?? sourceId,
      step,
      status: "skipped",
      message,
      durationMs: 0,
      requests: 0,
      fromCache: 0,
      retrievedAt: new Date().toISOString(),
    });
  }
}

export class TrackedHttp {
  requests = 0;
  fromCache = 0;
  stale = 0;
  partial = false;
  notes: string[] = [];
  lastRetrievedAt?: string;

  private track<T>(r: FetchResult<T>) {
    this.requests++;
    if (r.fromCache) this.fromCache++;
    if (r.stale) this.stale++;
    this.lastRetrievedAt = r.retrievedAt;
    return r;
  }
  async json<T = unknown>(url: string, opts?: FetchOptions) {
    return this.track(await fetchJson<T>(url, opts));
  }
  async text(url: string, opts?: FetchOptions) {
    return this.track(await fetchText(url, opts));
  }
}
