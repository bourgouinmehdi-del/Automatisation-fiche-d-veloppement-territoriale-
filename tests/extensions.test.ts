/**
 * Ciblage départemental (API simulées) et lecteurs des nouvelles sources :
 * municipales, export Action Populaire, archives ZIP, reprojection,
 * croisement quartiers × bureaux de vote.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { mockFetch } from "./fixtures/mock-apis";
import type { Report } from "@/lib/types";

const dir = path.join(os.tmpdir(), `fiche-ext-${process.pid}`);
let dep: Report;

beforeAll(async () => {
  process.env.DATA_DIR = dir;
  process.env.INSEE_MIN_INTERVAL_MS = "0";
  await fs.mkdir(path.join(dir, "interne"), { recursive: true });
  await fs.writeFile(path.join(dir, "interne", "parrains.csv"), "code_commune;parrains\n60159;40\n60382;5\n60057;20\n60338;12\n");
  await fs.writeFile(path.join(dir, "interne", "groupes.csv"), "code_commune;nom;membres\n60159;Groupe d'action fictif;9\n");
  vi.stubGlobal("fetch", mockFetch());
  const { buildReport } = await import("@/lib/report/build");
  dep = await buildReport({ codeInsee: "60159", scope: "departement" });
}, 180000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("ciblage départemental", () => {
  it("propose des territoires, hors des deux plus grandes villes, avec carte et classement", () => {
    expect(dep.sections[0].id).toBe("CIBLAGE");
    const targets = dep.sections[0].blocks.find((b) => b.type === "targets") as Extract<Report["sections"][number]["blocks"][number], { type: "targets" }>;
    expect(targets.items.length).toBeGreaterThanOrEqual(2);
    expect(targets.items.map((t) => t.nom)).not.toContain("Beauvais");
    for (const t of targets.items) {
      expect(dep.tables.some((x) => x.id === t.tableId)).toBe(true);
      expect(t.raisons.length).toBeGreaterThan(0);
    }
    const classement = dep.tables.find((t) => t.id === "ciblage_classement")!;
    expect(classement.rows.length).toBeGreaterThan(targets.items.length);
    expect(classement.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["ratio", "groupe", "mairie"]));
    const map = dep.maps.find((m) => m.id === "ciblage_carte")!;
    expect(map.layers[0].labelProperty).toBe("label");
    expect(map.legend?.categories?.length).toBe(targets.items.length + 1);
  });

  it("export PDF du ciblage (si Chromium est disponible)", async () => {
    const { findChromium, reportToPdf } = await import("@/lib/export/pdf");
    const { renderReportHtml } = await import("@/lib/render/html");
    const html = renderReportHtml(dep, { sectionIds: ["CIBLAGE"] });
    expect(html).toContain("Proposition de ciblage n°1");
    if (!findChromium()) return;
    const pdf = await reportToPdf(dep, { sectionIds: ["CIBLAGE"] });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 60000);
});

describe("lecteurs des nouvelles sources", () => {
  it("municipales : lecture d'une ligne « large » et liste majoritaire", async () => {
    const { parseMunicipalRow, majorityList, nuanceFamily } = await import("@/lib/collectors/municipales");
    const row = {
      "Code commune": "89206",
      Inscrits: "5451",
      Votants: "3000",
      Exprimés: "2900",
      "Nom candidat 1": "A",
      "Prénom candidat 1": "Anne",
      "Nuance liste 1": "LDVG",
      "Libellé de liste 1": "Liste A",
      "Voix 1": "1827",
      "Sièges au CM 1": "24",
      "Nom candidat 2": "B",
      "Nuance liste 2": "LRN",
      "Libellé de liste 2": "Liste B",
      "Voix 2": "1073",
      "Sièges au CM 2": "5",
      "Nom candidat 3": "",
      "Voix 3": "",
    };
    const r = parseMunicipalRow(row, 1)!;
    expect(r.listes).toHaveLength(2);
    expect(r.listes[0].pctExprimes).toBeCloseTo(63, 0);
    expect(majorityList([r])!.nuance).toBe("LDVG");
    expect(nuanceFamily("LDVG")).toBe("gauche");
    expect(nuanceFamily("LUXD")).toBe("extreme_droite");
  });

  it("Action Populaire : commune retrouvée par code postal et ville, colonnes nominatives ignorées", async () => {
    const { parseGroupes } = await import("@/lib/collectors/interne");
    const { groupes, unmatched } = parseGroupes(
      [
        { Nom: "Groupe d'action de Compiègne", "Code postal": "60200", Ville: "Compiègne", "Nombre de membres": "12", "Date de création": "2026-09-01", Certifié: "non", Animateur: "Personne Fictive" },
        { Nom: "Groupe sans lieu", "Code postal": "", Ville: "" },
      ],
      "action-populaire.csv",
    );
    expect(groupes).toHaveLength(1);
    expect(groupes[0]).toMatchObject({ code: "60159", membres: 12, certifie: false, creation: "2026-09-01" });
    expect(JSON.stringify(groupes)).not.toContain("Personne Fictive");
    expect(unmatched).toBe(1);
  });

  it("archives ZIP lues en flux, filtrage des lignes", async () => {
    const { zipCsvRows } = await import("@/lib/collectors/zip");
    const file = path.join(os.tmpdir(), `zip-test-${process.pid}.zip`);
    const lines = ["IRIS;COM;P21_POP", ...Array.from({ length: 5000 }, (_, i) => `${i % 2 ? "89206" : "60159"}${String(i).padStart(4, "0")};${i % 2 ? "89206" : "60159"};${i}`)];
    await fs.writeFile(file, zipSync({ "dossier/base.csv": strToU8(lines.join("\n")), "meta.csv": strToU8("COD_VAR;LIB_VAR\n") }));
    const { rows, header } = await zipCsvRows(file, (n) => /base\.csv$/.test(n), (r) => r.COM === "89206", (l) => l.includes("89206"));
    expect(header).toEqual(["IRIS", "COM", "P21_POP"]);
    expect(rows).toHaveLength(2500);
    await fs.rm(file);
  });

  it("reprojection Lambert-93 → WGS84", async () => {
    const { toWgs84 } = await import("@/lib/collectors/quartiers");
    const g = toWgs84({ type: "Point", coordinates: [700000, 6600000] }) as GeoJSON.Point;
    expect(g.coordinates[0]).toBeCloseTo(3, 3);
    expect(g.coordinates[1]).toBeCloseTo(46.5, 3);
  });

  it("croisement quartiers × bureaux : part de surface et lieu de vote", async () => {
    const { matchBureaux, bureauxByQuartier, quartierOfBureau } = await import("@/lib/analysis/quartiers");
    const sq = (x: number, y: number, d: number): GeoJSON.Polygon => ({ type: "Polygon", coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
    const q = [
      { kind: "qpv" as const, code: "QN1", nom: "La Madeleine", geometry: sq(0, 0, 0.01), stats: {} },
      { kind: "iris" as const, code: "I1", nom: "Centre", geometry: sq(0, 0, 0.02), stats: {} },
    ];
    const bv = [
      { type: "Feature" as const, properties: { bv: "3" }, geometry: sq(0.001, 0.001, 0.005) },
      { type: "Feature" as const, properties: { bv: "7" }, geometry: sq(0.007, 0.007, 0.004) },
    ];
    const pts = [{ type: "Feature" as const, properties: { bv: "9" }, geometry: { type: "Point" as const, coordinates: [0.015, 0.015] } }];
    const m = matchBureaux(q, bv, pts);
    expect(bureauxByQuartier(m).get("QN1")).toEqual(["3", "7"]);
    expect(quartierOfBureau(m, "3")!.kind).toBe("qpv"); // le QPV l'emporte sur l'IRIS
    expect(quartierOfBureau(m, "9")!.quartier).toBe("I1"); // lieu de vote dans l'IRIS
  });
});
