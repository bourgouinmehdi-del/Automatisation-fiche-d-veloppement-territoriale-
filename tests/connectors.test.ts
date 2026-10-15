import { describe, expect, it } from "vitest";
import { dvfStats, quantile, salesFromRows, type DvfRow } from "@/lib/collectors/dvf";
import { choosePartition, parseAgeCode, parseObservations, resolveCode, selectObs, latestValue, type MelodiDataset } from "@/lib/collectors/insee";
import { aggregateRows } from "@/lib/collectors/elections";
import { categorize, buildEquipmentQuery } from "@/lib/collectors/osm";
import { parseFrequentation } from "@/lib/collectors/public-apis";
import { epciMembers, searchCommunes, communeFromReferentiel } from "@/lib/collectors/admin";
import { numbersPreserved, extractNumbers } from "@/lib/llm/provider";

const row = (id: string, nature: string, val: number, type: string, surf: number | string, date = "2023-02-01"): DvfRow => ({
  id_mutation: id,
  date_mutation: date,
  nature_mutation: nature,
  valeur_fonciere: String(val),
  type_local: type,
  surface_reelle_bati: String(surf),
  code_commune: "00000",
});

describe("DVF", () => {
  it("ne retient que les ventes d'un seul logement avec surface", () => {
    const sales = salesFromRows([
      row("1", "Vente", 200000, "Appartement", 50),
      row("2", "Vente", 300000, "Maison", 100),
      row("2", "Vente", 300000, "Dépendance", ""),
      row("3", "Vente", 400000, "Appartement", 40),
      row("3", "Vente", 400000, "Appartement", 60), // deux logements : exclue
      row("4", "Echange", 100000, "Maison", 80), // pas une vente
      row("5", "Vente", 100000, "Appartement", 0), // sans surface
      row("6", "Vente", 10000000, "Appartement", 20), // aberrant (500 000 €/m²)
      row("7", "Vente", 150000, "Local industriel. commercial ou assimilé", 100),
      row("7", "Vente", 150000, "Maison", 50), // local mixte : exclue
    ]);
    expect(sales.map((s) => s.id).sort()).toEqual(["1", "2"]);
    expect(sales.find((s) => s.id === "1")!.pricePerM2).toBe(4000);
  });
  it("quantiles et statistiques annuelles", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    const st = dvfStats(salesFromRows([row("a", "Vente", 100000, "Appartement", 50), row("b", "Vente", 300000, "Appartement", 100), row("c", "Vente", 200000, "Appartement", 50)]));
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ year: "2023", type: "Appartement", count: 3, median: 3000 });
  });
});

function ds(obs: { dims: Record<string, string>; value: number }[], labels: Record<string, Record<string, string>> = {}): MelodiDataset {
  const dimValues = new Map<string, Set<string>>();
  for (const o of obs) for (const [k, v] of Object.entries(o.dims)) (dimValues.get(k) ?? dimValues.set(k, new Set()).get(k)!).add(v);
  return { id: "T", geo: "COM-1", url: "", retrievedAt: "", observations: obs, dimValues, labels: new Map(Object.entries(labels).map(([k, v]) => [k, new Map(Object.entries(v))])) };
}

describe("INSEE Melodi", () => {
  it("lit la mesure OBS_VALUE de chaque observation", () => {
    expect(parseObservations([{ dimensions: { GEO: "X" }, measures: { OBS_VALUE_NIVEAU: { value: 12 } } }, { dimensions: {}, measures: { OBS_VALUE_NIVEAU: { value: null } } }])).toEqual([
      { dims: { GEO: "X" }, value: 12 },
      { dims: {}, value: null },
    ]);
  });
  it("codes d'âge et partition", () => {
    expect(parseAgeCode("Y_LT15")).toMatchObject({ min: 0, max: 15 });
    expect(parseAgeCode("Y15T29")).toMatchObject({ min: 15, max: 30 });
    expect(parseAgeCode("Y_GE75")).toMatchObject({ min: 75, max: Infinity });
    const bands = ["Y_LT15", "Y15T29", "Y30T44", "Y45T59", "Y60T74", "Y_GE75", "Y_LT20", "Y_GE60"].map((c) => parseAgeCode(c)!);
    const p = choosePartition(bands)!;
    expect(p.map((b) => b.code)).toEqual(["Y_LT15", "Y15T29", "Y30T44", "Y45T59", "Y60T74", "Y_GE75"]);
  });
  it("fixe les autres dimensions au total et refuse les sélections ambiguës", () => {
    const d = ds([
      { dims: { TIME_PERIOD: "2021", SEX: "_T", AGE: "_T" }, value: 100 },
      { dims: { TIME_PERIOD: "2021", SEX: "F", AGE: "_T" }, value: 52 },
      { dims: { TIME_PERIOD: "2021", SEX: "_T", AGE: "Y_LT15" }, value: 20 },
      { dims: { TIME_PERIOD: "2016", SEX: "_T", AGE: "_T" }, value: 90 },
    ]);
    expect(latestValue(d, {})).toEqual({ value: 100, year: "2021" });
    expect(latestValue(d, { AGE: "Y_LT15" })!.value).toBe(20);
    expect(latestValue(d, {}, "2016")!.value).toBe(90);
    const amb = ds([
      { dims: { TIME_PERIOD: "2021", X: "a" }, value: 1 },
      { dims: { TIME_PERIOD: "2021", X: "b" }, value: 2 },
    ]);
    expect(selectObs(amb, {})).toBeNull();
  });
  it("reconnaît une modalité par code puis par libellé", () => {
    const d = ds([{ dims: { EDUC: "600_RP" }, value: 1 }, { dims: { EDUC: "_T" }, value: 2 }], { EDUC: { "600_RP": "Diplôme de l'enseignement supérieur" } });
    expect(resolveCode(d, "EDUC", { codes: ["XXX"], labelRe: /sup[ée]rieur/i })).toBe("600_RP");
    expect(resolveCode(d, "EDUC", { codes: ["XXX"] })).toBeNull();
  });
});

