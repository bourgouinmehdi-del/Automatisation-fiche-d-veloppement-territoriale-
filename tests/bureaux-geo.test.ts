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
