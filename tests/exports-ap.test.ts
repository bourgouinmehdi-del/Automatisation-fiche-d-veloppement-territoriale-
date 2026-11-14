import { describe, expect, it } from "vitest";
import { bilanDesExports, gaActif, normCp, parseActionsCommunes, parseGroupes, parseSoutiensCp, repartirSoutiens, type Bilan } from "@/lib/collectors/interne";

// Valeurs fictives (communes 99xxx inventées).
const G = (citycode: string, name: string, type: string, cert: string, ev2026: string, ev2025 = "0") => ({
  created: "2025-03-01 10:00:00+00:00",
  id: name,
  name,
  type,
  location_zip: "99000",
  location_citycode: citycode,
  certification_date: cert,
  members_count: "12",
  organized_events: "40",
  organized_events_2025: ev2025,
  organized_events_2026: ev2026,
  last_event_date: "2026-11-01 18:00:00+00:00",
});

describe("exports Action Populaire", () => {
  it("groupes de l'export SQL : code INSEE, certification, actions de l'année, boucles écartées", () => {
    const { groupes, unmatched } = parseGroupes(
      [
        G("99001", "Groupe A", "Groupe local", "2025-04-01 00:00:00+00:00", "12"),
        G("99001", "Groupe B", "Groupe local", "", "30"),
        G("99002", "Groupe C", "Groupe local", "2025-04-01 00:00:00+00:00", "3", "40"),
        G("99003", "Boucle", "Boucle départementale", "2025-04-01 00:00:00+00:00", "50"),
        G("99004", "Thème", "Groupe thématique", "", "50"),
        G("", "En ligne", "Groupe local", "", "5"),
      ],
      "action-populaire.csv",
      2026,
    );
    expect(groupes.map((g) => g.nom)).toEqual(["Groupe A", "Groupe B", "Groupe C"]);
    expect(unmatched).toBe(1);
    const [a, b, c] = groupes;
    expect(a).toMatchObject({ code: "99001", certifie: true, actions: 12, membres: 12, creation: "2025-03-01", derniereAction: "2026-11-01", exact: true });
    expect([a, b, c].map(gaActif)).toEqual([true, false, false]);
  });

  it("actions par commune ; un fichier « code_postal, nb_actions » n'est pas pris pour des soutiens", () => {
    const m = parseActionsCommunes([
      { code_commune: "99001", commune: "ville a", nb_events: "120" },
      { code_commune: "99001", commune: "Ville A centre", nb_events: "5" },
      { code_commune: "en ligne", commune: "x", nb_events: "9" },
    ]);
    expect([...m]).toEqual([["99001", 125]]);
    expect(parseSoutiensCp([{ code_postal: "99000", nb_actions: "3" }]).actions).toBe(true);
  });

  it("codes postaux nettoyés, soutiens répartis vers l'arrondissement et la ville", () => {
    expect(["'42130", "01 000", "13OO5", "1012 JS", "00000", "-", "+33"].map(normCp)).toEqual(["42130", "01000", "13005", null, null, null, null]);
    const { parCp, ignores } = parseSoutiensCp([
      { code_postal: "75011", soutiens: "100" },
      { code_postal: "1012 JS", soutiens: "4" },
    ]);
    expect(ignores).toBe(4);
    const r = repartirSoutiens(parCp);
    expect(Math.round(r.parCommune.get("75111")!)).toBe(100);
    expect(Math.round(r.parCommune.get("75056")!)).toBe(100);
    expect(r.estimees.has("75111")).toBe(false);
  });

  it("le bilan prend les actions et les groupes actifs des exports, garde les inscrits", () => {
    const b = new Map<string, Bilan>([
      ["99001", { actions: 7, ga: 3, parrains: 50, inscrits: 4000, estime: true }],
      ["99002", { actions: 9, ga: 1, parrains: 20, inscrits: 2000, estime: false }],
    ]);
    const groupes = Array.from({ length: 10 }, (_, i) => ({ code: "99001", nom: `G${i}`, membres: 5, statut: "", description: "", certifie: true, actions: i < 2 ? 8 : 1, exact: true }));
    const out = bilanDesExports(b, { actions: new Map([["99001", 300]]), groupes });
    expect(out.get("99001")).toEqual({ actions: 300, ga: 2, parrains: 50, inscrits: 4000, estime: true });
    expect(out.get("99002")).toEqual({ actions: 0, ga: 0, parrains: 20, inscrits: 2000, estime: false });
  });
});
