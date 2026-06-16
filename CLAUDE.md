# Claude Code Instructions — TOSSE

## MCP TOSSE
This project is managed via TOSSE CRM.

### FUNDAMENTAL RULE: Read contexts before acting
Before any action on this project, call get_context() to read the associated contexts
(repo, project, mission, client). These contexts contain essential information
to understand the scope and intentions of the project.

### TASK-FIRST RULE: Check tasks before coding
Before starting any development work, always check if a TOSSE task already exists
for the requested work (`/list-tasks` or `get_tasks` filtered by project_id).
If a matching task exists, `/pickup` it. If no task exists, create one via MCP
before writing any code. Never start coding without an associated TOSSE task.

### SYNC RULE: Keep the CRM up to date
- Any task created/modified/completed → update the CRM via MCP
- Any new project information → enrich the context via update_context()
- Call sync_claude_md() regularly to keep this file up to date

### ANTI-REDUNDANCY RULE
CRM contexts are organized in cascade (client → mission → project → repo).
Do not replicate in this file information already present in parent contexts.
Only enrich what is specific to THIS repository.

## TOSSE Workflow — Skills & Agent

Ce projet utilise le plugin TOSSE qui fournit des skills et un agent pour gérer le workflow de développement.

### Workflow standard

```
/pickup → travail sur le code → /done → /deploy
```

### Skills disponibles

| Skill | Quand l'utiliser |
|-------|-----------------|
| `/pickup` ou `/pickup <task_id>` | Démarrer une tâche. Vérifie les blocages, lit les contextes, passe la tâche "En cours". Accepte aussi une intention libre ("je veux fixer le bug du login") — il cherche la tâche existante ou en crée une. |
| `/done` | **Lancé automatiquement** quand tu finis ton travail (code compile, tests passent, feature OK). Résume ce qui a été fait, met à jour le contexte de la tâche, passe en "Review", lance /deploy si le skill existe. Si gros changement : propose un context update via tosse-manager. |
| `/list-tasks` | Lister les tâches du projet actuel. |
| `/setup` | Créer un skill /deploy spécifique à ce projet (pose des questions : commande test, branche, hosting). |
| `/context-audit` | Auditer la cascade de contextes (redondances, infos mal placées). Délègue à tosse-manager. |

### Agent tosse-manager

Sous-agent spécialisé CRM. Invoque-le avec `@tosse-manager` pour :
- Créer des hiérarchies complètes (client + mission + projet + tâches)
- Mettre à jour les contextes après un gros changement (délégué par /done)
- Auditer la cascade de contextes (délégué par /context-audit)
- Réorganiser des tâches, créer des dépendances, gérer en masse

Il ne touche PAS au code — uniquement les données TOSSE via MCP.

### Règles de workflow

- **Démarrer une tâche** : utilise `/pickup` — il fait tout (blocages, contextes, statut "En cours")
- **Terminer une tâche** : **lance `/done` AUTOMATIQUEMENT** quand tu as fini le travail et que tout est vérifié. Ne demande PAS à l'utilisateur.
- **JAMAIS** mettre une tâche en "Fait" — seul un humain le fait après review
- **Les sous-tâches** ne vont jamais en "Review", seules les tâches parentes
- Vérifie les relations de blocage (`get_task_relations`) avant de démarrer une tâche
- Toujours filtrer par `project_id` quand tu récupères des tâches

### Guide de contexte — quoi va où

| Niveau | Ce qu'on y met | Exemples |
|--------|---------------|----------|
| **Client** | Secteur, localisation, contacts, contraintes business | "Fintech Paris, RGPD strict, CTO = Pierre" |
| **Mission** | Scope contractuel, objectifs, budget, planning | "Refonte site, livraison avril, 15k€" |
| **Projet** | Architecture, décisions techniques structurantes | "SPA React + API REST, auth JWT" |
| **Repo** | Stack, commandes dev, CI/CD, deploy, patterns code | "Next.js 15, pnpm, Vercel, middleware /auth.ts" |
| **Tâche** | Ce qui a été fait, décisions prises pendant le travail | "Choisi JWT plutôt que sessions" |

Règle d'or : une info ne doit exister qu'à UN SEUL niveau.

Task status flow: `Backlog → À faire → En cours → Review → Fait`

**MCP entity IDs for this repository:**
- repository_id: `8c509e62-30cb-4f58-9074-086bac72528d`
- project_id (Tosse Code): `ef02be22-fe30-4463-9450-ec3b20746a35`

## [GENERATED] Global Rules

- Write all comments and variable names in English
- Always create a virtual environment before installing Python packages
- Never commit secrets or API keys
- Document all public functions

## [GENERATED] Associated Project Contexts

---
**Project: Tosse Code**
# Tosse Code — Desktop app pour piloter Claude Code

