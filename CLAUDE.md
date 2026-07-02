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
- **Éditeur** : Monaco (package npm) — **implémenté, lazy-loadé / code-split** (chunk éditeur hors du bundle de démarrage ; workers de langage json/css/html/ts en chunks lazy séparés, chargés seulement à l'ouverture d'un fichier du langage → démarrage non impacté).
- **Terminal** : `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-webgl` — **implémenté**. PTY natif côté Rust via `portable-pty` 0.8 ; octets PTY encodés en base64 sur le bus d'events Tauri (crate `base64` 0.22). Rendu WebGL côté front.
- **État UI** : Zustand (flotte d'agents, nourri par les events) + TanStack Query (commandes).
- **Crates clés** : `portable-pty` 0.8 (PTY interactif), `base64` 0.22 (cadrage octets PTY sur le bus d'events), notify (watch fichiers), **rusqlite (bundled)** + SQLite (persistance — SQLite C compilé dans le binaire, synchrone, mode WAL, foreign_keys ON ; sqlx écarté : nos écritures sont minuscules/rares/hors chemin chaud, pas besoin d'async + macros), serde_json (parse stream-json), **tauri-specta** (contrat IPC typé Rust→TS auto-généré, jamais de resync manuelle), **reqwest** (features `rustls-no-provider`) + **rustls** (feature `ring`) — ajoutées comme dépendances directes (étaient déjà présentes transitivement via tauri-plugin-updater) ; provider crypto `ring` installé idempotemment au runtime avant le 1er client HTTP.
- **Plugins Tauri** : opener, dialog, **updater** + **process** (auto-update signé), **notification** (notifs OS agent).
- **JS plugins** : `@tauri-apps/plugin-notification`. Permission `notification:default` dans `capabilities/default.json`.
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
- Canal de contrôle : `control_request` / `control_response` (sous-types : `initialize`, `can_use_tool`, `set_permission_mode`, `interrupt`, `mcp_message`, `generate_session_title`). Une demande de permission = un `control_request{can_use_tool}` → on répond `control_response`. Lancé avec `--permission-prompt-tool stdio`.
- `SessionStatePayload` contient un champ **`cwd`** capté depuis `system/init` (ré-émis à chaque tour) — source de vérité du répertoire de travail COURANT de la session. Le cwd n'est PAS figé : l'agent peut le déplacer (via outils worktree) ; l'UI suit le `cwd` live.
- « Par terminal, pas l'API HTTP » respecté : on pilote le binaire CLI (abo Max) ; le stream-json n'est qu'un cadrage stdio structuré par-dessus.
- Référence disséquée localement : extension `anthropic.claude-code` (`extension.js` = host/transport ; `webview/index.js` = UI React).
- Canal de contrôle — **arrêt d'une tâche de fond** : le wire est `control_request{subtype:"stop_task", task_id}`. Le sous-type est **`stop_task`** (et NON `task_stop` comme supposé initialement) — disséqué verbatim dans l'extension VS Code (`extension.js`, vérifié en 2.1.179 ET 2.1.181 : `stopTask(e){request({subtype:"stop_task",task_id:e})}`, enveloppe `{request_id,type:"control_request",request:e}`). Implémenté : `control::stop_task_request`, commande IPC `stop_task`, bouton Stop des Bash de fond. Après stop, la tâche settle `stopped` via le cycle `task_*`.

## Tools IDE exposés à l'agent (Phase 2)
Comme on remplace l'IDE, on implémentera le côté serveur des tools IDE que l'extension expose à l'agent : `openDiff`, `openFile` (à la bonne ligne), `getCurrentSelection`, `getDiagnostics`, `getWorkspaceFolders`, `saveDocument`… → l'agent agit dans NOTRE éditeur.

## Structure (monorepo pnpm)
- `src-tauri/` (Rust : `supervisor/`, `git/`, `fs/`, `usage/`, `terminal/`, `store/`, `tosse/`, `ipc/`)
  - `supervisor/` **implémenté** : `protocol.rs` (types serde du fil stream-json ; les sous-types `system/task_*` — `task_started`, `task_progress`, `task_updated`, `task_notification` — ont des variantes typées, ne tombent plus dans `SystemMsg::Unknown`), `transport.rs` (spawn + reader/writer/stderr), `control.rs` (canal de contrôle + gestion des permissions ; builders `interrupt_request`, `stop_task_request`, …), `model.rs` (normalisation messages UI + record `BackgroundTask` : kind Agent/Workflow/Bash/Monitor, status, agent_id ; types `WorkflowRun`/`WorkflowPhase`/`WorkflowJournal` ; variant `SessionEvent::Task`) + `assembler.rs` (normalisation + map `background_tasks` keyée `task_id` ; classification producteur Bash vs Monitor via nom de tool capté dès `content_block_start`), `session.rs` (acteur tokio par session ; `SessionCommand::StopTask` + `PendingControl::StopTask` pour l'arrêt d'une tâche de fond), `subagents.rs` (lecteurs disque des artefacts tâches de fond : transcript sous-agent, manifeste workflow `wf_<id>.json`, **journal live `subagents/workflows/wf_<id>/journal.jsonl`** et **phases du script `meta.phases`** ; `load_workflow_run`/`load_workflow_journal`/`load_workflow_phases` renvoient `Result<…, String>` — Err sur manifeste corrompu/IO remonté à l'UI, absent = `Ok(None)`/`Ok(vec)` ; lecteurs **multi-slug** via `session_dirs` car une session qui déplace son cwd via `EnterWorktree` éclate ses artefacts sur plusieurs slugs de dossier projet ; + `tasks/<id>.output`), `history.rs` factorisé : `parse_transcript_str(skip_sidechain)` (réutilisé par `subagents.rs` et `load_persisted_state`).
  - `store/` **implémenté** : `model.rs` (records de domaine, zéro SQL) + `db.rs` (struct `Store` = le SEUL service qui parle SQL ; mappe lignes ↔ records). DB ouverte dans `lib.rs` setup → `app_data_dir()/tosse.db`, managée en state Tauri. Périmètre : métadonnées only (repos + conversations + sélection active) ; messages NON persistés (restent dans les transcripts Claude). Migrations versionnées data-preserving : `SCHEMA_VERSION` pilote un runner de migrations (`const MIGRATIONS = [migrate_v1, migrate_v2, …]`, append-only, indexé par version cible ; garde-fou compile-time `assert!(MIGRATIONS.len() == SCHEMA_VERSION)`). Source de vérité = `PRAGMA user_version` (l'ancien marqueur `meta.schema_version` n'est plus écrit). `migrate()` amorce une fois le pont legacy (`bridge_legacy_version`), puis applique chaque migration dont la cible > `user_version` **dans sa propre transaction**, avec bump `user_version` commité atomiquement. Corps de migration **idempotents** : `CREATE TABLE IF NOT EXISTS` + helper `add_column_if_absent` (`ALTER ADD COLUMN` gardé par `column_exists`) — jamais de DROP. Note : une migration NON-additive (rename/retype/drop) impose le table-rebuild SQLite avec `foreign_keys` OFF, qui est un no-op dans une transaction → toggler HORS de la transaction du runner. `wipe_all()` conservé comme escape hatch **manuel** uniquement (bouton « Tout supprimer » dans les Réglages).
  - `git/` **implémenté** : `src-tauri/src/git/mod.rs` est le SEUL service qui parle `git` (même pattern d'encapsulation que `store/db.rs`, swappable). Il enveloppe le **binaire `git` en CLI** (sous-process + parsing `--porcelain`), PAS la crate git2. Raison : sécurité de suppression déléguée à `git worktree remove` (refuse de détruire un worktree sale), parsing porcelain stable, pas de dépendance de build libgit2 pour des ops rares hors hot-path. Aucune crate ajoutée au Cargo.toml.
  - `fs/` **implémenté** : `src-tauri/src/fs/mod.rs` = le SEUL service qui parle au filesystem pour l'éditeur (même pattern swappable que `git/mod.rs` et `store/db.rs`). `read_dir` (lazy, un niveau), `read_file` (gardes binaire/trop-gros >2 Mio), `write_file`, et `FsWatcher` (Tauri managed state) = une seule watch récursive via `notify` (crate désormais réellement dépendance), debounce ~150 ms, filtre `.git/node_modules/target/dist/build/…`, émet un `FsChangeEvent` coalescé.
  - `usage/` **implémenté** : `src-tauri/src/usage/mod.rs` = SEUL service qui touche les credentials OAuth et l'endpoint d'usage (même pattern d'encapsulation que `git/mod.rs`, `fs/mod.rs` et `store/db.rs`, swappable). Réplique `GET https://api.anthropic.com/api/oauth/usage` pour obtenir le % d'usage du forfait (5h/7j) — donnée absente du stream-json. Token lu depuis `~/.claude/.credentials.json` → Keychain macOS (`/usr/bin/security`), **lecture seule** (jamais de refresh ni d'écriture de credentials).
  - `terminal/` **implémenté** : `src-tauri/src/terminal/mod.rs` = SEUL service qui parle PTY (même pattern d'encapsulation que `git/mod.rs`, `fs/mod.rs`, `usage/mod.rs`, swappable). Spawn d'un shell interactif via `portable-pty` 0.8 ; octets PTY envoyés encodés en base64 via event Tauri `TerminalOutputEvent` ; resize via la commande `terminal_resize`. Commandes IPC : `terminal_open` / `terminal_write` / `terminal_resize` / `terminal_close`. Events : `TerminalOutputEvent` / `TerminalExitEvent`. Le writer PTY est derrière un `Arc<Mutex>` mais les écritures se font **hors du lock global** (anti-hang au quit). Teardown : le shell est lancé avec `setsid` (leader de groupe) → arrêt via `kill(-pid, SIGKILL)` sur tout le groupe, même pattern anti-orphelins que le superviseur pour les process `claude`.
  - Surface IPC (tauri-specta) : commandes `spawn_session` / `send_message` / `answer_permission` / `set_permission_mode` / `interrupt_session` / `stop_session` / **`stop_task`** (arrête UNE tâche de fond par `task_id` → `control_request{stop_task}`, sans tuer la session) + persistance `load_persisted_state` / `upsert_repo` / `delete_repo` / `upsert_conversation` / `delete_conversation` / `set_active_conversation` / `wipe_all_data` + worktrees `list_worktrees` / `worktree_status` / `create_worktree` / `remove_worktree` (types `WorktreeInfo` / `WorktreeStatus`) + filesystem `read_dir` / `read_file` / `write_file` / `watch_dir` / `unwatch_dir` (types `FsEntry` / `FileContent`) + tâches de fond `load_subagent_transcript` / `load_workflow_run` / `load_workflow_journal` / `load_workflow_phases` / `read_task_output` + **`request_user_attention(critical: bool)`** (rebond Dock macOS via `window.request_user_attention(Critical|Informational)`) + **`get_plan_usage`** (retourne `Result<PlanUsage, UsageError>` typé) + terminal `terminal_open` / `terminal_write` / `terminal_resize` / `terminal_close` + **`generate_conversation_title`** (déclenche un renommage via `control_request{generate_session_title}`) + events `session_state` / `session_message` / `session_permission` / `FsChangeEvent` / **`FsWatchErrorEvent`** (erreur du backend watcher) / `session_task` (type `SessionTaskEvent` — tâches de fond en cours) / `TerminalOutputEvent` / `TerminalExitEvent` / **`SessionTitleEvent`** (nouveau titre généré par le binaire). Managed state Tauri : `Sessions`, `Store`, `FsWatcher`.
- `src/` (React : `features/{flightdeck,conversation,editor,terminal,git,explorer,settings}`, `ipc/`, `store`, `agent/`, `notifications/`, `ui/`)
  - `src/features/flightdeck/` **implémenté** : Vue Gestion d'agents (Flight Deck). Layout en swimlanes par dépôt — scroll vertical entre repos, scroll horizontal dans un repo, bandes bornées à 2 rangées. Composants : FlightDeck, StreamCard, StateBlock, StateActions, ActivityLine, AttentionBar. CSS dédié `src/ui/conductor-flightdeck.css`.
  - `src/features/editor/` **implémenté** : `editorStore.ts` (Zustand, état par conversation en mémoire ; layout en localStorage `tosse:editor` — inclut `terminalOpen: boolean` et `terminalFraction: number` pour le panneau terminal), `MonacoView.tsx` (wrapper Monaco lazy), `FileTree`, `EditorPane`, `EditorPanel`, `Splitter`, `useFsWatch`, `language.ts`, `EditorToggle`, `editor.module.css`. Layout rooté sur `effectiveCwd` (cwd live de la conversation).
  - `src/features/terminal/` **implémenté** : terminal PTY intégré dans le panneau latéral de la vue Conversation. Architecture :
    - `termManager.ts` — gestionnaire d'instances xterm **hors React** : les instances `Terminal` (xterm) sont persistantes par conversation (survivent à la fermeture du panneau et au switch de conversation) et recyclées sans reconstruction. WebGL renderer attaché une fois ; fit addon pour le resize. Clé `conv_<id>`.
    - `TerminalView.tsx` — composant React lazy (code-split, hors bundle de démarrage) ; monte/démonte le DOM du terminal sans détruire l'instance xterm.
    - `cleanup.ts` — shim de découplage : câble le nettoyage des instances xterm sur `removeConversation`, `removeRepo` et `wipeAllData` (store Zustand) sans que `termManager` ne dépende de React ni du store → les instances xterm restent hors du bundle eager.
    - `TerminalToggle.tsx` — bouton d'ouverture/fermeture du panneau terminal dans la toolbar du SidePanel.
  - `src/features/conversation/SidePanel.tsx` **implémenté** : orchestre le panneau latéral (éditeur + terminal). Gère le splitter vertical éditeur/terminal, la fraction `terminalFraction`, et le toggle `TerminalToggle`. Le terminal est lazy-loadé à la première ouverture.
  - `src/features/conversation/` — barres épinglées au-dessus du composer : `AgentBar.tsx` (sous-agents détachés `run_in_background`), **`BashBar.tsx`** (Bash de fond `run_in_background` — voir pattern « Bash de fond LIVRÉ » ci-dessous), **`MonitorBar.tsx`** (watches live de l'outil `Monitor` — voir « Monitor LIVRÉ ») et **`WorkflowBar.tsx`** (runs de l'outil `Workflow` — voir « Vue Workflows LIVRÉE »). **`TaskOutputPopover.tsx`** = moteur de tail générique partagé (poll `read_task_output`) ; `BashOutputPopover.tsx` en est un wrapper mince. `ConductorThread.tsx` (thread + `WorkingIndicator` avec l'indicateur shell live).
  - `src/features/git/` **implémenté** : indicateur worktree actif, badge sidebar, gestionnaire modale des worktrees.
  - `src/features/settings/SettingsPanel.tsx` : page Réglages désormais structurée en **rail latéral à onglets** (Général / Notifications / Mises à jour / Données), conçue pour scaler. `src/store/settingsUi.ts` porte la section active + deep-link (la bannière MAJ ouvre l'onglet « updates »). Sections : `UpdateSection`, `NotificationsSection`. **La section Général porte aussi un sous-bloc « Affichage »** (`DisplayPrefs`) avec le toggle « Clean output » (voir pattern ci-dessous).
  - `src/store/updater.ts` : auto-check au lancement + toutes les 2h, check silencieux qui enregistre quand même les échecs dans `lastCheckError`. `UpdateBanner` = bannière globale « MAJ dispo ».
  - `src/store/notifications.ts` : 3 prefs persistées localStorage (`tosse:notifications`) — `systemNotification` / `sound` / `dockBounce`, toutes ON par défaut.
  - `src/store/display.ts` : prefs d'affichage du thread persistées localStorage (`tosse:display`) — aujourd'hui `cleanOutput` (défaut OFF). Même pattern léger que `notifications.ts`. Voir pattern « Mode Clean output » ci-dessous.
  - `src/store/workFold.ts` : état déplié/replié des blocs « Travail de Claude » (clean output) mémorisé **par conversation**, keyé `convId→roundKey`, persisté localStorage (`tosse:workfold`) — survit au switch de conversation ET au redémarrage. Même pattern léger que `display.ts`. Voir pattern « Mode Clean output » ci-dessous.
  - `src/store/contextData.ts` : `useContextData`/`fmtTokens` (fenêtre de contexte), extrait du composer.
  - `src/store/activity.ts` : `describeActivity`/`useLiveActivity` — activité live de l'agent (dernier tool_use EN COURS du tour courant seulement, jamais un outil terminé) ; **`liveBashCommand`/`useLiveBashCommand`** — la commande shell FOREGROUND en cours (rendue `$ commande…` dans le WorkingIndicator).
  - `src/store/conversationsStore.ts` : `groupConversationsByRepo`/`useConversationsByRepo` (groupement par repo, partagé sidebar + Flight Deck).
  - `src/store/backgroundTasksStore.ts` : registre des tâches de fond (`applyTask`, `useSessionTasks`, `useTaskByToolUse`, `useRunningTaskCount`) + **`orderBashTasks`/`useBackgroundBashTasks`** (Bash de fond, running-first) + **`orderMonitorTasks`/`useBackgroundMonitorTasks`** (watches Monitor, running-first) + **`orderWorkflowTasks`/`useBackgroundWorkflowTasks`** (workflows, running-first).
  - `src/store/workflowLive.ts` : accumulation live de l'activité par phase d'un workflow (depuis le fil `task_progress`), purgée au statut terminal. Voir « Vue Workflows LIVRÉE ».
  - `src/store/planUsage.ts` + hook `usePlanUsage` (TanStack Query, poll 5 min + on-open throttlé + bouton de rafraîchissement manuel) — expose le % d'usage du forfait (5h/7j) via `get_plan_usage`. Intégré dans le popover du cercle de contexte (section « Forfait » avec barres % + erreurs typées actionnables).
  - `src/agent/` : modules domaine agents partagés entre Vue Conversation et Flight Deck.
    - `status.ts` : `agentStatusForEntry(handle, entry)` (forme non-hook) + `statusRank` (ordre d'affichage flotte).
    - `fleet.ts` : `useFleetAttention`/`tallyAttention` (agrégat d'attention), `useFleetLanes`/`orderLanes` (ordonnancement des bandes par état ; re-render gated via `useShallow` sur tokens d'ordre).
    - `ask.ts` : `classifyAsk` (classification d'une demande de permission), extrait de ConductorThread.
    - `subagentMeta.ts` : `shortModel`, `fmtDuration`, `taskStatusDot`, `resolveAgentId`, **`isRunInBackground`** (détection générique `run_in_background:true` ; `isBackgroundAgentInput` délègue), **`isDetachedAgentAck`** (détecte l'ACK de lancement d'un sous-agent détaché ; voir pattern « Outil sous-agent Agent »), et **`runIdFromResult`** (parse le `runId` `wf_…` du tool_result d'un `Workflow`).
  - `src/notifications/` (nouveau dossier) :
    - `notify.ts` — dispatcher des notifs agent : initialise la permission OS, supprime la notif si la conv est déjà au premier plan, supprime le « terminé » post-interruption.
    - `sound.ts` — carillon synthétisé Web Audio, zéro asset externe.
    - `transition.ts` — fonction pure `agentEventFor` : décide la notif à émettre à partir des transitions d'état (`awaiting_permission` false→true = attention ; `busy` true→false (vivant) = terminé).
  - `src/ui/Toggle.tsx` : composant réutilisable interrupteur (`role=switch`).
  - `src/ui/kit.tsx` : primitives partagées `ContextMeter` (barre de contexte + %) et `TodoPips` (pips d'avancement des todos).
  - `src/ipc/useWorktrees.ts` : hook TanStack Query pour les commandes worktree IPC.
- `packages/ipc-types/` (types générés Rust→TS)

## Spec & fixtures
- Spec autoritaire du protocole stream-json (v2.1.178) : `docs/claude-code-protocol.md`
- Fixture de non-régression : `src-tauri/src/supervisor/fixtures/capture_text.jsonl` — à re-capturer à chaque upgrade du binaire `claude`.

## Patterns établis
- Normalisation côté Rust : l'UI est « bête » (reçoit des events déjà normalisés, ne reconstruit rien).
- Session bidirectionnelle persistante : un process `claude` vit toute la session, SANS flag `-p`.
- Acteur mono-tâche par session : pas de mutex partagé entre sessions (isolation tokio).
- Persistance encapsulée : un seul service (`store::db::Store`) parle SQL ; le reste du cœur et l'IPC ne manipulent que des records de domaine → changer de moteur/schéma = réécrire `db.rs` uniquement. Le schéma évolue via un runner de migrations versionnées (gate `PRAGMA user_version`, corps idempotents append-only, data-preserving) — plus de wipe-and-recreate sur changement de schéma. Note : une migration NON-additive (rename/retype/drop) impose le table-rebuild SQLite avec `foreign_keys` OFF hors transaction.
- **Git encapsulé** (même pattern) : `git::mod` est le seul point d'entrée pour toutes les ops git → swappable sans toucher à l'IPC ni au front.
- **Fs encapsulé** (même pattern que git/store) : `fs::mod` est le seul point d'entrée filesystem de l'éditeur → swappable sans toucher IPC ni front.
- **Usage encapsulé** (même pattern que git/fs/store) : `usage::mod` est le seul point d'entrée pour les credentials OAuth et l'API d'usage → swappable sans toucher à l'IPC ni au front. Lecture seule des credentials, jamais d'écriture.
- **Terminal encapsulé** (même pattern que git/fs/usage/store) : `terminal::mod` est le seul point d'entrée PTY → swappable sans toucher à l'IPC ni au front. Invariants à ne PAS régresser : (1) writer PTY hors du lock global (anti-hang au quit) ; (2) teardown tue le GROUPE de process (`kill(-pid)`, shell = leader `setsid`) — anti-orphelins, même logique que le superviseur pour `claude` ; (3) instances xterm **persistantes par conversation** (survivent fermeture panneau + switch conv) — gérées par `termManager.ts` hors React ; (4) `TerminalView` et Monaco **lazy-loadés** (hors bundle de démarrage, code-split) ; (5) nettoyage des instances xterm câblé via `cleanup.ts` (shim) sur `removeConversation`/`removeRepo`/`wipeAllData` — maintient xterm hors du bundle eager.
- Identité de conversation : l'**id stable** (UUID, PK persistée) est distinct du **handle de session live** (`session-N`, en mémoire, non persisté, remappé à chaque resume). Le front est keyé par **id stable** pour toutes les LECTURES (message store, état, timeline, composants) ; le **handle** (`session-N`) n'est résolu qu'au moment d'envoyer une commande au process vivant. Le routeur d'events (`useGlobalSessionEvents`) mappe `handle → id stable` (les events live restent keyés par handle côté cœur Rust). Le handle est libéré sur `state.ended` ; un renvoi re-spawne.
- Spawn **paresseux** (lazy) : aucun process `claude` n'est lancé au démarrage ni à la sélection d'une conversation. L'historique se lit du transcript on-disk (`loadSessionHistory`, pur I/O). Le process est spawné à la volée au **1er message** (`ensureConversationSession`, avec `--resume` si `sessionId`).
- Teardown **sans orphelins** : chaque `claude` tourne dans son propre groupe de process (`process_group(0)`, Unix). L'arrêt signale tout le groupe (`kill(-pid, …)`) selon l'échelle EOF → SIGTERM → SIGKILL, avec balayage SIGKILL final sur tous les chemins. Kill-all au quit : on attend que le registre `Sessions` se vide (borné). Dépendance `libc` (cfg unix). `stop_session` tue le process (≠ `interrupt_session`, qui ne stoppe que le tour ; ≠ `stop_task`, qui n'arrête qu'UNE tâche de fond).
- **Outils worktree natifs de Claude Code** (`EnterWorktree` / `ExitWorktree`) visibles dans `system/init.tools` — l'app les INTERCEPTE : détection des `tool_use` dans `useGlobalSessionEvents` → rafraîchit la liste des worktrees côté UI. Le `cwd` d'une conversation N'EST PAS figé ; l'UI suit le `cwd` live via `SessionStatePayload.cwd`.
- **Convention d'emplacement des worktrees** créés par l'app : `.claude/worktrees/<branche>` (dans le worktree principal, aligné sur le comportement de l'outil natif `EnterWorktree`).
- **Association conversation↔worktree** par le `cwd` : résolution longest-prefix côté front.
- **Éditeur rooté sur `effectiveCwd`** : arborescence + watch suivent le cwd live (EnterWorktree/ExitWorktree) ; marche aussi avant tout spawn `claude` (lecture disque pure). Après redémarrage de l'app, le `liveCwd` worktree d'une conversation est **rehydraté depuis son transcript** (`worktreeCwdFromTranscript`, dans `src/features/git/worktree.ts`) lors du chargement de l'historique — NE PAS le persister en SQLite (évite une migration de schéma ; `conv.cwd` reste l'ancre du `--resume`, ne pas le repointer vers le worktree).
- **Une seule watch fs active** à la fois (cwd de la conversation affichée), debounced + filtrée.
- **État éditeur par conversation en mémoire** ; seules les prefs de layout persistées en localStorage `tosse:editor` (inclut `terminalOpen` et `terminalFraction`) — PAS en SQLite (évite la migration de schéma, cohérent avec « messages non persistés »).
- **Politique de conflit fichier ouvert** : buffer propre → reload live ; buffer sale → garde les modifs + bandeau « modifié sur le disque ». Autosave debounced + Cmd+S.
- **Détection des transitions d'état agent** : point UNIQUE dans `useGlobalSessionEvents.ts` (`onState`) via `agentEventFor` (`transition.ts`, fonction pure). Règles : `awaiting_permission` false→true = attention requise ; `busy` true→false (vivant) = terminé. À factoriser pour la future Vue Gestion d'agents — ne PAS dupliquer cette détection ailleurs.
- **Raccourcis clavier** : ⌘1 (Conversation) / ⌘2 (Flight Deck) / **⌘Z (annuler la dernière suppression de conversation)** dans `App.tsx`, décidés par des helpers purs/testables dans `src/ui/shortcuts.ts` (`viewForShortcut` / `isUndoChord` / `isEditableTarget`). **Robustesse AZERTY — la règle dépend du TYPE de touche** : un **chiffre** se matche sur `e.code` (sur AZERTY les chiffres sont en position Shift → `e.key` renvoie un symbole « & »/« é »…) ; une **lettre** se matche sur `e.key` (`e.code` désigne la position QWERTY, et le « z » d'AZERTY est à `code:"KeyW"` → matcher `e.code==="KeyZ"` raterait la touche que l'utilisateur lit comme Z). Donc ⌘1/⌘2 → `e.code`, ⌘Z → `e.key`. Le ⌘Z d'annulation **bail** si le focus est dans une zone à undo propre (input/textarea/contenteditable, Monaco `.monaco-editor`, xterm `.xterm`).
- **Outil sous-agent `Agent` (alias `Task`)** : l'outil lancé par Claude Code pour les sous-agents est nommé `Agent` côté front ; l'alias `Task` est conservé pour compatibilité. La classification du producteur (Bash vs Monitor vs Agent) est faite côté Rust à partir du nom de tool, capté dès `content_block_start`. **Background vs foreground d'un sous-agent** : distingué UNIQUEMENT par `input.run_in_background` (le cycle `task_*` est émis par les DEUX — un foreground émet aussi `task_started`/`task_notification`). Un raté transitoire du binaire peut livrer le bloc `tool_use` live SANS le flag → il s'afficherait en carte foreground inline au lieu d'aller dans l'AgentBar. 2e signal de secours : l'ACK de lancement détaché du `tool_result` (`isDetachedAgentAck`, `subagentMeta.ts` — exige **≥2 marqueurs machine quasi-uniques** : « Async agent launched successfully » / `output_file: …/tasks/….output` / « notified automatically when it completes »), consommé dans le reducer `tool_result` (`conversationStore.ts` → `isDetachedAgentByAck`, **fail-safe** : ne folde jamais un bloc non confirmé `Agent`/`Task`) → ajoute le tool_use_id à **`bgAgentIds`**, source UNIQUE alimentant l'AgentBar ET le masquage inline (`groupBlocks(blocks, false, bgSet)` + garde `SubAgentCard`). ⚠️ Détection TEXTUELLE + `bgAgentIds` monotone + AgentBar running-only : un FAUX POSITIF sur la sortie finale d'un sous-agent FOREGROUND masquerait silencieusement sa carte + son transcript (perte de contenu) — d'où l'exigence ≥2 marqueurs + le fail-safe. **L'AgentBar (`AgentBar.tsx`) porte un bouton Stop par ligne** (`useStopTask` → `stop_task`), comme BashBar/MonitorBar.
- **Tâches de fond — séparation socle/UI** : `supervisor/` expose les briques (event `session_task`, commandes de lecture des artefacts disque). La consommation UI (vues Agent/Monitor/Workflow/Bash-bg) est déléguée aux tâches débloquées — ne PAS implémenter de logique de rendu dans `supervisor/`.
  - **Bash de fond LIVRÉ** (`run_in_background`) : `src/features/conversation/BashBar.tsx` = barre épinglée des Bash de fond (running + terminés), mirror d'`AgentBar` ; `BashOutputPopover.tsx` = tail live de `tasks/<id>.output` (poll `read_task_output` tant que running, réutilise le CSS du TranscriptPopover) ; bouton Stop (`useStopTask` → commande `stop_task`). Sélecteur `orderBashTasks`/`useBackgroundBashTasks` (`store/backgroundTasksStore.ts`, kind="bash", running-first). **Indicateur shell live (registre 1)** : `liveBashCommand`/`useLiveBashCommand` (`store/activity.ts`) → rendu `$ commande…` dans le `WorkingIndicator` quand un Bash FOREGROUND tourne. La carte inline d'un Bash détaché est supprimée sur l'INPUT seul (`isRunInBackground`, `subagentMeta.ts`), aligné sur `SubAgentCard`. Tâches live-only (pas de replay au resume), comme `AgentBar`.
  - **Monitor LIVRÉ** (outil `Monitor`, watches live de fond) : `src/features/conversation/MonitorBar.tsx` = barre épinglée des watches EN COURS (running-only ; un watch terminé/stoppé sort de la barre), mirror de `BashBar` au look distinct (icône `pulse` + tag « surveillance » + RunDots), bouton Stop (`useStopTask` → `stop_task`). **Le flux d'événements (1 ligne stdout = 1 event) N'EST PAS sur le fil** → tailé sur disque via `read_task_output` (`tasks/<id>.output`). Rendu par **`TaskOutputPopover.tsx`** = moteur de tail générique EXTRAIT, désormais partagé : `BashOutputPopover` devient un wrapper mince (prop `titleMono` : monospace `$ cmd` pour Bash, libellé prose proportionnel pour Monitor). Carte inline du Monitor supprimée (`ConductorThread` AssistantBlocks : `b.name==="Monitor"` → `null`) — toujours une tâche de fond, surfacée seulement dans la barre. Sélecteur `orderMonitorTasks`/`useBackgroundMonitorTasks` (kind="monitor", running-first) + tests. Live-only (pas de replay au resume), comme `BashBar`. **Zéro changement Rust** : le socle classe déjà `kind="monitor"` (via nom de tool) et `read_task_output` sert Bash-bg ET Monitor.
  - **Vue Workflows LIVRÉE** (outil `Workflow`, runs d'orchestration multi-agents façon `/workflows` de la CLI) : `WorkflowBar.tsx` (barre épinglée RUNNING-ONLY, comme les autres barres) + `WorkflowCard.tsx` (pastille inline **PERSISTANTE** dans le fil — segment `workflow` dans `toolGroup.ts`, rendu via `ConductorThread.renderSegments` ; survit au resume car le `runId` est parsé du tool_result PERSISTÉ + le manifeste est sur disque) + `WorkflowDetail.tsx` (modale : **vue d'ensemble LIVE** pendant le run = étapes du script + étape courante + 3 cases colorées lancés/en cours/terminés + done/total par étape ; puis **rapport RICHE** à la fin = phases → agents+métriques → transcript, réutilise `SubAgentTranscript` verbatim). `workflowModel.ts` (parse le manifeste en phases/agents, préserve les phases homonymes), `store/workflowLive.ts` (accumule `task_progress` par phase, purgé au statut terminal), `runIdFromResult` (`subagentMeta.ts`). Drill workflow aussi dans le Flight Deck (`BackgroundTaskBadge`). **VÉRITÉ TERRAIN CORRIGÉE (≠ ce que supposait la fiche/spec)** : le manifeste riche `wf_<id>.json` n'est écrit qu'à la **FIN** du run. Pendant le run, les seules sources sont : (1) le fil `task_progress` = « <phase>: <label> » (1 par agent lancé) ; (2) `subagents/workflows/wf_<id>/journal.jsonl` (started/result par agentId → COUNTS globaux) ; (3) le **script `workflows/scripts/…-<run_id>.js`** (`meta.phases`, écrit à t=0 → SEULE source des étapes À VENIR, parsé en Rust par un scan string-aware). Le mapping agentId↔phase n'existe PAS en live (seulement dans le manifeste final) → les compteurs PAR ÉTAPE sont **approximatifs** en live (le fan-out d'agents homonymes est sous-compté), exacts dans le rapport post-run. La barre est live-only au resume ; la carte inline, elle, persiste.
- **Renommage automatique du titre de conversation** : piloté par un `control_request{generate_session_title}` envoyé au binaire `claude` sur les premiers messages (contexte cumulé). Le titre est généré par un appel auxiliaire au petit modèle (Haiku), hors-conversation (ne touche pas au transcript ni au contexte Opus). Protection côté front : `seq` monotone comme garde d'ordre (ignore les réponses hors-ordre) + flag "titre custom" en mémoire (pas de colonne SQL, cohérent avec la politique « pas de migration de schéma »).
- **Surfaçage d'erreur unifié** : toute erreur (cœur Rust, IPC, protocole, process `claude`, front) doit être VISIBLE dans la vue conversation — jamais juste `eprintln`/`console.error`. Canal : `ConversationItem::Notice` (rendu `NoticeRow`) + `addErrorTurn` (rendu `MsgError`). Subtypes `Notice` d'erreur normalisés : `control_error`, `process_exited`, `send_failed`, `protocol_error`, `permission_error`, `history_error`, + générique `error` (detail `{message, detail?, stderr?, exit_code?, signal?}`). Front : map `NOTICE_ERROR_HEADINGS` (subtype→en-tête FR) + composant unique `ErrorBlock` (bulle `role=alert` + « Détails techniques » repliable) partagé par `MsgError`/`NoticeRow`/`TurnResultRow` (ce dernier rend ENFIN un `turn_result` en erreur, en-tête typé via `api_error_status`/`subtype`). Helpers : `SessionCore::emit_error_notice` (cœur), `emit_logged` (IPC, remplace `let _ = ev.emit`). Mort du process `claude` : `transport.rs` capture stderr (tail borné) + exit code/signal + EOF-vs-IO ; `session::run_actor` distingue mort spontanée vs Shutdown → émet `process_exited` avant `ended`. Erreurs systémiques (boot `loadPersistedState`, SQL `syncToCore`, historique, fs watcher, `open_in_terminal`) → infra bannière app-level `src/store/appErrors.ts` (`useAppErrors`, dédup par message) + `src/ui/AppErrorBanner.tsx` (slot `banner` de `App.tsx`, à côté d'`UpdateBanner`). Event `FsWatchErrorEvent` (émis par `fs/mod.rs` sur erreur backend notify, consommé par `useFsWatch`). `history.rs` : ligne de transcript corrompue/illisible → Notice `history_error` injecté dans la timeline (via `applyItem`, zéro changement de contrat IPC) ; `parse_transcript_str` renvoie `(items, skipped)`. **Lecteurs disque WORKFLOW** (`load_workflow_run`/`load_workflow_journal`/`load_workflow_phases`) renvoient `Result<…, String>` : un manifeste/journal/script CORROMPU ou en erreur IO remonte un `Err` (manifeste → corps « Manifeste illisible » de la modale ; journal/phases → bannière app-level), tandis qu'« absent » reste `Ok(None)`/`Ok(vec)` (normal) — plus jamais « introuvable » trompeur sur une vraie panne. **Périmètre encore exclu** : lecteurs disque `subagents.rs` côté SOUS-AGENT/Monitor (loggent en interne, surfaçage à traiter lors de leurs vues) ; inconnus forward-compat (`SystemMsg::Unknown`, control non supportés hooks/mcp/dialogs, rejet `generate_session_title`) → loggés via `tracing`, NON remontés au thread (bruit, pas signal).
- **Rendu groupé de l'output de conversation LIVRÉ** : les `tool_use` consécutifs **non interrompus par un message texte de l'agent** sont coalescés en **sections d'étapes dépliables** (façon claude.ai/code — référence retenue ; PAS l'extension VS Code). Le regroupement traverse les **messages assistant** : `planTimelineRender`/`useTimelineRender` (store) groupe les tours assistant consécutifs de la timeline, `useGroupBlocks` concatène leurs blocs, rendus par **`<MsgAIGroup>`** sous **un seul avatar** (toute la réponse de l'agent en un flux). `toolGroup.ts` = regroupement PUR + libellés + résumés (testé) ; `ToolSection.tsx` = composants section/étape/détail, partagés VERBATIM par `ConductorThread` (live) et `SubAgentTranscript` (disque). Dépli à 2 niveaux (section → ligne d'étape → détail). En-têtes d'action **DÉTERMINISTES (zéro LLM)** via `runHeader` (« Read · Search · Find », « Run ×3 », ou libellé complet pour 1 étape) ; libellés d'outils en **anglais** via `toolActivityLabel`, partagés avec l'indicateur live (`describeActivity`). **Le run EN COURS du tour actif s'affiche DÉPLIÉ et live** (chaque étape : spinner vert → résultat/sortie) puis **se replie** en en-tête une fois le tour terminé (signal `live = busy && !awaiting && turn.status==="streaming"` ; prop `active` qui gate le spinner pour ne pas faire clignoter un tour passé). **Sous-agents NON groupés** : rendus **inline** (`SubAgentCard`, lifecycle live + drill-in), jamais masqués ; **Workflow** = aussi son propre segment inline (`WorkflowCard`). Détail Edit/Write = `DiffView` LCS existant (**Monaco DiffEditor = follow-up**, non câblé). **UI volontairement discrète** : la section n'est PAS une carte (ligne atténuée ; au déplié un fin filet d'indentation à gauche, pas d'encadré) ; **chevrons** gauche (replié) → bas (déplié), sur sections et étapes. Sur une ligne d'étape : **clic sur la box = déplie le détail, clic sur le NOM de fichier = ouvre le fichier** (`MentionPathChip`, `stopPropagation`). Sélecteur `useRunErrored` (erreur dans un run → section auto-dépliée). CSS `.cv-steps`/`.cv-step` dans `conductor-conversation.css`.
- **Rendu recherche web LIVRÉ** (`WebSearch` / `WebFetch`) : détail dédié `src/features/conversation/WebSources.tsx` — `ToolDetail` (`ToolSection.tsx`) y route **seulement si `!result.isError`** (un résultat en erreur retombe sur `ToolResultBody`, avec son style d'erreur ; pas de fausse source verte). WebSearch → liste de sources cliquables (`SourceChip` : favicon Google S2 lazy + fallback Globe, ouverture externe via `openUrl`/plugin opener — capability `opener:default`) + résumé markdown ; WebFetch → chip de la source (`input.url`) + page markdown ; corps markdown **clampé** via `<Expandable>` (« Voir plus », comme les autres outputs). Parser PUR testé `webResults.ts` (`parseWebSearch`/`hostOf`/`faviconUrl`) : le `tool_result` est une **string** non structurée — WebSearch = `Links:[{title,url}]` (scanner JSON string-aware pour crochets/quotes échappées ; **pas de snippet** par lien ; tableau vide = autorité → 0 source, jamais le scaffolding `Links: []`), WebFetch = markdown. **Zéro changement Rust / IPC** : `assembler.rs` clone déjà le `content` brut (non aplati) → le front reçoit tout ; fixture de non-régression `src-tauri/src/supervisor/fixtures/capture_websearch.jsonl` + test `preserves_web_tool_result_content_verbatim`. Live : libellé WebFetch `Fetch <hôte>` tronqué (`activity.ts`) ; glyphe d'étape WebFetch = `globe` (`toolGroup.ts`, cohérent avec `toolMeta`). CSS `.cv-web`/`.cv-src*`. **Limites assumées** : les liens d'une WebSearch n'arrivent que dans le `tool_result` final (non streamés) → pas de « sites en live » pour WebSearch ; favicons via Google S2 = l'hôte consulté fuite vers Google au déploiement du détail (tradeoff accepté, lazy + cache → 1 requête/hôte).
- **Mode « Clean output » LIVRÉ** (option d'affichage du thread, défaut OFF) : pref globale `src/store/display.ts` (`cleanOutput`, persistée localStorage `tosse:display`) ; toggles miroir = chip « Clean output » du composer (`ConductorComposer.tsx`) + Réglages → Général → Affichage (`DisplayPrefs` dans `SettingsPanel.tsx`). Quand ON, replie **PAR ROUND** (pas globalement) tout le travail intermédiaire de Claude derrière UN bloc repliable `ClaudeWorkBlock` (« Travail de Claude · N étapes ») dans `ConductorThread.tsx` ; seul le **MESSAGE FINAL** du round (dernier(s) segment(s) `text`) reste en clair. Helpers PURS testés (`toolGroup.ts`, à côté de `groupBlocks`/`runHeader`) : `splitFinalMessage` (sépare travail vs message final), `countWorkSteps`, et le modèle d'atomes `flattenWork`/`atomsToSegments`/`liveVisibleStart` (flatten work en atomes → split par running+fenêtre → reconstruction segments avec clés stables PRÉFIXÉES « fold »/« vis » pour ne pas remonter une section quand la frontière glisse). **LIVE = règle conjointe portée par le SEUL tour live** (`CleanBlocks`, abonné aux `toolResults` du store ET au statut des tâches de fond → ne re-render que le tour live, pas les tours passés) : (a) fenêtre glissante des 3 dernières étapes visibles + (b) toute commande EN COURS d'exécution reste affichée live **MÊME au-delà de la fenêtre**, puis se replie une fois finie ; à la **FIN DU TOUR** (`!live`) tout se regroupe dans le bloc (sous-agents inclus), seul le message final dehors. Cas : que du texte (aucun outil) → pas de bloc ; round finissant sur des outils SANS texte final → rendu normal (non replié). **Rendu interne du bloc IDENTIQUE au thread classique** (mêmes composants `renderSegments`), juste décalé derrière le fold. **Invariant liveness du repli** (`atomStillRunning` dans `toolGroup.ts`, helper pur testé) : « cet outil est-il encore en cours ? » se décide via le MÊME signal que la carte `SubAgentCard` et les barres épinglées — quand un `BackgroundTask` existe pour le tool_use, SON statut fait autorité (`running` → reste visible, statut terminal → repliable) ; sinon fallback `!tool_result` (outils foreground qui ne créent pas de task : Bash/Read…). NE PAS keyer la complétion d'un sous-agent sur le seul `tool_result` : l'`Agent` tool_result peut arriver AVANT le `task_notification` terminal (la carte montrerait encore le point « running » alors que le repli avalerait le sous-agent en plein run). Repli et carte deviennent cohérents PAR CONSTRUCTION, quel que soit l'ordre des events. **Erreurs dans le bloc DÉ-EMPHASÉES** via `WorkBlockContext` (créé dans `ToolSection.tsx`, fourni par `ClaudeWorkBlock`) : header du bloc NEUTRE (zéro pastille/rouge), à l'intérieur pas d'auto-dépliage ni de texte rouge, pastille « Attention » conservée UNIQUEMENT sur la section de commande (`cv-steps-errico`) + la ligne d'étape (`cv-step-errico`) ; invariant « erreurs jamais cachées » préservé HORS du bloc (Notice/turn_result/activité live gardent auto-dépliage + rouge). **Scroll** : `useStickToBottom(convId, preserveKey)` ré-ancre la position quand un toggle change fortement la hauteur du thread (ancre l'élément en haut du viewport — capture coalescée rAF sur scroll ; fallback distance-au-bas ; pin-bas si on suivait le bas), câblé via `ConversationPane` avec `preserveKey = cleanOutput`. Le mode ne s'applique PAS au transcript des sous-agents (drill-down), seulement au thread principal. **État déplié/replié MÉMORISÉ par conversation** (survit au switch ET au redémarrage de l'app) : store dédié `src/store/workFold.ts` (localStorage `tosse:workfold`, keyé `convId→roundKey` où roundKey = 1er turnId du groupe assistant `MsgAIGroup`, stable au switch/reload) ; `ClaudeWorkBlock` persiste via props `foldConv`/`foldKey` fournies UNIQUEMENT par le thread live (le drill-down `SubAgentTranscript` garde un `useState` éphémère → clean-output non persisté côté sous-agents) ; purge câblée sur `removeConversation`/`removeRepo`/`wipeAllData` comme les autres caches UI par conversation. CSS `.cv-work*` dans `conductor-conversation.css`.
- **Rendu des messages spéciaux injectés LIVRÉ** (`<task-notification>` émis en fin de tâche/agent de fond) : le binaire `claude` injecte ces blocs comme un simple `user_message` dont le `text` est le bloc XML brut (même mécanisme d'injection que « while you were working ») → ils transitent par le rendu texte user et sont interceptés au **point unique `UserText`** (comme les slash-commands). Rendu en carte via **`SpecialMessageCard.tsx`** (PURE, zéro lecture de store → réutilisée VERBATIM par `MsgUser` du thread live ET la ligne user de `SubAgentTranscript` = aperçu recherche d'historique + drill-in sous-agent, donc disque et live ne divergent jamais). Parser PUR + testé **`specialMessage.ts`** : `parseSpecialMessage` (union taguée extensible `SpecialMessage`) + `taskNotificationStyle` (statut→icône/tone/label FR) ; extraction robuste du `result` (premier `<result>` → DERNIER `</result>`, tolère chevrons/tags imbriqués) + `usage` (subagent_tokens/tool_uses/duration_ms). **Garde anti-faux-positif DÉCISIVE** : le parser ne se déclenche QUE si le texte trimmé **OUVRE** sur `<task-notification>` (vérité terrain : sur 370 notifs réelles persistées, 368 ouvrent sur le tag, 2 sont de la prose qui le MENTIONNE — dont un prompt d'agent). Statuts gérés : completed/failed/killed/stopped (+ fallback muted). `result` replié par défaut via `<Expandable>` (markdown). **ZÉRO changement Rust/IPC** : transformation d'AFFICHAGE seulement (le fil vu par le modèle est intact ; pas de nouveau type d'item, pas de bindings à regénérer). CSS `.cv-tasknote*` dans `conductor-conversation.css`. Follow-up assumé : carte gardée PURE → pas de drill-in cliquable vers le `BackgroundTask` vivant via `task-id` (l'id est affiché mais non lié à l'AgentBar/BackgroundTask).
- **Remote control (bridge natif `/remote-control`) LIVRÉ** : activer une conversation en bridge vers claude.ai/code + l'app mobile Claude, entièrement via le **canal de contrôle stream-json** (pas de terminal — faisabilité tranchée en disséquant l'extension VS Code, même transport que nous). Wire : `control_request{subtype:"remote_control", enabled:bool, name?:string}` → `control_response{subtype:"success", response:{session_url, connect_url}}` (doublement niché `response.response`, comme `mcp_authenticate` ; `session_url` = lien claude.ai/code) ; désactivation `enabled:false`. Santé : `system/bridge_state{state:"disconnected"|"error", detail?}` — **DÉGRADE seulement**, "connected" ne vient QUE de la réponse au control_request. **Sync live tél→Mac** : spawn avec **`--replay-user-messages` (INCONDITIONNEL, comme l'extension)** — sans lui le binaire n'émet AUCUNE ligne `user` sur stdout (ni les nôtres ni les distantes) ; avec, il ré-émet chaque tour user avec `isReplay:true`. On **estampille chaque message qu'on envoie d'un uuid** (crate `uuid` v4, dans l'enveloppe `user_message`) et on **supprime l'écho de NOS propres tours par uuid** (`assembler.sent_user_uuids`, consommation one-shot) ; un tour distant (uuid inconnu) est surfacé, un `isMeta:true` est filtré. **Ordonnancement** (réplique du `replayInsertIndex` de l'extension) : ancre `SessionEntry.replayAnchor` (front) — **splice à l'ancre** pour un replay LIVE (`ConversationItem::UserMessage.replay=true`), **APPEND** pour l'historique (`replay=false`) ; ré-ancrage à `turn_result`, après hydratation d'historique (`reanchorReplay`), et sur envoi local/erreur. ⚠️ Distinguer live vs historique est **OBLIGATOIRE** : `history.rs` n'émet pas de `turn_result`, donc splicer l'historique regrouperait tous les tours user en haut (régression attrapée en revue adversariale). État remote-control **live-only** (`src/store/remoteControl.ts`, non persisté, keyé par convId, nettoyé sur `ended` + stop/remove/removeRepo/wipe). **Zéro erreur silencieuse** : rejets de bridge (policy org / succès sans `session_url`) remontés dans le fil (`addErrorTurn`, ack + event async) ; échec « copier le lien » → bannière `useAppErrors`. Cœur : `control::remote_control_request`/`parse_remote_control`, `SystemMsg::BridgeState`, `UserMsg.is_replay`, `SessionCommand::SetRemoteControl` (canal oneshot façon `mcp_authenticate`), `SessionEvent::RemoteControl`. IPC : commande `set_remote_control` + event `SessionRemoteControlEvent`. UI : `RemoteControlChip.tsx` (chip composer **icône-seule**, état connecté = point **vert** `.wf-dot run`, menu ouvrir/copier/désactiver aligné à droite) ; `ChipBtn` (kit.tsx) fusionne désormais `className` au lieu de l'écraser. Crate ajoutée : **`uuid` (feature v4)**.

## Commandes dev

Rust (depuis `src-tauri/`, cargo dans `~/.cargo/bin`) :
- Tests unitaires : `cargo test --lib`
- Tests live (spawn réel de `claude`, ignorés par défaut) : `cargo test --lib -- --ignored --nocapture`

Front TypeScript :
- Typecheck : `node_modules/.bin/tsc --noEmit`
- Build : `pnpm build`
- **Tests unitaires front** : `pnpm test` (= `vitest run` ; tests co-localisés `*.test.ts`)

Bindings IPC : regénérés automatiquement au build debug et via le test `export_bindings_regenerates_ts_client` (tauri-specta).

**Infra de test front** : `vitest` + `jsdom` ajoutés en devDeps. La **CI** (`.github/workflows/ci.yml`) exécute une étape « Tests unitaires front (vitest) » (`pnpm test`) en plus du build front et de `cargo test --lib` ; rappel : la CI ne tourne qu'à la PR vers `main`.

## Builds de test locaux (dev)

Alexandre **dogfoode** : il code ce projet en se servant de l'app **de production** installée dans `/Applications/Tosse Code.app` (identifiant `com.tosse.desktop`, `productName` « Tosse Code ») — c'est son outil de travail quotidien, et ses vraies conversations vivent dans la base de cette app.

⚠️ **Piège à connaître** : `tauri dev` ET `tauri build` réutilisent par défaut le MÊME `identifier` (`com.tosse.desktop`) → la MÊME base SQLite (`~/Library/Application Support/com.tosse.desktop/`). Un build de test lancé tel quel **écrase / pollue les données de l'app de prod** (vécu : un wipe pour réinstaller proprement la prod a aussi vidé l'environnement dev, car base partagée).

**Règle pour tout build de test** : lui donner un **nom ET un identifiant DISTINCTS** de la prod — jamais les mêmes. Ex. `productName: "Tosse Code Test"` + `identifier: "com.tosse.desktop.test"` → bundle séparé (`Tosse Code Test.app`) + dossier de données séparé → zéro conflit avec la prod, zéro risque pour les conversations réelles.
- Mécanisme propre : override **au moment du build** via `tauri build --config` (overlay JSON `productName`/`identifier`), SANS modifier le `tauri.conf.json` committé (qui reste la config prod).
- Fichier de référence versionné : `src-tauri/dev-build.conf.json` (`productName` "Tosse Code dev build", `identifier` `com.tosse.desktop.dev`).
- Les artefacts de test restent dans la sortie de build (`src-tauri/target/release/bundle/{dmg,macos}/`) ou un dossier dédié hors du chemin de la prod — mais l'important est le **nom/identifiant distinct**, pas seulement le dossier.
- Outiller ça proprement (script/skill « test build ») pourra faire l'objet d'une tâche.

## Branches & gouvernance

Repo **public** (`github.com/Alex375/tosse-code`). Deux branches :
- **`main`** — branche propre, **protégée**. **AUCUN push direct** : tout passe par PR. La PR doit (1) avoir le check **`test`** vert (workflow `.github/workflows/ci.yml`), (2) être approuvée par le **code owner** `@Alex375` (`.github/CODEOWNERS` ; l'approbation de quelqu'un d'autre ne suffit pas), (3) avoir ses conversations résolues. Force-push & suppression interdits.
- **`dev`** — branche de travail. Push libre. **Pas de CI sur push dev** (les tests tournent à la PR vers main, pas avant).

**Flux de travail** : bosser sur `dev` (ou des branches de feature → `dev`) → ouvrir une PR **`dev → main`** quand c'est mûr → la CI (`test`) se lance **sur la PR** → Alexandre approuve + merge. Les releases se coupent depuis `main` (workflow Release manuel, ci-dessous).

`enforce_admins=false` : GitHub interdit d'approuver sa propre PR ; comme Alexandre est le seul validateur (code owner), l'admin doit pouvoir merger ses propres PR → enforcement admin OFF. Conséquence : Alexandre (admin) peut contourner ; tout autre collaborateur reste gated derrière son approbation.

**Accès** : `Alex375` (admin), `clousty8`/Armand (write — peut pousser sur `dev` et ouvrir des PR ; ne peut PAS merger dans `main` sans l'approbation d'Alexandre, ni produire de release car le job `authorize` n'autorise que `Alex375`).

⚠️ Pour les agents : **ne jamais `git push origin main` en direct** — committer sur `dev` (ou une branche de feature) et ouvrir une PR vers `main`.

## Versioning & releases

SemVer `MAJEUR.MINEUR.CORRECTIF`. Tant qu'on est en `0.y.z` (cas actuel) : **MINEUR** pour toute nouveauté, **CORRECTIF** pour les fix ; on ne passe `1.0.0` que quand l'app est jugée stable. MAJEUR = changement incompatible (schéma SQLite sans migration, format de transcript, comportement cassé).

- **La version vit à 3 endroits, toujours synchronisés** : `src-tauri/tauri.conf.json` (**source de vérité runtime** — lue par `getVersion()`, affichée dans la page Réglages, et utilisée par le workflow pour le tag), `package.json`, `src-tauri/Cargo.toml` (+ `Cargo.lock`). Ne jamais les laisser diverger.
- **Bumper** : `pnpm bump <patch|minor|major|X.Y.Z>` (script `scripts/bump-version.mjs`) met les 4 fichiers à jour d'un coup. Puis commit `chore(release): vX.Y.Z` + push (sur `dev`, puis PR vers `main`). Ne PAS éditer les versions à la main.

### Publier une release
Workflow `.github/workflows/release.yml`, **100 % manuel** (`workflow_dispatch`, PAS de trigger sur push). À lancer depuis **`main`** (branche propre).
1. La version voulue est sur `main` (mergée via PR).
2. Actions → **Release** → Run workflow (ou `gh workflow run release.yml --ref main`).
3. La CI compile un bundle **macOS universel** (Apple Silicon + Intel) et **publie directement** (`releaseDraft: false`) la release GitHub. Assets : `.dmg` (installeur), `.app.tar.gz` + `.sig` (artefact updater signé), `latest.json` (manifeste). Plus rien à faire après.

### Sécurité (« un peu sécurisé »)
- Déclenchement : `workflow_dispatch` est lançable par tout compte en write, MAIS le job `authorize` fait que **seuls les comptes de `ALLOWED` (aujourd'hui `Alex375`) produisent une release** — tout autre déclencheur échoue AVANT le build. Ajouter Armand à `ALLOWED` au besoin.
- Garde-fou anti-doublon : refus si la version courante a déjà une release → force à bumper.
- macOS **signé self-signed** (code signing via certificat auto-signé « Tosse Code Self-Signed ») ; **PAS notarisé** (Developer ID payant écarté) → friction Gatekeeper au 1er lancement (clic droit → Ouvrir) demeure. Notarisation = chantier ultérieure.

### Signature de code macOS (self-signed → TCC)

**But** : donner à l'app une **Designated Requirement (DR) stable** (`identifier "com.tosse.desktop" and certificate leaf = H"…"`, épinglée au hash du certificat, pas au cdhash) → macOS **TCC** conserve les autorisations de dossier (Bureau/Documents/…) d'une version à l'autre sans les redemander à chaque auto-update. C'est le fix du bug « avalanche de demandes d'autorisation de dossiers ».

**Certificat** : auto-signé « Tosse Code Self-Signed » (validité ~20 ans), sauvegardé dans `~/TosseCodeSigning.p12`. ⚠️ **DR-CRITIQUE** : ne JAMAIS le réémettre (expiration, CN différent, nouvelle clé) — un nouveau cert = nouvelle DR = **re-grant TCC global pour tous les utilisateurs**. À sauvegarder hors repo avec la même discipline que la clé updater.

**Secrets repo** : `APPLE_CERTIFICATE` (base64 du .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (= CN « Tosse Code Self-Signed »). Si absents → build **non signé** (comportement historique, aucune erreur).

**`release.yml`** — étape « Configurer la signature macOS » : création d'un keychain dédié + import du .p12 + `set-key-partition-list` + **`sudo security add-trusted-cert -d … System.keychain`** (trust OBLIGATOIRE : Tauri refuse un cert self-signed non trusté — `find-identity -v` renvoie 0 identité → « failed to resolve signing identity »). L'étape build ne reçoit que `APPLE_SIGNING_IDENTITY` — **PAS `APPLE_CERTIFICATE`** (sinon Tauri refait un keychain non-trusté et échoue). tauri-action signe l'app AVANT de fabriquer l'artefact updater → la DR stable est présente dans l'artefact updater.

**`tauri.conf.json`** : `bundle.macOS.hardenedRuntime: false` — le défaut Tauri (`true`) casse le WebView sans entitlements JIT ; on ne notarise pas donc aucune raison de l'activer. **`src-tauri/Info.plist`** (mergé par Tauri au build) : `NSDesktopFolderUsageDescription`, `NSDocumentsFolderUsageDescription`, `NSDownloadsFolderUsageDescription`.

**Limites** : 1ʳᵉ MAJ signée = **1 re-grant de transition unique** (ancien bundle non-signé → signé, TCC voit une DR différente), puis stable. Builds contributeurs = non signés (identité TCC locale propre, sans impact utilisateurs).

### Auto-update in-app (implémenté — `tauri-plugin-updater` + `tauri-plugin-process`)
L'app vérifie/installe les MAJ signées depuis les releases GitHub (repo public → `latest.json` accessible sans token). Côté front : `src/store/updater.ts` (auto-check au lancement + toutes les 2h, check silencieux qui **enregistre** quand même les échecs dans `lastCheckError` → pas d'erreur silencieuse non détectable ; install = download → vérif signature → `relaunch()`), section « Mise à jour » des Réglages + `UpdateBanner`. Clé : publique dans `tauri.conf.json` (`plugins.updater.pubkey`) ; privée en secret repo `TAURI_SIGNING_PRIVATE_KEY` + backup local hors repo `~/.tauri/tosse-code-updater.key` (sans mot de passe → workflow passe `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""`). NE PAS perdre la privée (sinon plus aucune MAJ signable). `bundle.createUpdaterArtifacts: true`. NB : la MAJ ne touche QUE le bundle `.app` ; les données (base SQLite + transcripts) sont hors bundle et préservées.

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

## MVP (Phase 1) — état d'avancement

### [LIVRÉ] Stream / Conversation Claude Code
Protocole stream-json implémenté en Rust (clean-room). Session bidirectionnelle persistante, canal de contrôle, normalisation des messages, rendu React propre inspiré VS Code.

### [LIVRÉ] Éditeur de texte léger
Panneau latéral avec arborescence des fichiers + éditeur Monaco, lazy-loadé (code-split). Watch fs live, rooté sur le cwd courant (suit les worktrees).

### [LIVRÉ] Terminal
Terminal PTY intégré dans le panneau latéral via xterm.js + WebGL. Service Rust `terminal/` encapsulé (portable-pty), commandes IPC `terminal_open/write/resize/close`. Instances xterm persistantes par conversation (survivent au switch de panneau). Lazy-loadé (code-split, hors bundle de démarrage).

### [LIVRÉ] Vue Gestion d'agents (Flight Deck)
Swimlanes par dépôt, scroll vertical/horizontal, état live de chaque agent (busy/attention/idle), AttentionBar, notifs OS + son + rebond Dock.

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
- Phase 1 **complète** — les 4 livrables (Conversation, Éditeur, Terminal, Vue Gestion d'agents) sont implémentés et mergés sur dev.

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