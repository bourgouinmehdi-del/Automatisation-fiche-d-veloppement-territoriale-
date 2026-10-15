import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { isPorteAPorte, parseCatalogue, residencesOf } from "@/lib/collectors/residences-etudiantes";

/** Classeur minimal au format du catalogue mensuel (titre au-dessus des en-têtes, chaînes en ligne). */
function xlsx(sheets: Record<string, string[][]>): Uint8Array {
  const names = Object.keys(sheets);
  const cell = (v: string, c: number, r: number) => {
    const ref = String.fromCharCode(65 + c) + (r + 1);
    return /^-?\d+(\.\d+)?$/.test(v) ? `<x:c r="${ref}" t="n"><x:v>${v}</x:v></x:c>` : `<x:c r="${ref}" t="inlineStr"><x:is><x:t>${v.replace(/&/g, "&amp;")}</x:t></x:is></x:c>`;
  };
  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": strToU8(`<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets>${names.map((n, i) => `<x:sheet name="${n}" sheetId="${i + 1}" r:id="R${i}" />`).join("")}</x:sheets></x:workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships>${names.map((_, i) => `<Relationship Target="/xl/worksheets/sheet${i + 1}.xml" Id="R${i}" />`).join("")}</Relationships>`),
  };
  names.forEach((n, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<x:worksheet><x:sheetData>${sheets[n].map((row, r) => `<x:row r="${r + 1}">${row.map((v, c) => (v === "" ? "" : cell(v, c, r))).join("")}</x:row>`).join("")}</x:sheetData></x:worksheet>`);
  });
  return zipSync(files);
}

const HEAD = ["ID résidence", "Code postal", "Ville", "Nom du logement", "Adresse principale", "Nombre total de logements", "Crous ou hors Crous", "Catégorie de résidence", "Gestionnaire", "Date de récupération"];

describe("catalogue des résidences étudiantes", () => {
  const buf = xlsx({
    Résidences: [
      ["Catalogue des logements étudiants"],
      [""],
      HEAD,
      ["1", "60200", "Compiègne", "Roberval", "1 Rue A", "385", "Crous", "Résidence étudiante", "CROUS", "46270"],
      ["2", "60200", "Compiègne", "Picardie", "2 Rue B", "92", "Hors Crous", "Foyer de jeunes travailleurs", "ACCUEIL & PROMOTION", "46270"],
      ["3", "60200", "Compiègne", "Studéa", "3 Rue C", "", "Hors Crous", "Résidence étudiante", "Nexity", "46270"],
      ["4", "47000", "Agen", "Ailleurs", "4 Rue D", "10", "Crous", "Résidence étudiante", "CROUS", "46270"],
    ],
    Adresses: [
      ["Adresses"],
      ["ID résidence", "Nom du logement", "Adresse principale / secondaire", "Adresse", "Ville", "Code postal", "Crous ou hors Crous", "Latitude", "Longitude"],
      ["1", "Roberval", "Principale", "1 Rue A", "Compiègne", "60200", "Crous", "49.40", "2.80"],
      ["2", "Picardie", "Principale", "2 Rue B", "Compiègne", "60200", "Hors Crous", "49.41", "2.81"],
      ["3", "Studéa", "Principale", "3 Rue C", "Compiègne", "60200", "Hors Crous", "49.42", "2.82"],
      ["4", "Ailleurs", "Principale", "4 Rue D", "Agen", "47000", "Crous", "44.18", "0.62"],
    ],
  });

  it("lit les onglets Résidences et Adresses par intitulé de colonne", () => {
    const cat = parseCatalogue(buf);
    expect(cat.list).toHaveLength(4);
    expect(cat.retrievedAt).toBe("2026-09-05");
    expect(cat.list[1]).toMatchObject({ nom: "Picardie", gestionnaire: "ACCUEIL & PROMOTION", logements: 92, crous: false, lat: 49.41, lon: 2.81 });
    expect(cat.list[2].logements).toBeNull();
  });

  it("porte-à-porte : résidences du Crous et foyers de jeunes travailleurs seulement", () => {
    const cat = parseCatalogue(buf);
    expect(cat.list.filter(isPorteAPorte).map((r) => r.nom)).toEqual(["Roberval", "Picardie", "Ailleurs"]);
  });

  it("rattache les résidences à la commune par position, sinon par ville et code postal", () => {
    const { list } = parseCatalogue(buf);
    const contour: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[2.7, 49.3], [2.9, 49.3], [2.9, 49.5], [2.7, 49.5], [2.7, 49.3]]] };
    expect(residencesOf(list, { nom: "Compiègne", contour }).map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(residencesOf(list, { nom: "COMPIEGNE", codesPostaux: ["60200"] }).map((r) => r.id)).toEqual(["1", "2", "3"]);
  });
});
