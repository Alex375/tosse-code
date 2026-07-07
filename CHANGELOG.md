# Changelog

Nouveautés de chaque version, **affichées dans l'app** au moment de la mise à jour.

Convention : une section `## vX.Y.Z` par version (la plus récente en haut), avec des
puces courtes orientées **utilisateur** — pas de détails techniques internes. Le skill
`/release` ajoute automatiquement la section de la nouvelle version à partir des
commits ; `release.yml` lit cette section et la met en description de la release
GitHub, que l'app affiche telle quelle. Le bloc d'instructions d'installation (après
le marqueur `<!-- gh-only -->`) est ajouté par `release.yml` et reste **seulement**
sur la page GitHub — il n'apparaît pas dans l'app.

## v0.27.0

- Durée des tours affichée dans la conversation, avec un compteur en direct pendant que l'agent travaille et le détail par poste (modèle, réflexion, outils).
- Cartes du Flight Deck interactives : liste des tâches, contexte, effort et piles de to-do consultables directement.
- Les plugins et slash-commands des conversations actives se rechargent automatiquement quand vous les activez/désactivez.
- Un agent qui termine pendant qu'une tâche de fond tourne passe désormais en vert (« tâche de fond en cours ») au lieu d'un état « à relire » trompeur.
- Correction : les prompts internes des sous-agents ne s'affichent plus comme vos propres messages dans le fil.

## v0.26.0

- Notifications sonores plus fiables : le son de fin d'agent se déclenche à nouveau même après avoir regardé une vidéo ou changé la sortie audio du Mac.
- Un nouvel installeur renomme le bundle en **Flight Deck.app** au premier lancement.

## v0.25.0

- L'app s'appelle désormais **Flight Deck** et arbore un nouveau logo.
- Nouveaux contrôles au survol des messages : reprendre la conversation à partir d'un message (rewind) ou repartir dans une nouvelle branche (fork).
- Un pin flottant affiche votre dernier message envoyé en haut du fil.
- Les messages conservent leurs retours à la ligne, et l'aperçu du dernier message ignore les notifications internes.
- Correction : un jeton d'usage périmé ne masque plus le solde issu du Keychain.

## v0.24.0

- Flight Deck : cartes cliquables avec pop-ups (conversation, dernier message, to-do) et vue d'ensemble enrichie de la flotte d'agents.
- Alerte quand un agent a terminé, même s'il tournait en tâche de fond ; les notifications de tâches internes n'encombrent plus le fil.
- Bouton « + » du composer : joindre des fichiers et des images à un message.
- Page Réglages repensée, avec un récapitulatif des raccourcis clavier (et de nouveaux raccourcis).
- Confirmation avant de supprimer une conversation **en cours d'exécution** (les conversations inactives se suppriment toujours en un clic, annulable avec ⌘Z).
- Refonte de la page de mise à jour : nouveautés de version lisibles, et avertissement clair avant le redémarrage — avec le nombre de conversations en cours qui seront interrompues.
