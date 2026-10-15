/**
 * Diagnostic des sources de données (à lancer avec accès réseau) :
 *
 *   npm run check:sources                 # teste chaque source sur Compiègne (60159)
 *   npm run check:sources -- --insee 60159 # liste en plus les dimensions/modalités INSEE servies
 *
 * Sert à vérifier la disponibilité des API et à ajuster les correspondances
 * de `src/lib/collectors/insee-indicators.ts` si la nomenclature INSEE évolue.
 * Les réponses sont mises en cache (data/cache) : supprimer ce dossier pour tout retélécharger.
 */

import { TrackedHttp } from "../src/lib/collectors/context";
import { enrichCommune, communeFromReferentiel } from "../src/lib/collectors/admin";
import { DATASETS } from "../src/lib/collectors/insee-indicators";
import { loadDataset, MELODI } from "../src/lib/collectors/insee";
import { collectDvf } from "../src/lib/collectors/dvf";
import { collectEquipments } from "../src/lib/collectors/osm";
import { collectEntreprises, collectRisques, collectSchools, collectStations } from "../src/lib/collectors/public-apis";
import { collectBureaux, collectElection, ELECTIONS, resolveResource } from "../src/lib/collectors/elections";
import { collectBureauxGeo, diagnoseBureauxGeo } from "../src/lib/collectors/bureaux-geo";
import { rankBureaux, score } from "../src/lib/analysis/political";
import { loadInternalData } from "../src/lib/collectors/interne";
import { collectInsee } from "../src/lib/collectors/insee-indicators";
import { CollectContext } from "../src/lib/collectors/context";
import { collectIris, collectQpv } from "../src/lib/collectors/quartiers";
import { collectMunicipales } from "../src/lib/collectors/municipales";
import { collectBpe } from "../src/lib/collectors/bpe";
import { collectTimetables } from "../src/lib/collectors/gtfs";
import { collectRoutes } from "../src/lib/collectors/routes";

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
          console.log(`      ${k}: ${[...v].map((x) => (lab?.get(x) ? `${x} (${lab.get(x)})` : x)).join(" | ")}`);
        }
      return `${d.observations.length} observations, GEO=${d.geo}, dimensions ${dims.map(([k]) => k).join(", ")}`;
    });
  // Codes géographiques des territoires de référence (syntaxe Melodi).
  const refs: [string, "EPCI" | "DEP" | "REG" | "FRANCE", string | undefined][] = [
    ["EPCI", "EPCI", c.epci?.code],
    ["Département", "DEP", c.departement.code],
    ["Région", "REG", c.region.code],
    ["France", "FRANCE", "FR"],
  ];
  for (const [label, kind, code] of refs) {
    if (!code) continue;
    await check(`INSEE référence ${label}`, async () => {
      const d = await loadDataset(h(), "DS_FILOSOFI_CC", kind, code);
      if (!d) throw new Error("aucune observation (syntaxe du code géographique à revoir)");
      return `GEO=${d.geo}, ${d.observations.length} observations`;
    });
  }
  // Regroupement des territoires dans une seule requête Melodi (accélération des fiches).
  await check("INSEE requêtes regroupées", async () => {
    const geos = [`COM-${c.code}`, `DEP-${c.departement.code}`, `REG-${c.region.code}`];
    const r = await h().json<{ observations?: { dimensions?: Record<string, string> }[] }>(
      `${MELODI}/data/DS_FILOSOFI_CC?${geos.map((g) => `GEO=${g}`).join("&")}&maxResult=10000`,
      { noCache: true, retries: 0 },
    );
    const got = new Set((r.data?.observations ?? []).map((o) => o.dimensions?.GEO));
    if (geos.filter((g) => got.has(g)).length < 2) throw new Error(`un seul territoire renvoyé (${[...got].join(", ")}) : regroupement inactif, fiches plus lentes mais complètes`);
    return `${geos.filter((g) => got.has(g)).length}/3 territoires dans une seule requête : regroupement actif`;
  });
  // Indicateurs effectivement calculés pour la commune.
  await check("Indicateurs INSEE calculés", async () => {
    const r = await collectInsee(new CollectContext(), h(), "COM", c.code, { level: "commune", code: c.code, name: c.nom });
    for (const i of r.indicators) console.log(`      ${i.id.padEnd(34)} ${i.value?.toFixed(1)} (${i.year})`);
    for (const d of r.distributions) console.log(`      [distribution] ${d.id} : ${d.items.length} modalités`);
    console.log(`      [séries] ${r.series.map((x) => `${x.id} ${x.points.map((p) => p.x).join("/")}`).join(", ") || "aucune"}`);
    console.log(`      [âges] ${r.ages?.map((a) => a.label).join(" | ") ?? "non disponible"}`);
    return `${r.indicators.length} indicateurs, ${r.distributions.length} distributions`;
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
    await check(`Élections ${e.id} (ressource)`, async () => {
      const r = await resolveResource(h(), e);
      if (!r) throw new Error("aucune ressource « par commune » trouvée");
      return `${r.dataset} → « ${r.title} » (${r.format}) ${r.url}`;
    });
  for (const e of ELECTIONS)
    await check(`Élections ${e.id}`, async () => {
      const r = await collectElection(h(), e, c.code, c.departement.code);
      const com = r.find((x) => x.level === "commune")!;
      return `inscrits ${com.inscrits}, votants ${com.votants}, ${com.candidates.length} listes/candidats`;
    });
  // Bureaux de vote
  for (const e of ELECTIONS)
    await check(`Bureaux ${e.id} (ressource)`, async () => {
      const r = await resolveResource(h(), e, "bureau");
      if (!r) throw new Error("aucune ressource « par bureau de vote » trouvée");
      return `« ${r.title} » (${r.format}) ${r.url}`;
    });
  for (const e of ELECTIONS)
    await check(`Bureaux ${e.id}`, async () => {
      const r = await collectBureaux(h(), e, c.code, c.departement.code);
      return `${r.length} bureaux : ${r.slice(0, 4).map((b) => `BV ${b.bv} (${b.inscrits} inscrits)`).join(", ")}…`;
    });
  // Scores LFI reconnus (contrôle des libellés de listes / candidats).
  for (const e of ELECTIONS.filter((x) => x.id !== "LG24T1"))
    await check(`Score LFI ${e.id}`, async () => {
      const r = (await collectElection(h(), e, c.code, c.departement.code)).find((x) => x.level === "commune")!;
      const s = score(e.id, r, "lfi");
      console.log(`      listes/candidats : ${r.candidates.slice(0, 6).map((x) => `${x.label} (${x.voix})`).join(" | ")}`);
      if (!s?.voix) throw new Error("aucune voix LFI reconnue");
      return `${s.voix} voix, ${s.pctInscrits.toFixed(1)} % des inscrits, ${s.pctExprimes.toFixed(1)} % des exprimés`;
    });
  await check("Classement des bureaux (E24)", async () => {
    const eu = ELECTIONS.find((x) => x.id === "EU24")!;
    const pr = ELECTIONS.find((x) => x.id === "PR22T1")!;
    const rows = rankBureaux(await collectBureaux(h(), eu, c.code, c.departement.code), await collectBureaux(h(), pr, c.code, c.departement.code), new Map());
    for (const b of rows.slice(0, 6)) console.log(`      BV ${b.bv} : LFI ${b.lfiPctExp.toFixed(1)} % des exprimés, abstention ${b.abstPct.toFixed(1)} %, priorité ${b.priorite}`);
    return `${rows.length} bureaux classés, ${rows.filter((r) => r.lfi2PctIns != null).length} appariés avec P22`;
  });
  await check("Géographie des bureaux", async () => {
    const g = await collectBureauxGeo(h(), c.code);
    if (!g) {
      for (const l of await diagnoseBureauxGeo(h(), c.code)) console.log("      " + l);
      throw new Error("aucune source (déposer data/interne/bv-" + c.code + ".geojson)");
    }
    for (const [bv, l] of [...g.labels].slice(0, 5)) console.log(`      BV ${bv} : ${l}${g.points.find((p) => String(p.properties?.bv) === bv) ? ` — ${g.points.find((p) => String(p.properties?.bv) === bv)!.properties?.adresse}` : ""}`);
    // Diagnostic toujours affiché tant que les contours ne sont pas validés.
    for (const l of (await diagnoseBureauxGeo(h(), c.code)).filter((l) => /^contours «|^ {2}[^ •]/.test(l))) console.log("      " + l);
    return `${g.method} — ${g.features.length} contours, ${g.points.length} lieux de vote géocodés, ${g.labels.size} libellés (${g.sourceName})`;
  });
  // Sources ajoutées en version 0.3 (quartiers, municipales, services, accès).
  await check("QPV (ANCT + INSEE)", async () => {
    const q = await collectQpv(h(), c.code);
    for (const x of q.quartiers) console.log(`      ${x.code} ${x.nom} : contour ${x.geometry ? "oui" : "non"}, ${JSON.stringify(x.stats)}`);
    for (const n of q.notes) console.log(`      note : ${n}`);
    return `${q.quartiers.length} QPV`;
  });
  await check("IRIS (IGN + INSEE)", async () => {
    const q = await collectIris(h(), c.code);
    for (const x of q.quartiers.slice(0, 5)) console.log(`      ${x.code} ${x.nom} (${x.type}) : ${JSON.stringify(x.stats)}`);
    for (const n of q.notes) console.log(`      note : ${n}`);
    return `${q.quartiers.length} IRIS`;
  });
  await check("Municipales 2026 et maire", async () => {
    const m = await collectMunicipales(h(), c.code);
    for (const r of m.rounds) console.log(`      tour ${r.tour} : ${r.listes.map((l) => `${l.libelle} (${l.nuance}, ${l.pctExprimes.toFixed(1)} %, ${l.sieges ?? "?"} sièges)`).join(" | ")}`);
    return `majorité : ${m.majorite?.libelle ?? "?"} (${m.majorite?.nuance ?? "?"}) ; maire : ${m.maire ? `${m.maire.prenom} ${m.maire.nom}` : "n.d."}`;
  });
  await check("BPE 2025 (fichier national)", async () => {
    const b = await collectBpe(h(), c.code, c.departement.code);
    const n = (t: string) => b.commune.filter((e) => e.type === t).length;
    return `${b.commune.length} équipements retenus dans la commune ; médecins généralistes ${n("D265")} ; France Services ${n("A128")} ; département : ${b.countsDep.D265 ?? 0} médecins`;
  });
  await check("Horaires SNCF (GTFS)", async () => {
    const st = await collectStations(h(), c.code, c.codesPostaux);
    if (!st.stations.length) return "aucune gare dans la commune";
    const t = await collectTimetables(h(), st.stations);
    return t.stations.map((s) => `${s.nom} : ${s.departs} passages le ${s.date}, pointe ${s.pointe?.join("-") ?? "?"} h, Paris ${s.paris ? `${s.paris.minMinutes} min` : "pas de direct"}`).join(" ; ");
  });
  await check("Temps de trajet (OSRM)", async () => {
    const e = await enrichCommune(h(), c);
    if (!e.centre) throw new Error("centre de la commune inconnu");
    const r = await collectRoutes(h(), e.centre, [{ label: "Paris", nom: "Paris", to: [2.3488, 48.8534] }]);
    return r.routes.map((x) => `${x.nom} : ${x.minutes} min, ${x.km} km`).join(" ; ");
  });
  await check("Données internes (data/interne)", async () => {
    const d = await loadInternalData();
    return d.files.length ? `${d.files.join(", ")} : ${d.parrains.size} communes avec parrains, ${d.groupes.length} groupes${d.unmatched ? ` (${d.unmatched} sans commune reconnue)` : ""}` : "aucun fichier (facultatif)";
  });
}

main();
