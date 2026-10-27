/** Accès aux services : distance au plus proche, comparée aux communes de taille semblable. */
import { describe, expect, it } from "vitest";
import { servicesAccess } from "@/lib/analysis/services";

const eq = (type: string, commune: string, lon: number | null, lat: number | null) => ({ type, nom: "", commune, lon, lat, qp: null, adresse: "" });

describe("accès aux services", () => {
  const communes = Array.from({ length: 12 }, (_, i) => ({ code: `07${String(i).padStart(3, "0")}`, at: [4 + i * 0.1, 45] as [number, number], pop: 15000 }));
  it("compte un équipement sans coordonnées dans sa commune", () => {
    const equip = [eq("F101", "07000", null, null), eq("F101", "07005", 4.5, 45), eq("F101", "07011", 5.1, 45)];
    const r = servicesAccess("07000", communes, equip)!;
    const pis = r.rows.find((x) => x.label === "Piscine")!;
    expect(pis).toMatchObject({ val: 0, surPlace: true });
    expect(r.faibles.some((x) => x.label === "Piscine")).toBe(false);
  });
  it("signale un service nettement plus loin qu'ailleurs", () => {
    const equip = communes.slice(1).map((c) => eq("D307", c.code, c.at[0], c.at[1]));
    const far = servicesAccess("07000", communes.map((c, i) => (i === 0 ? { ...c, at: [3, 45] as [number, number] } : c)), equip)!;
    expect(far.faibles.map((x) => x.label)).toContain("Pharmacie");
  });
  it("distingue les communes qui ont un médecin, mais trop peu pour leur population", () => {
    // Toutes les communes ont des médecins ; la première en a 2, les autres 10, pour 15 000 habitants.
    const equip = communes.flatMap((c, i) => Array.from({ length: i === 0 ? 2 : 10 }, () => eq("D265", c.code, c.at[0], c.at[1])));
    const r = servicesAccess("07000", communes, equip)!;
    const med = r.rows.find((x) => x.label === "Médecin généraliste")!;
    expect(med.txt).toBe("1,3 pour 10 000 habitants à moins de 5 km (habitant moyen du département : 6,7)");
    expect(r.faibles.map((x) => x.label)).toContain("Médecin généraliste");
    expect(r.cats.find((x) => x.cat === "sante")!.niveau).toBe("moins");
  });
});

describe("niveau par catégorie", () => {
  it("dit « moins bien desservie » quand la plupart des services sont un peu en dessous (cas d'Ivry)", () => {
    const communes = Array.from({ length: 12 }, (_, i) => ({ code: `94${String(i).padStart(3, "0")}`, at: [2 + i * 0.1, 48.8] as [number, number], pop: 60000 }));
    const eq = (type: string, commune: string, lon: number, lat: number) => ({ type, nom: "", commune, lon, lat, qp: null, adresse: "" });
    // Commune étudiée : 37 médecins, 31 dentistes, 40 infirmiers pour 60 000 habitants ; les autres : 49, 38, 49.
    const n = (i: number, a: number, b: number) => (i === 0 ? a : b);
    const equip = communes.flatMap((c, i) => [
      ...Array.from({ length: n(i, 37, 49) }, () => eq("D265", c.code, c.at[0], c.at[1])),
      ...Array.from({ length: n(i, 31, 38) }, () => eq("D277", c.code, c.at[0], c.at[1])),
      ...Array.from({ length: n(i, 40, 49) }, () => eq("D281", c.code, c.at[0], c.at[1])),
      ...Array.from({ length: 18 }, () => eq("D307", c.code, c.at[0], c.at[1])),
    ]);
    const r = servicesAccess("94000", communes, equip)!;
    expect(r.faibles).toEqual([]);
    expect(r.cats.find((x) => x.cat === "sante")!.niveau).toBe("moins");
  });
});

