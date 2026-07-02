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

Desktop app pour piloter Claude Code. La **vision**, le **périmètre par phases**, le **principe directeur** et les **décisions structurantes** sont au niveau du contexte projet (Tosse Code). Ici : la stack concrète et le « comment on construit ».

## Stack

- **Shell desktop** : Tauri 2 (webview de l'OS, pas de Chromium embarqué).
- **Cœur** : Rust + tokio. Superviseur de process, client du protocole Claude Code, persistance.
- **UI** : React + TypeScript + Vite, rendue dans le webview Tauri.
- **Éditeur** : Monaco (npm) — lazy-loadé / code-split (chunk éditeur + workers de langage json/css/html/ts en chunks lazy séparés → démarrage non impacté).
- **Terminal** : `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-webgl`. PTY natif côté Rust via `portable-pty` 0.8 ; octets PTY encodés en base64 sur le bus d'events Tauri (crate `base64` 0.22). Rendu WebGL côté front.
- **État UI** : Zustand (flotte d'agents, nourri par les events) + TanStack Query (commandes).
- **Crates clés** : `portable-pty` 0.8, `base64` 0.22, notify (watch fichiers), **rusqlite (bundled)** + SQLite (persistance — synchrone, WAL, foreign_keys ON ; sqlx écarté : nos écritures sont minuscules/rares/hors chemin chaud, pas besoin d'async + macros), serde_json, **tauri-specta** (contrat IPC typé Rust→TS auto-généré, jamais de resync manuelle), **reqwest** (`rustls-no-provider`) + **rustls** (`ring`) + provider crypto `ring` installé au runtime avant le 1er client HTTP, **uuid** (v4, remote control).
- **Plugins Tauri** : opener, dialog, updater + process (auto-update signé), notification (notifs OS agent). Permission `notification:default` dans `capabilities/default.json`.
- **git2** : option ouverte pour diff/status in-process côté Monaco — PAS utilisé pour les worktrees.

## Protocole Claude Code

Réimplémentation clean-room en Rust du client de l'extension VS Code officielle (disséquée, pas un fork) :
- Spawn du binaire `claude` avec `--output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio`.
- Mode **bidirectionnel persistant** (un process vit toute la session) — PAS `claude -p` (one-shot).
- Messages JSON-lines : `system`, `assistant`, `user`, `tool_use`, `tool_result`, `result`, `stream_event`.
- Canal de contrôle : `control_request` / `control_response` (sous-types : `initialize`, `can_use_tool`, `set_permission_mode`, `interrupt`, `mcp_message`, `generate_session_title`, `remote_control`, `stop_task`).
- `SessionStatePayload` contient un champ **`cwd`** capté depuis `system/init` (ré-émis à chaque tour) — source de vérité du répertoire courant. Le cwd n'est PAS figé : l'agent peut le déplacer via outils worktree.
- **Arrêt d'une tâche de fond** : wire = `control_request{subtype:"stop_task", task_id}` — le sous-type est **`stop_task`** (PAS `task_stop`, disséqué verbatim dans l'extension VS Code).
- **Remote control** : `control_request{subtype:"remote_control", enabled:bool, name?}` → `control_response{response:{session_url, connect_url}}` (doublement niché `response.response`). Bridge santé : `system/bridge_state{state:"disconnected"|"error"}` — **dégrade seulement**, "connected" ne vient QUE de la réponse au control_request. Spawn avec **`--replay-user-messages` inconditionnel** (sans lui le binaire n'émet aucune ligne `user` sur stdout) ; on estampille chaque message envoyé d'un uuid et on supprime l'écho de NOS propres tours (`assembler.sent_user_uuids`, one-shot) ; tour distant (uuid inconnu) surfacé. **Distinguer live vs historique est OBLIGATOIRE** : `history.rs` n'émet pas de `turn_result` → splicer l'historique regrouperait tous les tours user en haut (régression).

## Tools IDE exposés à l'agent (Phase 2)

`openDiff`, `openFile` (à la bonne ligne), `getCurrentSelection`, `getDiagnostics`, `getWorkspaceFolders`, `saveDocument`… → l'agent agit dans NOTRE éditeur. Non encore implémenté.

## Structure (monorepo pnpm)

- `src-tauri/` (Rust) : `supervisor/`, `git/`, `fs/`, `usage/`, `terminal/`, `store/`, `tosse/`, `ipc/`
  - `supervisor/` : `protocol.rs` (types serde + variantes typées pour `task_started/progress/updated/notification`), `transport.rs` (spawn + reader/writer/stderr), `control.rs` (canal de contrôle + permissions), `model.rs` (normalisation UI + `BackgroundTask`, `WorkflowRun/Phase/Journal`), `assembler.rs` (map `background_tasks` keyée `task_id` ; classification Bash vs Monitor vs Agent depuis nom de tool capté dès `content_block_start`), `session.rs` (acteur tokio par session), `subagents.rs` (lecteurs disque artefacts tâches de fond — **multi-slug** via `session_dirs` car une session qui déplace son cwd éclate ses artefacts sur plusieurs slugs), `history.rs` (`parse_transcript_str(skip_sidechain)` réutilisé par `subagents.rs` et `load_persisted_state`).
  - `store/` : `model.rs` (records de domaine) + `db.rs` (struct `Store` = SEUL service SQL). DB : `app_data_dir()/tosse.db`, WAL, `foreign_keys ON`. Migrations versionnées : `SCHEMA_VERSION` + runner append-only, corps **idempotents** (`CREATE TABLE IF NOT EXISTS`, helper `add_column_if_absent`). `wipe_all()` = escape hatch manuel uniquement (bouton « Tout supprimer » dans les Réglages).
  - `git/` : `src-tauri/src/git/mod.rs` = SEUL service git. Enveloppe le **binaire `git` en CLI** (PAS la crate git2 — sécurité de suppression déléguée à `git worktree remove`, parsing porcelain stable, pas de dépendance libgit2).
  - `fs/` : `src-tauri/src/fs/mod.rs` = SEUL service filesystem de l'éditeur. `read_dir`, `read_file` (garde binaire/trop-gros >2 Mio), `write_file`, `FsWatcher` (notify, debounce ~150 ms, filtre `.git/node_modules/target/dist/build/…`).
  - `usage/` : `src-tauri/src/usage/mod.rs` = SEUL service credentials OAuth + endpoint d'usage. `GET https://api.anthropic.com/api/oauth/usage` (% forfait 5h/7j). Token depuis `~/.claude/.credentials.json` → Keychain macOS (`/usr/bin/security`). **Lecture seule** (jamais de refresh ni d'écriture de credentials).
  - `terminal/` : `src-tauri/src/terminal/mod.rs` = SEUL service PTY. Invariants à ne PAS régresser : (1) writer PTY **hors du lock global** (anti-hang au quit) ; (2) teardown tue le GROUPE de process (`kill(-pid, SIGKILL)`, shell = leader `setsid`) — anti-orphelins ; (3) instances xterm **persistantes par conversation** (survivent fermeture panneau + switch conv), gérées par `termManager.ts` hors React ; (4) Monaco + TerminalView **lazy-loadés** (code-split, hors bundle de démarrage) ; (5) nettoyage xterm câblé via `cleanup.ts` sur `removeConversation`/`removeRepo`/`wipeAllData`.
  - Surface IPC (tauri-specta) : `spawn_session`, `send_message`, `answer_permission`, `set_permission_mode`, `interrupt_session`, `stop_session`, `stop_task`, `load_persisted_state`, `upsert_repo`, `delete_repo`, `upsert_conversation`, `delete_conversation`, `set_active_conversation`, `wipe_all_data`, `list_worktrees`, `worktree_status`, `create_worktree`, `remove_worktree`, `read_dir`, `read_file`, `write_file`, `watch_dir`, `unwatch_dir`, `load_subagent_transcript`, `load_workflow_run`, `load_workflow_journal`, `load_workflow_phases`, `read_task_output`, `request_user_attention(critical:bool)`, `get_plan_usage`, `terminal_open`, `terminal_write`, `terminal_resize`, `terminal_close`, `generate_conversation_title`, `set_remote_control`. Events : `session_state`, `session_message`, `session_permission`, `FsChangeEvent`, `FsWatchErrorEvent`, `session_task`, `TerminalOutputEvent`, `TerminalExitEvent`, `SessionTitleEvent`, `SessionRemoteControlEvent`.

- `src/` (React) : `features/{flightdeck,conversation,editor,terminal,git,explorer,settings}`, `ipc/`, `store/`, `agent/`, `notifications/`, `ui/`
  - `store/` clés : `conversationsStore.ts` (groupement par repo), `backgroundTasksStore.ts` (registre tâches de fond + sélecteurs Bash/Monitor/Workflow, running-first), `workflowLive.ts` (accumulation `task_progress` par phase), `planUsage.ts` (TanStack Query, poll 5 min), `notifications.ts` (3 prefs localStorage), `display.ts` (`cleanOutput` + `markdownMode`, défaut `warm`), `workFold.ts` (état déplié/replié clean-output par conv, localStorage), `remoteControl.ts` (état live-only, keyé convId), `commandsStore.ts` (catalogue slash-commands caché par cwd, localStorage), `updater.ts` (auto-check lancement + 2h), `appErrors.ts` (bannière erreurs systémiques déduplicatées).
  - `agent/` : `status.ts` (statut agent), `fleet.ts` (ordonnancement flotte), `ask.ts` (classification permission), `subagentMeta.ts` (`isRunInBackground`, `isDetachedAgentAck` (≥2 marqueurs), `runIdFromResult`).
  - `notifications/` : `notify.ts`, `sound.ts` (carillon Web Audio, zéro asset), `transition.ts` (`agentEventFor` — point UNIQUE de détection des transitions d'état agent).
  - `src/ui/` : `Toggle.tsx`, `kit.tsx` (`ContextMeter`, `TodoPips`, `ChipBtn`), `shortcuts.ts` (helpers purs, robustesse AZERTY).

- `packages/ipc-types/` (types générés Rust→TS, à committer avant PR)

## Spec & fixtures

- Spec autoritaire du protocole stream-json (v2.1.178) : `docs/claude-code-protocol.md`
- Fixture de non-régression : `src-tauri/src/supervisor/fixtures/capture_text.jsonl` — re-capturer à chaque upgrade du binaire `claude`.

## Patterns établis

**Architecture générale**
- Normalisation côté Rust : l'UI est « bête » (events déjà normalisés, ne reconstruit rien).
- Session bidirectionnelle persistante : un process `claude` vit toute la session, SANS flag `-p`.
- Acteur mono-tâche par session (isolation tokio — pas de mutex partagé entre sessions).
- **Encapsulation** (pattern uniforme) : un seul module parle à chaque ressource — `store/db.rs` (SQL), `git/mod.rs` (git), `fs/mod.rs` (filesystem éditeur), `usage/mod.rs` (credentials OAuth), `terminal/mod.rs` (PTY) → swappable sans toucher à l'IPC ni au front.
- **Schéma SQLite via migrations versionnées** : gate `PRAGMA user_version`, corps idempotents append-only (`CREATE TABLE IF NOT EXISTS`, `add_column_if_absent`). ⚠️ Migration NON-additive (rename/retype/drop) = table-rebuild avec `foreign_keys` OFF — ce toggle est un no-op DANS une transaction → le faire HORS de la transaction du runner.
- Persistance : messages NON persistés (restent dans transcripts Claude) ; seules les métadonnées (repos + conversations + sélection active) en SQLite.

**Sessions & identité**
- Identité de conversation : **id stable** (UUID, PK persistée) distinct du **handle de session live** (`session-N`, en mémoire, non persisté). Le front est keyé par id stable pour toutes les LECTURES ; le handle n'est résolu qu'à l'envoi de commandes.
- Spawn **paresseux** : aucun process `claude` au démarrage. Historique lu du transcript on-disk (`loadSessionHistory`). Process spawné à la volée au 1er message (`--resume` si `sessionId`).
- Teardown **sans orphelins** : chaque `claude` dans son propre groupe (`process_group(0)`) ; arrêt via `kill(-pid, …)` tout le groupe selon l'échelle EOF → SIGTERM → SIGKILL ; kill-all au quit (attend que le registre `Sessions` se vide, borné).

**Worktrees**
- Outils natifs `EnterWorktree` / `ExitWorktree` interceptés dans `useGlobalSessionEvents` → rafraîchit la liste UI. Le cwd n'est PAS figé.
- Convention emplacement : `.claude/worktrees/<branche>` (dans le worktree principal).
- Association conversation↔worktree par longest-prefix côté front.
- Éditeur rooté sur `effectiveCwd` : arborescence + watch suivent le cwd live. Après redémarrage, `liveCwd` rehydraté depuis le transcript (`worktreeCwdFromTranscript`) — **NE PAS le persister en SQLite** (évite une migration de schéma ; `conv.cwd` reste l'ancre du `--resume`).

**État éditeur & UI**
- État éditeur par conversation en mémoire ; layout (`terminalOpen`, `terminalFraction`) persisté en localStorage `tosse:editor` — PAS en SQLite.
- Politique fichier ouvert : buffer propre → reload live ; buffer sale → garde modifs + bandeau « modifié sur le disque ». Autosave debounced + Cmd+S.
- Raccourcis clavier : **chiffres** (⌘1/⌘2) → `e.code` (robustesse AZERTY — les chiffres en Shift renverraient un symbole sur `e.key`) ; **lettres** (⌘Z) → `e.key` (robustesse AZERTY — `e.code` désignerait la position QWERTY). ⌘Z bail si focus dans zone à undo propre (input/textarea/contenteditable, Monaco `.monaco-editor`, xterm `.xterm`).

**Sous-agents & tâches de fond**
- Classification producteur (Bash vs Monitor vs Agent) : capté côté Rust dès `content_block_start` par nom de tool.
- **Background vs foreground** : distingué UNIQUEMENT par `input.run_in_background`. ACK de lancement détaché : `isDetachedAgentAck` exige **≥2 marqueurs** (« Async agent launched successfully » + `output_file: …/tasks/….output` + « notified automatically when it completes ») → fail-safe : ne folde jamais un bloc non confirmé `Agent`/`Task`. ⚠️ Un FAUX POSITIF masquerait silencieusement la carte + transcript d'un sous-agent foreground — d'où l'exigence ≥2 marqueurs.
- `tasks/<id>.output` vit dans un répertoire TEMP (`/tmp/claude-<uid>/…`), **PAS dans le répertoire de session** → lire via le chemin absolu `output_file` du wire.
- **Artefacts multi-slug** : une session qui déplace son cwd via `EnterWorktree` éclate ses artefacts sur plusieurs slugs → `subagents.rs` scanne TOUS les `session_dirs`, pas le premier.
- **Manifeste workflow** (`wf_<id>.json`) : écrit seulement à la FIN du run. Sources live : `task_progress` (wire) + `journal.jsonl` (counts) + script `meta.phases` (étapes à venir). Mapping agentId↔phase absent en live → comptes par étape approximatifs jusqu'à la fin.

**Rendu & affichage**
- **Surfaçage d'erreur unifié** : toute erreur visible dans la vue conversation (`ConversationItem::Notice` + `addErrorTurn`). Subtypes normalisés : `control_error`, `process_exited`, `send_failed`, `protocol_error`, `permission_error`, `history_error`, `error`.
- **Transitions d'état agent** : point UNIQUE dans `useGlobalSessionEvents.ts` via `agentEventFor` (`transition.ts`, fonction pure). Règles : `awaiting_permission` false→true = attention ; `busy` true→false (vivant) = terminé. **Ne PAS dupliquer cette détection**.
- **Mode Clean output** (`cleanOutput`, localStorage `tosse:display`) : repli du travail intermédiaire par round. Invariant liveness via `atomStillRunning` : si un `BackgroundTask` existe pour le tool_use, SON statut fait autorité (`running` → reste visible) ; sinon fallback `!tool_result`. **NE PAS keyer la complétion d'un sous-agent sur le seul `tool_result`** (peut arriver avant le `task_notification` terminal → fold/carte incohérents).
- **Garde `<task-notification>`** : le parser se déclenche UNIQUEMENT si le texte trimmé **OUVRE** sur `<task-notification>` (anti-faux-positif — un prompt qui mentionne le tag ne doit pas déclencher le rendu).
- **Invocation de skill/slash-command** : expansée en messages `role:user` (pas de type dédié). Le body SKILL.md porte `isMeta:true` → **droppé** (`assembler.rs::ingest_user` + `history.rs::push_user`), jamais de bulle user. Un skill **model-invoqué** (`tool_use{name:"Skill"}`) rend un **chip commande dédié** (`SkillChip` + segment `skill` dans `toolGroup.ts`, calqué sur agent/workflow — casse le run, non compté comme travail) ; la voie composer (`parseSlashCommand`, header `<command-name>`) reste inchangée. Wire : `docs/claude-code-protocol.md` §3.7.1.
- **Rendu Markdown** : 3 modes (Classic/Warm/Minimal, défaut `warm`), posé via `data-md-mode` sur `.md-body` → variantes CSS dans `conductor-markdown-modes.css`. Coloration syntaxique : `highlight.js` importé lazy, **langages taggés ET connus seulement** (pas de `highlightAuto` — perf + zéro fausse détection). Chip de chemin (`FileMention.tsx`) : rendu segmenté réservé aux VRAIS fichiers (gating `target != null || demo`).
- **Bindings IPC** (`src/ipc/bindings.ts`) : générés par tauri-specta → **toujours regénérer et committer avant PR** (le build release ne regénère pas).
- **Flight Deck — reply modal** (`FlightDeckReplyModal` + `flightdeckModalStore`) : répondre à une conversation en modale par-dessus le Flight Deck sans quitter la vue. Réutilise `ConversationPane` verbatim (3ᵉ point de montage, keyé id stable) SANS `SidePanel` (léger, par design). Store keyé id stable, INDÉPENDANT de l'activeId ; modale montée dans `App`, **gated sur la vue flightdeck** + fermée par un effet en quittant la vue → jamais la même conv montée en modale ET plein écran. Clics : TITRE de carte = plein écran, TOUT bouton d'action (« Vu » excepté) = modale, bouton « Plein écran » promeut. `FileMentionProvider` gagne un flag `inert` (propagé via `ConversationPane.inertMentions`) : dans la modale (pas d'éditeur monté) les chemins de fichiers sont du texte simple — sinon clic mort + flip silencieux du flag persisté `editorOpen`. `notify.ts` : la conv ouverte en modale compte comme « regardée » (via `useFlightdeckModal.getState().convId`) → pas de notif OS redondante.
- **Le calque le plus haut réclame Échap** : un listener Échap au niveau `window` (ex. la reply modal) double-ferme avec les popovers drill-in `document` (`TranscriptPopover` / `TaskOutputPopover` / `WorkflowDetail`) car keydown bulle document→window. Convention : les popovers font `preventDefault()` sur leur Échap (ils possèdent la touche quand ils sont ouverts) et le calque externe garde `if (!e.defaultPrevented)` avant de fermer → un Échap ne ferme qu'UNE couche. Les menus en capture-phase + `stopPropagation` (slash-menu du composer, ReviewBar) gagnent déjà.

## Commandes dev

Rust (dans `src-tauri/`, cargo dans `~/.cargo/bin`) :
- Tests unitaires : `cargo test --lib`
- Tests live (spawn réel de `claude`, ignorés par défaut) : `cargo test --lib -- --ignored --nocapture`

Front TypeScript :
- Typecheck : `node_modules/.bin/tsc --noEmit`
- Build : `pnpm build`
- Tests unitaires front : `pnpm test` (= `vitest run`, tests co-localisés `*.test.ts`)

CI (`.github/workflows/ci.yml`) : vitest + cargo test + build front. Ne tourne qu'à la PR vers `main`.

## Builds de test locaux (dev)

Alexandre **dogfoode** l'app de production (`/Applications/Tosse Code.app`, identifiant `com.tosse.desktop`) — ses vraies conversations y vivent.

⚠️ **Piège** : `tauri dev` ET `tauri build` réutilisent le MÊME identifiant → même base SQLite (`~/Library/Application Support/com.tosse.desktop/`). Un build de test lancé tel quel **écrase les données de prod**.

**Règle** : donner un nom + identifiant DISTINCTS à tout build de test.
- Override au build : `tauri build --config` (overlay JSON `productName`/`identifier`), SANS modifier `tauri.conf.json` committé (qui reste la config prod).
- Fichier de référence : `src-tauri/dev-build.conf.json` (`productName` "Tosse Code dev build", `identifier` `com.tosse.desktop.dev`).

## Branches & gouvernance

- **`main`** : protégée. Tout passe par PR. PR doit : (1) check `test` vert (CI), (2) approuvée par `@Alex375` (code owner — `.github/CODEOWNERS`), (3) conversations résolues. Force-push & suppression interdits.
- **`dev`** : branche de travail. Push libre. Pas de CI sur push dev.

Flux : feature branch → `dev` → PR `dev → main` → CI → Alexandre approuve + merge.

`enforce_admins=false` : Alexandre (admin) peut merger ses propres PR. Tout autre collaborateur gated derrière son approbation.

Accès : `Alex375` (admin), `clousty8`/Armand (write — push dev + ouvrir PR ; ne peut PAS merger dans main sans approbation d'Alexandre ni produire de release).

⚠️ Agents : **ne jamais `git push origin main` en direct** — committer sur `dev` ou une branche de feature et ouvrir une PR.

## Versioning & releases

SemVer `MAJEUR.MINEUR.CORRECTIF`. En `0.y.z` : MINEUR pour toute nouveauté, CORRECTIF pour les fix.

**3 fichiers toujours synchronisés** : `src-tauri/tauri.conf.json` (source de vérité runtime), `package.json`, `src-tauri/Cargo.toml` + `Cargo.lock`. Bumper via `pnpm bump <patch|minor|major|X.Y.Z>` — ne jamais éditer à la main.

**Release** : workflow `.github/workflows/release.yml`, 100 % manuel (`workflow_dispatch`), à lancer depuis `main`. Bundle macOS universel (Apple Silicon + Intel), publication directe (`releaseDraft: false`). Assets : `.dmg`, `.app.tar.gz` + `.sig`, `latest.json`. Seul `Alex375` peut déclencher (job `authorize`). Garde-fou anti-doublon : refus si version déjà releasée.

**Signature macOS (self-signed)** :
- But : DR stable (`identifier "com.tosse.desktop" and certificate leaf = H"…"`) → TCC conserve les autorisations de dossier d'une version à l'autre sans les redemander.
- Certificat « Tosse Code Self-Signed » (~20 ans), sauvegardé dans `~/TosseCodeSigning.p12`.
- ⚠️ **DR-CRITIQUE : ne JAMAIS réémettre ce certificat** (expiration / CN différent / nouvelle clé = nouvelle DR = re-grant TCC global pour tous les utilisateurs). Même discipline de sauvegarde que la clé updater.
- Secrets repo : `APPLE_CERTIFICATE` (base64 du .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (= « Tosse Code Self-Signed »). Si absents → build non signé.
- `release.yml` : `sudo security add-trusted-cert -d … System.keychain` obligatoire (Tauri refuse un cert self-signed non trusté). L'étape build reçoit UNIQUEMENT `APPLE_SIGNING_IDENTITY` (pas `APPLE_CERTIFICATE` — sinon Tauri refait un keychain non-trusté et échoue).
- `tauri.conf.json` : `bundle.macOS.hardenedRuntime: false` (le défaut `true` casse le WebView sans entitlements JIT ; pas de notarisation).

**Auto-update** (`tauri-plugin-updater` + `tauri-plugin-process`) :
- Check au lancement + toutes les 2h → download → vérif signature → `relaunch()`.
- Clé privée : secret repo `TAURI_SIGNING_PRIVATE_KEY` + backup local `~/.tauri/tosse-code-updater.key` (sans mot de passe). **NE PAS la perdre** (sinon plus aucune MAJ signable).
- `bundle.createUpdaterArtifacts: true`. MAJ touche uniquement le bundle `.app` ; données (SQLite + transcripts) hors bundle, préservées.

## IDs MCP (entités TOSSE associées à ce repo)

- `repository_id` : `8c509e62-30cb-4f58-9074-086bac72528d`
- `project_id` (Tosse Code) : `ef02be22-fe30-4463-9450-ec3b20746a35`

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

## Frontière build vs réutilisation
- **On écrit nous-mêmes (c'est le produit)** : superviseur de flotte, client du protocole stream-json + canal de contrôle, machine à états des agents, orchestration des git worktrees, persistance, intégration TOSSE.
- **On réutilise (substrat de rendu, zéro différenciation produit)** : Monaco, xterm.js, le rendu markdown/diff/code en React.
- **On ne réimplémente PAS** le moteur d'agent de Claude : le binaire `claude` reste une boîte noire pilotée par son protocole stdio ; on construit tout autour. Le réécrire = perdre l'abo Max et toutes les améliorations futures du CLI.

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
- **[LIVRÉ] Client Git** (amélioration) : indicateur worktree actif, badge sidebar, gestionnaire modale des worktrees.
- **[LIVRÉ] Éditeur de texte enrichi** : coloration syntaxique via highlight.js (lazy), rendu Markdown en 3 modes (Classic / Warm / Minimal), chip de chemin de fichier segmenté, tableaux stylés.
- **Visualisation d'images** : pouvoir ouvrir des images.
- **Association des conversations à TOSSE** : chaque conversation est associée à une tâche TOSSE et à un projet.
- **[LIVRÉ] Remote control natif** : activation d'un bridge vers claude.ai/code + app mobile via le canal de contrôle stream-json (`control_request{remote_control}`).
- **[LIVRÉ] Mode Clean output** : repli du travail intermédiaire de Claude par round derrière un bloc dépliable, avec état mémorisé par conversation (localStorage).
- **[LIVRÉ] Barres de tâches de fond** : BashBar, MonitorBar, WorkflowBar — barres épinglées au-dessus du composer pour les tâches run_in_background, avec stop, tail live et vue workflow détaillée.
- **[LIVRÉ] Menu slash-commands** : catalogue des commandes `/` du composer issu du `initialize` control_response, groupé par scope (projet / builtin / plugin), rafraîchi après `/reload-skills`.

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
- Designs Claude Design (gestion d'agents) : à intégrer plus tard, Alexandre les fournira.
- Périmètre exact des actions exposées par le MCP server de pilotage : à lister (Phase 2).

## Organisation
- Phase 1 **complète** — les 4 livrables (Conversation, Éditeur, Terminal, Vue Gestion d'agents) sont implémentés et mergés sur dev.

---
**Active Mission: Développement TOSSE** (En cours, assigned to Les deux)
Développement complet des outils internes pour Alexandre et Armand (freelancers) :
- **CRM TOSSE** : backend API, frontend web, serveur MCP, plugin Claude Code, déploiement cloud.
- **App desktop tosse-code** : application desktop pour piloter Claude Code de manière optimisée (plusieurs agents en parallèle, éditeur intégré, terminal, Flight Deck).

Spec de référence CRM : `Cahier_des_charges.md` (v1.3, mars 2026) — document autoritatif pour toutes les fonctionnalités et comportements attendus.

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
- Hébergement Railway
