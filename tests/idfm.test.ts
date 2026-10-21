/**
 * Métro, RER, tram d'Île-de-France : index des lignes (horaires IDFM, archive GTFS fictive)
 * et trajet direct le plus court entre deux ensembles de gares.
 */
import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { strToU8, zipSync } from "fflate";

describe("métro, RER, tram (horaires IDFM)", () => {
  it("indexe les lignes ferrées et trouve le trajet direct le plus court", async () => {
    const dir = path.join(os.tmpdir(), `idfm-${process.pid}`);
    await fs.mkdir(dir, { recursive: true });
    process.env.DATA_DIR = dir;
    const z = zipSync({
      "routes.txt": strToU8("route_id,route_short_name,route_long_name,route_type\nR9,9,Ligne 9,1\nRB,B,RER B,2\nBUS,76,Bus 76,3\n"),
      "trips.txt": strToU8("route_id,service_id,trip_id,direction_id\nR9,S,t9,0\nRB,S,tb,0\nBUS,S,tbus,0\n"),
      "stop_times.txt": strToU8(
        [
          "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
          "t9,08:00:00,08:00:00,q1,1",
          "t9,08:12:00,08:12:00,q2,2",
          "t9,08:20:00,08:20:00,q3,3",
          "tb,08:00:00,08:00:00,q1b,1",
          "tb,08:09:00,08:09:00,q3,2",
          "tbus,08:00:00,08:00:00,q1,1",
          "tbus,08:05:00,08:05:00,q3,2",
        ].join("\n") + "\n",
      ),
      "stops.txt": strToU8(
        [
          "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
          "S1,Châtelet,48.858,2.347,1,",
          "q1,Châtelet,48.858,2.347,0,S1",
          "q1b,Châtelet RER,48.8585,2.3475,0,S1",
          "q2,République,48.867,2.363,0,",
          "q3,Mairie de Montreuil,48.862,2.441,0,",
        ].join("\n") + "\n",
      ),
    });
    const file = path.join(dir, "idfm.zip");
    await fs.writeFile(file, z);
    const { collectIdfmIndex, directTc, routeTc } = await import("@/lib/collectors/gtfs");
    const http = { file: async () => ({ data: file, retrievedAt: "2026-10-21T00:00:00Z" }), notes: [] } as unknown as Parameters<typeof collectIdfmIndex>[0];
    const idx = await collectIdfmIndex(http);
    expect(idx.patterns.map((p) => p.ligne).sort()).toEqual(["RER B", "métro 9"]);
    const i = (nom: string) => idx.stations.findIndex((s) => s.nom === nom);
    // Châtelet (quais métro et RER regroupés) → Mairie de Montreuil : RER B 9 min plutôt que métro 9 (20 min) ; le bus est ignoré.
    expect(directTc(idx, new Set([i("Châtelet")]), new Set([i("Mairie de Montreuil")]))).toEqual({ minutes: 9, ligne: "RER B" });
    // Sens inverse.
    expect(directTc(idx, new Set([i("Mairie de Montreuil")]), new Set([i("République")]))).toEqual({ minutes: 8, ligne: "métro 9" });
    // Trajet calculé par routeTc : 12 min de métro + 5 min à la montée.
    expect(routeTc(idx, new Set([i("République")]), new Set([i("Châtelet")]))).toEqual({ minutes: 17, lignes: ["métro 9"] });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("trouve les trajets avec correspondance, y compris à pied entre gares proches", async () => {
    const { routeTc } = await import("@/lib/collectors/gtfs");
    const st = (nom: string, lon: number, lat: number) => ({ nom, lon, lat });
    const idx = {
      stations: [st("X", 2.3, 48.8), st("Y", 2.33, 48.82), st("Z", 2.36, 48.84), st("Y bis", 2.3315, 48.8205), st("W", 2.4, 48.83)],
      patterns: [
        { ligne: "métro 1", stops: [0, 1], t: [0, 10] },
        { ligne: "RER A", stops: [1, 2], t: [0, 6] },
        { ligne: "tram T3", stops: [3, 4], t: [0, 4] },
      ],
      url: "",
      retrievedAt: "",
    };
    // X → Z : métro 1 (5 + 10) puis RER A (5 + 6).
    expect(routeTc(idx, new Set([0]), new Set([2]))).toEqual({ minutes: 26, lignes: ["métro 1", "RER A"] });
    // X → W : métro 1, marche vers « Y bis » (~150 m : 3 min), tram T3 (5 + 4).
    const r = routeTc(idx, new Set([0]), new Set([4]))!;
    expect(r.lignes).toEqual(["métro 1", "tram T3"]);
    expect(r.minutes).toBeGreaterThanOrEqual(25);
    expect(r.minutes).toBeLessThanOrEqual(28);
    // Sens inverse (lignes décrites dans un seul sens).
    expect(routeTc(idx, new Set([2]), new Set([0]))?.lignes).toEqual(["RER A", "métro 1"]);
  });
});
