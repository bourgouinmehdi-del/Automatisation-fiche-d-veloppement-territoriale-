import { describe, expect, it } from "vitest";
import { deputationsPhrase, deputationsRows, deputationsToCsv, parseDeputations, precedents } from "@/lib/collectors/deputations";
import { parseCsv } from "@/lib/collectors/interne";

// Valeurs fictives (circonscription et noms inventés).
const ancien = [
  { circo: "99-01", ancienne_circo: "99-01", part_pop_actuelle: "0.9", election: "1997", groupe: "PS", depute: "Alice Martin" },
  { circo: "99-01", ancienne_circo: "99-02", part_pop_actuelle: "0.1", election: "1997", groupe: "RPR", depute: "Bob Durand" },
  { circo: "99-01", ancienne_circo: "99-01", part_pop_actuelle: "0.9", election: "2002", groupe: "UMP", depute: "Claire Petit" },
  { circo: "99-01", ancienne_circo: "99-01", part_pop_actuelle: "0.9", election: "2007", groupe: "UMP", depute: "Claire Petit" },
];
const actuel = [
  { circo: "99-01", election: "2012", groupe: "PS", depute: "David Roux", debut: "2012-06-26", fin: "2015-01-01" },
  { circo: "99-01", election: "2012", groupe: "PS", depute: "Emma Blanc", debut: "2015-01-02", fin: "2017-06-20" },
  { circo: "99-01", election: "2017", groupe: "LREM", depute: "Félix Noir", debut: "2017-06-27", fin: "2022-06-21" },
  { circo: "99-01", election: "2022", groupe: "RN", depute: "Gaël Vert", debut: "2022-06-29", fin: "2024-06-09" },
  { circo: "99-01", election: "2024", groupe: "RN", depute: "Gaël Vert", debut: "2024-07-19", fin: "2026-09-27" },
];

describe("historique des député·es par circonscription", () => {
  const m = parseDeputations(parseCsv(deputationsToCsv(deputationsRows([...ancien, ...actuel]))));
  const h = m.get("99-01")!;
  it("un siège par élection : ancienne circonscription majoritaire, élu·e de début de législature", () => {
    expect(h.map((d) => `${d.election}:${d.depute}`)).toEqual(["1997:Alice Martin", "2002:Claire Petit", "2007:Claire Petit", "2012:David Roux", "2017:Félix Noir", "2022:Gaël Vert", "2024:Gaël Vert"]);
  });
  it("phrase du profil politique", () => {
    expect(deputationsPhrase(h, "1re circonscription de Fictif")).toBe("Depuis 1997, la 1re circonscription de Fictif a élu un·e député·e de gauche en 1997 et 2012, de droite en 2002 et 2007, du camp présidentiel en 2017, puis d'extrême droite depuis 2022 ; jamais LFI.");
  });
  it("précédent·es depuis 2007", () => {
    expect(precedents(h, "Gaël Vert").map((d) => d.depute)).toEqual(["Félix Noir", "David Roux"]);
  });
});
