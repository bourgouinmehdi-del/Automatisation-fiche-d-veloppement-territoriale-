# État des lieux — version 0.1

## ⚠️ Point important : validation des connecteurs

L'application a été développée dans un environnement dont la politique réseau **bloquait tous les hôtes de données publiques** (geo.api.gouv.fr, api.insee.fr, data.gouv.fr, Overpass, Géorisques, SNCF, éducation, SIRENE : refus 403 du proxy). Conséquences :

- les connecteurs sont implémentés d'après la documentation publique des API, **mais n'ont pas pu être exécutés contre les vraies API** ;
- ils ont été validés contre des **réponses simulées** reproduisant la forme attendue (`tests/fixtures/mock-apis.ts`, valeurs fictives) ;
- la **démo Compiègne** (`demo/`) a été générée réellement par l'application, mais ne contient que les données du référentiel embarqué ; toutes les autres sources y apparaissent « en échec » dans le journal de collecte — ce qui illustre au passage la gestion des sources indisponibles.

**Première action recommandée** sur une machine avec accès Internet :

```bash
npm run check:sources -- --insee 60159   # vérifie chaque source et liste les modalités INSEE
npm run generate -- 60200 --out demo     # régénère la démo Compiègne avec les données réelles
```

Les points les plus susceptibles de nécessiter un ajustement sont : les codes de modalités de l'API Melodi (déclarés de façon tolérante dans `insee-indicators.ts`, avec reconnaissance par libellé), la syntaxe des codes géographiques Melodi (plusieurs variantes essayées automatiquement), et les slugs des jeux électoraux sur data.gouv.fr (`elections.ts`). Un écart se traduit par une donnée signalée manquante, jamais par une valeur erronée silencieuse — sauf erreur de correspondance de modalité, d'où l'importance de la vérification ci-dessus.

## Critères d'acceptation

| # | Critère | État |
|---|---|---|
| 1 | Saisie d'un code postal et choix de la commune | ✅ référentiel embarqué ; codes ambigus (ex. 60350 → 18 communes) ; recherche par nom ; communes nouvelles (déléguées → commune nouvelle). Testé (unitaires + e2e navigateur). |
| 2 | Génération sans saisie manuelle | ✅ une seule saisie ; périmètre facultatif. |
| 3 | Collecte réelle depuis plusieurs sources | ⚠️ 10 connecteurs implémentés ; exécutés contre API simulées uniquement (voir ci-dessus). |
| 4 | Valeurs accompagnées de leurs références | ✅ chaque indicateur porte source, URL, date, millésime, échelle, unité, méthode, limites ; notes numérotées et bibliographie. |
| 5 | Graphiques et cartes fondés sur les données récupérées | ✅ générés exclusivement depuis les indicateurs/séries collectés. |
| 6 | Calculs testés et reproductibles | ✅ fonctions pures testées ; valeurs vérifiées dans le test d'intégration. |
| 7 | Erreurs de collecte et données manquantes signalées | ✅ journal de collecte, avertissements, encadrés « données manquantes », « n.d. ». Testé (mode dégradé). |
| 8 | PDF correctement mis en page | ✅ couverture, sommaire, en-têtes, pagination, légendes, notes, bibliographie (Chromium). |
| 9 | DOCX exploitable et modifiable | ✅ styles de titres Word, sommaire automatique, tableaux natifs, images, en-tête/pied de page. Vérifié par conversion LibreOffice. |
| 10 | Export des données structurées | ✅ CSV indicateurs (format long, traçabilité complète), CSV séries, CSV par tableau, JSON, GeoJSON/PNG/SVG par carte. |
| 11 | Seconde génération sans tout retélécharger | ✅ cache disque avec durée de vie ; test : 100 % des requêtes servies par le cache. |
| 12 | Documentation d'installation et de maintenance | ✅ README, SOURCES, STATUS, `.env.example`. |

