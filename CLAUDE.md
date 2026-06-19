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
- **Crates clés** : portable-pty (PTY interactif), notify (watch fichiers), **rusqlite (bundled)** + SQLite (persistance — SQLite C compilé dans le binaire, synchrone, mode WAL, foreign_keys ON ; sqlx écarté : nos écritures sont minuscules/rares/hors chemin chaud, pas besoin d'async + macros), serde_json (parse stream-json), **tauri-specta** (contrat IPC typé Rust→TS auto-généré, jamais de resync manuelle).
- **git2** : option ouverte pour diff/status in-process côté éditeur Monaco — PAS utilisé pour les worktrees (voir module `git/` ci-dessous).

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
- `SessionStatePayload` contient un champ **`cwd`** capté depuis `system/init` (ré-émis à chaque tour) — source de vérité du répertoire de travail COURANT de la session. Le cwd n'est PAS figé : l'agent peut le déplacer (via outils worktree) ; l'UI suit le `cwd` live.
- « Par terminal, pas l'API HTTP » respecté : on pilote le binaire CLI (abo Max) ; le stream-json n'est qu'un cadrage stdio structuré par-dessus.
- Référence disséquée localement : extension `anthropic.claude-code` (`extension.js` = host/transport ; `webview/index.js` = UI React).

## Tools IDE exposés à l'agent (Phase 2)
Comme on remplace l'IDE, on implémentera le côté serveur des tools IDE que l'extension expose à l'agent : `openDiff`, `openFile` (à la bonne ligne), `getCurrentSelection`, `getDiagnostics`, `getWorkspaceFolders`, `saveDocument`… → l'agent agit dans NOTRE éditeur.

## Structure (monorepo pnpm)
- `src-tauri/` (Rust : `supervisor/`, `git/`, `fs/`, `store/`, `tosse/`, `ipc/`)
  - `supervisor/` **implémenté** : `protocol.rs` (types serde du fil stream-json), `transport.rs` (spawn + reader/writer/stderr), `control.rs` (canal de contrôle + gestion des permissions), `model.rs` + `assembler.rs` (normalisation des messages pour l'UI), `session.rs` (acteur tokio par session).
  - `store/` **implémenté** : `model.rs` (records de domaine, zéro SQL) + `db.rs` (struct `Store` = le SEUL service qui parle SQL ; mappe lignes ↔ records). DB ouverte dans `lib.rs` setup → `app_data_dir()/tosse.db`, managée en state Tauri. Périmètre : métadonnées only (repos + conversations + sélection active) ; messages NON persistés (restent dans les transcripts Claude). Politique dev : pas de migration data-preserving pour l'instant → wipe-and-recreate (+ bouton « Tout supprimer » dans les Réglages).
  - `git/` **implémenté** : `src-tauri/src/git/mod.rs` est le SEUL service qui parle `git` (même pattern d'encapsulation que `store/db.rs`, swappable). Il enveloppe le **binaire `git` en CLI** (sous-process + parsing `--porcelain`), PAS la crate git2. Raison : sécurité de suppression déléguée à `git worktree remove` (refuse de détruire un worktree sale), parsing porcelain stable, pas de dépendance de build libgit2 pour des ops rares hors hot-path. Aucune crate ajoutée au Cargo.toml.
  - Surface IPC (tauri-specta) : commandes `spawn_session` / `send_message` / `answer_permission` / `set_permission_mode` / `interrupt_session` / `stop_session` + persistance `load_persisted_state` / `upsert_repo` / `delete_repo` / `upsert_conversation` / `delete_conversation` / `set_active_conversation` / `wipe_all_data` + worktrees `list_worktrees` / `worktree_status` / `create_worktree` / `remove_worktree` (types `WorktreeInfo` / `WorktreeStatus`) + events `session_state` / `session_message` / `session_permission`. Registre `Sessions` en managed state Tauri.
- `src/` (React : `features/{fleet,conversation,editor,git,explorer,settings}`, `ipc/`, `store`)
  - `src/features/git/` **implémenté** : indicateur worktree actif, badge sidebar, gestionnaire modale des worktrees.
  - `src/ipc/useWorktrees.ts` : hook TanStack Query pour les commandes worktree IPC.
- `packages/ipc-types/` (types générés Rust→TS)

## Spec & fixtures
- Spec autoritaire du protocole stream-json (v2.1.178) : `docs/claude-code-protocol.md`
- Fixture de non-régression : `src-tauri/src/supervisor/fixtures/capture_text.jsonl` — à re-capturer à chaque upgrade du binaire `claude`.

## Patterns établis
- Normalisation côté Rust : l'UI est « bête » (reçoit des events déjà normalisés, ne reconstruit rien).
- Session bidirectionnelle persistante : un process `claude` vit toute la session, SANS flag `-p`.
- Acteur mono-tâche par session : pas de mutex partagé entre sessions (isolation tokio).
- Persistance encapsulée : un seul service (`store::db::Store`) parle SQL ; le reste du cœur et l'IPC ne manipulent que des records de domaine → changer de moteur/schéma = réécrire `db.rs` uniquement.
- **Git encapsulé** (même pattern) : `git::mod` est le seul point d'entrée pour toutes les ops git → swappable sans toucher à l'IPC ni au front.
- Identité de conversation : l'**id stable** (UUID, PK persistée) est distinct du **handle de session live** (`session-N`, en mémoire, non persisté, remappé à chaque resume). Le front est keyé par **id stable** pour toutes les LECTURES (message store, état, timeline, composants) ; le **handle** (`session-N`) n'est résolu qu'au moment d'envoyer une commande au process vivant. Le routeur d'events (`useGlobalSessionEvents`) mappe `handle → id stable` (les events live restent keyés par handle côté cœur Rust). Le handle est libéré sur `state.ended` ; un renvoi re-spawne.
- Spawn **paresseux** (lazy) : aucun process `claude` n'est lancé au démarrage ni à la sélection d'une conversation. L'historique se lit du transcript on-disk (`loadSessionHistory`, pur I/O). Le process est spawné à la volée au **1er message** (`ensureConversationSession`, avec `--resume` si `sessionId`).
- Teardown **sans orphelins** : chaque `claude` tourne dans son propre groupe de process (`process_group(0)`, Unix). L'arrêt signale tout le groupe (`kill(-pid, …)`) selon l'échelle EOF → SIGTERM → SIGKILL, avec balayage SIGKILL final sur tous les chemins. Kill-all au quit : on attend que le registre `Sessions` se vide (borné). Dépendance `libc` (cfg unix). `stop_session` tue le process (≠ `interrupt_session`, qui ne stoppe que le tour).
- **Outils worktree natifs de Claude Code** (`EnterWorktree` / `ExitWorktree`) visibles dans `system/init.tools` — l'app les INTERCEPTE : détection des `tool_use` dans `useGlobalSessionEvents` → rafraîchit la liste des worktrees côté UI. Le `cwd` d'une conversation N'EST PAS figé ; l'UI suit le `cwd` live via `SessionStatePayload.cwd`.
- **Convention d'emplacement des worktrees** créés par l'app : `.claude/worktrees/<branche>` (dans le worktree principal, aligné sur le comportement de l'outil natif `EnterWorktree`).
- **Association conversation↔worktree** par le `cwd` : résolution longest-prefix côté front.

## Commandes dev

Rust (depuis `src-tauri/`, cargo dans `~/.cargo/bin`) :
- Tests unitaires : `cargo test --lib`
- Tests live (spawn réel de `claude`, ignorés par défaut) : `cargo test --lib -- --ignored --nocapture`

Front TypeScript :
- Typecheck : `node_modules/.bin/tsc --noEmit`
- Build : `pnpm build`

Bindings IPC : regénérés automatiquement au build debug et via le test `export_bindings_regenerates_ts_client` (tauri-specta).

## Versioning & releases

SemVer `MAJEUR.MINEUR.CORRECTIF`. Tant qu'on est en `0.y.z` (cas actuel) : **MINEUR** pour toute nouveauté, **CORRECTIF** pour les fix ; on ne passe `1.0.0` que quand l'app est jugée stable. MAJEUR = changement incompatible (schéma SQLite sans migration, format de transcript, comportement cassé).

- **La version vit à 3 endroits, toujours synchronisés** : `src-tauri/tauri.conf.json` (**source de vérité runtime** — lue par `getVersion()`, affichée dans la page Réglages, et utilisée par le workflow pour le tag), `package.json`, `src-tauri/Cargo.toml` (+ `Cargo.lock`). Ne jamais les laisser diverger.
- **Bumper** : `pnpm bump <patch|minor|major|X.Y.Z>` (script `scripts/bump-version.mjs`) met les 4 fichiers à jour d'un coup. Puis commit `chore(release): vX.Y.Z` + push sur `main`. Ne PAS éditer les versions à la main.

### Publier une release
Workflow `.github/workflows/release.yml`, **100 % manuel** (`workflow_dispatch`, PAS de trigger sur push — choix assumé pour l'instant). Build depuis l'état courant de `main`.
1. Bumper (`pnpm bump …`), commit, push.
2. Actions → **Release** → Run workflow (ou `gh workflow run release.yml`).
3. La CI compile un bundle **macOS universel** (Apple Silicon + Intel) et crée une release GitHub **EN BROUILLON** avec `.dmg`/`.app` attachés.
4. Relire dans Releases puis cliquer **Publish**.

### Sécurité (« un peu sécurisé »)
- Lancement restreint : seuls les comptes de la liste `ALLOWED` du job `authorize` peuvent déclencher (aujourd'hui `Alex375` ; ajouter Armand au besoin).
- La release sort en **brouillon** → publication = geste humain explicite (dernier verrou, jamais en un clic 100 % auto).
- Garde-fou anti-doublon : le workflow refuse de tourner si une release porte déjà le numéro courant → force à bumper avant de re-publier.
- macOS **non signé Apple** (pas de compte Developer) : au 1er lancement, clic droit → Ouvrir (`xattr -cr "/Applications/Tosse Code.app"`). Signature/notarisation = chantier ultérieur.

### Lien auto-update (pas encore branché)
L'updater (`tauri-plugin-updater`) comparera la version installée à la dernière release → SemVer + tags `vX.Y.Z` cohérents indispensables. Quand on l'activera : `tauri signer generate` (clé privée en secret repo `TAURI_SIGNING_PRIVATE_KEY` + `_PASSWORD`, clé publique dans `tauri.conf.json`), activer `createUpdaterArtifacts` (génère artefacts signés + `latest.json`), dé-commenter les vars `TAURI_SIGNING_*` du workflow (déjà repérées en commentaire). Tant que non fait : builds non signés updater, MAJ manuelle (télécharger le `.dmg` de la dernière release).

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
- Assigné à Alexandre. Repo créé : `github.com/Alex375/tosse-code`.
- **Tâches Phase 1 créées** (6 parents + sous-tâches + dépendances de blocage). Chemin critique : Scaffolding → Cœur stream-json → Vue Conversation, puis (éditeur léger, terminal) ; la Vue Gestion d'agents part en parallèle dès que le cœur est prêt. Seule tâche non bloquée (point d'entrée) : **« Scaffolding : projet Tauri 2 + monorepo + IPC typé »**.

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
