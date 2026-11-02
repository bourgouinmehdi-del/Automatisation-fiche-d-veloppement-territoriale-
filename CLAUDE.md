# Fiches Territoires — consignes de travail

Outil Next.js qui génère des fiches d'action par commune (et des fiches de ciblage par département, EPCI, circonscription) à partir de données publiques et d'un bilan militant interne.

## Règles absolues

- **Données internes** : tout ce qui est dans `data/interne/` (bilan militant, soutiens, municipales LFI…) est confidentiel et gitignoré. Ne jamais le committer, ni citer de chiffres internes dans un commit, une PR, un test ou un message. Le dépôt est public. Dans les tests, utiliser des valeurs fictives (communes et codes inventés, ex. `00000`).
- **Fusion** : ne fusionner une PR qu'après l'accord explicite de Mehdi (« oui »), sauf s'il a dit en début de session « fusionne directement après les tests ».
- **Texte des fiches** : français simple, direct, sans tournure d'IA. Écriture inclusive avec le point médian (député·es, militant·es). « Soutiens JLM2027 », jamais « parrains » dans le texte affiché.

## Branches et déploiement

- Branche de base des PR : `claude/magical-ptolemy-dz2n9o`. La VM se met à jour depuis cette branche toutes les 5 minutes environ.
- Travailler sur une branche courte par série de retours, puis ouvrir une PR vers la branche de base.
- Commits : `git -c user.name="Mehdi Bourgouin" -c user.email="bourgouinmehdi@gmail.com" commit …`
- PR via l'API : écrire le corps dans un fichier JSON (`title`, `head`, `base`, `body`) puis
  `gh api repos/bourgouinmehdi-del/automatisation-fiche-d-veloppement-territoriale-/pulls --input pr.json --jq .number`.
  Fusion : `gh api -X PUT repos/bourgouinmehdi-del/automatisation-fiche-d-veloppement-territoriale-/pulls/N/merge -f merge_method=merge --jq .message`.

## Commandes

- Types : `./node_modules/.bin/tsc --noEmit`
- Tests : `timeout 600 ./node_modules/.bin/vitest run` (un fichier : ajouter son chemin). Pas de prettier.
- Ne jamais lancer `pkill -f "next dev"` (tue le shell). Pour arrêter le serveur :
  `for p in $(pgrep -f "next-server|next dev -p 3999"); do kill $p; done`
- Le shell ne joint pas data.gouv ni la plupart des sites (proxy). Les données réelles ne sont vérifiables que sur la VM.

## Où est quoi

- `src/lib/report/collect.ts` : collecte des données pour une commune.
- `src/lib/report/lfi.ts` : contenu de la fiche d'action (synthèse, profil socio, profil politique, « Que faire ? », « Organiser la venue »). C'est là que se font la plupart des retours.
- `src/lib/report/gradation.ts` : échelle unique des comparaisons (« à peine plus » … « quatre fois plus »). Toute comparaison chiffrée passe par elle.
- `src/lib/report/acces.ts` : villes militantes (choix, carte, temps en voiture et en train).
- `src/lib/report/build.ts` : assemblage des blocs.
- `src/lib/collectors/` : une source par fichier (`rpls.ts` logements sociaux, `deputes.ts`, `municipales.ts`, `interne.ts` fichiers internes, `gtfs.ts` trains, `bureaux-geo.ts` bureaux de vote…).
- `src/lib/render/html.ts` : rendu HTML et PDF. `src/lib/export/docx.ts` : Word. `src/components/` : site.
- Caches : quand le format d'une donnée traitée change, changer sa clé de cache (ex. `rpls5|code` dans `rpls.ts`).

## Façon de travailler

- Retours de Mehdi : corriger le code pour toutes les fiches, pas seulement la commune citée, et ajouter un test avec des valeurs fictives.
- Vérifier les remplacements de texte dans le code (une espace insécable ` ` peut faire échouer un remplacement sans erreur).
- Réponses courtes : ce qui a changé, le numéro de PR, ce qui reste à vérifier sur la VM.
