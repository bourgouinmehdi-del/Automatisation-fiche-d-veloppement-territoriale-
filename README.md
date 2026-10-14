# Fiches territoriales — générateur automatisé de diagnostics territoriaux

Application web (Next.js / TypeScript) qui produit, à partir d'un **code postal** ou d'un **nom de commune**, une fiche de diagnostic territorial **sourcée, reproductible et exportable** (PDF, DOCX, CSV, JSON, GeoJSON), en s'appuyant exclusivement sur des données publiques françaises.

Le rapport s'ouvre sur une **fiche d'action (approche LFI)** puis suit le plan du cahier des charges : présentation générale, profil sociodémographique, économie et emploi, services et équipements, mobilité, logement et cadre de vie, contexte électoral (strictement descriptif), analyse transversale, synthèse opérationnelle — complété d'une annexe méthodologique, d'un journal de collecte et d'une bibliographie numérotée.

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
| `www.insee.fr` | fichiers nationaux : BPE, bases IRIS, statistiques QPV |
| `data.geopf.fr` | contours IRIS (WFS de la Géoplateforme IGN) |
| `eu.ftp.opendatasoft.com` | horaires SNCF (GTFS) |
| `router.project-osrm.org` (configurable) | temps de trajet routiers |
| `overpass-api.de` (configurable) | équipements OpenStreetMap |
| `georisques.gouv.fr` | risques, CatNat, ICPE |
| `data.education.gouv.fr` | annuaire de l'éducation |
| `ressources.data.sncf.com` | gares et fréquentation |
| `recherche-entreprises.api.gouv.fr` | base SIRENE |
| `www.data.gouv.fr`, `tabular-api.data.gouv.fr`, `static.data.gouv.fr` | résultats électoraux (commune, bureau de vote), Répertoire électoral unique |
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
| `GENERATION_CONCURRENCY` | 1 | générations simultanées (les suivantes attendent leur tour) |
| `HEAVY_CONCURRENCY` | 2 | fichiers nationaux traités en même temps ; attente automatique au-delà de 60 % de la mémoire |
| `DOWNLOAD_STALL_MS` | 120000 | abandon puis nouvel essai d'un téléchargement bloqué |
| `MEMORY_LIMIT_MB` | auto | limite mémoire, si elle n'est pas lue dans le conteneur |
| `LLM_PROVIDER` | `none` | `anthropic` pour la reformulation assistée (facultatif) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | — | clé et modèle si `LLM_PROVIDER=anthropic` |

---

## 2 bis. Fiche d'action — approche LFI

Chaque rapport commence par une **fiche d'action** rédigée sur le modèle des fiches « PEE · Développement territorial » (une « proposition de ciblage » par territoire) :

