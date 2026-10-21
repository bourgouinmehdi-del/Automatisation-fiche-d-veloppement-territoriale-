/**
 * Test d'intégration de la chaîne complète avec des API SIMULÉES
 * (tests/fixtures/mock-apis.ts — valeurs fictives).
 * Vérifie : collecte multi-sources, calculs, constats, cartes, graphiques,
 * exports HTML/DOCX/CSV (et PDF si Chromium est disponible), cache.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { melodiCalls, mockFetch } from "./fixtures/mock-apis";
import type { Report } from "@/lib/types";

const dir = path.join(os.tmpdir(), `fiche-test-${process.pid}`);
let report: Report;
let build: typeof import("@/lib/report/build").buildReport;

beforeAll(async () => {
  process.env.DATA_DIR = dir;
  process.env.INSEE_MIN_INTERVAL_MS = "0";
  // Données internes facultatives (fictives).
  await fs.mkdir(path.join(dir, "interne"), { recursive: true });
  await fs.writeFile(path.join(dir, "interne", "parrains.csv"), "code_commune;parrains\n60159;40\n60382;5\n60057;20\n");
  await fs.writeFile(path.join(dir, "interne", "bilan.csv"), "code_insee;nb_actions;nb_ga_actifs;nb_parrains;inscrits;estime\n60159;60;2;300;25000;0\n60057;20;1;100;20000;0\n60151;5;2;250;3000;0\n60382;1.5;0;6.6;900;1\n01001;9000;1000;80000;9074100;0\n");
  await fs.writeFile(path.join(dir, "interne", "groupes.csv"), "code_commune;nom;membres;statut\n60159;Groupe d'action fictif;9;actif\n");
  // Export Action Populaire : commune retrouvée par code postal et ville.
  await fs.writeFile(path.join(dir, "interne", "action-populaire.csv"), "Nom;Code postal;Ville;Nombre de membres;Certifié\nGroupe des étudiants;60200;Compiègne;4;Oui\n");
  // Demandeurs d'emploi (fichiers France Travail, fictifs) : déposés bruts, importés au premier usage.
  {
    const head = "COMRES;MOISTA;_FREQ_;part_fem;AGE_m;ancien_m;ancien_mn\n";
    const months = ["202408", "202508", "202607", "202608"];
    const com = months.map((m, k) => `60159;${m};${3600 + 200 * k};0.5;39.5;600;\n60057;${m};${800 + 10 * k};0.48;41;700;\n60001;${m};2;;;;`).join("\n");
    await fs.writeFile(path.join(dir, "interne", "RES_STMT_COM_1.csv"), "\uFEFF" + head + com + "\n");
    await fs.writeFile(path.join(dir, "interne", "RES_NAT.csv"), head + months.map((m, k) => `;${m};${5500000 + 100000 * k};0.51;39.3;640;`).join("\n") + "\n");
  }
  vi.stubGlobal("fetch", mockFetch());
  build = (await import("@/lib/report/build")).buildReport;
  report = await build({ codeInsee: "60159", scope: "commune" });
}, 120000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

const ind = (id: string, level = "commune") => report.indicators.find((i) => i.id === id && i.geo.level === level);

describe("chaîne de génération (API simulées)", () => {
  it("INSEE : territoires demandés ensemble (moins de requêtes), sans perte de données", () => {
    const grouped = melodiCalls.filter((g) => g.length > 1);
    expect(grouped.length).toBeGreaterThan(0);
    // Sans regroupement : une requête par jeu et par territoire.
    const territoires = melodiCalls.reduce((n, g) => n + g.length, 0);
    expect(melodiCalls.length).toBeLessThan(territoires * 0.6);
    for (const lvl of ["commune", "epci", "departement", "region"]) expect(report.indicators.some((i) => i.geo.level === lvl && i.id === "revenu_median")).toBe(true);
  });

  it("toutes les sources simulées sont interrogées avec succès", () => {
    const failed = report.runs.filter((r) => r.status === "failed");
    expect(failed.map((f) => `${f.step}: ${f.message}`)).toEqual([]);
    const sources = new Set(report.runs.map((r) => r.sourceId));
    for (const s of ["geoapi", "insee_melodi", "dvf", "osm", "georisques", "education", "sncf", "entreprises", "elections"]) expect(sources).toContain(s);
  });

  it("chaque indicateur porte sa traçabilité", () => {
    for (const i of report.indicators) {
      expect(i.source.name).toBeTruthy();
      expect(i.source.retrievedAt).toMatch(/^\d{4}-/);
      expect(i.unit).toBeTruthy();
      expect(i.geo.code).toBeTruthy();
    }
  });

  it("calcule les parts d'âge à partir des tranches réellement diffusées", () => {
    // Partition fictive 2023 : 7000, 6500, 8000, 7500, 4500, 5200, 2000 → total 40 700.
    expect(ind("part_65_plus")!.value).toBeCloseTo(((5200 + 2000) / 40700) * 100, 6);
    expect(ind("part_moins_25")!.value).toBeCloseTo(((7000 + 6500) / 40700) * 100, 6);
    expect(ind("part_80_plus")!.value).toBeCloseTo((2000 / 40700) * 100, 6);
    expect(ind("part_moins_30")).toBeUndefined(); // pas de borne à 30 ans : pas d'estimation
  });

  it("construit l'historique de population à partir des millésimes du recensement", () => {
    const s = report.series.find((x) => x.id === "pop_historique" && x.geo.level === "commune")!;
    expect(s.points.map((p) => p.x)).toEqual(["2012", "2017", "2023"]);
    expect(ind("evol_pop_annuelle")).toBeDefined();
  });

  it("calcule les ratios logement / emploi / diplôme / mobilité", () => {
    expect(ind("part_logements_vacants")!.value).toBeCloseTo((2000 / 22000) * 100, 6);
    expect(ind("part_locataires_hlm")!.value).toBeCloseTo((5000 / 19500) * 100, 6);
    expect(ind("part_proprietaires")!.value).toBeCloseTo((7500 / 19500) * 100, 6);
    expect(ind("part_maisons")!.value).toBeCloseTo((6000 / 22000) * 100, 6);
    // Tranche 15-64 ans explicitement retenue (pas de total d'âge dans ce jeu).
    expect(ind("taux_chomage_rp")!.value).toBeCloseTo((2600 / (16000 + 2600)) * 100, 6);
    expect(ind("taux_emploi")!.value).toBeCloseTo((16000 / 26000) * 100, 6);
    // Définition INSEE : actifs occupés résidents de 15 ans ou plus (21 600 dans la simulation).
    expect(ind("concentration_emploi")!.value).toBeCloseTo((24000 / 21600) * 100, 6);
    expect(ind("part_diplome_superieur")!.value).toBeCloseTo((10000 / 28000) * 100, 6);
    expect(ind("part_sans_diplome")!.value).toBeCloseTo((7000 / 28000) * 100, 6);
    expect(ind("part_personnes_seules")!.value).toBeCloseTo((6800 / 34000) * 100, 6);
    expect(ind("part_menages_sans_voiture")!.value).toBeCloseTo((5000 / 19500) * 100, 6);
    expect(ind("part_trajets_voiture")!.value).toBeCloseTo((9000 / 16000) * 100, 6);
    expect(ind("part_actifs_travaillant_commune")!.value).toBeCloseTo((7000 / 16000) * 100, 6);
  });

  it("distributions : partitions explicites sans double compte", () => {
    const d = (id: string) => report.charts.find((c) => c.id === "chart_" + id)!;
    expect(d("dist_mode_transport").data.map((r) => r.modalite)).toEqual(["Pas de déplacement", "Marche à pied", "Vélo", "Deux-roues motorisé", "Voiture, camion, fourgonnette", "Transports en commun"]);
    expect(d("dist_periode_construction").data).toHaveLength(6);
    expect(d("dist_csp").data).toHaveLength(8);
    expect(d("dist_diplomes").data).toHaveLength(7);
  });

  it("collecte les mêmes indicateurs pour les territoires de référence", () => {
    for (const lvl of ["epci", "departement", "region", "france"]) expect(ind("revenu_median", lvl)?.value).toBeTypeOf("number");
  });

  it("prix immobiliers DVF : médiane des ventes simples", () => {
    const p = ind("prix_m2_appartement")!;
    expect(p.denominator).toBe(41); // 40 ventes + 1 avec dépendance ; la vente multiple est exclue
    expect(p.value).toBeGreaterThan(2000);
  });

  it("produit cartes, graphiques et tableaux à partir des données collectées", () => {
    const maps = report.maps.map((m) => m.id);
    for (const id of ["map_localisation", "map_densite", "map_revenus", "map_equipements", "map_transports", "map_participation"]) expect(maps).toContain(id);
    const charts = report.charts.map((c) => c.id);
    for (const id of ["chart_pop_historique", "chart_ages", "chart_pyramide", "chart_dvf", "chart_sections", "chart_participation", "chart_dist_voitures", "chart_dist_lieu_travail"]) expect(charts).toContain(id);
    expect(report.tables.find((t) => t.id === "table_voisins")!.rows.length).toBe(8);
    // Sélecteur de période : une carte de participation par scrutin.
    expect(report.maps.filter((m) => m.group === "participation").length).toBe(3);
  });

  it("génère des constats reliés aux indicateurs, y compris des vigilances", () => {
    expect(report.findings.length).toBeGreaterThan(10);
    const vig = report.findings.filter((f) => f.kind === "vigilance");
    expect(vig.length).toBeGreaterThan(0);
    // Toute affirmation chiffrée est reliée à des indicateurs (les pistes d'action et vérifications en sont exemptées).
    for (const f of report.findings.filter((x) => x.kind !== "a_verifier" && x.kind !== "piste")) expect(f.evidence.length, f.text).toBeGreaterThan(0);
    // Toute preuve citée correspond à un indicateur existant.
    const ids = new Set(report.indicators.map((i) => `${i.id}@${i.geo.level}:${i.geo.code}`));
    for (const f of report.findings) for (const e of f.evidence) expect(ids.has(e)).toBe(true);
  });

  it("produit la fiche d'action puis les 9 parties A à I", () => {
    expect(report.sections[0].id).toBe("LFI");
    expect(report.sections.slice(1).map((s) => s.letter).join("")).toBe("ABCDEFGHI");
  });

  it("fiche d'action : bureaux de vote, carte, profil politique, actions", () => {
    const bv = report.tables.find((t) => t.id === "lfi_bureaux")!;
    expect(bv.rows).toHaveLength(6);
    expect(bv.rows[0].bv).toBe("2"); // vote LFI 35 % des exprimés, forte abstention
    expect(bv.rows[0].libelle).toBe("École Fictive B"); // libellé REU mis en forme
    expect(report.maps.find((m) => m.id === "lfi_map_bv")!.layers[0].data.features).toHaveLength(6);
    const pol = report.tables.find((t) => t.id === "lfi_politique")!;
    expect(pol.columns.map((c) => c.key)).toContain("parrains");
    expect(String(pol.rows[0].parrains)).toMatch(/^40 /);
    const kinds = new Set(report.findings.filter((f) => f.theme === "strategie").map((f) => f.kind));
    for (const k of ["atout", "hypothese", "piste"]) expect(kinds).toContain(k);
    expect(report.findings.some((f) => f.theme === "strategie" && /Porte-à-porte/.test(f.text))).toBe(true);
    expect(report.tables.find((t) => t.id === "lfi_lieux")!.rows.length).toBeGreaterThan(0);
    // Commune, département, France ; 4 à 7 indicateurs.
    const socioT = report.tables.find((t) => t.id === "lfi_socio")!;
    expect(socioT.rows.length).toBe(3);
    expect(socioT.columns.length - 1).toBeGreaterThanOrEqual(4);
    expect(socioT.columns.length - 1).toBeLessThanOrEqual(7);
  });

  it("fiche d'action rédigée sur le modèle « Développement territorial »", async () => {
    const fiche = report.sections[0];
    const types = fiche.blocks.map((b) => b.type);
    // Avertissement, chiffres clés, intertitres, cartes jumelles, actions groupées.
    expect(fiche.blocks[0]).toMatchObject({ type: "callout", tone: "warning" });
    for (const t of ["glance", "heading", "map", "table"]) expect(types).toContain(t);
    const headings = fiche.blocks.filter((b) => b.type === "heading").map((b) => (b as { text: string }).text);
    expect(headings).toEqual(expect.arrayContaining(["Profil sociodémographique du territoire", "Profil politique du territoire", "Actions recommandées"]));
    // Fiche : plan d'action en tableau ; toutes les pistes détaillées en annexe.
    const plan = report.tables.find((t) => t.id === "lfi_plan")!;
    expect(plan.rows[0]).toMatchObject({ action: "Porte-à-porte", bv: "2" });
    expect(plan.columns.length).toBeLessThanOrEqual(7);
    expect(report.tables.find((t) => t.id === "lfi_bureaux_prio")!.columns.length).toBeLessThanOrEqual(7);
    const detail = report.sections.find((x) => x.id === "LFI_DETAIL")!;
    const actions = detail.blocks.find((b) => b.type === "actions") as Extract<(typeof fiche.blocks)[number], { type: "actions" }>;
    expect(actions.groups[0].title).toBe("Porte-à-porte");
    expect(actions.groups[0].items[0]).toMatch(/^\*\*BV 2/);
    expect(types).not.toContain("actions");
    // Les constats rédigés renvoient à des constats existants.
    for (const b of fiche.blocks) if (b.type === "findings" && b.ids) for (const id of b.ids) expect(report.findings.some((f) => f.id === id)).toBe(true);
    // Profil socio synthétique : intro en langage courant, tableau limité aux indicateurs
    // déterminants (7 au plus), 3 phrases qualitatives au plus, retours du terrain par partie.
    const iSocio = fiche.blocks.findIndex((b) => b.type === "heading" && b.text === "Profil sociodémographique du territoire");
    const intro = fiche.blocks[iSocio + 1] as Extract<(typeof fiche.blocks)[number], { type: "paragraph" }>;
    expect(intro.type).toBe("paragraph");
    expect(intro.text).toMatch(/habitants/);
    const t = report.tables.find((x) => x.id === "lfi_socio")!;
    expect(t.columns.length - 1).toBeGreaterThanOrEqual(1);
    expect(t.columns.length - 1).toBeLessThanOrEqual(7);
    const qual = fiche.blocks.slice(iSocio).find((b) => b.type === "list") as Extract<(typeof fiche.blocks)[number], { type: "list" }> | undefined;
    if (qual) expect(qual.items.length).toBeLessThanOrEqual(3);
    expect(fiche.blocks.some((b) => b.type === "list" && b.items.some((i) => /^Dans la moyenne départementale/.test(i.text)))).toBe(false);
    const parts = fiche.blocks.filter((b) => b.type === "fieldNotes").map((b) => (b as { part?: string }).part ?? "general");
    expect(parts).toEqual(expect.arrayContaining(["general", "socio", "politique", "actions"]));
    // Profil politique : graphiques et chiffres, pas de texte rédigé.
    const iP = fiche.blocks.findIndex((b) => b.type === "heading" && b.text === "Profil politique du territoire");
    const iO = fiche.blocks.findIndex((b) => b.type === "heading" && /Où agir/.test(b.text));
    expect(fiche.blocks.slice(iP + 1, iO).filter((b) => b.type === "paragraph" || b.type === "findings")).toEqual([]);
    // Gras rendu en HTML, retiré du CSV.
    const { renderReportHtml } = await import("@/lib/render/html");
    const { tableCsv } = await import("@/lib/export/csv");
    const html = renderReportHtml(report, { sectionIds: ["LFI"] });
    expect(html).toContain("<strong>");
    expect(html).not.toMatch(/\*\*/);
    expect(html).toContain("Proposition de ciblage");
    expect(tableCsv(report.tables.find((t) => t.id === "lfi_politique")!)).not.toContain("**");
  });

  it("quartiers, contexte municipal, services, horaires et temps de trajet", async () => {
    // Quartiers : QPV et IRIS, rattachés aux bureaux de vote.
    const q = report.tables.find((t) => t.id === "lfi_quartiers")!;
    expect(q.rows[0].nom).toMatch(/Quartier Fictif Nord.*QPV/);
    expect(q.rows[0].pauvrete).toMatch(/^50\s%$/);
    expect(q.rows[0].bv).toBe("2");
    expect(q.rows.length).toBe(6); // 1 QPV + 4 IRIS + commune
    const bv = report.tables.find((t) => t.id === "lfi_bureaux")!;
    expect(bv.rows.find((r) => r.bv === "2")!.quartier).toMatch(/QPV/);
    expect(report.tables.find((t) => t.id === "lfi_politique")!.rows.some((r) => /QPV quartier Fictif Nord|QPV Quartier Fictif Nord/.test(String(r.territoire)))).toBe(true);
    expect(report.findings.some((f) => /concentre la pauvreté/.test(f.text))).toBe(true);
    expect(report.maps.find((m) => m.id === "lfi_map_bv")!.layers.some((l) => l.id === "qpv")).toBe(true);
    // Municipales 2026 et maire.
    const muni = report.tables.find((t) => t.id === "lfi_municipales")!;
    expect(muni.rows).toHaveLength(3);
    expect(muni.highlight).toEqual([0]);
    const fiche = report.sections[0];
    expect(fiche.blocks.some((b) => b.type === "paragraph" && /dirigée par/.test(b.text))).toBe(false);
    const annexe = report.sections.find((x) => x.id === "LFI_DETAIL")!;
    expect(annexe.blocks.some((b) => b.type === "paragraph" && /dirigée par Alice DURAND/.test(b.text) && /gauche battue/.test(b.text))).toBe(true);
    // BPE : désert médical (2 médecins pour ~41 000 habitants, département bien mieux doté).
    const socio = fiche.blocks.find((b) => b.type === "list" && b.items.some((i) => /Désert médical/.test(i.text))) as Extract<(typeof fiche.blocks)[number], { type: "list" }>;
    expect(socio.items.some((i) => /Désert médical/.test(i.text) && /France Services/.test(i.text))).toBe(true);
    // Horaires GTFS : pointe du soir et temps vers Paris ; temps routiers.
    const actions = report.sections.find((x) => x.id === "LFI_DETAIL")!.blocks.find((b) => b.type === "actions") as Extract<(typeof fiche.blocks)[number], { type: "actions" }>;
    const gare = actions.groups.find((g) => g.title === "Gare")!;
    expect(gare.items[0]).toMatch(/Paris en 52 min/);
    // Actions du week-end : créneaux samedi / dimanche, ni sorties d'établissements ni services fermés.
    expect(gare.items.some((t) => /Le week-end : samedi 9 h/.test(t))).toBe(true);
    expect(actions.groups.some((g) => /Sorties|Services publics/.test(g.title))).toBe(false);
    const plan = report.tables.find((t) => t.id === "lfi_plan")!;
    expect(plan.rows.length).toBeGreaterThan(0);
    // Ni poste ni simple supermarché ; un moment convivial dans un grand parc nommé.
    expect(plan.rows.some((r) => /poste|^Supermarché$/i.test(String(r.action)))).toBe(false);
    // Grandes surfaces : enseigne d'un grand groupe, desservie ; ni format de proximité ni magasin sans arrêt.
    expect(plan.rows.find((r) => /hypermarché/.test(String(r.action)))).toMatchObject({ ou: "E.Leclerc (Avenue fictive)" });
    const gs = actions.groups.find((g) => g.title === "Grandes surfaces")!.items.join(" ");
    expect(gs).not.toMatch(/Carrefour City|Auchan/);
    // Présence militante : parrains, groupes actifs, actions ; trait = moyenne nationale.
    const pres = report.sections.find((x) => x.id === "LFI")!.blocks.find((b) => b.type === "presence");
    expect(pres && "rows" in pres ? pres.rows.map((r) => r.label) : []).toEqual(["Parrains et marraines", "Groupes d'action actifs", "Actions"]);
    if (pres && pres.type === "presence") {
      expect(pres.rows[0]).toMatchObject({ n: 300, r: 1.2 });
      // Comparaison aux communes de même taille (10 000 à 30 000 inscrits : 60159 et 60057).
      expect(pres.rows[0].rRef).toBeCloseTo(0.8889, 3);
      expect(pres.rows[1].rRef).toBeCloseTo(0.6667, 3);
      expect(pres.note).toMatch(/communes de même taille \(10\u00a0000 à 30\u00a0000 inscrits, 2 communes\)/);
      expect(pres.rows[1].rUnit).toBe("pour 10 000 inscrits");
      expect(Math.round(pres.rows[2].nRef)).toBe(44);
    }
    // Temps de trajet depuis les villes militantes proches (Choisy-au-Bac : 2 groupes actifs).
    const accT = report.tables.find((t) => t.id === "commune_acces");
    expect(accT?.rows[0]).toMatchObject({ ville: "Choisy-au-Bac" });
    expect(String(accT?.rows[0].voiture)).toMatch(/min|h/);
    const lfiB = report.sections.find((x) => x.id === "LFI")!.blocks;
    expect(lfiB.some((b) => b.type === "heading" && b.text === "Venir depuis les villes militantes proches")).toBe(true);
    // Effectifs estimés pour les bureaux prioritaires.
    const tete = report.sections.find((x) => x.id === "LFI")!.blocks.find((b) => b.type === "paragraph" && /À avoir en tête/.test(b.text));
    expect(tete && "text" in tete ? tete.text : "").toMatch(/médecins généralistes .*\(6,3 dans le département\) ; .* de chômage/);
    expect(report.tables.some((t) => t.id === "lfi_sujets")).toBe(false);
    const eff = report.tables.find((t) => t.id === "lfi_effectifs")!;
    expect(String(eff.rows[eff.rows.length - 1].binomes)).toMatch(/militants/);
    // Stations de métro et de tram : lieux de tractage (sorties de station).
    const st = actions.groups.find((g) => g.title === "Métro, RER, tram");
    expect(st?.items.join(" ")).toMatch(/Métro Mairie fictive/);
    expect(plan.rows.some((r) => r.action === "Tractage en sortie de métro" && r.ou === "Métro Mairie fictive")).toBe(true);
    // Grande surface : desserte nommée.
    expect(gs).toMatch(/du tram Centre commercial/);
    // Sur la carte : la grande surface dans le tractage, le parc en « moment convivial ».
    const aff = report.maps.find((m) => m.id === "lfi_affiche")!;
    expect(aff.layers.find((l) => l.id === "tractage")!.data.features.some((f) => /Leclerc/.test(String(f.properties?.nom)))).toBe(true);
    expect(aff.layers.find((l) => l.id === "convivial")?.data.features[0].properties?.nom).toBe("Parc fictif");
    expect(plan.rows.find((r) => r.action === "Moment convivial")).toMatchObject({ ou: "Parc fictif" });
    const conv = actions.groups.find((g) => g.title === "Moment convivial")!;
    expect(conv.items.join(" ")).toMatch(/Grand café fictif/);
    expect(conv.items.join(" ")).not.toMatch(/Petit bar/);
    for (const r of plan.rows) {
      expect(String(r.action)).not.toMatch(/Sortie/);
      expect(String(r.quand)).not.toMatch(/semaine/i);
    }
    const access = fiche.blocks.find((b) => b.type === "paragraph" && /Accès/.test(b.text)) as { text: string };
    expect(access.text).toMatch(/en voiture/);
    // Groupe d'action importé depuis l'export Action Populaire (code postal + ville).
    expect(fiche.blocks.some((b) => b.type === "callout" && /Groupe d'action fictif/.test(b.text))).toBe(true);
  });

  it("demandeurs d'emploi : tableau, graphique, phrase de la fiche", () => {
    const t = report.tables.find((x) => x.id === "table_demandeurs")!;
    expect(t.rows[0]).toMatchObject({ territoire: "Compiègne", n: expect.stringMatching(/^4\s?200$/) });
    expect(t.rows.map((r) => r.territoire)).toEqual(["Compiègne", "Oise", "France"]);
    // Oise = somme des communes du fichier (60159 + 60057 + 60001).
    expect(String(t.rows[1].n).replace(/\D/g, "")).toBe(String(4200 + 830 + 2));
    expect(report.charts.some((c) => c.id === "chart_demandeurs")).toBe(true);
    const fiche = report.sections[0];
    const lists = fiche.blocks.filter((b) => b.type === "list") as Extract<(typeof fiche.blocks)[number], { type: "list" }>[];
    expect(lists.some((l) => l.items.some((i) => /demandeurs d'emploi\*\* fin août 2026/.test(i.text)))).toBe(true);
    expect(report.sections.find((x) => x.id === "C")!.blocks.some((b) => b.type === "table" && b.tableId === "table_demandeurs")).toBe(true);
  });

  it("carte « affiche » de la commune : porte-à-porte et tractage sur fond de plan", async () => {
    const m = report.maps.find((x) => x.id === "lfi_affiche")!;
    expect(m.poster?.kicker).toBe("Compiègne");
    const ids = m.layers.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(["voisins", "commune", "voies", "fer", "limite", "bv_prio", "qpv", "residences", "tractage"]));
    expect(m.layers.find((l) => l.id === "residences")!.data.features[0].properties).toMatchObject({ nom: "Roberval" });
    expect(m.layers.find((l) => l.id === "residences")!.data.features[0].properties?.sub).toMatch(/^Résidence du Crous · 385 logements/);
    expect(m.layers.find((l) => l.id === "tractage")!.data.features.some((f) => /voyageurs\/jour/.test(f.properties?.sub))).toBe(true);
    const { mapSvg } = await import("@/lib/render/svg");
    const svg = mapSvg(m);
    for (const t of ["COMPIÈGNE", "Propositions de ciblage : porte-à-porte et tractage", "Roberval", "#F91616", "Tractage : marché, gare", "OÙ AGIR", "Limite communale"]) expect(svg).toContain(t);
    const fiche = report.sections[0];
    const iAct = fiche.blocks.findIndex((b) => b.type === "heading" && b.text === "Actions recommandées");
    expect(fiche.blocks.slice(iAct).some((b) => b.type === "map" && b.mapId === "lfi_affiche")).toBe(true);
  });

  it("résidences Crous et foyers de jeunes travailleurs : porte-à-porte systématique et annexe", async () => {
    const plan = report.tables.find((t) => t.id === "lfi_plan")!;
    const porte = plan.rows.filter((r) => r.action === "Porte-à-porte").map((r) => String(r.ou));
    expect(porte.some((o) => o.startsWith("Roberval (résidence du Crous), 1 Rue Bachaga Boualem"))).toBe(true);
    expect(porte.some((o) => o.startsWith("Picardie (foyer de jeunes travailleurs)"))).toBe(true);
    expect(plan.columns.map((c) => c.label)).toEqual(["Action", "Où", "Pourquoi", "Quand", "Bureau"]);
    for (const r of plan.rows) expect(String(r.quand)).not.toBe("");
    const annexe = report.tables.find((t) => t.id === "lfi_residences")!;
    expect(annexe.columns.map((c) => c.label)).toEqual(["Nom", "Type", "Gestionnaire", "Nombre de logements", "Adresse"]);
    const logements = annexe.rows.map((r) => Number(String(r.logements).replace(/\D/g, "")) || -1);
    expect(logements).toEqual([...logements].sort((a, b) => b - a));
    const detail = report.sections.find((x) => x.id === "LFI_DETAIL")!;
    expect(detail.blocks.some((b) => b.type === "table" && b.tableId === "lfi_residences")).toBe(true);
  });

  it("graphiques par scrutin en onglets (présidentielles 2017 et 2022, européennes 2019 et 2024)", async () => {
    const g = report.charts.filter((c) => c.group === "lfi_votes");
    expect(g.map((c) => c.tab)).toEqual(expect.arrayContaining(["Présidentielle 2022", "Européennes 2024"]));
    for (const c of g) {
      expect(c.type).toBe("refbar");
      // Dernière barre : l'abstention (part des inscrits), avec l'abstention nationale.
      expect(c.data[c.data.length - 1].label).toBe("Abstention");
      expect(c.data[c.data.length - 2].label).toBe("Autres");
      const total = c.data.filter((d) => d.label !== "Abstention").reduce((s, d) => s + Number(d.value), 0);
      expect(total).toBeGreaterThan(99);
      expect(total).toBeLessThan(101);
    }
    const p22 = g.find((c) => c.id === "lfi_chart_pr22");
    if (p22) expect(p22.data.find((d) => d.label === "Mélenchon (LFI)")).toMatchObject({ ref: 21.95 });
  });

  it("comparaisons du vote en mots : une seule règle, jamais « autant » et « nettement plus » à la fois", async () => {
    const { voteCompare } = await import("@/lib/report/lfi");
    expect(voteCompare(6, 4)).toMatchObject({ dir: "plus", words: "un peu plus", net: false });
    expect(voteCompare(15, 14)).toMatchObject({ dir: "autant" });
    expect(voteCompare(22, 15)).toMatchObject({ dir: "plus", net: true });
    expect(voteCompare(12, 6).words).toBe("deux fois plus");
    expect(voteCompare(7, 3.5).words).toBe("nettement plus");
    expect(voteCompare(8, 12)).toMatchObject({ dir: "moins", net: true });
  });

  it("graphique « Européennes 2024 » dans le profil politique", async () => {
    const ch = report.charts.find((c) => c.id === "lfi_chart_eu24")!;
    expect(ch.type).toBe("refbar");
    expect(ch.data.map((d) => d.label)).toEqual(["PCF", "LFI", "LÉ", "PS / PP", "Ensemble", "LR", "RN", "Reconquête", "Autres", "Abstention"]);
    expect(ch.data.find((d) => d.label === "LFI")).toMatchObject({ color: "#E8434B", ref: 9.89 });
    expect(ch.data.find((d) => d.label === "Abstention")).toMatchObject({ refIns: 48.51, value: null });
    // Deux lectures : « % inscrits » (par défaut, exports) et « % exprimés » ; trait en tirets avant l'abstention.
    expect(ch.modes?.map((m) => m.label)).toEqual(["% inscrits", "% exprimés"]);
    expect(ch.series[0].key).toBe("ins");
    expect(ch.sepKey).toBe("Abstention");
    const fiche = report.sections[0];
    const iPol = fiche.blocks.findIndex((b) => b.type === "heading" && b.text === "Profil politique du territoire");
    const iOu = fiche.blocks.findIndex((b) => b.type === "heading" && /Où agir/.test(b.text));
    const iChart = fiche.blocks.findIndex((b) => b.type === "chart" && b.chartId === "lfi_chart_eu24");
    expect(iChart).toBeGreaterThan(iPol);
    expect(iChart).toBeLessThan(iOu);
    const { chartSvg } = await import("@/lib/render/svg");
    expect(chartSvg(ch)).toContain("#830E21");
  });

  it("logements sociaux (RPLS) : résidences, bureaux, carte, porte-à-porte", async () => {
    const t = report.tables.find((x) => x.id === "lfi_hlm")!;
    // Fiche : rue par rue (les deux programmes de la rue des Roses ensemble).
    expect(t.rows[0]).toMatchObject({ rue: "Rue des Roses (n° 4 et 12)", nom: "Les Musiciens, Clos des Roses", logements: "500" });
    expect(String(t.rows[0].bv)).toMatch(/prioritaire/);
    const prioT = report.tables.find((x) => x.id === "lfi_bureaux_prio")!;
    expect(prioT.columns.map((c) => c.key)).toContain("hlm");
    const m = report.maps.find((x) => x.id === "lfi_affiche")!;
    const hl = m.layers.find((l) => l.id === "hlm")!;
    // Rue par rue : les deux programmes de la rue des Roses forment un seul lieu numéroté (500 logements, bureau prioritaire).
    expect(hl.data.features[0].properties).toMatchObject({ nom: "Rue des Roses (n° 4 et 12)", sub: expect.stringMatching(/^500 logements sociaux · bureau 2 \(prioritaire\)/) });
    expect(m.layers.find((l) => l.id === "qpv")?.style?.fill).toBe("none");
    // Une seule numérotation : la carte, la liste HTML et la carte interactive.
    const { posterItems } = await import("@/lib/render/poster");
    const items = posterItems(m);
    expect(items.map((i) => i.n)).toEqual(items.map((_, k) => k + 1));
    expect(items.some((i) => i.layerId === "hlm" && i.quand)).toBe(true);
    const { mapSvg } = await import("@/lib/render/svg");
    expect(mapSvg(m, 720, 540, { posterList: false })).not.toContain("OÙ AGIR");
    expect(mapSvg(m)).toContain("OÙ AGIR");
    // Nom de la rue ciblée écrit le long de la voie.
    expect(mapSvg(m)).toContain("Rue des Roses</text>");
    const fiche = report.sections[0];
    expect(fiche.blocks.some((b) => b.type === "paragraph" && /en commençant par les logements sociaux de la rue des Roses \(500 logements\)/.test(b.text))).toBe(true);
    const porte = report.sections.find((s) => s.id === "PORTE")!;
    expect(porte.blocks.some((b) => b.type === "paragraph" && /Résidences HLM du bureau/.test(b.text))).toBe(true);
  });

  it("non-inscription : estimation commune et par bureau", () => {
    const fiche = report.sections[0];
    const p = fiche.blocks.find((b) => b.type === "paragraph" && /Des habitants absents des listes électorales/.test(b.text)) as { text: string } | undefined;
    expect(p?.text).toMatch(/environ 2\s?900 adultes de nationalité française/);
    const ind = report.indicators.find((i) => i.id === "taux_inscription_estime" && i.geo.level === "commune")!;
    expect(ind.value).toBeGreaterThan(85);
    expect(ind.value).toBeLessThan(95);
    const t = report.tables.find((x) => x.id === "lfi_inscription");
    expect(t?.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("fiche en langage courant : pas de jargon, tableau du vote court", async () => {
    const { renderReportHtml } = await import("@/lib/render/html");
    const html = renderReportHtml(report, { sectionIds: ["LFI"] });
    const text = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
    for (const jargon of [/\bE24\b/, /\bP22\b/, /\bpts?\b/, /surperform/i, /exprimés/, /\bQPV\b/, /scores? z/i]) expect(text).not.toMatch(jargon);
    const vote = report.tables.find((t) => t.id === "lfi_vote")!;
    expect(vote.columns.length).toBeLessThanOrEqual(7);
    for (const r of vote.rows) for (const [k, v] of Object.entries(r)) if (k !== "territoire" && k !== "inscrits" && v) expect(String(v)).toMatch(/^[\d\s\u00a0]+(%)?$/);
    const fiche = report.sections[0];
    expect(fiche.blocks.some((b) => b.type === "table" && b.tableId === "lfi_vote")).toBe(true);
    expect(fiche.blocks.some((b) => b.type === "table" && b.tableId === "lfi_politique")).toBe(false);
  });

  it("présidentielle 2022 (Mélenchon) à côté des européennes dans la fiche", () => {
    const fiche = report.sections[0];
    const glance = fiche.blocks.find((b) => b.type === "glance") as Extract<(typeof fiche.blocks)[number], { type: "glance" }>;
    expect(glance.items.map((i) => i.label)).toEqual(expect.arrayContaining(["Vote LFI aux européennes 2024", "Vote Mélenchon à la présidentielle 2022"]));
    const bv = report.tables.find((t) => t.id === "lfi_bureaux")!;
    expect(bv.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["lfi2", "lfi2exp"]));
    expect(report.maps.some((m) => m.id === "lfi_map_bv_p22")).toBe(true);
    // Une seule carte par scrutin (vote) ; la participation est l'autre carte du même groupe (bouton sur le site).
    expect(fiche.blocks.some((b) => b.type === "map" && b.mapId === "lfi_map_bv")).toBe(true);
    expect(fiche.blocks.filter((b) => b.type === "mapPair")).toHaveLength(0);
    expect(report.maps.find((m) => m.id === "lfi_map_bv_participation")?.group).toBe("lfi_bv");
    expect(report.sections.find((x) => x.id === "LFI_DETAIL")!.blocks.some((b) => b.type === "map" && b.mapId === "lfi_map_bv_p22")).toBe(true);
    // Échelle fixe : mêmes bornes dans toutes les communes.
    expect(report.maps.find((m) => m.id === "lfi_map_bv")!.legend!.classes!.map((c) => c.label)).toEqual(["moins de 10 %", "10 à 15 %", "15 à 20 %", "20 à 30 %", "30 % et plus"]);
    expect(report.charts.find((c) => c.id === "lfi_chart_bureaux")!.series.map((x) => x.key)).toContain("mel");
    const actions = report.sections.find((x) => x.id === "LFI_DETAIL")!.blocks.find((b) => b.type === "actions") as Extract<(typeof fiche.blocks)[number], { type: "actions" }>;
    expect(actions.groups[0].items[0]).toMatch(/Mélenchon/);
  });

  it("retours du terrain : enregistrés, conservés à la régénération, repris dans les exports", async () => {
    const { saveReport, saveFieldNotes, getReport } = await import("@/lib/report/store");
    const { renderReportHtml } = await import("@/lib/render/html");
    await saveReport(structuredClone(report));
    await saveFieldNotes(report.id, "Marché du samedi très fréquenté.");
    const again = await build({ codeInsee: "60159", scope: "commune" });
    await saveReport(again);
    const stored = (await getReport(report.id))!;
    expect(stored.fieldNotes?.text).toBe("Marché du samedi très fréquenté.");
    expect(renderReportHtml(stored, { sectionIds: ["LFI"] })).toContain("Retours du terrain");
  }, 60000);

  it("exports HTML, DOCX et CSV", async () => {
    const { renderReportHtml } = await import("@/lib/render/html");
    const { reportToDocx } = await import("@/lib/export/docx");
    const { indicatorsCsv } = await import("@/lib/export/csv");
    const html = renderReportHtml(report);
    expect(html).toContain("Bibliographie des sources citées");
    expect(html).toContain("<svg");
    const docx = await reportToDocx(report);
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    const csv = indicatorsCsv(report);
    expect(csv.split("\r\n").length).toBe(report.indicators.length + 1);
    await fs.writeFile(path.join(os.tmpdir(), "fiche-test-mock.docx"), docx);
    await fs.writeFile(path.join(os.tmpdir(), "fiche-test-mock.json"), JSON.stringify(report));
  }, 60000);

  it("feuilles de porte-à-porte et évolution du vote par bureau", async () => {
    const porte = report.sections.find((s) => s.id === "PORTE");
    expect(porte).toBeTruthy();
    const rues = report.tables.filter((t) => t.id.startsWith("porte_rues_"));
    expect(rues.length).toBeGreaterThan(0);
    expect(rues[0].rows.length).toBeGreaterThan(0);
    expect(String(rues[0].rows[0].numeros)).toMatch(/impairs|pairs/);
    // Aucune adresse d'une autre commune.
    expect(rues.flatMap((t) => t.rows.map((r) => String(r.voie)))).not.toContain("Rue Ailleurs");
    const evo = report.tables.find((t) => t.id === "lfi_evolution");
    expect(evo?.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["lfi19", "evoE", "mel17", "evoP", "nfp"]));
    expect(report.findings.some((f) => /voix aux européennes 2024, contre \d+ en 2019/.test(f.text))).toBe(true);
    const { renderReportHtml } = await import("@/lib/render/html");
    expect(renderReportHtml(report, { sectionIds: ["PORTE"] })).toContain("Porte-à-porte : Bureau");
  });

  it("fiche au format du document de référence (HTML et Word)", async () => {
    const { renderReportHtml } = await import("@/lib/render/html");
    const { reportToDocx } = await import("@/lib/export/docx");
    const { unzipSync, strFromU8 } = await import("fflate");
    const html = renderReportHtml(report, { sectionIds: ["LFI"], style: "yonne" });
    expect(html).toContain("Pôle d'études électorales");
    expect(html).toContain('class="fiche yonne"');
    expect(html).not.toContain('class="glance"');
    const docx = await reportToDocx(report, { sectionIds: ["LFI"], style: "yonne" });
    const xml = strFromU8(unzipSync(new Uint8Array(docx))["word/document.xml"]);
    expect(xml).toContain("Arial");
    expect(xml).toContain("Proposition de ciblage");
    expect(xml).not.toContain("Journal de collecte");
    // Le thème « yonne » ne doit pas fuir sur l'export complet suivant.
    const full = strFromU8(unzipSync(new Uint8Array(await reportToDocx(report)))["word/document.xml"]);
    expect(full).not.toContain('w:ascii="Arial"');
  }, 60000);

  it("export PDF (si Chromium est disponible)", async () => {
    const { findChromium, reportToPdf } = await import("@/lib/export/pdf");
    if (!findChromium()) return;
    const pdf = await reportToPdf(report);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    await fs.writeFile(path.join(os.tmpdir(), "fiche-test-mock.pdf"), pdf);
    const court = await reportToPdf(report, { sectionIds: ["LFI"] });
    expect(court.length).toBeLessThan(pdf.length);
    await fs.writeFile(path.join(os.tmpdir(), "fiche-test-mock-court.pdf"), court);
  }, 60000);

  it("une seconde génération est servie par le cache", async () => {
    const second = await build({ codeInsee: "60159", scope: "commune" });
    const net = second.runs.filter((r) => r.requests > 0);
    expect(net.length).toBeGreaterThan(0);
    for (const r of net) expect(r.fromCache).toBe(r.requests);
  }, 60000);

  it("bilan : groupe d'action absent de la commune mais présent dans l'intercommunalité", async () => {
    const d = path.join(dir, "interne");
    await fs.rm(path.join(d, "groupes.csv"), { force: true });
    await fs.rm(path.join(d, "action-populaire.csv"), { force: true });
    await fs.writeFile(path.join(d, "bilan.csv"), "code_insee;nb_actions;nb_ga_actifs;nb_parrains;inscrits;estime\n60159;60;0;300;25000;0\n60325;0.4;1;5.7;1581;1\n01001;9000;1000;80000;9074100;0\n");
    const r = await build({ codeInsee: "60159", scope: "commune" });
    const txt = JSON.stringify(r.sections.find((x) => x.id === "LFI")!.blocks);
    expect(txt).not.toMatch(/ni dans son intercommunalité|ni aux alentours/);
    expect(txt).toMatch(/Aucun groupe d'action actif dans la commune\.\*\* Dans l'intercommunalité : Jaux/);
  }, 120000);

  it("mode comparaison : l'essentiel d'une fiche, prêt à aligner", async () => {
    const { compareCol } = await import("@/lib/report/compare");
    const col = compareCol(report);
    expect(col.nom).toBe("Compiègne");
    expect(Object.keys(col.glance)).toEqual(expect.arrayContaining(["Vote LFI aux européennes 2024"]));
    expect(col.profil["Sous le seuil de pauvreté"]?.value).toMatch(/%/);
    expect(col.chart?.id).toBe("lfi_chart_eu24");
    expect(col.bureaux.length).toBeGreaterThan(0);
    expect(col.synth.length).toBeGreaterThan(0);
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const Compare = (await import("@/components/Compare")).default;
    const html = renderToString(createElement(Compare, { cols: [col, { ...col, id: "b", nom: "Autre" }] }));
    expect(html).toContain("Chiffres clés");
    expect(html).toContain("Autre");
  });
});
