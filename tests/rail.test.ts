/**
 * Trains avec correspondance un samedi (index SNCF fictif) et choix du réseau urbain
 * dans la liste de transport.data.gouv.fr.
 */
import { describe, expect, it } from "vitest";
import { pickUrbanGtfs, routeRail, type RailIndex } from "@/lib/collectors/gtfs";

const st = (id: string, nom: string, lon: number, lat: number) => ({ id, nom, lon, lat });
const h = (x: string) => {
  const [a, b] = x.split(":").map(Number);
  return a * 60 + b;
};
const trip = (stops: [number, string][]) => ({ s: stops.map((x) => x[0]), a: stops.map((x) => h(x[1])), d: stops.map((x) => h(x[1])) });

describe("trains avec correspondance", () => {
  const index: RailIndex = {
    stations: [
      st("A", "Montargis", 2.73, 48.0),
      st("B", "Orléans", 1.9, 47.9),
      st("C", "Blois", 1.33, 47.59),
      st("D", "Paris Gare de Lyon", 2.373, 48.844),
      st("E", "Paris Montparnasse", 2.32, 48.84),
      st("F", "Chartres", 1.48, 48.44),
    ],
    trips: [
      trip([[0, "08:00"], [1, "09:10"]]), // Montargis → Orléans
      trip([[1, "09:15"], [2, "09:50"]]), // trop juste (8 min de correspondance)
      trip([[1, "09:30"], [2, "10:10"]]), // Orléans → Blois
      trip([[0, "07:00"], [3, "08:10"]]), // Montargis → Paris Gare de Lyon
      trip([[4, "09:00"], [5, "10:00"]]), // Paris Montparnasse → Chartres
      trip([[0, "06:00"], [2, "11:30"]]), // direct mais lent
    ],
    date: "20261107",
    url: "",
    retrievedAt: "",
  };

  it("trouve le trajet le plus court avec une correspondance de 8 min au moins", () => {
    expect(routeRail(index, new Set([0]), new Set([2]))).toEqual({ minutes: 130, depart: h("08:00"), changes: ["Orléans"] });
  });

  it("compte un changement de gare dans une même ville", () => {
    // Gare de Lyon → Montparnasse : ≈ 3,9 km, 15 + 4 × 3,9 ≈ 31 min ; arrivée 8 h 10, départ 9 h : possible.
    expect(routeRail(index, new Set([0]), new Set([5]))).toEqual({ minutes: 180, depart: h("07:00"), changes: ["Paris Gare de Lyon → Paris Montparnasse"] });
  });

  it("ne trouve rien hors de la plage de départ", () => {
    expect(routeRail(index, new Set([0]), new Set([2]), { earliest: h("12:00"), latest: h("14:00") })).toBeNull();
  });
});

describe("réseaux urbains (transport.data.gouv.fr)", () => {
  const ds = (title: string, extra: object, modes = "tramway") => ({ type: "public-transit", title, resources: [{ format: "GTFS", url: `https://exemple.fr/${title}.zip`, is_available: true, modes: [modes] }], ...extra });
  it("retient le réseau qui cite la commune et compte un tram ou un métro", () => {
    const list = [
      ds("Réseau TCL", { aom: { name: "SYTRAL Mobilités" }, covered_area: [{ insee: "69123", nom: "Lyon" }, { insee: "69259", nom: "Vénissieux" }] }),
      ds("Bus de Vienne", { covered_area: [{ insee: "38544", nom: "Vienne" }] }, "bus"),
      ds("Agrégat Auvergne-Rhône-Alpes", { covered_area: [{ insee: "69259", nom: "Vénissieux" }] }),
    ];
    expect(pickUrbanGtfs(list, { codes: ["69259", "69123"], names: ["Vénissieux", "Lyon"] })).toEqual([{ title: "Réseau TCL", url: "https://exemple.fr/Réseau TCL.zip" }]);
    expect(pickUrbanGtfs(list, { codes: ["38544"], names: ["Vienne"] })).toEqual([]);
  });
});
