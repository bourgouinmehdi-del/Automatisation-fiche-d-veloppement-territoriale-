import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { filterCsvFile } from "@/lib/collectors/elections";

describe("lecture en flux du fichier national", () => {
  it("filtre un département, gère le BOM, le latin1 et les virgules décimales", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "elec-"));
    const csv =
      "﻿Code du département;Libellé du département;Code de la commune;Libellé de la commune;Inscrits;Votants;Exprimés;% Exp/Ins;Nom;Voix\n" +
      "60;Oise;159;Compiègne;100;60;50;50,00;DUPONT;30\n" +
      "02;Aisne;408;Laon;80;40;35;43,75;DUPONT;10\n" +
      "60;Oise;175;Creil;90;50;45;50,00;Hélène;20\n";
    const file = path.join(dir, "res.csv");
    await fs.writeFile(file, Buffer.from(csv.slice(1), "latin1"));
    const { rows, fields } = await filterCsvFile(file, "60", "Test");
    expect(fields[0]).toBe("Code du département");
    expect(rows).toHaveLength(2);
    expect(rows[1]["Nom"]).toBe("Hélène");
    expect(rows[0]["% Exp/Ins"]).toBe("50,00");
    await fs.writeFile(file, csv, "utf8");
    const u = await filterCsvFile(file, "60", "Test");
    expect(u.fields[0]).toBe("Code du département");
    expect(u.rows[1]["Libellé de la commune"]).toBe("Creil");
  });
});
