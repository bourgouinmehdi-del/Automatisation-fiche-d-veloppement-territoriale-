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
    expect(med.txt).toBe("1,3 pour 10 000 habitants à moins de 5 km (communes semblables : 6,7)");
    expect(r.faibles.map((x) => x.label)).toContain("Médecin généraliste");
    expect(r.cats.find((x) => x.cat === "sante")!.niveau).toBe("moins");
  });
});
