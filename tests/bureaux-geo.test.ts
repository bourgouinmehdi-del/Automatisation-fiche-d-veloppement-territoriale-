import { describe, expect, it } from "vitest";
import { extractFeaturesByText, normalizeBvFeatures } from "@/lib/collectors/bureaux-geo";

const poly = (x: number) => ({ type: "Polygon", coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 0]]] });

describe("géographie des bureaux de vote", () => {
  it("extrait d'un GeoJSON national les seules entités de la commune, sans tout décoder", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { codeCommune: "60159", codeBureauVote: "60159_1", nom: "École \"A\" {test}" }, geometry: poly(0) },
        { type: "Feature", properties: { codeCommune: "60382", codeBureauVote: "60382_1" }, geometry: poly(1) },
        { type: "Feature", properties: { codeCommune: "60159", codeBureauVote: "60159_2" }, geometry: poly(2) },
      ],
    };
    const text = JSON.stringify(fc, null, 1);
    const sub = extractFeaturesByText(text, "60159");
    expect(sub.features).toHaveLength(2);
    const n = normalizeBvFeatures(sub, "60159");
    expect(n.features.map((f) => f.properties?.bv)).toEqual(["1", "2"]);
    expect(n.labels.get("1")).toBe('École "A" {test}');
  });
  it("reconnaît des noms de propriétés variés et filtre par commune", () => {
    const n = normalizeBvFeatures(
      {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: { INSEE: "60159", NUM_BUREAU: "03" }, geometry: poly(0) as GeoJSON.Polygon },
          { type: "Feature", properties: { INSEE: "60057", NUM_BUREAU: "01" }, geometry: poly(0) as GeoJSON.Polygon },
          { type: "Feature", properties: { id_bv: "60159_7" }, geometry: poly(0) as GeoJSON.Polygon },
        ],
      },
      "60159",
    );
    expect(n.features.map((f) => f.properties?.bv)).toEqual(["3", "7"]);
  });
});

import { extractTopoJson, extractTopoJsonFile, toWgs84 } from "@/lib/collectors/topojson-extract";

describe("TopoJSON national (structure du fichier INSEE)", () => {
  // Deux bureaux de 60159 partageant une frontière, un bureau d'une autre commune.
  // Coordonnées Lambert-93 quantifiées (scale 1, translate autour de Compiègne), arcs delta-encodés.
  const T = { scale: [1, 1], translate: [680000, 6920000] };
  const topo = {
    type: "Topology",
    arcs: [
      [[0, 0], [0, 1000]], // 0 : frontière commune (vertical x=0)
      [[0, 1000], [-1000, 0], [0, -1000], [1000, 0]], // 1 : contour ouest
      [[0, 0], [1000, 0], [0, 1000], [-1000, 0]], // 2 : contour est
      [[5000, 5000], [100, 0], [0, 100], [-100, -100]], // 3 : autre commune
    ],
    transform: T,
    objects: {
      bv: {
        type: "GeometryCollection",
        geometries: [
          { type: "Polygon", arcs: [[0, 1]], properties: { codeCommune: "60159", numeroBureauVote: "1" } },
          { type: "Polygon", arcs: [[2, -1]], properties: { codeCommune: "60159", numeroBureauVote: "2" } },
          { type: "Polygon", arcs: [[3]], properties: { codeCommune: "60382", numeroBureauVote: "1" } },
        ],
      },
    },
  };
  it("décode les seules géométries de la commune, en WGS84", async () => {
    const diag: string[] = [];
    const fc = await extractTopoJson(JSON.stringify(topo), "60159", diag);
    expect(fc.features).toHaveLength(2);
    const ring = (fc.features[0].geometry as GeoJSON.Polygon).coordinates[0];
    expect(ring.length).toBe(5);
    // Autour de Compiègne : ~2,8° E, ~49,4° N.
    for (const [lon, lat] of ring) {
      expect(lon).toBeGreaterThan(2.5);
      expect(lon).toBeLessThan(3.1);
      expect(lat).toBeGreaterThan(49.2);
      expect(lat).toBeLessThan(49.6);
    }
    // L'arc partagé est parcouru en sens inverse pour le second bureau.
    const r2 = (fc.features[1].geometry as GeoJSON.Polygon).coordinates[0];
    expect(r2[r2.length - 1][0]).toBeCloseTo(r2[0][0], 9);
    const n = normalizeBvFeatures(fc, "60159");
    expect(n.features.map((f) => f.properties?.bv)).toEqual(["1", "2"]);
  });
  it("lit un fichier en flux, quel que soit l'ordre des clés et le découpage", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fsp = await import("node:fs/promises");
    // « objects » avant « arcs » et « transform » à la fin, comme d'autres exports.
    const reordered = { type: "Topology", objects: topo.objects, arcs: topo.arcs, transform: T };
    const file = path.join(os.tmpdir(), `topo-${process.pid}.json`);
    await fsp.writeFile(file, JSON.stringify(reordered, null, 1));
    const fc = await extractTopoJsonFile(file, "60159");
    expect(fc.features).toHaveLength(2);
    // Découpage arbitraire du flux : même résultat.
    const { JsonScanner, geoJsonFeatures } = await import("@/lib/collectors/json-stream");
    const gj = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { c: "60159", s: "a\\\"}" }, geometry: null }, { type: "Feature", properties: { c: "60382" }, geometry: null }] });
    const got: string[] = [];
    const sc = new JsonScanner(geoJsonFeatures, (t) => got.push(t));
    for (let i = 0; i < gj.length; i += 3) sc.feed(gj.slice(i, i + 3));
    expect(got.map((t) => JSON.parse(t).properties.c)).toEqual(["60159", "60382"]);
    await fsp.rm(file);
  });
  it("reconnaît les systèmes de coordonnées", () => {
    expect(toWgs84([2.8, 49.4])!([2.8, 49.4])).toEqual([2.8, 49.4]);
    const [lon, lat] = toWgs84([680000, 6920000])!([680000, 6920000]);
    expect(lon).toBeCloseTo(2.72, 1);
    expect(lat).toBeCloseTo(49.38, 1);
  });
});
