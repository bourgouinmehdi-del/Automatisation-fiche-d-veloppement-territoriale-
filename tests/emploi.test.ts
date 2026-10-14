import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

describe("demandeurs d'emploi (fichiers France Travail)", () => {
  it("import en flux (gzip), découpage par département, Paris = somme des arrondissements", async () => {
    process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "stmt-"));
    const { importStmt, loadStmt, stmtSummary, removeStmt } = await import("@/lib/collectors/emploi");
    const { duree } = await import("@/lib/report/emploi");
    const csv = "COMRES;MOISTA;_FREQ_;part_fem;AGE_m;ancien_m;ancien_mn\n75101;202608;100;0.5;40;300;\n75102;202608;300;0.6;30;600;\n2A004;202608;50;;;;\n97411;202608;7;0.4;35;100;\n";
    const r = await importStmt(Readable.from(gzipSync(csv)), { gzip: true });
    expect(r).toMatchObject({ kind: "communes", rows: 4, communes: 4, last: "202608" });
    const files = await fs.readdir(path.join(process.env.DATA_DIR!, "interne", "demandeurs-emploi"));
    expect(files).toEqual(expect.arrayContaining(["dep-75.csv", "dep-2A.csv", "dep-974.csv"]));
    const s = (await loadStmt(["75101", "75102"], "75"))!;
    expect(s.commune[0]).toMatchObject({ n: 400, fem: 0.575, age: 32.5, anc: 525 });
    expect(s.france).toEqual([]);
    expect((await stmtSummary()).communes?.communes).toBe(4);
    await expect(importStmt(Readable.from("a;b\n1;2\n"))).rejects.toThrow(/COMRES/);
    await removeStmt("communes");
    expect(await loadStmt(["75101"], "75")).toBeNull();
    expect(duree(525)).toBe("1 an et 5 mois");
    expect(duree(300)).toBe("10 mois");
  });
});
