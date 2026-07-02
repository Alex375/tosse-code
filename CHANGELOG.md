# Changelog

Nouveautés de chaque version, **affichées dans l'app** au moment de la mise à jour.

Convention : une section `## vX.Y.Z` par version (la plus récente en haut), avec des
puces courtes orientées **utilisateur** — pas de détails techniques internes. Le skill
`/release` ajoute automatiquement la section de la nouvelle version à partir des
commits ; `release.yml` lit cette section et la met en description de la release
GitHub, que l'app affiche telle quelle. Le bloc d'instructions d'installation (après
le marqueur `<!-- gh-only -->`) est ajouté par `release.yml` et reste **seulement**
sur la page GitHub — il n'apparaît pas dans l'app.

## v0.24.0

- Confirmation avant de supprimer une conversation **en cours d'exécution** (les conversations inactives se suppriment toujours en un clic, annulable avec ⌘Z).
- Refonte de la page de mise à jour : nouveautés de version lisibles, et avertissement clair avant le redémarrage — avec le nombre de conversations en cours qui seront interrompues.
