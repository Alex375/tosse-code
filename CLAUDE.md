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

## [GENERATED] Repository Context

# tosse-code — Stack & implémentation

Desktop app pour piloter Claude Code. La **vision**, le **périmètre par phases** et les **décisions structurantes** sont au niveau du contexte projet (Tosse Code). Ici : la stack concrète et le « comment on construit ».

## Principe directeur
Logiciel **rapide et très optimisé** — exigence cœur, pas un nice-to-have. Chaque arbitrage technique se tranche en faveur de la perf : cœur natif, pas de surcouche lourde. C'est ce qui motive Tauri (pas Electron) et un cœur Rust.

## Stack
- **Shell desktop** : Tauri 2 — utilise le webview de l'OS, **pas de Chromium embarqué** (~15 Mo, léger/rapide ; vs Electron ~180 Mo).
- **Cœur** (le « backend » **local**, pas de serveur cloud) : Rust + tokio. Superviseur de process, client du protocole Claude Code, persistance.
- **UI** : React + TypeScript + Vite, rendue dans le webview Tauri.
- **Éditeur** : Monaco (l'éditeur de VS Code, package npm) — diffs inclus.
- **Terminal** : xterm.js + addon-webgl.
- **État UI** : Zustand (flotte d'agents, nourri par les events) + TanStack Query (commandes).
- **Crates clés** : portable-pty (PTY interactif), notify (watch fichiers), git2 (statut/diff/worktrees), sqlx + SQLite (persistance), serde_json (parse stream-json), **tauri-specta** (contrat IPC typé Rust→TS auto-généré, jamais de resync manuelle).

## Frontière build vs réutilisation
- **On écrit nous-mêmes (c'est le produit)** : superviseur de flotte, client du protocole stream-json + canal de contrôle, machine à états des agents, orchestration des git worktrees, persistance, intégration TOSSE.
- **On réutilise (substrat de rendu, zéro différenciation produit)** : Monaco, xterm.js, le rendu markdown/diff/code en React.
- **On ne réimplémente PAS** le moteur d'agent de Claude : le binaire `claude` reste une boîte noire pilotée par son protocole stdio ; on construit tout autour. Le réécrire = perdre l'abo Max et toutes les améliorations futures du CLI.

## Protocole Claude Code (cœur de la conversation)
Réimplémentation **clean-room en Rust** du client utilisé par l'extension VS Code officielle (réécrit depuis le format de fil, **PAS un fork**) :
- Spawn du binaire `claude` avec `--output-format stream-json --input-format stream-json --verbose`.
- Mode **bidirectionnel persistant** (un process vit toute la session) — **PAS `claude -p`** (one-shot).
- Messages JSON-lines reçus : `system`, `assistant`, `user`, `tool_use`, `tool_result`, `result`, `stream_event`.
- Canal de contrôle : `control_request` / `control_response` (sous-types : `initialize`, `can_use_tool`, `set_permission_mode`, `interrupt`, `mcp_message`). Une demande de permission = un `control_request{can_use_tool}` → on répond `control_response`. Lancé avec `--permission-prompt-tool stdio`.
- « Par terminal, pas l'API HTTP » respecté : on pilote le binaire CLI (abo Max) ; le stream-json n'est qu'un cadrage stdio structuré par-dessus.
- Référence disséquée localement : extension `anthropic.claude-code` (`extension.js` = host/transport ; `webview/index.js` = UI React).

## Tools IDE exposés à l'agent (Phase 2)
Comme on remplace l'IDE, on implémentera le côté serveur des tools IDE que l'extension expose à l'agent : `openDiff`, `openFile` (à la bonne ligne), `getCurrentSelection`, `getDiagnostics`, `getWorkspaceFolders`, `saveDocument`… → l'agent agit dans NOTRE éditeur.

## Structure cible (monorepo pnpm)
- `src-tauri/` (Rust : `supervisor/`, `git/`, `fs/`, `store/`, `tosse/`, `ipc/`)
- `src/` (React : `features/{fleet,conversation,editor,git,explorer}`, `ipc/`, `store`)
- `packages/ipc-types/` (types générés Rust→TS)

## Commandes dev
- À venir — repo encore vide. Premier scaffolding : projet Tauri 2 + module superviseur Rust (client stream-json minimal qui spawn un `claude` et relaie ses messages).

## [GENERATED] Associated Project Contexts

---
**Project: Tosse Code**
# Tosse Code — Desktop app pour piloter Claude Code

## Vision
Logiciel desktop interne pour utiliser Claude Code de manière optimisée pour notre workflow. Aujourd'hui on a (a) Claude Code en terminal et (b) l'app Claude Code, mais aucun n'est bien optimisé pour notre usage. Objectif : un seul outil qui combine une vue propre du code + une conversation propre + (surtout) la gestion de plusieurs agents Claude Code en parallèle, le tout pilotable par Claude lui-même.

## Principe directeur : performance
Le logiciel doit être **rapide et très optimisé** — c'est une exigence cœur, non négociable. Tous les arbitrages techniques se tranchent en faveur de la perf (cœur natif, pas de surcouche lourde). C'est la raison d'être des choix de stack ci-dessous.

## Structure générale de l'UI (grandes lignes)
Deux vues principales :
1. **Vue Gestion d'agents** — l'aperçu de tous les agents en cours.
2. **Vue Conversation** — la discussion avec un Claude Code. Depuis cette vue, on peut **ouvrir un panneau latéral (à droite)** qui contient l'arborescence des fichiers / l'architecture du projet, le fichier ouvert, et un terminal.

## Stack technique (décisions structurantes)
- **Shell desktop : Tauri 2** (webview de l'OS, pas de Chromium embarqué) — choisi pour la perf/légèreté vs Electron. Validé avec Alexandre (à l'aise en Rust).
- **Cœur en Rust** (superviseur, conversation, persistance) ; **UI en React/TS** dans le webview. Architecture en 3 couches : UI React ↔ cœur Rust ↔ binaire `claude` (×N).
- **Pilotage de Claude Code via le protocole stream-json persistant** — pas `claude -p` (one-shot), pas l'API HTTP. C'est le binaire CLI piloté en stdio structuré → « par terminal » respecté, abo Max conservé.
- **Ne PAS forker** VS Code ni l'extension : on réimplémente *clean-room* en Rust le client du protocole de l'extension officielle (disséquée). On réutilise le substrat de rendu (Monaco = éditeur, xterm.js = terminal), mais on écrit le **cœur** nous-mêmes.
- Détails de stack, crates et protocole : voir le contexte **repo** (tosse-code).

---

## MVP (Phase 1)

### Stream / Conversation Claude Code
- **Premier livrable concret.** Stream Claude Code **basique** : pouvoir streamer une conversation Claude Code, envoyer des messages, recevoir des messages.
- Ça doit être **clean**. **On garde la qualité du rendu du stream de VS Code** (jugé très propre) comme référence d'affichage — refait à notre sauce (Rust + React).

### Éditeur de texte léger
- Un panneau qui s'ouvre sur le côté avec l'**arborescence des fichiers du projet** et le **fichier qui s'ouvre**.
- (Coloration syntaxique et le reste viennent en Phase 2.)

### Terminal
- Une petite fenêtre terminal intégrée, qui s'ouvre dans la vue.

### Vue Gestion d'agents
Des petites cases pour chaque agent en cours, avec :
- **Où il est** : dans quel repo.
- **Actif ou non**.
- **Ce qu'il fait en ce moment / où il en est**.
- **Pouvoir lui répondre** s'il pose une question.
- **Notification** quand il a besoin d'intervention.
- **Quoi afficher** quand une intervention est requise (ex. la question / le blocage).
- Son **état** : en cours de run / idle / ready for review / besoin d'intervention.

---

## Phase 2

- **MCP server qui contrôle l'IDE** : Claude peut piloter l'app via un MCP server (cf. cas d'usage ci-dessous).
- **Explorateurs Skills / Plugins / MCP** actifs dans le projet et par scope : vision générale des skills + vision pour le repo, quelque chose de propre.
- **Client Git** (amélioration).
- **Éditeur de texte enrichi** : coloration syntaxique, etc.
- **Visualisation d'images** : pouvoir ouvrir des images.
- **Association des conversations à TOSSE** : chaque conversation est associée à une tâche TOSSE et à un projet.

### Cas d'usage du pilotage par Claude (MCP server)
Tout le logiciel doit être pilotable par les agents via un MCP server exposant les actions de l'UI comme tools. Exemples :
- « Ouvre-moi la page Git » → l'agent ouvre la vue Git.
- « Ouvre-moi le commit dont tu parles » → l'agent ouvre ce commit.
- « Ouvre-moi le fichier que tu viens d'écrire » → l'agent ouvre le fichier **à la bonne ligne**.
- … navigation entre vues, ouverture de diff, focus sur un agent, lancement de tâche, etc.
Principe : chaque action significative de l'UI a un équivalent appelable par un agent.

---

## Phase 3 (plus complexe)

- **Intégration TOSSE complète** : liste des projets et des tâches dans l'app ; on clique sur une tâche → **ça démarre directement un agent Claude Code dessus** (comme une conversation classique).

---

## Points ouverts / à cadrer
- Détails d'UI (boutons, agencement fin) : non figés, on s'en occupera plus tard.
- Designs Claude Design (gestion d'agents) : à intégrer plus tard, Alexandre les fournira.
- Périmètre exact des actions exposées par le MCP server de pilotage : à lister (Phase 2).

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
