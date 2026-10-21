import { describe, expect, it } from "vitest";
import { familyVotes, frenchHours, lfiOverperformance, rankBureaux, score } from "@/lib/analysis/political";
import { ELECTIONS, normBv, pickResource } from "@/lib/collectors/elections";
import type { BureauResult, ElectionResult } from "@/lib/collectors/elections";

const EU = ELECTIONS.find((e) => e.id === "EU24")!;
const bv = (n: string, ins: number, vot: number, lfi: number, other: number): BureauResult => ({
  election: EU,
  bv: n,
  inscrits: ins,
  votants: vot,
  abstentions: ins - vot,
  exprimes: lfi + other,
  blancs: 0,
  nuls: 0,
  candidates: [
    { label: "LA FRANCE INSOUMISE - UNION POPULAIRE", voix: lfi },
    { label: "REVEILLER L'EUROPE", voix: other },
  ],
  sourceUrl: "",
  retrievedAt: "",
});

describe("familles politiques", () => {
  it("reconnaît LFI selon le scrutin", () => {
    expect(familyVotes("EU24", { inscrits: 100, votants: 50, exprimes: 50, candidates: [{ label: "LA FRANCE INSOUMISE - UNION POPULAIRE", voix: 10 }, { label: "AUTRE", voix: 40 }] }, "lfi")).toBe(10);
    expect(familyVotes("PR22T1", { inscrits: 100, votants: 50, exprimes: 50, candidates: [{ label: "MÉLENCHON", voix: 12 }] }, "lfi")).toBe(12);
    // Européennes 2024 : nuances de liste du ministère (LFI, LRN, LENS, LUG…).
    const eu = { inscrits: 100, votants: 60, exprimes: 60, candidates: [{ label: "LRN", voix: 20 }, { label: "LFI", voix: 9 }, { label: "LUG", voix: 8 }, { label: "LCOM", voix: 2 }] };
    expect(familyVotes("EU24", eu, "rn")).toBe(20);
    expect(familyVotes("EU24", eu, "lfi")).toBe(9);
    expect(familyVotes("EU24", eu, "ps")).toBe(8);
    expect(familyVotes("EU24", eu, "pcf")).toBe(2);
    // … ou libellés abrégés (« LFI - UP », « La FRANCE REVIENT », « REVEIL EUR »).
    const eu2 = { inscrits: 100, votants: 60, exprimes: 60, candidates: [{ label: "LFI - UP", voix: 9 }, { label: "La FRANCE REVIENT", voix: 20 }, { label: "REVEIL EUR", voix: 8 }, { label: "LA FRANCE FIERE, MENEE PAR MARION MARECHAL", voix: 3 }] };
    expect(familyVotes("EU24", eu2, "lfi")).toBe(9);
    expect(familyVotes("EU24", eu2, "rn")).toBe(20);
    expect(familyVotes("EU24", eu2, "ps")).toBe(8);
    expect(familyVotes("EU24", eu2, "rec")).toBe(3);
    // Pas de liste LFI identifiable aux législatives 2024 (candidatures NFP).
    expect(familyVotes("LG24T1", { inscrits: 100, votants: 50, exprimes: 50, candidates: [{ label: "UG", voix: 12 }] }, "lfi")).toBeNull();
    expect(score("EU24", { inscrits: 200, votants: 100, exprimes: 80, candidates: [{ label: "LFI", voix: 20 }] }, "lfi")).toEqual({ voix: 20, pctInscrits: 10, pctExprimes: 25 });
  });
});

describe("classement des bureaux de vote", () => {
  const rows = rankBureaux(
    [bv("1", 1000, 600, 60, 540), bv("2", 1000, 400, 120, 280), bv("3", 1000, 700, 50, 650), bv("4", 1000, 450, 40, 410), bv("5", 1000, 650, 140, 510), bv("6", 1000, 500, 70, 430)],
    null,
    new Map([["2", "École A"]]),
  );
  it("priorise le vote LFI élevé combiné à une forte abstention", () => {
    expect(rows[0].bv).toBe("2"); // 30 % des exprimés et 60 % d'abstention
    expect(rows[0].label).toBe("École A");
    expect(rows[0].type).toBe("bastion_a_mobiliser");
    expect(rows.filter((r) => r.priorite === 1)).toHaveLength(2);
    expect(rows.find((r) => r.bv === "3")!.type).toBe("terrain_difficile");
  });
  it("apparie un second scrutin uniquement si les inscrits restent comparables", () => {
    const r2 = rankBureaux([bv("1", 1000, 600, 60, 540)], [bv("1", 1100, 700, 100, 600)], new Map());
    expect(r2[0].lfi2PctIns).toBeCloseTo((100 / 1100) * 100, 6);
    const r3 = rankBureaux([bv("1", 1000, 600, 60, 540)], [bv("1", 2000, 700, 100, 600)], new Map());
    expect(r3[0].lfi2PctIns).toBeNull();
  });
});

