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
    expect(quartierLabel("Gare 31")).toBe("Gare, secteur 31");
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
    const rows: Record<string, string>[] = [
      ...Array.from({ length: 30 }, () => row("CITE DES FLEURS", "2", "DES LILAS", 652000, 6862000)),
      ...Array.from({ length: 20 }, () => row("", "10", "DES LILAS", 652050, 6862020)),
      ...Array.from({ length: 5 }, () => row("", "3", "LOINTAINE", 655000, 6865000)),
    ];
    const g = groupRpls(rows);
    expect(g.total).toBe(55);
    expect(g.residences.map((r) => [r.nom, r.logements])).toEqual([["Cité des Fleurs", 30], ["10 Rue des Lilas", 20], ["3 Rue Lointaine", 5]]);
    expect(g.ensembles[0]).toMatchObject({ nom: "Cité des Fleurs", logements: 50, residences: 2 });
  });
  it("noms de programme, adresses en double et regroupement par rue", async () => {
    const { groupRpls, hlmByStreet, isProgName, numsLabel } = await import("@/lib/collectors/rpls");
    for (const code of ["A.h.", "0401-03-5", "Bat F/28", "D09", "BATIMENT A"]) expect(isProgName(code)).toBe(false);
    expect(isProgName("Les Musiciens")).toBe(true);
    const row = (prog: string, num: string, typ: string, voie: string, x: number) => ({ DEPCOM: "35281", NUMVOIE: num, TYPVOIE: typ, NOMVOIE: voie, COMPLGEO: prog, X: String(x), Y: "6862000", EPSG: "2154" });
    const rows: Record<string, string>[] = [
      ...Array.from({ length: 4 }, () => row("", "192", "RUE", "192 RUE ALEXANDRA DAVID NEEL", 652000)),
      ...Array.from({ length: 60 }, () => row("D09", "2", "ALL", "NICOLAS COPERNIC", 652100)),
      ...Array.from({ length: 59 }, () => row("CITE DES PERRIERES M,J", "4", "ALL", "NICOLAS COPERNIC", 652130)),
    ];
    const g = groupRpls(rows);
    expect(g.residences.map((r) => r.adresse)).toContain("192 Rue Alexandra David Neel");
    expect(g.residences.map((r) => r.nom)).toEqual(expect.arrayContaining(["2 Allée Nicolas Copernic", "Cité des Perrieres"]));
    const rue = hlmByStreet(g.residences)[0];
    expect(rue).toMatchObject({ voie: "Allée Nicolas Copernic", nums: ["2", "4"], logements: 119 });
    expect(numsLabel(rue.nums)).toBe("n° 2 et 4");
  });
  it("compte les adultes (18 ans et plus) d'une ligne IRIS", async () => {
    const { adultesOf } = await import("@/lib/collectors/adultes");
    expect(adultesOf({ P21_POP: "1000", P21_POP0002: "40", P21_POP0305: "40", P21_POP0610: "60", P21_POP1117: "90", P21_POP_FR: "900", P21_POP1824: "120" })).toEqual({ pop: 1000, adultes: 770, fr: 900, jeunes: 120, annee: "2021" });
    expect(adultesOf({ P20_POP: "100", P20_POP0014: "20", P20_POP1519: "10" })?.adultes).toBe(74);
  });
});

describe("articles des départements", () => {
  it("la Creuse, le Nord, l'Oise, les Landes, Paris", async () => {
    const { deDep, dansDep } = await import("@/lib/format");
    expect(["Creuse", "Nord", "Oise", "Landes", "Paris", "Haute-Vienne", "Hérault", "Val-de-Marne"].map(deDep)).toEqual(["de la Creuse", "du Nord", "de l'Oise", "des Landes", "de Paris", "de la Haute-Vienne", "de l'Hérault", "du Val-de-Marne"]);
    expect(dansDep("Creuse")).toBe("dans la Creuse");
    const { circoLabel } = await import("@/lib/collectors/carto");
    expect(circoLabel(1, "Creuse")).toMatch(/circonscription de la Creuse$/);
  });
});

