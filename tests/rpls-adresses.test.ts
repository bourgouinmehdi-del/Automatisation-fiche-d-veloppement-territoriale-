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

describe("logements sociaux : abréviations et accents (retour Montargis)", () => {
  it("« RU » = rue ; « Sirene » et « Sirène » : une seule rue ; nom mal encodé nettoyé", () => {
    const base = { X: "2.73", Y: "48.0", EPSG: "4326", DEPCOM: "45208" };
    const rows = [
      ...Array(3).fill({ ...base, NUMVOIE: "4", TYPVOIE: "RU", NOMVOIE: "DE CROWBOROUGH", COMPLGEO: "" }),
      ...Array(2).fill({ ...base, NUMVOIE: "2", TYPVOIE: "RUE", NOMVOIE: "DE LA SIRENE", COMPLGEO: "MONTARGIS SIRENE (LABELLIS?E)" }),
      ...Array(2).fill({ ...base, NUMVOIE: "57", TYPVOIE: "RUE", NOMVOIE: "DE LA SIRÈNE", COMPLGEO: "" }),
    ];
    const rues = hlmByStreet(groupRpls(rows).residences);
    expect(rues.map((r) => r.voie).sort()).toEqual(["Rue de Crowborough", "Rue de la Sirène"]);
    expect(rues.find((r) => r.voie === "Rue de la Sirène")!.noms).toEqual(["Montargis Sirene"]);
  });
});

describe("logements sociaux : numéros vides, bâtiments, accents (retour Pont-l'Évêque)", () => {
  it("« n° 0 », « Bat G - 6 Lgts », « Alencon »", () => {
    const base = { X: "0.19", Y: "49.28", EPSG: "4326", DEPCOM: "14514" };
    const rows = [
      ...Array(3).fill({ ...base, NUMVOIE: "0 -", TYPVOIE: "RTE", NOMVOIE: "DE ROUEN", COMPLGEO: "" }),
      ...Array(2).fill({ ...base, NUMVOIE: "2", TYPVOIE: "RUE", NOMVOIE: "D ALENCON", COMPLGEO: "" }),
      ...Array(2).fill({ ...base, NUMVOIE: "1", TYPVOIE: "RUE", NOMVOIE: "DES PRAIRIES", COMPLGEO: "LES LONGS CHAMPS - BAT G - 6 LGTS" }),
    ];
    const rues = hlmByStreet(groupRpls(rows).residences);
    const rouen = rues.find((r) => /Rouen/.test(r.voie))!;
    expect(rouen.nums).toEqual([]);
    expect(rues.some((r) => /Alençon/.test(r.voie))).toBe(true);
    expect(rues.find((r) => /Prairies/.test(r.voie))!.noms).toEqual(["Les Longs Champs"]);
  });
});

describe("logements sociaux : numéro suivi d'une virgule, lettre (retour Farébersviller)", () => {
  it("« 1, RUE … » et « 3, RUE … » : une seule rue ; « 1 D » → « 1D »", () => {
    const base = { X: "6.87", Y: "49.12", EPSG: "4326", DEPCOM: "00000" };
    const rows = [
      ...Array(2).fill({ ...base, NUMVOIE: "", TYPVOIE: "", NOMVOIE: "1, RUE DES TILLEULS", COMPLGEO: "" }),
      ...Array(2).fill({ ...base, NUMVOIE: "3", TYPVOIE: "RUE", NOMVOIE: "3, RUE DES TILLEULS", COMPLGEO: "" }),
      ...Array(2).fill({ ...base, NUMVOIE: "1", INDREP: "D", TYPVOIE: "IMP", NOMVOIE: "DES CHENES", COMPLGEO: "" }),
    ];
    const rues = hlmByStreet(groupRpls(rows).residences);
    expect(rues.find((r) => r.voie === "Rue des Tilleuls")).toMatchObject({ nums: ["1", "3"], logements: 4 });
    expect(rues.find((r) => /Chênes|Chenes/.test(r.voie))!.nums).toEqual(["1D"]);
  });
});
