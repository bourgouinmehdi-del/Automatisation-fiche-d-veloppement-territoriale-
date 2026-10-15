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
