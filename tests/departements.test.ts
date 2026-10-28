/** Ciblage d'un département : on tape son numéro ou son nom, la préfecture sert d'entrée. */
import { describe, expect, it } from "vitest";
import { searchDepartements } from "@/lib/collectors/admin";

describe("recherche de départements", () => {
  it("par numéro ou par nom", () => {
    expect(searchDepartements("29").map((c) => [c.nom, c.prefecture])).toEqual([["Finistère", "Quimper"]]);
    expect(searchDepartements("2A")[0].prefecture).toBe("Ajaccio");
    expect(searchDepartements("val-de-marne")[0].code).toBe("94028");
    expect(searchDepartements("Brest")).toEqual([]);
  });
});
