/**
 * Précision selon la taille et le type de territoire (petites communes,
 * arrondissements, outre-mer) et lisibilité des noms.
 */
import { describe, expect, it } from "vitest";
import { prettyBvLabel, rankBureaux } from "@/lib/analysis/political";
import { quartierLabel } from "@/lib/analysis/quartiers";
import { ELECTIONS, normDep } from "@/lib/collectors/elections";
import type { BureauResult } from "@/lib/collectors/elections";
import { aNom, deNom } from "@/lib/format";
import { gareNom } from "@/lib/report/affiche";

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

describe("bureaux prioritaires selon la taille", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => bv(String(i + 1), 1000, 500 + (i % 7) * 20, 50 + (i % 5) * 15, 400));
  it("proportionne le nombre de bureaux prioritaires", () => {
    for (const [n, p] of [[3, 1], [6, 2], [15, 3], [36, 4], [72, 6]] as const) expect(rankBureaux(many(n), null, new Map()).filter((b) => b.priorite === 1)).toHaveLength(p);
  });
  it("ne qualifie pas de « fort » ou « faible » des bureaux qui se ressemblent", () => {
    const r = rankBureaux([bv("1", 735, 380, 21, 330), bv("2", 800, 420, 24, 370), bv("3", 860, 470, 26, 410)], null, new Map());
    expect(new Set(r.map((b) => b.profil.split(",")[0]))).toEqual(new Set(["LFI moyen"]));
  });
});

describe("noms lisibles", () => {
  it("lieux de vote : numéro retiré, accents et minuscules", () => {
    expect(prettyBvLabel("22 école Elementaire Anton Makarenko A")).toBe("École élémentaire Anton Makarenko A");
    expect(prettyBvLabel("35 maison de Quartier Monmousseau")).toBe("Maison de quartier Monmousseau");
    expect(prettyBvLabel("Groupe Sco Pierre Zobda Quitman Bat A")).toBe("Groupe scolaire Pierre Zobda Quitman bât. A");
  });
  it("quartiers : mots de liaison, numéros d'IRIS", () => {
    expect(quartierLabel("Frange Ouest Du Centre-Ville Aggloméré")).toBe("Frange Ouest du Centre-Ville Aggloméré");
    expect(quartierLabel("Pierre Et Marie Curie")).toBe("Pierre et Marie Curie");
    expect(quartierLabel("Gare 31")).toBe("Gare (secteur 31)");
    expect(quartierLabel("La Victoire")).toBe("la Victoire");
  });
  it("articles et élisions", () => {
    expect(aNom("Le Lamentin")).toBe("au Lamentin");
    expect(deNom("Le Lamentin")).toBe("du Lamentin");
    expect(deNom("Ivry-sur-Seine")).toBe("d'Ivry-sur-Seine");
    expect(deNom("Compiègne")).toBe("de Compiègne");
    expect(gareNom("Ivry-sur-Seine")).toBe("Gare d'Ivry-sur-Seine");
    expect(gareNom("Paris Austerlitz")).toBe("Gare de Paris Austerlitz");
  });
});

describe("outre-mer", () => {
  it("reconnaît les codes « ZA »… des fichiers du ministère", () => {
    expect(normDep("ZB")).toBe("972");
    expect(normDep("zd")).toBe("974");
    expect(normDep("1")).toBe("01");
    expect(normDep("2A")).toBe("2A");
  });
});

describe("logements sociaux et population adulte", () => {
  it("regroupe les logements en résidences et en ensembles", async () => {
    const { groupRpls, toLonLat } = await import("@/lib/collectors/rpls");
    // Lambert-93 et UTM 20 (Antilles).
    const [lon, lat] = toLonLat(652000, 6862000, "2154")!;
    expect(lon).toBeCloseTo(2.37, 1);
    expect(lat).toBeCloseTo(48.83, 1);
    const [lonM, latM] = toLonLat(715000, 1615000, "5490")!;
    expect(lonM).toBeCloseTo(-61, 0);
    expect(latM).toBeCloseTo(14.6, 0);
    const row = (prog: string, num: string, voie: string, x: number, y: number) => ({ DEPCOM: "75113", NUMVOIE: num, TYPVOIE: "RUE", NOMVOIE: voie, COMPLGEO: prog, X: String(x), Y: String(y), EPSG: "2154" });
    const rows = [
      ...Array.from({ length: 30 }, () => row("CITE DES FLEURS", "2", "DES LILAS", 652000, 6862000)),
      ...Array.from({ length: 20 }, () => row("", "10", "DES LILAS", 652050, 6862020)),
      ...Array.from({ length: 5 }, () => row("", "3", "LOINTAINE", 655000, 6865000)),
    ];
    const g = groupRpls(rows);
    expect(g.total).toBe(55);
    expect(g.residences.map((r) => [r.nom, r.logements])).toEqual([["Cité des Fleurs", 30], ["10 Rue des Lilas", 20], ["3 Rue Lointaine", 5]]);
    expect(g.ensembles[0]).toMatchObject({ nom: "Cité des Fleurs", logements: 50, residences: 2 });
  });
  it("compte les adultes (18 ans et plus) d'une ligne IRIS", async () => {
    const { adultesOf } = await import("@/lib/collectors/adultes");
    expect(adultesOf({ P21_POP: "1000", P21_POP0002: "40", P21_POP0305: "40", P21_POP0610: "60", P21_POP1117: "90", P21_POP_FR: "900" })).toEqual({ pop: 1000, adultes: 770, fr: 900, annee: "2021" });
    expect(adultesOf({ P20_POP: "100", P20_POP0014: "20", P20_POP1519: "10" })?.adultes).toBe(74);
  });
});
