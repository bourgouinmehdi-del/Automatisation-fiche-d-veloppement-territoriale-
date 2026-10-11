# Sources de données et dépendances

## Sources de données

| Source | Producteur | Accès | Licence | Indicateurs produits | Limites |
|---|---|---|---|---|---|
| Découpage administratif (COG 2026) — `@etalab/decoupage-administratif` 6.0.0 | INSEE / DGCL | référentiel embarqué | LO 2.0 | communes, codes postaux, EPCI, départements, régions, population légale (millésime 2023, en vigueur au 01/01/2026) | pas de géométries |
| geo.api.gouv.fr | DINUM, à partir de l'INSEE et de l'IGN (ADMIN EXPRESS) | REST sans clé | LO 2.0 | surface, densité, contours, communes limitrophes, pôles urbains proches | contours généralisés |
| INSEE — API Melodi | INSEE | REST sans clé, ~30 req/min | LO 2.0 | populations de référence (historique), âges, ménages, familles, Filosofi (revenu médian, pauvreté, D9/D1), logement (catégorie, type, statut d'occupation), emploi (taux d'emploi, chômage RP, emplois au lieu de travail), diplômes, CSP, navettes | recensement = moyenne de 5 ans ; secret statistique Filosofi ; correspondances de modalités à valider avec `check:sources` |
| DVF géolocalisé | DGFiP / Etalab | CSV par commune et par an | LO 2.0 | prix médian au m² (maisons, appartements), quartiles, nombre de ventes | hors Alsace-Moselle et Mayotte ; année en cours partielle |
| OpenStreetMap — Overpass | contributeurs OSM | API Overpass | ODbL 1.0 | 22 catégories d'équipements, aménagements cyclables, équipements structurants proches | couverture contributive (absence ≠ inexistence) |
| Géorisques (GASPAR, ICPE, sismicité, radon) | MTE / BRGM | REST sans clé | LO 2.0 | risques recensés, arrêtés CatNat, installations classées | inventaire réglementaire |
| Annuaire de l'éducation | Ministère de l'Éducation nationale | Opendatasoft v2.1 | LO 2.0 | établissements, statut, éducation prioritaire, effectifs | effectifs partiels |
| SNCF Open Data | SNCF Gares & Connexions | Opendatasoft v2.1 | ODbL 1.0 | gares, segment, fréquentation annuelle | estimations annuelles |
| API Recherche d'entreprises (SIRENE) | DINUM / INSEE | REST sans clé | LO 2.0 | unités légales actives par section NAF, établissements ≥ 100 salariés | tranches d'effectifs déclaratives |
| Résultats électoraux | Ministère de l'Intérieur (data.gouv.fr) | API data.gouv + API tabulaire | LO 2.0 | participation, abstention, blancs et nuls, résultats agrégés par liste/nuance, commune et département | descriptif uniquement ; slugs des jeux à confirmer (`check:sources`) |
| Quartiers prioritaires 2024 (liste, contours) | ANCT (data.gouv.fr) | API tabulaire + archive GeoJSON | LO 2.0 | QPV de la commune, contours superposés aux bureaux | géographie 2024 |
| Statistiques QPV (Filosofi 2021, estimations 2022) | INSEE | archives CSV lues en flux | LO 2.0 | revenu médian, pauvreté, âges, chômage, locataires par QPV | colonnes des estimations repérées par libellé (métadonnées de l'archive) ; secret statistique |
| IRIS : contours (IRIS… GE) et bases infracommunales 2021 | IGN (WFS Géoplateforme) ; INSEE | WFS + archives CSV nationales lues en flux | LO 2.0 | revenu médian, pauvreté, âges, chômage, locataires et HLM par IRIS | communes ≥ 5 000 hab. environ |
| Municipales 2026, Répertoire national des élus | Ministère de l'Intérieur (data.gouv.fr) | API tabulaire | LO 2.0 | listes, nuances, voix, sièges, maire ; nuance de la majorité de chaque commune (mode département) | communes < 1 000 hab. sans listes |
| Base permanente des équipements 2025 | INSEE | archive CSV nationale (≈ 136 Mo) lue en flux | LO 2.0 | médecins généralistes pour 10 000 hab., urgences, France Services, France Travail, poste, supermarchés | ne mesure pas les délais d'accès |
| Horaires SNCF (GTFS) | SNCF (data.gouv.fr, « horaires-sncf ») | archive GTFS nationale lue en flux | LO 2.0 / ODbL | départs un mardi type, heures de pointe, temps de trajet direct vers Paris | horaires théoriques |
| OSRM | projet OSRM, données OSM | API d'itinéraire | ODbL | temps de trajet routiers (pôle urbain, Paris) | sans trafic |
| Carte SVG des départements (`@svg-maps/france.departments`) | svg-maps | embarqué | CC BY 4.0 | carte de localisation nationale | contours simplifiés |
| Tuiles OpenStreetMap | contributeurs OSM | tuiles raster (navigateur) | ODbL | fond des cartes interactives | usage raisonnable |

Chaque indicateur conserve : source, URL de la requête, jeu de données, date de récupération, millésime, échelle géographique, unité, méthode, limites, statut et (pour les ratios) numérateur/dénominateur.

### Sources examinées mais non intégrées (voir STATUS.md)

- **APL (DREES)** — pas d'adresse de téléchargement stable : l'offre de soins est mesurée par la BPE (médecins pour 10 000 habitants).
- **FINESS** — redondant avec la BPE pour les besoins de la fiche (urgences, maternités, centres de santé).
- **RPLS**, **LOVAC**, **DPE (ADEME)**, **portail de l'artificialisation** — logement et environnement.

## Dépendances logicielles

| Paquet | Rôle | Licence |
|---|---|---|
| next 15, react 19 | application web | MIT |
| tailwindcss 4 | styles | MIT |
| leaflet, react-leaflet | cartes interactives | BSD-2 / Hippocratic |
| recharts | graphiques interactifs | MIT |
| d3-geo | projection des cartes statiques | ISC |
| @turf/turf | géotraitements (contiguïté, longueurs, simplification) | MIT |
| papaparse | lecture CSV (DVF) | MIT |
| fflate | lecture en flux des archives ZIP (INSEE, ANCT, GTFS) | MIT |
| proj4 | reprojection Lambert-93 → WGS84 (contours QPV) | MIT |
| docx | export Word | MIT |
| playwright-core | export PDF (Chromium headless) | Apache-2.0 |
| @resvg/resvg-js | rasterisation SVG → PNG (DOCX, export de cartes) | MPL-2.0 |
| @etalab/decoupage-administratif | référentiel administratif | MIT / LO 2.0 |
| @svg-maps/france.departments | carte nationale | CC BY 4.0 |
| vitest, tsx, typescript | tests et outillage | MIT / Apache-2.0 |
