/**
 * Test d'intégration de la chaîne complète avec des API SIMULÉES
 * (tests/fixtures/mock-apis.ts — valeurs fictives).
 * Vérifie : collecte multi-sources, calculs, constats, cartes, graphiques,
 * exports HTML/DOCX/CSV (et PDF si Chromium est disponible), cache.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { mockFetch } from "./fixtures/mock-apis";
import type { Report } from "@/lib/types";

const dir = path.join(os.tmpdir(), `fiche-test-${process.pid}`);
let report: Report;
let build: typeof import("@/lib/report/build").buildReport;

beforeAll(async () => {
  process.env.DATA_DIR = dir;
  process.env.INSEE_MIN_INTERVAL_MS = "0";
  // Données internes facultatives (fictives).
  await fs.mkdir(path.join(dir, "interne"), { recursive: true });
  await fs.writeFile(path.join(dir, "interne", "parrains.csv"), "code_commune;parrains\n60159;40\n60382;5\n60057;20\n");
  await fs.writeFile(path.join(dir, "interne", "groupes.csv"), "code_commune;nom;membres;statut\n60159;Groupe d'action fictif;9;actif\n");
  vi.stubGlobal("fetch", mockFetch());
  build = (await import("@/lib/report/build")).buildReport;
  report = await build({ codeInsee: "60159", scope: "commune" });
}, 120000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

const ind = (id: string, level = "commune") => report.indicators.find((i) => i.id === id && i.geo.level === level);

describe("chaîne de génération (API simulées)", () => {
  it("toutes les sources simulées sont interrogées avec succès", () => {
    const failed = report.runs.filter((r) => r.status === "failed");
    expect(failed.map((f) => `${f.step}: ${f.message}`)).toEqual([]);
    const sources = new Set(report.runs.map((r) => r.sourceId));
    for (const s of ["geoapi", "insee_melodi", "dvf", "osm", "georisques", "education", "sncf", "entreprises", "elections"]) expect(sources).toContain(s);
  });

  it("chaque indicateur porte sa traçabilité", () => {
    for (const i of report.indicators) {
      expect(i.source.name).toBeTruthy();
      expect(i.source.retrievedAt).toMatch(/^\d{4}-/);
      expect(i.unit).toBeTruthy();
      expect(i.geo.code).toBeTruthy();
    }
  });

  it("calcule les parts d'âge à partir des tranches réellement diffusées", () => {
    // Partition fictive 2023 : 7000, 6500, 8000, 7500, 4500, 5200, 2000 → total 40 700.
    expect(ind("part_65_plus")!.value).toBeCloseTo(((5200 + 2000) / 40700) * 100, 6);
    expect(ind("part_moins_25")!.value).toBeCloseTo(((7000 + 6500) / 40700) * 100, 6);
    expect(ind("part_80_plus")!.value).toBeCloseTo((2000 / 40700) * 100, 6);
    expect(ind("part_moins_30")).toBeUndefined(); // pas de borne à 30 ans : pas d'estimation
  });

  it("construit l'historique de population à partir des millésimes du recensement", () => {
    const s = report.series.find((x) => x.id === "pop_historique" && x.geo.level === "commune")!;
    expect(s.points.map((p) => p.x)).toEqual(["2012", "2017", "2023"]);
    expect(ind("evol_pop_annuelle")).toBeDefined();
  });

  it("calcule les ratios logement / emploi / diplôme / mobilité", () => {
    expect(ind("part_logements_vacants")!.value).toBeCloseTo((2000 / 22000) * 100, 6);
    expect(ind("part_locataires_hlm")!.value).toBeCloseTo((5000 / 19500) * 100, 6);
    expect(ind("part_proprietaires")!.value).toBeCloseTo((7500 / 19500) * 100, 6);
    expect(ind("part_maisons")!.value).toBeCloseTo((6000 / 22000) * 100, 6);
    // Tranche 15-64 ans explicitement retenue (pas de total d'âge dans ce jeu).
    expect(ind("taux_chomage_rp")!.value).toBeCloseTo((2600 / (16000 + 2600)) * 100, 6);
    expect(ind("taux_emploi")!.value).toBeCloseTo((16000 / 26000) * 100, 6);
    // Définition INSEE : actifs occupés résidents de 15 ans ou plus (21 600 dans la simulation).
    expect(ind("concentration_emploi")!.value).toBeCloseTo((24000 / 21600) * 100, 6);
    expect(ind("part_diplome_superieur")!.value).toBeCloseTo((10000 / 28000) * 100, 6);
    expect(ind("part_sans_diplome")!.value).toBeCloseTo((7000 / 28000) * 100, 6);
    expect(ind("part_personnes_seules")!.value).toBeCloseTo((6800 / 34000) * 100, 6);
    expect(ind("part_menages_sans_voiture")!.value).toBeCloseTo((5000 / 19500) * 100, 6);
    expect(ind("part_trajets_voiture")!.value).toBeCloseTo((9000 / 16000) * 100, 6);
    expect(ind("part_actifs_travaillant_commune")!.value).toBeCloseTo((7000 / 16000) * 100, 6);
  });

  it("distributions : partitions explicites sans double compte", () => {
    const d = (id: string) => report.charts.find((c) => c.id === "chart_" + id)!;
    expect(d("dist_mode_transport").data.map((r) => r.modalite)).toEqual(["Pas de déplacement", "Marche à pied", "Vélo", "Deux-roues motorisé", "Voiture, camion, fourgonnette", "Transports en commun"]);
    expect(d("dist_periode_construction").data).toHaveLength(6);
    expect(d("dist_csp").data).toHaveLength(8);
    expect(d("dist_diplomes").data).toHaveLength(7);
  });

  it("collecte les mêmes indicateurs pour les territoires de référence", () => {
    for (const lvl of ["epci", "departement", "region", "france"]) expect(ind("revenu_median", lvl)?.value).toBeTypeOf("number");
  });

  it("prix immobiliers DVF : médiane des ventes simples", () => {
    const p = ind("prix_m2_appartement")!;
    expect(p.denominator).toBe(41); // 40 ventes + 1 avec dépendance ; la vente multiple est exclue
    expect(p.value).toBeGreaterThan(2000);
  });

  it("produit cartes, graphiques et tableaux à partir des données collectées", () => {
    const maps = report.maps.map((m) => m.id);
    for (const id of ["map_localisation", "map_densite", "map_revenus", "map_equipements", "map_transports", "map_participation"]) expect(maps).toContain(id);
    const charts = report.charts.map((c) => c.id);
    for (const id of ["chart_pop_historique", "chart_ages", "chart_pyramide", "chart_dvf", "chart_sections", "chart_participation", "chart_dist_voitures", "chart_dist_lieu_travail"]) expect(charts).toContain(id);
    expect(report.tables.find((t) => t.id === "table_voisins")!.rows.length).toBe(8);
    // Sélecteur de période : une carte de participation par scrutin.
    expect(report.maps.filter((m) => m.group === "participation").length).toBe(3);
  });

  it("génère des constats reliés aux indicateurs, y compris des vigilances", () => {
    expect(report.findings.length).toBeGreaterThan(10);
    const vig = report.findings.filter((f) => f.kind === "vigilance");
    expect(vig.length).toBeGreaterThan(0);
    // Toute affirmation chiffrée est reliée à des indicateurs (les pistes d'action et vérifications en sont exemptées).
    for (const f of report.findings.filter((x) => x.kind !== "a_verifier" && x.kind !== "piste")) expect(f.evidence.length, f.text).toBeGreaterThan(0);
    // Toute preuve citée correspond à un indicateur existant.
    const ids = new Set(report.indicators.map((i) => `${i.id}@${i.geo.level}:${i.geo.code}`));
    for (const f of report.findings) for (const e of f.evidence) expect(ids.has(e)).toBe(true);
  });

  it("produit la fiche d'action puis les 9 parties A à I", () => {
    expect(report.sections[0].id).toBe("LFI");
    expect(report.sections.slice(1).map((s) => s.letter).join("")).toBe("ABCDEFGHI");
  });

  it("fiche d'action : bureaux de vote, carte, profil politique, actions", () => {
    const bv = report.tables.find((t) => t.id === "lfi_bureaux")!;
    expect(bv.rows).toHaveLength(6);
    expect(bv.rows[0].bv).toBe("2"); // vote LFI 35 % des exprimés, forte abstention
    expect(bv.rows[0].libelle).toBe("École fictive B");
    expect(report.maps.find((m) => m.id === "lfi_map_bv")!.layers[0].data.features).toHaveLength(6);
    const pol = report.tables.find((t) => t.id === "lfi_politique")!;
    expect(pol.columns.map((c) => c.key)).toContain("parrains");
    expect(String(pol.rows[0].parrains)).toMatch(/^40 /);
    const kinds = new Set(report.findings.filter((f) => f.theme === "strategie").map((f) => f.kind));
    for (const k of ["atout", "hypothese", "piste"]) expect(kinds).toContain(k);
    expect(report.findings.some((f) => f.theme === "strategie" && /Porte-à-porte/.test(f.text))).toBe(true);
    expect(report.tables.find((t) => t.id === "lfi_lieux")!.rows.length).toBeGreaterThan(0);
    expect(report.tables.find((t) => t.id === "lfi_socio")!.rows.length).toBeGreaterThanOrEqual(4);
  });

  it("exports HTML, DOCX et CSV", async () => {
    const { renderReportHtml } = await import("@/lib/render/html");
    const { reportToDocx } = await import("@/lib/export/docx");
    const { indicatorsCsv } = await import("@/lib/export/csv");
    const html = renderReportHtml(report);
    expect(html).toContain("Bibliographie des sources citées");
    expect(html).toContain("<svg");
    const docx = await reportToDocx(report);
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    const csv = indicatorsCsv(report);
    expect(csv.split("\r\n").length).toBe(report.indicators.length + 1);
    await fs.writeFile(path.join(os.tmpdir(), "fiche-test-mock.docx"), docx);
    await fs.writeFile(path.join(os.tmpdir(), "fiche-test-mock.json"), JSON.stringify(report));
  }, 60000);

  it("export PDF (si Chromium est disponible)", async () => {
    const { findChromium, reportToPdf } = await import("@/lib/export/pdf");
    if (!findChromium()) return;
    const pdf = await reportToPdf(report);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    await fs.writeFile(path.join(os.tmpdir(), "fiche-test-mock.pdf"), pdf);
  }, 60000);

  it("une seconde génération est servie par le cache", async () => {
    const second = await build({ codeInsee: "60159", scope: "commune" });
    const net = second.runs.filter((r) => r.requests > 0);
    expect(net.length).toBeGreaterThan(0);
    for (const r of net) expect(r.fromCache).toBe(r.requests);
  }, 60000);
});