0. **Avertissement et « en bref »** : encadré rappelant que le ciblage doit être confronté au terrain ; chiffres clés comparés au département (habitants, pauvreté, vote LFI, abstention, parrains pour 100 voix LFI, bureaux prioritaires) ; atout principal, difficulté principale, bureaux où agir en priorité, lieux de passage.
1. **Profil sociodémographique du territoire** : puces rédigées, chiffres clés en gras, qui ne développent que les **écarts significatifs** au département (pauvreté, HLM, âge, CSP, chômage, diplôme, pôle d'emploi, ménages sans voiture, services) ; les indicateurs proches de la moyenne sont regroupés en une seule puce. Tableau comparatif commune / EPCI / département / région / France et répartition par âge comparée à la France.
2. **Profil politique du territoire** : encadré « implantation militante » (groupes d'action), surperformance par rapport aux communes comparables, ratio parrains / voix, tableau *Inscrits (2024) · LFI (P22) · LFI (E24) · Parrains · Abstention 2022 · Abstention 2024* (voix et **% des inscrits**), abstention et scrutins intermédiaires, forces de gauche et RN comparées au département.
3. **Où agir** : cartes **vote LFI / participation par bureau côte à côte** (palette divergente bleu → rouge), part des voix LFI concentrée dans les bureaux prioritaires, classement des bureaux.
4. **Pourquoi** : hypothèses explicites, reliées aux indicateurs — toujours à confirmer sur le terrain.
5. **Actions recommandées**, regroupées comme dans les fiches de référence : porte-à-porte (bureaux prioritaires, adresse du lieu de vote), abstentionnistes et inscription, marchés (horaires OpenStreetMap), gares (fréquentation SNCF), supermarchés, sorties de collèges et lycées, implantation ; encadré d'accessibilité et tableau des lieux d'action avec le bureau le plus proche.

Les textes acceptent une mise en évidence minimale (`**gras**`), rendue dans l'interface, le PDF et le DOCX, et retirée des exports CSV.

**Accès réservé** : dès que la variable `AUTH_USERS` est renseignée, toutes les pages et API exigent une connexion (identifiant et mot de passe ; session de 30 jours ; 10 tentatives par quart d'heure). Pour ajouter une personne : `npm run mot-de-passe -- prenom.nom` (le mot de passe est saisi puis chiffré), copier la ligne affichée dans `AUTH_USERS` sur Railway (comptes séparés par `;`), et définir une fois `AUTH_SECRET` (longue chaîne aléatoire). Retirer une ligne de `AUTH_USERS` coupe l'accès de la personne immédiatement. Bouton « Déconnexion » dans l'en-tête.

**Retours du terrain** : sous l'en-tête de la fiche et sous chaque partie (population, situation politique, actions), un encadré permet d'ajouter un retour qualitatif ; il est conservé à la régénération et repris dans le PDF et le Word. Les lieux d'action (marchés, associations…) se saisissent dans l'encadré dédié.

**Fiche synthétique** : le profil sociodémographique s'ouvre sur une phrase en langage courant, suivie d'un tableau limité aux indicateurs qui distinguent vraiment la commune du département (7 au plus) et de 2 ou 3 phrases qualitatives ; le profil politique s'ouvre sur un « En bref ». Le détail reste dans le diagnostic complet.

**Feuilles de porte-à-porte** : pour chaque bureau prioritaire, une page imprimable avec les rues et numéros à couvrir (Base adresse nationale, adresses rattachées au bureau par leur position dans les contours), une carte, le lieu de vote et une case « Fait » par voie. Bouton « PDF porte-à-porte » (ou `…/export/pdf?porte=1`). Désactivable avec `DISABLE_SOURCES=ban`.

**Évolution du vote par bureau** : européennes 2019 → 2024, présidentielle 2017 → 2022 (bureaux appariés par numéro, inscrits à ±25 %) et score de la gauche unie aux législatives 2024. Désactivable avec `DISABLE_SOURCES=elections_historiques`.

**Lieux d'action signalés par les militants** : marchés, associations, lieux de passage saisis dans la fiche (jours, horaires, adresse) ; chaque adresse est géolocalisée et rattachée à son bureau de vote ; conservés d'une régénération à l'autre et repris dans le PDF et le Word.

**Vitesse et mémoire** : les sources indépendantes sont interrogées en parallèle ; l'INSEE reste séquentiel (limite de débit). Les fichiers nationaux (contours des bureaux de vote, BPE, GTFS, IRIS, résultats électoraux) sont lus en flux et leurs extraits départementaux ou communaux sont gardés sur disque (`data/cache/extracts/`, 1 à 30 jours selon la source) : la fiche suivante dans le même département les réutilise sans relire le fichier national. Un extrait incomplet (sous-source en panne) n'est pas mis en cache. Sur Railway, monter un **volume persistant** sur `/data` pour que ce cache survive aux redéploiements. La page de progression et les journaux du serveur indiquent la mémoire utilisée à chaque étape.

**Export court** : bouton « PDF fiche d'action » (ou `…/export/pdf?fiche=1`, et `<id>-fiche-action.pdf` en ligne de commande) — la fiche d'action seule, quelques pages, comme le document de référence.

**Fiche au format du document de référence** (menu « Autres formats ») : la même fiche mise en page comme le document Word « Développement territorial » (Arial, titres soulignés, une couleur par proposition de ciblage, tableaux quadrillés, « en bref » en liste à puces). Disponible en PDF (`…/export/pdf?fiche=1&style=yonne`), en Word modifiable (`…/export/docx?fiche=1`) et en aperçu HTML (`…/export/html?fiche=1&style=yonne`).

**Méthode de priorisation des bureaux** : potentiel = moyenne de deux scores z calculés entre les bureaux de la commune — réservoir (part LFI des exprimés aux européennes 2024, moyennée avec la part de J.-L. Mélenchon au 1er tour de la présidentielle 2022 pour les bureaux appariés) et marge de mobilisation (taux d'abstention aux européennes) ; priorité 1 = un quart des bureaux, 4 au maximum ; priorité 2 = jusqu'à la moitié. La fiche présente les deux scrutins côte à côte : chiffres clés, cartes par bureau (vote LFI / participation 2024, vote Mélenchon / participation 2022), classement, graphique, quartiers et porte-à-porte.

**Géographie des bureaux de vote** (dans l'ordre) : fichier fourni `data/interne/bv-<code INSEE>.geojson` (contours officiels de la mairie, propriété `bv` ou `numero`), contours publiés sur data.gouv.fr, ou enveloppes approximatives calculées à partir des adresses du Répertoire électoral unique (INSEE).

**Données internes (facultatives)** — à déposer dans `data/interne/` (jamais versionné) :

| Fichier | Colonnes | Usage |
|---|---|---|
| `parrains.csv` | `code_commune;parrains` | colonne « Parrains » et ratio parrains / voix LFI vs département |
| `groupes.csv` | `code_commune;nom;membres;statut;description` | encadré « Implantation militante » |
| `bv-<code>.geojson` | polygones avec propriété `bv` | carte exacte des bureaux |

Exemples dans `docs/exemples-interne/`. Uniquement des agrégats par commune : aucun nom de personne.

**Garde-fous** : uniquement des agrégats publics (commune, bureau de vote) ; aucune donnée individuelle ; aucune variable d'origine ou de nationalité ; explications présentées comme hypothèses.

### Quartiers, contexte municipal, services et accès (fiche d'action)

- **Quartiers** : quartiers prioritaires 2024 (ANCT : liste et contours ; INSEE : Filosofi 2021 et estimations démographiques 2022) et IRIS (IGN : contours ; INSEE : recensement et Filosofi 2021 à l'IRIS), dans un tableau « Profil des quartiers » (revenu médian, pauvreté, moins de 25 ans, 60 ans et plus, chômage, locataires dont HLM). Les bureaux de vote sont rattachés aux quartiers (au moins 30 % de leur surface) : lignes « BV 3 et 7 (QPV la Madeleine) » dans le tableau politique, vote LFI par quartier, contours des QPV sur les cartes des bureaux, hypothèse « ce quartier devrait nous être favorable » quand la pauvreté est forte mais le vote LFI moyen.
- **Contexte municipal** : municipales 2026 (listes, nuances, 1er et 2nd tours, sièges) et maire en fonction (Répertoire national des élus) ; listes de gauche battues, liste unique.
- **Services** (BPE 2025) : médecins généralistes pour 10 000 habitants comparés au département (« désert médical »), urgences, France Services, France Travail, poste ; supermarchés et services publics comme lieux d'action.
- **Gares** (GTFS SNCF) : départs un mardi type, heures de pointe réelles, temps de trajet direct vers Paris.
- **Accès** (OSRM) : temps de trajet en voiture vers le pôle urbain le plus proche et vers Paris.
- **Retours du terrain** : texte libre saisi dans la fiche (bouton « Ajouter des retours du terrain »), conservé lors des régénérations et repris dans le PDF et le Word.

### Ciblage départemental

Choisir « Ciblage d'un département » sur la page d'accueil (ou `npm run generate -- <commune> --scope departement`). L'application compare toutes les communes du département, sur le modèle de la fiche Yonne :

- unités : villes de 2 500 habitants et plus, et groupements de bourgs (1 000 à 2 500 habitants) d'une même intercommunalité avec leurs « focus possibles » ;
- score : surperformance LFI (européennes 2024, % des inscrits) par rapport aux communes de taille comparable du département (35 %), écart d'abstention au département (25 %), ratio parrains / voix (20 %, si fourni), volume de voix LFI (20 %) ; pénalité pour les territoires déjà couverts par un groupe de 20 membres ou plus ; les deux plus grandes villes restent hors ciblage ;
- sorties : liste des territoires proposés, carte du département, une page par proposition (raisons, tableau Inscrits / LFI P22 / LFI E24 / Parrains / Abstention), classement complet avec la nuance de la majorité municipale ; bouton « Générer la fiche » pour chaque proposition (fiche communale, ou territoire personnalisé pour un groupement) ; export « PDF ciblage ».

### Données internes depuis l'interface

Page **Données internes** : dépôt des parrainages, des groupes (format simple) ou de l'**export brut d'Action Populaire** (colonnes reconnues par leur intitulé ; commune retrouvée par code postal et ville ; colonnes nominatives ignorées). Les fichiers restent dans `data/interne/`. **En ligne, protéger l'application par une authentification** : cette page permet de déposer et supprimer ces fichiers.

### Sources volumineuses

La BPE (≈ 136 Mo), les bases IRIS (≈ 70 Mo) et le GTFS SNCF sont téléchargés une fois puis mis en cache (`CACHE_TTL_HOURS`) ; leur lecture en flux limite la mémoire. Pour s'en passer : `DISABLE_SOURCES=bpe,gtfs,iris`. Les adresses des fichiers INSEE (qui changent à chaque millésime) sont surchargeables : `INSEE_BPE_URL`, `INSEE_IRIS_POP_URL`, `INSEE_IRIS_LOGEMENT_URL`, `INSEE_IRIS_ACTIVITE_URL`, `INSEE_IRIS_FILOSOFI_URL`, `INSEE_QPV_FILOSOFI_URL`, `INSEE_QPV_RP_URL`, `SNCF_GTFS_URL`, `OSRM_URL`.

## 2 ter. Déploiement en ligne

**Vercel n'est pas adapté à la génération des fiches** : une génération dure plusieurs minutes, télécharge des fichiers nationaux de plusieurs centaines de Mo (résultats par bureau de vote, contours), a besoin d'environ 2 Go de mémoire, d'un cache persistant et de Chromium pour le PDF. Les fonctions serverless de Vercel sont limitées en durée, n'ont pas de disque persistant et arrêtent les traitements lancés en arrière-plan. Sur Vercel, l'application démarre (recherche de communes, consultation) mais refuse la génération avec un message explicite (`ALLOW_SERVERLESS_GENERATION=1` pour forcer, à vos risques).

**Hébergement recommandé : un serveur ou un conteneur** (Railway, Render, Fly.io, ou un petit VPS), à partir du `Dockerfile` fourni :

- au moins **2 Go de RAM** ;
- un **volume persistant** monté sur `/data` (cache et fiches générées) ;
- port exposé : `3000` (ou variable `PORT`).

Exemple sur Railway : *New Project → Deploy from GitHub repo* → le Dockerfile est détecté → *Settings → Volumes* : ajouter un volume monté sur `/data` → *Networking* : générer un domaine.

Si la page de génération indique « génération interrompue » : le serveur a redémarré en cours de route, le plus souvent faute de mémoire. Vérifier dans Railway l'onglet *Metrics* (pic de mémoire) et *Deployments → Logs* (`Killed`, `out of memory`), passer à une offre avec plus de mémoire (formule d'essai insuffisante) et relancer : grâce au volume `/data`, les fichiers déjà téléchargés ne le sont pas une seconde fois. Les gros fichiers nationaux sont téléchargés sur disque et lus en flux pour limiter la mémoire nécessaire.

Exemple sur un VPS (Debian/Ubuntu avec Docker) :

```bash
git clone <dépôt> fiches && cd fiches
docker build -t fiches .
docker run -d --restart unless-stopped -p 80:3000 -v fiches-data:/data --name fiches fiches
```

Pour protéger l'accès (fiches contenant des données internes), placer le service derrière une authentification (ex. accès restreint de la plateforme, ou proxy avec mot de passe).

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
