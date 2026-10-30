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
  it("commune sur deux codes postaux (Porte-de-Seine, 27100 et 27430) : pas la somme des deux", () => {
    const b = new Map<string, Bilan>([
      ["27701", { actions: 8, ga: 1, parrains: 50, inscrits: 8000, estime: true }], // Val-de-Reuil, 27100
      ["27528", { actions: 1, ga: 1, parrains: 5, inscrits: 800, estime: true }], // Le Vaudreuil, 27100
      ["27471", { actions: 0, ga: 2, parrains: 1, inscrits: 190, estime: true }], // Porte-de-Seine, 27100 + 27430
      ["27598", { actions: 1, ga: 1, parrains: 5, inscrits: 900, estime: true }], // Saint-Pierre-du-Vauvray, 27430
    ]);
    const d = dedupeBilanGa(b);
    expect(d.get("27701")!.ga).toBe(1);
    expect(d.get("27471")!.ga).toBe(0);
    expect(d.get("27598")!.ga).toBe(1);
  });
  it("export Action Populaire avec actions : groupes actifs comptés par code INSEE", async () => {
    const { gaFromGroupes } = await import("@/lib/collectors/interne");
    const b = new Map<string, Bilan>([["27701", { actions: 8, ga: 1, parrains: 50, inscrits: 8000, estime: true }], ["60159", { actions: 20, ga: 2, parrains: 200, inscrits: 20000, estime: false }]]);
    const g = (code: string, actions: number) => ({ code, nom: `G${Math.random()}`, membres: null, statut: "", description: "", actions });
    const groupes = [...Array(3)].map(() => g("27701", 12)).concat([...Array(8)].map(() => g("76540", 6)), [g("27701", 1)]);
    const d = gaFromGroupes(b, groupes);
    expect(d.get("27701")!.ga).toBe(3);
    expect(d.get("60159")!.ga).toBe(2);
  });
});
