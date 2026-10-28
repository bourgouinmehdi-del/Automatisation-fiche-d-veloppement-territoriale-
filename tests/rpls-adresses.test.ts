import { describe, expect, it } from "vitest";
import { groupRpls, hlmByStreet } from "@/lib/collectors/rpls";

describe("logements sociaux : adresses", () => {
  it("numéro écrit dans le nom de voie : une seule rue, pas trois (retour Avon)", () => {
    const base = { X: "2.73", Y: "48.41", EPSG: "4326", DEPCOM: "77014" };
    const rows = [
      ...Array(5).fill({ ...base, NUMVOIE: "", TYPVOIE: "AV", NOMVOIE: "1-3 DU GENERAL DE GAULLE", COMPLGEO: "" }),
      ...Array(3).fill({ ...base, NUMVOIE: "", TYPVOIE: "", NOMVOIE: "1/3 AVENUE DU GENERAL DE GAULLE", COMPLGEO: "ARMADE" }),
      ...Array(4).fill({ ...base, NUMVOIE: "27", TYPVOIE: "AV", NOMVOIE: "DU GENERAL DE GAULLE", COMPLGEO: "" }),
      ...Array(2).fill({ ...base, NUMVOIE: "2", TYPVOIE: "RUE", NOMVOIE: "DES BOULEAUX", COMPLGEO: "AVON PEUPLIERS-BOULEAUX AA" }),
    ];
    const g = groupRpls(rows);
    const rues = hlmByStreet(g.residences);
    expect(rues[0]).toMatchObject({ voie: "Avenue du Général de Gaulle", nums: ["1", "3", "27"], logements: 12, noms: ["Armade"] });
    expect(rues[1].noms).toEqual(["Avon Peupliers-Bouleaux"]);
  });
});
