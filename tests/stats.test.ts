import { describe, expect, it } from "vitest";
import { cagr, comparableCommunes, density, gap, haversineKm, mad, median, pctChange, quantileBreaks, rankOf, robustZ, seriesEvolution } from "@/lib/analysis/stats";

describe("statistiques de base", () => {
  it("médiane et MAD", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1);
  });
  it("score z robuste : null si moins de 5 points ou dispersion nulle", () => {
    expect(robustZ(10, [1, 2, 3])).toBeNull();
    expect(robustZ(10, [5, 5, 5, 5, 5])).toBeNull();
    const z = robustZ(10, [1, 2, 3, 4, 5]);
    // médiane 3, MAD 1 → (10-3)/1.4826
    expect(z).toBeCloseTo(7 / 1.4826, 6);
  });
  it("taux de croissance annuel moyen", () => {
    expect(cagr(100, 121, 2)).toBeCloseTo(10, 10);
    expect(cagr(0, 10, 2)).toBeNull();
    expect(pctChange(200, 150)).toBe(-25);
  });
  it("densité", () => {
    expect(density(1000, 4)).toBe(250);
    expect(density(null, 4)).toBeNull();
    expect(density(1000, 0)).toBeNull();
  });
});

describe("règle de significativité des écarts", () => {
  it("taux : ≥ 2 points ET ≥ 10 % relatif", () => {
    expect(gap(22, 20, "%").significant).toBe(true); // +2 pts, +10 %
    expect(gap(21.5, 20, "%").significant).toBe(false); // +1,5 pt
    expect(gap(52, 50, "%").significant).toBe(false); // +2 pts mais +4 %
    expect(gap(15, 20, "%")).toMatchObject({ significant: true, direction: "inferieur", unit: "points" });
  });
  it("grandeurs : ≥ 10 % relatif", () => {
    expect(gap(22000, 20000, "€").significant).toBe(true);
    expect(gap(21000, 20000, "€")).toMatchObject({ significant: false, direction: "proche" });
  });
});

describe("séries et classes", () => {
  it("évolution sur ~10 ans", () => {
    const ev = seriesEvolution(
      [
        { x: "2006", y: 100 },
        { x: "2011", y: 110 },
        { x: "2016", y: 115 },
        { x: "2021", y: 121 },
      ],
      10,
    )!;
    expect(ev.from).toBe(2011);
    expect(ev.to).toBe(2021);
    expect(ev.annual).toBeCloseTo((Math.pow(121 / 110, 1 / 10) - 1) * 100, 10);
  });
  it("bornes de quantiles", () => {
    expect(quantileBreaks([1, 2, 3, 4, 5], 4)).toEqual([1, 2, 3, 4, 5]);
    expect(quantileBreaks([], 5)).toEqual([]);
  });
  it("rang", () => {
    expect(rankOf([{ c: "a", v: 3 }, { c: "b", v: 9 }, { c: "c", v: null }], (x) => x.v, (x) => x.c === "a")).toEqual({ rank: 2, of: 2 });
  });
  it("communes comparables : ±tolérance, triées par proximité, sans la cible", () => {
    const all = [
      { code: "A", population: 1000 },
      { code: "B", population: 1100 },
      { code: "C", population: 1500 },
      { code: "D", population: 950 },
    ];
    expect(comparableCommunes(all, { code: "A", population: 1000 }, 0.2).map((c) => c.code)).toEqual(["D", "B"]);
  });
  it("distance orthodromique Paris–Lyon ≈ 392 km", () => {
    expect(haversineKm([2.3522, 48.8566], [4.8357, 45.764])).toBeCloseTo(392, -1);
  });
});

describe("rendu", () => {
  it("les graduations couvrent la valeur maximale", async () => {
    const { niceTicks } = await import("@/lib/render/svg");
    const t = niceTicks(0, 19.7);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(19.7);
    expect(niceTicks(0, 20).at(-1)).toBe(20);
  });
  it("balisage **gras**", async () => {
    const { inlineParts, stripMarks } = await import("@/lib/render/cite");
    expect(inlineParts("a **b** c")).toEqual([
      { text: "a ", bold: false },
      { text: "b", bold: true },
      { text: " c", bold: false },
    ]);
    expect(stripMarks("2 809 **(9,8 %)**")).toBe("2 809 (9,8 %)");
  });
});

describe("zones électorales (bureaux voisins qui votent pareil)", () => {
  it("regroupe des bureaux contigus au profil proche", async () => {
    const { electoralZones, compass } = await import("@/lib/analysis/zones");
    // Grille 5 × 4 de bureaux carrés : ouest très LFI et abstentionniste, est modéré, une bande sud à part.
    const sq = (i: number, j: number): GeoJSON.Polygon => ({ type: "Polygon", coordinates: [[[i * 0.01, j * 0.01], [(i + 1) * 0.01, j * 0.01], [(i + 1) * 0.01, (j + 1) * 0.01], [i * 0.01, (j + 1) * 0.01], [i * 0.01, j * 0.01]]] });
    const units = [];
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 4; j++) {
        const x = j === 0 ? [8, 30, 25] : i < 2 ? [45, 10, 55] : [15, 20, 35];
        units.push({ bv: `${i}-${j}`, inscrits: 1000, x: x.map((v) => v + ((i + j) % 2)), geometry: sq(i, j) });
      }
    const zones = electoralZones(units, 3);
    expect(zones).toHaveLength(3);
    const zoneOf = (bv: string) => zones.findIndex((z) => z.bvs.includes(bv));
    // Ouest (hors bande sud) ensemble, est ensemble, bande sud ensemble.
    expect(new Set(["0-1", "0-2", "1-3", "1-1"].map(zoneOf)).size).toBe(1);
    expect(new Set(["3-1", "4-3", "2-2"].map(zoneOf)).size).toBe(1);
    expect(new Set(["0-0", "2-0", "4-0"].map(zoneOf)).size).toBe(1);
    expect(zoneOf("0-1")).not.toBe(zoneOf("4-1"));
    expect(compass([0.0, 0.02], [0.025, 0.02], 3)).toBe("ouest");
    expect(compass([0.025, 0.0201], [0.025, 0.02], 3)).toBe("centre");
  });
});
