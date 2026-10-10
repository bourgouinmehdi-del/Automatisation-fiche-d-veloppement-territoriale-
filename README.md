# Fiches territoriales — générateur automatisé de diagnostics territoriaux

Application web (Next.js / TypeScript) qui produit, à partir d'un **code postal** ou d'un **nom de commune**, une fiche de diagnostic territorial **sourcée, reproductible et exportable** (PDF, DOCX, CSV, JSON, GeoJSON), en s'appuyant exclusivement sur des données publiques françaises.

Le plan de la fiche (parties A à I) suit le cahier des charges : présentation générale, profil sociodémographique, économie et emploi, services et équipements, mobilité, logement et cadre de vie, contexte électoral (strictement descriptif), analyse transversale, synthèse opérationnelle — complété d'une annexe méthodologique, d'un journal de collecte et d'une bibliographie numérotée.

> **Principe directeur** : aucune valeur n'est estimée ni inventée. Une donnée indisponible est affichée « n.d. », listée parmi les données manquantes, et l'étape de collecte correspondante figure en échec dans le journal.

---

## 1. Installation

Prérequis : **Node.js ≥ 20** et, pour l'export PDF, un **Chromium/Chrome** installé (détecté automatiquement, sinon renseigner `CHROMIUM_PATH`).

```bash
npm install
cp .env.example .env.local      # facultatif : tous les réglages ont une valeur par défaut
npm run dev                     # http://localhost:3000
```

Production :

```bash
npm run build && npm start
```

### Réseau

L'application interroge les hôtes suivants (HTTPS) ; ils doivent être joignables depuis le serveur :

| Hôte | Usage |
|---|---|
| `geo.api.gouv.fr` | contours, surfaces, centres, communes du département |
| `api.insee.fr` | API Melodi (recensement, Filosofi, populations de référence) |
| `files.data.gouv.fr` | DVF géolocalisé |
| `overpass-api.de` (configurable) | équipements OpenStreetMap |
| `georisques.gouv.fr` | risques, CatNat, ICPE |
| `data.education.gouv.fr` | annuaire de l'éducation |
| `ressources.data.sncf.com` | gares et fréquentation |
| `recherche-entreprises.api.gouv.fr` | base SIRENE |
| `www.data.gouv.fr`, `tabular-api.data.gouv.fr` | résultats électoraux |
| `tile.openstreetmap.org` (navigateur) | fond des cartes interactives |

Le référentiel administratif (codes postaux, communes, EPCI, populations légales) est **embarqué** : la recherche fonctionne sans réseau.

Pour vérifier les sources : `npm run check:sources` (et `npm run check:sources -- --insee 60159` pour lister les dimensions et modalités INSEE réellement servies).

---

## 2. Utilisation

### Interface web

1. Saisir un code postal (ex. `60200`) ou un nom (`Compiègne`). Si plusieurs communes partagent le code postal (ex. `60350`), choisir la bonne dans la liste.
2. (Facultatif) Réglages avancés : périmètre d'analyse — commune, intercommunalité, département ou territoire personnalisé (liste de codes INSEE).
3. « Générer la fiche territoriale » : une page de progression suit les étapes de collecte.
4. Le rapport s'affiche avec navigation par chapitres, tableaux, graphiques interactifs, cartes (couches activables, infobulles, sélecteur de période pour les scrutins), panneau « Sources et méthodologie », exports PDF / DOCX / CSV / JSON, export PNG / SVG / GeoJSON de chaque carte et CSV de chaque tableau.
5. « Régénérer » relance la collecte : les réponses encore valides en cache ne sont pas retéléchargées ; la version du rapport est incrémentée.

### Ligne de commande

```bash
npm run generate -- 60200                          # commune unique
npm run generate -- 60350 --commune 60491          # code postal ambigu
npm run generate -- 60159 --scope epci --out demo  # périmètre intercommunal
```

Produit `<id>.pdf`, `.docx`, `.html`, `.json`, `-indicateurs.csv`, `-series.csv`.

### Réglages (`.env.local`)

| Variable | Défaut | Rôle |
|---|---|---|
| `DATA_DIR` | `./data` | cache HTTP et rapports |
| `CACHE_TTL_HOURS` | `720` | durée de validité du cache |
| `OFFLINE` | `0` | `1` : aucune requête, cache et référentiel uniquement |
| `HTTP_TIMEOUT_MS` | `20000` | délai maximal par requête |
| `INSEE_MIN_INTERVAL_MS` | `2100` | espacement des requêtes INSEE (limite 30/min) |
| `OVERPASS_URL` | overpass-api.de | instance Overpass |
| `CHROMIUM_PATH` | auto | exécutable pour l'export PDF |
| `LLM_PROVIDER` | `none` | `anthropic` pour la reformulation assistée (facultatif) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | — | clé et modèle si `LLM_PROVIDER=anthropic` |

---

## 3. Architecture