describe("noms lisibles et horaires du week-end", () => {
  it("développe les abréviations et rétablit les accents", async () => {
    const { prettyFr } = await import("@/lib/format");
    expect(prettyFr("Rue du Mal de Lattre Tassigny")).toBe("Rue du Maréchal de Lattre Tassigny");
    expect(prettyFr("Allee Paul Signac")).toBe("Allée Paul Signac");
    expect(prettyFr("Res.university Berges de Seine")).toBe("Résidence universitaire Berges de Seine");
    expect(prettyFr("Résidence de clichy", "Clichy")).toBe("Résidence de Clichy");
    expect(prettyFr("École Jean Jaures")).toBe("École Jean Jaurès");
  });
  it("ne garde que les créneaux du samedi et du dimanche", async () => {
    const { weekendHours } = await import("@/lib/report/affiche");
    expect(weekendHours("mercredi, samedi et dimanche, 8 h – 13 h")).toBe("samedi et dimanche, 8 h – 13 h");
    expect(weekendHours("vendredi, 12 h – 21 h ; dimanche, 8 h – 14 h")).toBe("dimanche, 8 h – 14 h");
    expect(weekendHours("mardi et jeudi, 8 h – 12 h")).toBe("");
  });
});

describe("bilan militant LFI", () => {
  it("lit le classeur par l'intitulé des colonnes et repère les estimations", async () => {
    const { bilanToCsv, parseBilan } = await import("@/lib/collectors/interne");
    const rows: Record<string, string>[] = [
      { code_insee: "1007", nom_commune: "Ambronay", nb_actions_2026_estime: "2.2", nb_actions_2026_estime_bas: "1.6", nb_actions_2026_estime_haut: "2.9", nb_ga_actifs_5plus: "1", nb_parrains_estime: "13", nb_parrains_estime_bas: "9.1", nb_parrains_estime_haut: "16.9", inscrits_2024_europeenne: "2073" },
      { code_insee: "92024", nom_commune: "Clichy", nb_actions_2026_estime: "159", nb_actions_2026_estime_bas: "159", nb_actions_2026_estime_haut: "159", nb_ga_actifs_5plus: "1", nb_parrains_estime: "766", nb_parrains_estime_bas: "766", nb_parrains_estime_haut: "766", inscrits_2024_europeenne: "33879" },
      { code_insee: "99999", nom_commune: "Sans inscrits", nb_actions_2026_estime: "0", nb_ga_actifs_5plus: "0", nb_parrains_estime: "0", inscrits_2024_europeenne: "" },
    ];
    const b = parseBilan(rows);
    expect(b.get("01007")).toEqual({ actions: 2.2, ga: 1, parrains: 13, inscrits: 2073, estime: true });
    expect(b.get("92024")?.estime).toBe(false);
    expect(b.has("99999")).toBe(false);
    expect(bilanToCsv(rows).csv.split("\n")[2]).toBe("92024;159;1;766;33879;0");
  });
});

describe("contours IRIS : réessai quand la Géoplateforme répond 404", () => {
  it("passe à la variante suivante de la requête", async () => {
    process.env.IRIS_RETRY_MS = "1";
    const { irisContours } = await import("@/lib/collectors/quartiers");
    const calls: string[] = [];
    const http = {
      json: async (url: string) => {
        calls.push(url);
        if (calls.length === 1) throw new Error("Échec de la requête (HTTP 404)");
        return { data: { type: "FeatureCollection", features: [{ type: "Feature", properties: { code_iris: "592710101" }, geometry: null }] }, retrievedAt: "2026-10-19" };
      },
    } as unknown as Parameters<typeof irisContours>[0];
    const r = await irisContours(http, "59271");
    expect(calls).toHaveLength(2);
    expect(r.features).toHaveLength(1);
    expect(r.url).toMatch(/COUNT=1000/);
  });
});
