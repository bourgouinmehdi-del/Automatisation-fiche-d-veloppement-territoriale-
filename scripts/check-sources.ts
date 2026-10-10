/**
 * Diagnostic des sources de données (à lancer avec accès réseau) :
 *
 *   npm run check:sources                 # teste chaque source sur Compiègne (60159)
 *   npm run check:sources -- --insee 60159 # liste en plus les dimensions/modalités INSEE servies
 *
 * Sert à vérifier la disponibilité des API et à ajuster les correspondances
 * de `src/lib/collectors/insee-indicators.ts` si la nomenclature INSEE évolue.
 * Le cache est contourné (CACHE_TTL_HOURS=0).
 */
process.env.CACHE_TTL_HOURS = "0";

import { TrackedHttp } from "../src/lib/collectors/context";
import { enrichCommune, communeFromReferentiel } from "../src/lib/collectors/admin";
import { DATASETS } from "../src/lib/collectors/insee-indicators";
import { loadDataset } from "../src/lib/collectors/insee";
import { collectDvf } from "../src/lib/collectors/dvf";
import { collectEquipments } from "../src/lib/collectors/osm";
import { collectEntreprises, collectRisques, collectSchools, collectStations } from "../src/lib/collectors/public-apis";
import { collectElection, ELECTIONS } from "../src/lib/collectors/elections";

const args = process.argv.slice(2);
const code = args[args.indexOf("--insee") + 1] && args.includes("--insee") ? args[args.indexOf("--insee") + 1] : "60159";
const listDims = args.includes("--insee");

async function check(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const msg = await fn();
    console.log(`✓ ${name.padEnd(34)} ${((Date.now() - t0) / 1000).toFixed(1)} s  ${msg}`);
  } catch (e) {
    console.log(`✗ ${name.padEnd(34)} ${((Date.now() - t0) / 1000).toFixed(1)} s  ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  const c = communeFromReferentiel(code);
  if (!c) throw new Error("Code INSEE inconnu");
  console.log(`Commune de test : ${c.nom} (${c.code})\n`);
  const h = () => new TrackedHttp();
  await check("geo.api.gouv.fr", async () => {
    const e = await enrichCommune(h(), c);
    return `surface ${e.surfaceKm2?.toFixed(1)} km², contour ${e.contour ? "oui" : "non"}`;
  });
  for (const ds of DATASETS)
    await check(`INSEE ${ds}`, async () => {
      const d = await loadDataset(h(), ds, "COM", c.code);
      if (!d) throw new Error("aucune observation");
      const dims = [...d.dimValues.entries()].filter(([k]) => k !== "GEO");
      if (listDims)
        for (const [k, v] of dims) {
          const lab = d.labels.get(k);
          console.log(`      ${k}: ${[...v].slice(0, 25).map((x) => (lab?.get(x) ? `${x} (${lab.get(x)})` : x)).join(" | ")}`);
        }
      return `${d.observations.length} observations, GEO=${d.geo}, dimensions ${dims.map(([k]) => k).join(", ")}`;
    });
  await check("DVF", async () => {
    const d = await collectDvf(h(), c.code, c.departement.code);
    return `${d.nSales} ventes retenues, ${d.urls.length} fichiers annuels`;
  });
  await check("OpenStreetMap (Overpass)", async () => `${(await collectEquipments(h(), c.code)).features.length} équipements`);
  await check("Géorisques", async () => {
    const r = await collectRisques(h(), c.code);
    return `${r.risques.length} risques, ${r.catnat.length} arrêtés CatNat, ${r.icpe.length} ICPE`;
  });
  await check("Annuaire de l'éducation", async () => `${(await collectSchools(h(), c.code)).schools.length} établissements`);
  await check("SNCF Open Data", async () => {
    const s = await collectStations(h(), c.code, c.codesPostaux);
    return s.stations.map((x) => `${x.nom} (${x.frequentation.at(-1)?.voyageurs ?? "?"} voy.)`).join(", ") || "aucune gare";
  });
  await check("Recherche d'entreprises", async () => {
    const e = await collectEntreprises(h(), c.code);
    return `${e.bySection.reduce((s, x) => s + x.count, 0)} unités légales, ${e.employers.length} établissements ≥ 100 salariés`;
  });
  for (const e of ELECTIONS)
    await check(`Élections ${e.id}`, async () => {
      const r = await collectElection(h(), e, c.code, c.departement.code);
      const com = r.find((x) => x.level === "commune")!;
      return `inscrits ${com.inscrits}, votants ${com.votants}, ${com.candidates.length} listes/candidats`;
    });
}

main();
