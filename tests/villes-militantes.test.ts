import { describe, expect, it } from "vitest";
import { chooseHubs } from "@/lib/report/acces";

/** Coordonnées approximatives des centres ; groupes et parrains fictifs. */
const c = (code: string, lon: number, lat: number, ga: number, parrains: number, km: number) => ({ l: { code, lon, lat }, b: { ga, parrains }, km });

describe("choix des villes militantes proches", () => {
  it("Charente-Maritime : une par agglomération, la grande ville la plus proche en dernier", () => {
    const all = [
      c("17300", -1.15, 46.16, 6, 800, 5), // La Rochelle
      c("17200", -1.155, 46.19, 1, 45, 7), // Lagord, même agglomération
      c("17274", -1.1, 46.15, 1, 42, 4), // Périgny, même agglomération
      c("17415", -0.63, 45.75, 2, 180, 20), // Saintes
      c("16102", -0.33, 45.69, 2, 70, 30), // Cognac
      c("79191", -0.46, 46.32, 8, 460, 45), // Niort
      c("16015", 0.16, 45.65, 5, 690, 60), // Angoulême
      c("33063", -0.58, 44.84, 18, 4400, 85), // Bordeaux
      c("44109", -1.55, 47.22, 11, 5700, 120), // Nantes
    ];
    const h = chooseHubs(all, 6).map((x) => x.l.code);
    expect(h).not.toContain("17200");
    expect(h).not.toContain("17274");
    expect(h).toContain("16015");
    expect(h[h.length - 1]).toBe("33063");
    expect(h).not.toContain("44109");
  });
  it("Île-de-France : les villes voisines restent distinctes", () => {
    const all = [c("94081", 2.39, 48.79, 1, 800, 3), c("75056", 2.35, 48.86, 70, 31000, 7), c("94041", 2.38, 48.81, 1, 1000, 1)];
    expect(chooseHubs(all, 6).map((x) => x.l.code).sort()).toEqual(["75056", "94041", "94081"]);
  });
});