describe("services en ville (mesure mixte)", () => {
  it("repère une ville qui a tout sur place mais trop peu pour sa population", () => {
    const communes = Array.from({ length: 12 }, (_, i) => ({ code: `93${String(i).padStart(3, "0")}`, at: [2 + i * 0.1, 48.9] as [number, number], pop: 60000 }));
    const eq = (type: string, commune: string, lon: number, lat: number) => ({ type, nom: "", commune, lon, lat, qp: null, adresse: "" });
    // Toutes ont écoles, poste et piscine ; la première : 8 écoles et 1 piscine, les autres : 20 écoles et 2 piscines.
    const equip = communes.flatMap((c, i) => [
      ...Array.from({ length: i === 0 ? 8 : 20 }, () => eq("C108", c.code, c.at[0], c.at[1])),
      ...Array.from({ length: i === 0 ? 1 : 2 }, () => eq("F101", c.code, c.at[0], c.at[1])),
      eq("A206", c.code, c.at[0], c.at[1]),
    ]);
    const r = servicesAccess("93000", communes, equip)!;
    const ecole = r.rows.find((x) => x.label === "École")!;
    expect(ecole.mode).toBe("offre");
    expect(ecole.faible).toBe(true);
    expect(r.cats.find((x) => x.cat === "education")!.niveau).toBe("moins");
    expect(r.cats.find((x) => x.cat === "culture")!.niveau).toBe("moins");
    // La poste : pareil partout, « comme ».
    expect(r.cats.find((x) => x.cat === "public")!.niveau).toBe("comme");
  });
});

describe("référence : l'habitant moyen du département", () => {
  it("signale une petite ville délaissée même quand ses semblables le sont aussi", () => {
    // Une grande ville (200 000 habitants, 20 piscines) et 12 petites villes sans piscine, à 15 km.
    const petites = Array.from({ length: 12 }, (_, i) => ({ code: `07${String(i).padStart(3, "0")}`, at: [4 + i * 0.01, 45.3] as [number, number], pop: 15000 }));
    const grande = { code: "07999", at: [4, 45.43] as [number, number], pop: 200000 };
    const eq = (type: string, commune: string, lon: number, lat: number) => ({ type, nom: "", commune, lon, lat, qp: null, adresse: "" });
    const equip = Array.from({ length: 20 }, () => eq("F101", grande.code, grande.at[0], grande.at[1]));
    const r = servicesAccess("07000", [...petites, grande], equip)!;
    const pis = r.rows.find((x) => x.label === "Piscine")!;
    expect(pis.faible).toBe(true);
    expect(pis.txtFaible).toMatch(/^le plus proche à 1\d km, contre sur place pour l'habitant moyen du département$/);
  });
});

describe("référence nationale et indice", () => {
  it("calcule la référence de l'habitant moyen en France et un indice par gamme", async () => {
    const { nationalServiceRefs } = await import("@/lib/analysis/services-ref");
    // 40 communes : 30 bien équipées (pharmacie sur place, 3 pour 10 000 hab.), 10 sans pharmacie.
    const communes = Array.from({ length: 40 }, (_, i) => ({ code: `${10000 + i}`, lon: 1 + (i % 8) * 0.2, lat: 45 + Math.floor(i / 8) * 0.2, pop: 10000 }));
    const byType = { D307: { lon: [] as number[], lat: [] as number[], commune: [] as string[] } };
    communes.slice(0, 30).forEach((c) => {
      for (let k = 0; k < 3; k++) {
        byType.D307.lon.push(c.lon);
        byType.D307.lat.push(c.lat);
        byType.D307.commune.push(c.code);
      }
    });
    const ref = nationalServiceRefs(communes, { byType });
    expect(ref.Pharmacie.dist).toBe(0);
    expect(ref.Pharmacie.offre).toBeCloseTo(3, 5);
    // Une commune avec une pharmacie pour 10 000 habitants : en dessous de la France.
    const local = Array.from({ length: 12 }, (_, i) => ({ code: `2${i}`, at: [2 + i * 0.2, 46] as [number, number], pop: 10000 }));
    const equip = local.flatMap((c, i) => Array.from({ length: i === 0 ? 1 : 3 }, () => ({ type: "D307", nom: "", commune: c.code, lon: c.at[0], lat: c.at[1], qp: null, adresse: "" })));
    const r = servicesAccess("20", local, equip, ref)!;
    expect(r.rows.find((x) => x.label === "Pharmacie")!.txt).toBe("1,0 pour 10 000 habitants à moins de 5 km (France : 3,0 ; département : 3,0)");
    expect(r.indice!.ref).toBe("France");
    expect(r.indice!.global).toBeLessThan(50);
  });
});