describe("élections", () => {
  it("agrège les lignes au format large du ministère", () => {
    const a = aggregateRows([
      { Inscrits: 100, Votants: 60, Abstentions: 40, Blancs: 2, Nuls: 1, Exprimés: 57, "Libellé de la liste 1": "A", "Voix 1": 30, "Libellé de la liste 2": "B", "Voix 2": 27 },
      { Inscrits: "50", Votants: "20", Abstentions: "30", Blancs: "0", Nuls: "0", Exprimés: "20", "Libellé de la liste 1": "B", "Voix 1": "15", "Libellé de la liste 2": "A", "Voix 2": "5" },
    ])!;
    expect(a).toMatchObject({ inscrits: 150, votants: 80, abstentions: 70, blancs: 2, nuls: 1, exprimes: 77 });
    expect(a.candidates).toEqual([
      { label: "B", voix: 42 },
      { label: "A", voix: 35 },
    ]);
  });
});

describe("OpenStreetMap et SNCF", () => {
  it("classe les objets OSM", () => {
    expect(categorize({ amenity: "pharmacy" })?.id).toBe("pharmacie");
    expect(categorize({ amenity: "social_facility", social_facility: "nursing_home" })?.id).toBe("ehpad");
    expect(categorize({ name: "Espace France Services", office: "government" })?.id).toBe("france_services");
    expect(categorize({ amenity: "bench" })).toBeNull();
    expect(buildEquipmentQuery("60159")).toContain('"ref:INSEE"="60159"');
  });
  it("lit les colonnes de fréquentation annuelle", () => {
    expect(parseFrequentation({ nom_gare: "X", total_voyageurs_2022: 10, total_voyageurs_2023: "12", total_voyageurs_non_voyageurs_2023: 99 })).toEqual([
      { year: "2022", voyageurs: 10 },
      { year: "2023", voyageurs: 12 },
    ]);
  });
});

describe("référentiel administratif (données réelles embarquées)", () => {
  it("code postal à commune unique : 60200 → Compiègne", () => {
    const r = searchCommunes("60200").filter((c) => c.via === "postal");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ code: "60159", nom: "Compiègne", departement: "60" });
  });
  it("recherche par code INSEE (y compris un code qui est aussi un code postal)", () => {
    expect(searchCommunes("60159")).toMatchObject([{ code: "60159", nom: "Compiègne", via: "insee" }]);
    expect(searchCommunes("2A004")).toMatchObject([{ code: "2A004", nom: "Ajaccio", via: "insee" }]);
    const r = searchCommunes("60200");
    expect(r[0]).toMatchObject({ nom: "Compiègne", via: "postal" });
    expect(r[r.length - 1]).toMatchObject({ code: "60200", via: "insee" });
  });
  it("code postal ambigu : 60350 renvoie plusieurs communes triées par population", () => {
    const r = searchCommunes("60350").filter((c) => c.via === "postal");
    expect(r.length).toBeGreaterThan(10);
    expect(r.map((c) => c.nom)).toContain("Pierrefonds");
    for (let i = 1; i < r.length; i++) expect((r[i - 1].population ?? 0) >= (r[i].population ?? 0)).toBe(true);
  });
  it("recherche par nom sans accents", () => {
    expect(searchCommunes("compiegne")[0].code).toBe("60159");
    expect(searchCommunes("st etienne")[0].nom).toMatch(/^Saint-Étienne/);
  });
  it("fiche d'identité et intercommunalité", () => {
    const c = communeFromReferentiel("60159")!;
    expect(c.epci?.nom).toMatch(/Compiègne/);
    expect(c.region.nom).toBe("Hauts-de-France");
    expect(epciMembers(c.epci!.code).some((m) => m.code === "60159")).toBe(true);
  });
  it("commune nouvelle : les communes déléguées sont rattachées", () => {
    // Annecy (74010) regroupe plusieurs communes déléguées depuis 2017.
    const c = communeFromReferentiel("74010")!;
    expect(c.communesDeleguees.length).toBeGreaterThan(2);
    expect(searchCommunes("Seynod")[0].code).toBe("74010");
  });
});

describe("garde-fou de la rédaction assistée", () => {
  it("rejette toute reformulation introduisant un nombre absent", () => {
    const src = "Le taux de pauvreté atteint 21,3 % en 2021 (département : 14,9 %).";
    expect(extractNumbers(src)).toEqual(["21.3", "2021", "14.9"]);
    expect(numbersPreserved(src, "En 2021, la pauvreté touche 21,3 % des habitants, contre 14,9 % dans le département.")).toBe(true);
    expect(numbersPreserved(src, "La pauvreté (21,3 %) dépasse de 6,4 points la moyenne.")).toBe(false);
    expect(numbersPreserved("Population : 40 761 habitants.", "La commune compte 40 761 habitants.")).toBe(true);
  });
});