```
src/
  lib/
    config.ts, cache.ts, http.ts      Configuration ; cache disque ; client HTTP (délais, nouvelles
                                      tentatives, coupe-circuit, repli sur cache périmé, hors ligne)
    collectors/                       COLLECTE — un connecteur par source
      catalog.ts                      catalogue des sources (licences, accès, limites)
      context.ts                      journal de collecte, données manquantes
      admin.ts                        référentiel embarqué + geo.api.gouv.fr
      insee.ts, insee-indicators.ts   API Melodi : lecture générique des cubes + déclaration des indicateurs
      dvf.ts, osm.ts, public-apis.ts, elections.ts
    report/
      collect.ts                      orchestration de la collecte (étapes isolées, progression)
      assemble.ts                     NORMALISATION : indicateurs, séries, tableaux, graphiques, cartes
      sections.ts                     plan A→I et rédaction par gabarits
      build.ts, store.ts              chaîne complète ; stockage JSON et tâches de fond
    analysis/
      stats.ts                        CALCULS déterministes (médiane, MAD, z robuste, TCAM, écarts…)
      findings.ts                     moteur de constats (constat / atout / vigilance / hypothèse / piste / à vérifier)
    llm/provider.ts                   abstraction LLM + garde-fou numérique (facultatif)
    render/                           RENDU : SVG (graphiques, cartes, carte nationale), HTML imprimable
    export/                           EXPORT : PDF (Chromium), DOCX (docx), CSV
  app/                                pages (accueil, progression, rapport, méthodologie) et routes API
  components/                         visionneuse, graphiques Recharts, cartes Leaflet
scripts/                              generate.ts (CLI), check-sources.ts (diagnostic)
tests/                                tests unitaires, d'intégration (API simulées) et e2e
```

**Arbitrages**

- *Une seule pile TypeScript* (pas de service Python) : les traitements géospatiaux nécessaires (contiguïté, longueurs, simplification, projections) sont couverts par Turf et d3-geo ; un seul langage simplifie l'installation et la maintenance.
- *Stockage fichier* (cache + rapports JSON) pour le prototype ; `store.ts` et `cache.ts` isolent l'interface pour une migration PostgreSQL/PostGIS.
- *Cartes statiques en SVG* pour le PDF et le DOCX (reproductibles, sans dépendance aux tuiles), *cartes Leaflet* pour la consultation interactive.
- *Rédaction par gabarits* : chaque phrase est construite à partir de valeurs d'indicateurs présentes. Le LLM, optionnel, ne fait que reformuler et toute sortie contenant un nombre absent du texte source est rejetée.
- *Collecte tolérante* : chaque étape est isolée ; une source en panne n'interrompt pas la génération. Un coupe-circuit évite d'attendre un hôte injoignable.

---

## 4. Méthodes de calcul

- **Écart significatif** à une référence : ≥ 2 points **et** ≥ 10 % en relatif pour un taux ; ≥ 10 % en relatif sinon.
- **Valeur atypique** : score z robuste `(x − médiane) / (1,4826 × MAD)` ≥ 2 en valeur absolue parmi au moins 5 communes comparables.
- **Communes comparables** : même région, population à ±30 %, densité entre la moitié et le double (élargissement national si moins de 5).
- **Évolution démographique** : taux de croissance annuel moyen sur ~10 ans à partir des populations de référence.
- **Prix immobiliers (DVF)** : ventes d'un seul logement (avec ou sans dépendances), prix/m² dans [200 ; 25 000] €, médiane et quartiles par an et type ; signalement sous 30 ventes.
- **Petits effectifs** : ratio calculé sur moins de 200 unités signalé.
- **Distances** : à vol d'oiseau (aucun temps de trajet n'est simulé).

---

## 5. Tests

```bash
npm test          # vitest : unitaires + intégration (API simulées, sans réseau)
npm run lint      # vérification TypeScript
# e2e (serveur lancé) :
BASE_URL=http://localhost:3000 node tests/e2e/smoke.mjs
```

- `tests/stats.test.ts` — calculs statistiques et règle de significativité.
- `tests/connectors.test.ts` — DVF (règles d'exclusion), lecture des cubes INSEE, agrégation électorale, classification OSM, référentiel réel (codes postaux simples et ambigus, communes nouvelles), garde-fou LLM.
- `tests/integration.test.ts` — chaîne complète avec **API simulées** (`tests/fixtures/mock-apis.ts`, valeurs fictives) : valeurs calculées vérifiées, cartes, graphiques, constats reliés aux preuves, exports PDF/DOCX/CSV, seconde génération servie par le cache.
- `tests/degraded.test.ts` — sources en panne, données non diffusées, mode hors ligne.
- `tests/e2e/smoke.mjs` — parcours navigateur : code postal ambigu → choix → génération → rapport → exports.

Voir `STATUS.md` pour les résultats et l'état des lieux, `SOURCES.md` pour le détail des sources.

---

## 6. Maintenance

- **Nomenclatures INSEE** : les correspondances indicateur → modalités sont déclarées dans `src/lib/collectors/insee-indicators.ts` (codes candidats, puis expressions régulières sur codes et libellés). Utiliser `npm run check:sources -- --insee <code>` pour inspecter les modalités servies.
- **Élections** : ajouter un scrutin dans `ELECTIONS` (`src/lib/collectors/elections.ts`) avec le slug data.gouv.fr du jeu ou l'identifiant de ressource.
- **Référentiel administratif** : mettre à jour `@etalab/decoupage-administratif` à chaque nouveau millésime du COG (et `POPULATION_VINTAGE` dans `admin.ts`).
- **Vider le cache** : supprimer `data/cache/`.

## 7. Licences et données personnelles

Les données utilisées sont publiques et agrégées (Licence Ouverte 2.0, ODbL pour OpenStreetMap et SNCF, CC BY 4.0 pour le fond SVG national) ; les attributions figurent dans chaque rapport. L'application ne collecte aucune donnée personnelle. Le chapitre électoral est descriptif : aucune inférence individuelle, aucun classement de quartiers à des fins de ciblage.
