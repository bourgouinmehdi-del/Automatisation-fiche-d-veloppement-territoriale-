import { describe, expect, it } from "vitest";
import { circoOf, fitAspect, stitchRings } from "@/lib/collectors/carto";
import { perDay } from "@/lib/report/affiche";

describe("cartes « affiche »", () => {
  it("reconnaît la circonscription quel que soit le format des propriétés", () => {
    expect(circoOf({ codeDepartement: "12", codeCirconscription: "1202" })).toEqual({ dep: "12", num: 2 });
    expect(circoOf({ code_circ: "2A01" })).toEqual({ dep: "2A", num: 1 });
    expect(circoOf({ id_circo: "97103" })).toEqual({ dep: "971", num: 3 });
    expect(circoOf({ ref: "012-03" })).toEqual({ dep: "12", num: 3 });
    expect(circoOf({ code_dep: "5", num_circ: "4" })).toEqual({ dep: "05", num: 4 });
    expect(circoOf({ nom: "sans code" })).toBeNull();
  });
  it("réassemble les tronçons d'un plan d'eau en anneau fermé", () => {
    const rings = stitchRings([
      [[0, 0], [1, 0]],
      [[1, 1], [1, 0]],
      [[1, 1], [0, 1], [0, 0]],
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
  });
  it("élargit l'emprise aux proportions du cadre", () => {
    const [w, s, e, n] = fitAspect([2.8, 49.4, 2.81, 49.5]);
    const k = 1 / Math.cos((((s + n) / 2) * Math.PI) / 180);
    expect(((n - s) * k) / (e - w)).toBeCloseTo(1.25, 2);
    expect(perDay(2300000).replace(/\s/g, " ")).toBe("~6 300 voyageurs par jour de semaine");
  });
});