describe("surperformance", () => {
  it("compare à la médiane des communes de taille comparable du département", () => {
    const mk = (code: string, ins: number, lfi: number) => ({ code, inscrits: ins, votants: ins / 2, exprimes: ins / 2, candidates: [{ label: "LFI", voix: lfi }] });
    const dep = { byCommune: [mk("A", 1000, 100), mk("B", 1000, 40), mk("C", 1000, 50), mk("D", 1000, 60), mk("E", 1000, 50), mk("F", 1000, 45), mk("G", 100000, 1)] } as unknown as ElectionResult;
    const pops = new Map<string, number | null>([["A", 1000], ["B", 900], ["C", 1100], ["D", 1200], ["E", 950], ["F", 1050], ["G", 100000]]);
    const o = lfiOverperformance("EU24", dep, "A", pops)!;
    expect(o.commune).toBe(10);
    expect(o.median).toBe(5); // B..F (G exclue : taille non comparable)
    expect(o.n).toBe(5);
  });
});

describe("utilitaires", () => {
  it("normalise les numéros de bureau", () => {
    expect(normBv("0003")).toBe("3");
    expect(normBv("60159_12")).toBe("12");
    expect(normBv("0")).toBe("0");
  });
  it("choisit la ressource par bureau de vote", () => {
    const res = [
      { id: "a", title: "resultats-definitifs-par-commune.csv", format: "csv" },
      { id: "b", title: "resultats-definitifs-par-bureau-de-vote.csv", format: "csv" },
      { id: "c", title: "resultats-par-niveau-burvot-t1-france-entiere.xlsx", format: "xlsx" },
    ];
    expect(pickResource(res, "bureau")?.id).toBe("b");
    expect(pickResource(res, "commune")?.id).toBe("a");
    expect(pickResource([{ id: "d", title: "resultats-par-niveau-burvot-t1-france-entiere.txt", format: "txt" }], "bureau")?.id).toBe("d");
  });
  it("traduit les horaires OpenStreetMap", () => {
    expect(frenchHours("We,Sa 08:00-13:00")).toBe("mercredi et samedi, 8 h – 13 h");
    expect(frenchHours("Tu-Sa 08:00-19:00; Mo,Su off")).toBe("du mardi au samedi, 8 h – 19 h");
    expect(frenchHours("Mo-Fr 08:00-12:00,14:00-18:30; PH off")).toBe("du lundi au vendredi, 8 h – 12 h et 14 h – 18 h 30");
  });
});

describe("introduction du profil politique", () => {
  it("ne dit que ce qui ressort, dans l'ordre demandé", async () => {
    const { politiqueIntro } = await import("@/lib/report/lfi");
    const nat19 = { pcf: 2.49, lfi: 6.31, eco: 13.48, ps: 6.19, ens: 22.42, lr: 8.48, rn: 23.34 };
    const nat24 = { pcf: 2.36, lfi: 9.89, eco: 5.5, ps: 13.83, ens: 14.6, lr: 7.25, rn: 31.37, rec: 5.47 };
    const t0 = politiqueIntro(
      [
        { eid: "PR17T1", sh: { lfi: 25, ps: 5, ens: 20, lr: 15, rn: 25 }, nat: { lfi: 19.58, ps: 6.36, ens: 24.01, lr: 20.01, rn: 21.3 }, abst: 25 },
        { eid: "EU19", sh: { pcf: 2, lfi: 7, eco: 10, ps: 5, ens: 18, lr: 6, rn: 27 }, nat: nat19, abst: 55 },
        { eid: "PR22T1", sh: { pcf: 2, lfi: 18, eco: 4, ps: 1, ens: 25, lr: 4, rn: 30, rec: 6 }, nat: { pcf: 2.28, lfi: 21.95, eco: 4.63, ps: 1.75, ens: 27.85, lr: 4.78, rn: 23.15, rec: 7.07 }, abst: 30 },
        { eid: "EU24", sh: { pcf: 2, lfi: 8, eco: 4, ps: 11, ens: 12, lr: 6, rn: 42, rec: 5 }, nat: nat24, abst: 56 },
      ],
      [
        { nom: "dans le nord-est", lfi: 30, lfi19: 12 },
        { nom: "dans le sud", lfi: 6, lfi19: 5 },
        { nom: "au centre", lfi: 10, lfi19: 7 },
      ],
    );
    const t = t0.replace(/[\u00a0\u202f]/g, " ");
    expect(t).toMatch(/La gauche recule par rapport à la France : 4 points au-dessus de la moyenne nationale à la présidentielle 2017, 7 points en dessous aux européennes 2024\./);
    expect(t).toMatch(/^Le RN arrive en tête aux européennes 2024 \(42 %\), en forte progression : 27 % aux européennes 2019\./);
    expect(t).toMatch(/LFI était 5 points au-dessus de la moyenne nationale en 2017, 2 points en dessous de la moyenne nationale en 2024\./);
    expect(t).toMatch(/On y vote moins qu'en France : 56 % d'abstention aux européennes 2024 \(49 % en France\)\./);
    expect(t).toMatch(/Le vote LFI a surtout progressé dans le nord-est de la commune : de 12 % aux européennes 2019 à 30 % en 2024\./);
    expect(t).toMatch(/très inégal .* 30 % dans le nord-est, 6 % dans le sud/);
    expect(t).not.toMatch(/exprimés|\bpts\b/);
  });
});
