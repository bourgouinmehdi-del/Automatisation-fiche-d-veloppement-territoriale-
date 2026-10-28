import { describe, expect, it } from "vitest";
import { dedupeBilanGa, type Bilan } from "@/lib/collectors/interne";

/** Valeurs fictives ; codes INSEE réels (code postal 07100 partagé). */
describe("bilan : groupes d'action recopiés sur tout un code postal", () => {
  it("07100 : les groupes restent à la plus grande commune (Annonay), pas aux communes voisines", () => {
    const b = new Map<string, Bilan>([
      ["07010", { actions: 50, ga: 3, parrains: 100, inscrits: 10000, estime: true }],
      ["07041", { actions: 5, ga: 3, parrains: 10, inscrits: 1500, estime: true }],
      ["07265", { actions: 3, ga: 3, parrains: 6, inscrits: 1000, estime: true }],
      // Commune non estimée : chiffres réels, inchangés.
      ["60159", { actions: 20, ga: 2, parrains: 200, inscrits: 20000, estime: false }],
    ]);
    const d = dedupeBilanGa(b);
    expect(d.get("07010")!.ga).toBe(3);
    expect(d.get("07041")!.ga).toBe(0);
    expect(d.get("07265")!.ga).toBe(0);
    expect(d.get("07041")!.parrains).toBe(10);
    expect(d.get("60159")!.ga).toBe(2);
  });
});
