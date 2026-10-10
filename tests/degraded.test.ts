/**
 * Robustesse : génération quand des sources tombent ou que des données
 * manquent (API simulées — valeurs fictives).
 *  - Overpass et SNCF en erreur 503 ;
 *  - Filosofi absent pour la commune (secret statistique simulé) ;
 *  - mode hors ligne : seuls cache et référentiel embarqué.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { mockFetch } from "./fixtures/mock-apis";

const dir = path.join(os.tmpdir(), `fiche-degraded-${process.pid}`);

beforeAll(() => {
  process.env.DATA_DIR = dir;
  process.env.INSEE_MIN_INTERVAL_MS = "0";
  const base = mockFetch();
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.host === "overpass-api.de" || u.host === "ressources.data.sncf.com") return new Response("indisponible", { status: 503 });
    if (u.pathname.includes("DS_FILOSOFI_CC") && u.searchParams.get("GEO") === "COM-60159") return new Response(JSON.stringify({ observations: [] }), { status: 200 });
    return base(input, init);
  }) as typeof fetch);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("génération en mode dégradé", () => {
  it("produit la fiche, signale les sources en échec et les données manquantes, sans inventer de valeur", async () => {
    const { buildReport } = await import("@/lib/report/build");
    const r = await buildReport({ codeInsee: "60159", scope: "commune" });
    const failed = new Set(r.runs.filter((x) => x.status === "failed").map((x) => x.sourceId));
    expect(failed).toContain("osm");
    expect(failed).toContain("sncf");
    expect(r.warnings.join(" ")).toMatch(/échec/);
    // Revenu médian non diffusé pour la commune : absent, mais présent pour le département.
    expect(r.indicators.find((i) => i.id === "revenu_median" && i.geo.level === "commune")).toBeUndefined();
    expect(r.indicators.find((i) => i.id === "revenu_median" && i.geo.level === "departement")?.value).toBeTypeOf("number");
    expect(r.missing.map((m) => m.label)).toContain("Revenu médian (Filosofi)");
    expect(r.missing.some((m) => /OpenStreetMap/.test(m.label))).toBe(true);
    expect(r.maps.find((m) => m.id === "map_equipements")).toBeUndefined();
    // Les autres sources restent exploitées.
    expect(r.indicators.find((i) => i.id === "prix_m2_appartement")).toBeDefined();
    expect(r.sections).toHaveLength(10); // fiche d'action + A à I
  }, 60000);

  it("mode hors ligne : n'émet aucune requête et réutilise le cache", async () => {
    vi.resetModules();
    process.env.OFFLINE = "1";
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (i: RequestInfo | URL) => {
      calls.push(String(i));
      throw new Error("réseau interdit");
    }) as typeof fetch);
    const { buildReport } = await import("@/lib/report/build");
    const r = await buildReport({ codeInsee: "60159", scope: "commune" });
    delete process.env.OFFLINE;
    expect(calls).toEqual([]);
    // Données mises en cache lors de la génération précédente.
    expect(r.indicators.find((i) => i.id === "prix_m2_appartement")).toBeDefined();
    expect(r.warnings.join(" ")).toMatch(/hors ligne/);
  }, 60000);
});
