/**
 * Élections : chemin « téléchargement du fichier » (ressource non indexée par
 * l'API tabulaire), avec fichiers SIMULÉS reproduisant les formats du ministère :
 *  - 2024 : colonnes nommées « Libellé de la liste 1 », « Voix 1 »… ;
 *  - 2022 : seul le premier bloc candidat a un en-tête, les suivants sont anonymes.
 * Le fichier simulé couvre ~35 000 communes pour vérifier la tenue en mémoire.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const dir = path.join(os.tmpdir(), `fiche-elec-${process.pid}`);

function file2024() {
  const head = "Code département;Libellé département;Code commune;Libellé commune;Inscrits;Votants;Abstentions;Blancs;Nuls;Exprimés;Libellé de la liste 1;Voix 1;Libellé de la liste 2;Voix 2";
  const lines = [head];
  for (let d = 1; d <= 95; d++)
    for (let k = 1; k <= 370; k++) {
      const dep = String(d).padStart(2, "0");
      const code = dep + String(k).padStart(3, "0");
      lines.push(`${dep};Dép;${code};Commune ${code};1000;600;400;10;5;585;Liste A;300;Liste B;285`);
    }
  return lines.join("\n");
}

function file2022() {
  const head = "Code du département;Libellé du département;Code de la commune;Libellé de la commune;Inscrits;Abstentions;Votants;Blancs;Nuls;Exprimés;N°Panneau;Sexe;Nom;Prénom;Voix;% Voix/Ins;% Voix/Exp";
  const lines = [head];
  for (let d = 1; d <= 95; d++)
    for (let k = 1; k <= 370; k++)
      lines.push(`${d};Dép;${k};Commune;1000;300;700;10;10;680;1;F;ALPHA;Anne;400;40,00;58,82;2;M;BETA;Bruno;280;28,00;41,18`);
  return lines.join("\n");
}

beforeAll(() => {
  process.env.DATA_DIR = dir;
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });
    if (u.host === "www.data.gouv.fr") {
      const is22 = u.pathname.includes("presidentielle");
      return json({
        slug: "x",
        resources: [{ id: is22 ? "r22" : "r24", title: is22 ? "resultats-par-niveau-subcom-t1-france-entiere.txt" : "resultats-definitifs-par-commune.csv", format: is22 ? "txt" : "csv", url: `https://static.data.gouv.fr/${is22 ? "f22.txt" : "f24.csv"}` }],
      });
    }
    if (u.host === "tabular-api.data.gouv.fr") {
      // Ressource 2022 indexée, mais sans les blocs candidats anonymes (comportement réel de l'API).
      if (u.pathname.includes("r22"))
        return json({
          data: [{ "Code du département": "60", "Code de la commune": "159", Inscrits: 1000, Abstentions: 300, Votants: 700, Blancs: 10, Nuls: 10, Exprimés: 680, "N°Panneau": 1, Sexe: "F", Nom: "ALPHA", Prénom: "Anne", Voix: 400 }],
          links: { next: null },
        });
      return json({ message: "not found" }, 404);
    }
    if (u.host === "static.data.gouv.fr") return new Response(u.pathname.includes("f22") ? file2022() : file2024());
    throw new TypeError("fetch failed");
  }) as typeof fetch);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("élections — lecture du fichier national", () => {
  it("format 2024 : commune et département, sans charger toute la France en mémoire", async () => {
    const { collectElection, ELECTIONS } = await import("@/lib/collectors/elections");
    const { TrackedHttp } = await import("@/lib/collectors/context");
    const before = process.memoryUsage().heapUsed;
    const r = await collectElection(new TrackedHttp(), ELECTIONS.find((e) => e.id === "EU24")!, "60159", "60");
    const com = r.find((x) => x.level === "commune")!;
    const dep = r.find((x) => x.level === "departement")!;
    expect(com).toMatchObject({ inscrits: 1000, votants: 600, exprimes: 585 });
    expect(com.candidates).toEqual([
      { label: "Liste A", voix: 300 },
      { label: "Liste B", voix: 285 },
    ]);
    expect(dep.inscrits).toBe(370 * 1000);
    expect(dep.byCommune).toHaveLength(370);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(400 * 1024 * 1024);
  }, 60000);

  it("format 2022 : blocs candidats sans en-tête (API tabulaire incomplète → fichier) et codes sur 3 caractères", async () => {
    const { collectElection, ELECTIONS } = await import("@/lib/collectors/elections");
    const { TrackedHttp } = await import("@/lib/collectors/context");
    const r = await collectElection(new TrackedHttp(), ELECTIONS.find((e) => e.id === "PR22T1")!, "60159", "60");
    const com = r.find((x) => x.level === "commune")!;
    expect(com).toMatchObject({ inscrits: 1000, votants: 700, exprimes: 680 });
    expect(com.candidates).toEqual([
      { label: "ALPHA", voix: 400 },
      { label: "BETA", voix: 280 },
    ]);
    expect(r.find((x) => x.level === "departement")!.byCommune!.some((x) => x.code === "60159")).toBe(true);
  }, 60000);
});