## Résultats des tests (exécution du 10 octobre 2026)

```
✓ tests/stats.test.ts        (11 tests)
✓ tests/connectors.test.ts   (15 tests)
✓ tests/integration.test.ts  (12 tests)
✓ tests/degraded.test.ts     (2 tests)
Test Files  4 passed (4) — Tests  40 passed (40)
```

Test e2e navigateur (`tests/e2e/smoke.mjs`, serveur de production) : parcours 60350 → Pierrefonds → génération → rapport → exports PDF/DOCX/CSV/JSON (HTTP 200).

Le test d'intégration a permis de corriger un défaut réel (la règle « sans diplôme » captait le « brevet professionnel », de niveau bac).

## Fonctionnalités implémentées

- **Recherche** : code postal, code INSEE, nom (insensible aux accents, « St » → « Saint »), communes déléguées.
- **Périmètres** : commune (défaut), intercommunalité, département, territoire personnalisé (≤ 40 communes).
- **Collecte** : geo.api.gouv.fr, INSEE Melodi (11 jeux, 5 échelles : commune, EPCI, département, région, France), DVF, OSM (22 catégories, cyclable, équipements structurants à 30 km), Géorisques, Annuaire de l'éducation, SNCF, SIRENE, élections (3 scrutins). Cache, nouvelles tentatives, coupe-circuit, repli sur cache périmé, mode hors ligne, limitation de débit.
- **Analyse** : écarts aux références avec règle de significativité, évolutions (TCAM), communes comparables et score z robuste, petits effectifs, constats typés reliés à leurs preuves, hypothèses formulées au conditionnel, pistes d'action sur enjeux objectifs, vérifications de terrain.
- **Cartes** (8 types) : localisation nationale (hors ligne) et départementale avec EPCI, densité, revenus du périmètre, équipements, transports, accès aux équipements structurants, participation électorale (sélecteur de scrutin), installations classées.
- **Interface** : accueil, progression, rapport avec navigation par chapitres, graphiques interactifs, cartes à couches activables et infobulles sourcées, panneau sources/méthodologie, régénération, liste des fiches générées, page méthodologie.
- **Exports** : PDF, DOCX, HTML, JSON, CSV, GeoJSON, PNG, SVG.
- **LLM facultatif** : abstraction de fournisseur, clé en variable d'environnement, garde-fou rejetant tout nombre ajouté.

## Limites connues et développements restants

1. **Validation sur API réelles** (cf. ci-dessus) — priorité n°1.
2. **Partie C** : évolution annuelle de l'emploi salarié (URSSAF), zones d'activité, offre de formation/insertion, évolution du tissu commercial — non automatisés.
3. **Partie D** : la BPE de l'INSEE devrait compléter OSM pour les décomptes d'équipements ; FINESS / APL pour la santé.
4. **Partie E** : temps de trajet (calculateur d'itinéraires) et horaires/fréquences (GTFS) non intégrés ; distances à vol d'oiseau uniquement.
5. **Partie F** : DPE, RPLS, LOVAC, artificialisation non intégrés ; pas de comparaison de prix DVF avec le département.
6. **Partie G** : résultats par bureau de vote (contours REU) non intégrés ; composition des assemblées non collectée.
7. **Infracommunal** (IRIS, QPV) : non intégré — c'est ce qui permettrait les tableaux par quartier du document de référence.
8. **Périmètres EPCI / département** : les indicateurs et constats sont calculés à l'échelle choisie, mais les paragraphes rédigés et les équipements restent centrés sur la commune saisie.
9. **Voisinage** : les communes limitrophes situées dans un autre département ne sont pas listées.
10. **Stockage** : fichiers JSON ; migration PostgreSQL/PostGIS à prévoir pour un usage multi-utilisateurs ; les tâches de génération vivent dans le processus serveur.
11. **Accessibilité** : légendes textuelles et tableaux présents ; pas de texture alternative aux couleurs sur les cartes.
