import { describe, expect, it } from "vitest";
import { arrondissementsOf, investie, parseMunicipalesLfi, splitSheetsText } from "@/lib/collectors/interne";

/** Classeur fictif, au format de l'export texte (un onglet par situation). */
const TEXT = `## Sheet name: Liste & TDL FI
l,Région,Département,Commune,Population,Détail,TDL 1 Prénom,TDL 1 NOM,TDL 2 Prénom,TDL 2 NOM
Ok,HdF,60 - Oise,Compiègne,40000,,Alice,EXEMPLE,,
Planté,HdF,60 - Oise,Margny-lès-Compiègne,8000,,Paul,FICTIF,,
## Sheet name: UG TDL FI
,Région,Département,Commune,Population,Détail,TDL 1 Prénom,TDL 1 NOM,TDL 2 Prénom,TDL 2 NOM
Ok,PACA,13 - Bouches-du-Rhône,Marseille 3e secteur,100000,"Note
sur deux lignes",Léa,TEST,,
## Sheet name: TDL EELV
,Région,Département,Commune,Population,Détail,TDL 1 Prénom,TDL 1 NOM,TDL 2 Prénom,TDL 2 NOM
En attente,AURA,03 - Allier,Moulins,19000,,Jean,ESSAI,,
Ok,AURA,63 - Puy-de-Dôme,Vichy,25000,,Marc,ESSAI,,
`;

describe("municipales 2026 : classeur des listes soutenues par LFI", () => {
  it("lit les onglets, la situation, le statut et retrouve les communes", () => {
    const { listes, unmatched } = parseMunicipalesLfi(splitSheetsText(TEXT));
    expect(unmatched).toEqual([]);
    const ok = listes.filter(investie);
    expect(ok.find((l) => l.code === "60159")).toMatchObject({ situation: "liste LFI", tdl: ["Alice EXEMPLE"] });
    // « Planté » et « En attente » : pas investies.
    expect(listes.find((l) => l.code === "60382")?.statut).toBe("Planté");
    expect(ok.some((l) => l.code === "60382")).toBe(false);
    // Secteur de Marseille : ses deux arrondissements ; cellule sur deux lignes sans décaler les colonnes.
    expect(ok.filter((l) => l.situation === "liste d'union de la gauche menée par LFI").map((l) => l.code)).toEqual(["13204", "13205"]);
    // Département mal saisi (Vichy est dans l'Allier) : nom unique en France.
    expect(ok.find((l) => l.tdl[0] === "Marc ESSAI")?.code).toBe("03310");
  });
  it("secteurs de Paris", () => {
    expect(arrondissementsOf("Paris 1, 2, 3 et 4")).toEqual(["75101", "75102", "75103", "75104"]);
  });
});
