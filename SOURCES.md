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
| Carte SVG des départements (`@svg-maps/france.departments`) | svg-maps | embarqué | CC BY 4.0 | carte de localisation nationale | contours simplifiés |
| Tuiles OpenStreetMap | contributeurs OSM | tuiles raster (navigateur) | ODbL | fond des cartes interactives | usage raisonnable |

Chaque indicateur conserve : source, URL de la requête, jeu de données, date de récupération, millésime, échelle géographique, unité, méthode, limites, statut et (pour les ratios) numérateur/dénominateur.

### Sources examinées mais non intégrées (voir STATUS.md)

- **Base permanente des équipements (BPE)** — référence pour les équipements ; à brancher via Melodi (jeu BPE) pour remplacer/compléter OSM.
- **FINESS** et **APL (DREES)** — offre et accessibilité de soins.
- **transport.data.gouv.fr (GTFS)** — horaires, fréquences, lignes de bus.
- **RPLS**, **LOVAC**, **DPE (ADEME)**, **portail de l'artificialisation** — logement et environnement.
- **Contours des bureaux de vote** (REU) — résultats infracommunaux.
- **IRIS / QPV** — données infracommunales.

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
| docx | export Word | MIT |
| playwright-core | export PDF (Chromium headless) | Apache-2.0 |
| @resvg/resvg-js | rasterisation SVG → PNG (DOCX, export de cartes) | MPL-2.0 |
| @etalab/decoupage-administratif | référentiel administratif | MIT / LO 2.0 |
| @svg-maps/france.departments | carte nationale | CC BY 4.0 |
| vitest, tsx, typescript | tests et outillage | MIT / Apache-2.0 |
