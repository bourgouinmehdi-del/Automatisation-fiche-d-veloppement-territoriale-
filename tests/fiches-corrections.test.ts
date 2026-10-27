/** Corrections relevées sur des fiches réelles (Huelgoat, Faches-Thumesnil, Ivry, Decazeville). */
import { describe, expect, it } from "vitest";
import { frenchHours } from "@/lib/analysis/political";
import { openWeekend } from "@/lib/report/affiche";
import { servicesAccess } from "@/lib/analysis/services";

describe("marchés", () => {
  it("lit la période de l'année et reconnaît un marché de semaine", () => {
    expect(frenchHours("Jul-Aug Th 08:00-13:00")).toBe("jeudi, 8 h – 13 h (de juillet à août)");
    expect(openWeekend(frenchHours("Jul-Aug Th 08:00-13:00"))).toBe(false);
    expect(openWeekend("Jul-Aug jeu. 08:00-13:00")).toBe(false);
    expect(openWeekend(frenchHours("Sa 08:00-13:00"))).toBe(true);
    expect(openWeekend("")).toBeNull();
  });
});

describe("accès aux services en ville", () => {
  it("ne signale pas un lycée à 2 km comme point faible", () => {
    const communes = Array.from({ length: 12 }, (_, i) => ({ code: `59${String(i).padStart(3, "0")}`, at: [3 + i * 0.02, 50.6] as [number, number], pop: 18000 }));
    const eq = (type: string, commune: string, lon: number, lat: number) => ({ type, nom: "", commune, lon, lat, qp: null, adresse: "" });
    // Lycée dans toutes les communes sauf la première, à 2 km environ.
    const equip = communes.slice(1).map((c) => eq("C301", c.code, c.at[0], c.at[1]));
    const r = servicesAccess("59000", communes.map((c, i) => (i === 0 ? { ...c, at: [2.99, 50.6] as [number, number] } : c)), equip)!;
    expect(r.rows.find((x) => x.label === "Lycée")!.km).toBeLessThan(3);
    expect(r.faibles).toEqual([]);
  });
});
