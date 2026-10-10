# État des lieux — version 0.1

## Validation des connecteurs sur les API réelles

Première exécution de `npm run check:sources -- --insee 60159` sur une machine connectée (10 octobre 2026) :

| Source | Résultat |
|---|---|
| geo.api.gouv.fr | ✅ surface 53,1 km², contour |
| INSEE Melodi (10 jeux sur 11) | ✅ `GEO=COM-60159` ; `DS_RP_FAMILLE_PRINC` n'existe pas (retiré) |
| DVF | ✅ 2 803 ventes retenues sur 5 ans |
| OpenStreetMap | ✅ 492 équipements |
| Géorisques | ✅ 2 risques, 12 arrêtés CatNat, 44 ICPE |
| Annuaire de l'éducation | ✅ 54 établissements |
| SNCF | ✅ gare de Compiègne, 2,8 millions de voyageurs |
| SIRENE | ✅ 11 015 unités légales |
| Élections | ❌ slugs data.gouv.fr erronés / ressource non indexée par l'API tabulaire |

Corrections apportées à partir des modalités réellement servies :
- dimensions sans total (`AGE`, `RP_MEASURE`, `UNIT_MEASURE`) : sélection par modalité par défaut au lieu d'un rejet systématique ;
- tranches d'âge réelles (15/25/40/55/65/80 ans) : parts des moins de 25 ans, 65 ans et plus, 80 ans et plus ;
- historique de population construit à partir des millésimes du recensement (2012, 2017, 2023), les populations de référence ne couvrant qu'un millésime ;
- statut d'occupation (codes `100`, `211`, `221`…), diplômes (nomenclature CITE : `500T702_RP` = supérieur), CSP, modes de transport, lieu de travail, période de construction et équipement automobile des ménages, avec libellés et partitions explicites ;
- nouveaux indicateurs : personnes vivant seules, ménages sans voiture / avec 2 voitures ou plus, actifs travaillant dans leur commune, part de la voiture et des transports en commun dans les trajets domicile-travail ;
- élections : découverte des jeux par recherche data.gouv.fr (ministère de l'Intérieur) et téléchargement direct du CSV si l'API tabulaire n'indexe pas la ressource.

Deuxième exécution : codes `EPCI-…`, `DEP-…`, `REG-…` validés ; 26 indicateurs et 6 distributions calculés pour Compiègne (revenu médian 23 310 €, pauvreté 24,4 %, chômage RP 15,7 %, concentration d'emploi 172) ; ressources électorales trouvées pour les trois scrutins. Corrections consécutives :
- le code « France » `FRANCE-F` est refusé (HTTP 400) : plusieurs syntaxes sont désormais essayées ; si aucune n'est acceptée, la colonne France est simplement absente des comparaisons ;
- dépassement mémoire à la lecture du fichier national des législatives : lecture en flux, seules les lignes du département sont conservées ;
- séparateur des fichiers électoraux détecté sur l'en-tête (les virgules décimales trompaient la détection automatique) ;
- partition des âges la plus fine retenue (65-79 ans et 80 ans et plus distincts).

**Reste à confirmer** : code « France » accepté par Melodi, lecture effective des trois fichiers électoraux.

## Fiche d'action « approche LFI » (version 0.2)

Ajouts : résultats par bureau de vote (E24, P22, LG24), géographie des bureaux (GeoJSON fourni, contours data.gouv.fr ou enveloppes REU), moteur d'analyse `src/lib/analysis/political.ts` (familles politiques, surperformance, potentiel et priorités par bureau), fiche d'action `src/lib/report/lfi.ts` sur le modèle du document de référence, import des données internes (parrains, groupes d'action).

**À valider sur les API réelles** avec `npm run check:sources -- --insee 60159` : ressources « par bureau de vote » trouvées pour les trois scrutins, colonne « Code BV », source de géographie des bureaux (le jeu REU doit être indexé par l'API tabulaire ; sinon déposer un GeoJSON).

Limites : les législatives 2024 ne permettent pas d'isoler LFI (candidatures NFP, nuance « UG ») ; le découpage des bureaux peut avoir changé entre 2022 et 2024 (appariement limité aux bureaux dont les inscrits varient de moins de 25 %) ; les heures de pointe des gares sont indicatives ; les quartiers prioritaires (QPV) et les données IRIS ne sont pas encore croisés avec les bureaux.

## Critères d'acceptation

| # | Critère | État |
|---|---|---|
| 1 | Saisie d'un code postal et choix de la commune | ✅ référentiel embarqué ; codes ambigus (ex. 60350 → 18 communes) ; recherche par nom ; communes nouvelles (déléguées → commune nouvelle). Testé (unitaires + e2e navigateur). |
| 2 | Génération sans saisie manuelle | ✅ une seule saisie ; périmètre facultatif. |
| 3 | Collecte réelle depuis plusieurs sources | ✅ 8 sources validées sur les API réelles ; élections en cours de validation (voir ci-dessus). |
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
✓ tests/integration.test.ts  (14 tests)
✓ tests/degraded.test.ts     (2 tests)
✓ tests/elections-file.test.ts (2 tests)
✓ tests/political.test.ts    (8 tests)
Test Files  6 passed (6) — Tests  52 passed (52)
```

Test e2e navigateur (`tests/e2e/smoke.mjs`, serveur de production) : parcours 60350 → Pierrefonds → génération → rapport → exports PDF/DOCX/CSV/JSON (HTTP 200).

Le test d'intégration a permis de corriger un défaut réel (la règle « sans diplôme » captait le « brevet professionnel », de niveau bac).

## Fonctionnalités implémentées

- **Recherche** : code postal, code INSEE, nom (insensible aux accents, « St » → « Saint »), communes déléguées.
- **Périmètres** : commune (défaut), intercommunalité, département, territoire personnalisé (≤ 40 communes).
- **Collecte** : geo.api.gouv.fr, INSEE Melodi (10 jeux, 5 échelles : commune, EPCI, département, région, France), DVF, OSM (22 catégories, cyclable, équipements structurants à 30 km), Géorisques, Annuaire de l'éducation, SNCF, SIRENE, élections (3 scrutins). Cache, nouvelles tentatives, coupe-circuit, repli sur cache périmé, mode hors ligne, limitation de débit.
- **Analyse** : écarts aux références avec règle de significativité, évolutions (TCAM), communes comparables et score z robuste, petits effectifs, constats typés reliés à leurs preuves, hypothèses formulées au conditionnel, pistes d'action sur enjeux objectifs, vérifications de terrain.
- **Cartes** (8 types) : localisation nationale (hors ligne) et départementale avec EPCI, densité, revenus du périmètre, équipements, transports, accès aux équipements structurants, participation électorale (sélecteur de scrutin), installations classées.
- **Interface** : accueil, progression, rapport avec navigation par chapitres, graphiques interactifs, cartes à couches activables et infobulles sourcées, panneau sources/méthodologie, régénération, liste des fiches générées, page méthodologie.
- **Exports** : PDF, DOCX, HTML, JSON, CSV, GeoJSON, PNG, SVG.
- **LLM facultatif** : abstraction de fournisseur, clé en variable d'environnement, garde-fou rejetant tout nombre ajouté.

## Limites connues et développements restants

1. **Validation complète** : codes géographiques de référence INSEE et élections à confirmer (cf. ci-dessus).
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