## Vision
Logiciel desktop interne pour utiliser Claude Code de manière optimisée pour notre workflow. Aujourd'hui on a (a) Claude Code en terminal et (b) l'app Claude Code, mais aucun des deux n'est bien optimisé pour notre usage. Objectif : un seul outil qui combine une vue propre du code + une conversation propre + (surtout) la gestion de plusieurs agents Claude Code en parallèle.

Trois piliers de valeur :
1. Voir le code proprement.
2. Une conversation propre avec Claude Code (reproduire l'app Claude Code, en mieux).
3. **Gérer plusieurs agents / plusieurs Claude Code qui tournent en même temps** — c'est le point le plus important pour nous.

## Approche technique (décisions structurantes)
- **Par terminal, pas par API** : on stream le terminal Claude Code (comme l'intégration VS Code).
- **S'appuyer sur l'extension open-source VS Code pour Claude Code** comme base.

## Périmètre fonctionnel souhaité

### 1. Conversation Claude Code
- Stream du terminal Claude Code intégré (à la VS Code).
- Reproduire l'expérience de discussion de l'app Claude Code, en mieux pour notre usage.

### 2. Explorateur Skills / Plugins / MCP (important pour nous)
- Vue des **skills activés** par scope (projet / repo / niveau user).
- Explorateur de **plugins** et de **MCP servers** activés, et éventuellement des **marketplaces** (pouvoir aller chercher / installer).
- Pouvoir **changer facilement** les activations.
- Bonne visualisation des tools et skills : une vue « humaine » + une vue du **niveau d'activité** des skills.

### 3. Client Git GUI
- Diffs propres et efficaces.
- Arborescence du dépôt.
- Éventuellement : visualisation des PR + actions (à confirmer, pas sûr).

### 4. Éditeur de texte léger (type IDE)
- Arborescence des fichiers du projet + éditeur au centre.
- Onglets pour ouvrir plusieurs fichiers en même temps.
- Raccourcis clavier classiques, coloration syntaxique, auto-complétion basique.
- **Visualisation d'images** (pouvoir ouvrir des images).

### 5. Gestion multi-agents (cœur différenciant)
- Voir les **agents actifs** et dans quel « réseau » / contexte ils tournent.
- **Notifications** quand une intervention est nécessaire : soit l'agent a fini et attend une review, soit il s'est arrêté (question / blocage) — et dans ce cas **afficher la question**.
- États des différents agents, tâches en cours, contexte, avancement (où ils en sont).
- **Agents attachés à des projets / tâches** assignées.
- Designs déjà réalisés dans Claude Design pour cette partie (à intégrer plus tard).

### 6. Vue Projets & Tâches
- Liste des projets et liste des tâches.
- Ouvrir une tâche → bouton **Start** qui lance directement Claude Code sur cette tâche et l'envoie, comme une conversation classique.

## Points ouverts / à cadrer
- **Layout de l'IDE** pas encore figé : où placer la conversation (à droite ? au milieu ?), le fichier au centre avec l'arborescence, etc. → travail de design à faire.
- Intégration des **designs Claude Design** (gestion d'agents) à venir.
- PR / actions Git : à confirmer.

## Organisation
- Assigné à Alexandre. Le repo sera créé par Alexandre de son côté.
- Tâches à créer plus tard (non créées pour l'instant, volontairement).

---
**Active Mission: Développement TOSSE** (En cours, assigned to Les deux)
Développement complet du CRM interne TOSSE pour Alexandre et Armand (freelancers) : backend API, frontend web, serveur MCP, plugin Claude Code, déploiement cloud.

Spec de référence : `Cahier_des_charges.md` (v1.3, mars 2026) — document autoritatif pour toutes les fonctionnalités et comportements attendus.

---
**Client: Interne**
Alexandre Josien et Armand Mounsi, deux ingénieurs informatique freelances travaillant en binôme.

## Services proposés
- **Développement logiciel** : prototypage rapide / MVP, développement IA / algorithmes complexes, architecture technique
- **Conseil** : automatisation, architecture, audit technique
- **Formation** : intelligence artificielle, Claude Code, outils IA pour développeurs

## Domaines de prédilection
1. Prototypage rapide — résultats très vite, très bien, pas cher
2. Développement nécessitant un vrai ingénieur (IA, algorithmes complexes, architecture)
3. Formation IA (notamment Claude Code)
4. Conseil en automatisation

## Modèle de travail
- Flexibilité : plusieurs contrats en parallèle
- Binôme complémentaire, livraison rapide et efficace
- Préfèrent le distanciel, acceptent le présentiel ponctuel (1-3 semaines)
- Refusent les contrats longs sur site (incompatible avec le modèle multi-contrats)

## Ressources techniques
- Abonnement Max Claude Code
- Clé API OpenAI
- CRM interne TOSSE (avec serveur MCP)
- Hébergement Railway