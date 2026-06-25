---
name: start
description: |
  Démarre une tâche TOSSE DANS UN WORKTREE dédié, prêt à coder. Lance `/pickup`, puis crée et entre un git worktree basé sur `dev`. Utilise ce skill chaque fois que tu commences un nouveau travail sur ce projet :
  - L'utilisateur tape `/start` ou `/start <task_id>`
  - L'utilisateur dit « démarre la tâche… », « on commence sur… », « je veux bosser sur… »
  - L'utilisateur décrit une feature/un bug à attaquer (intention libre)
  C'est le point d'entrée du workflow tosse-code (`/start` → code → `/build-app` → `/land`). Préfère-le à `/pickup` seul, car ici tout le travail doit se faire dans un worktree isolé, jamais sur le worktree principal partagé.
---

# Start — Démarrer une tâche dans un worktree dédié

Ce skill prépare une tâche TOSSE **et** un worktree git isolé pour la coder, puis te laisse travailler dedans.

**Pourquoi un worktree dès le départ ?** Le worktree principal (`dev`) est partagé avec d'autres agents Claude. Travailler dans un worktree dédié par tâche isole complètement la branche de feature, évite de polluer `dev`, et permet à plusieurs agents de bosser en parallèle sans se marcher dessus. C'est l'invariant central du workflow.

## Étape 1 — Lancer `/pickup`

Invoque le skill `/pickup` (outil Skill) en lui passant l'argument reçu, s'il y en a un (`/start <task_id>` → `/pickup <task_id>`). Il fait tout le travail TOSSE : résoudre/créer la tâche, vérifier les blocages, lire la cascade de contextes, passer la tâche **« En cours »**. **Ne réimplémente pas cette logique** — `/pickup` est la source de vérité.

Une fois `/pickup` terminé, tu connais la tâche (titre, id). Continue ici.

## Étape 2 — Dériver le slug de la tâche

Construis un **slug** court et lisible depuis le titre de la tâche : minuscules, mots séparés par des tirets, uniquement `[a-z0-9-]` (l'identifiant de build et le nom de branche en dépendent). Garde-le parlant (5-6 mots max).

Exemple : tâche « Explorateur de skills/plugins/MCP » → slug `extensions-explorer`.

Ce slug sert partout ensuite : branche `feat/<slug>`, dossier worktree `.claude/worktrees/<slug>`, et plus tard le nom de l'app de test (`/build-app`).

## Étape 3 — Mettre `dev` à jour, puis créer le worktree depuis `dev`

On part **toujours de `dev`** (cible d'atterrissage des features → on minimise les conflits au moment du `/land`).

```bash
git fetch origin
# Crée le worktree + la branche de feature à partir du dernier dev distant
git worktree add .claude/worktrees/<slug> -b feat/<slug> origin/dev
```

Si la branche `feat/<slug>` ou le worktree existe déjà (re-`/start` d'une tâche reprise) : ne recrée pas, réutilise l'existant et passe à l'étape suivante.

## Étape 4 — Entrer dans le worktree avec l'outil Claude

**Capital** : entre dans le worktree avec l'outil natif `EnterWorktree`, pas avec un `cd`.

```
EnterWorktree({ path: ".claude/worktrees/<slug>" })
```

C'est ce qui fait suivre le `cwd` de la session à l'app Tosse Code (l'éditeur, le watch fs, le terminal se rebasent dessus). Un `cd` ne déclencherait rien de tout ça.

## Étape 5 — Installer les dépendances

```bash
pnpm install
```

Un worktree neuf partage le `.git` mais a son **propre répertoire de fichiers**, et `node_modules` est gitignoré : il n'est pas recopié. Sans ce `pnpm install`, tout échoue dans le worktree (`tsc`, `vitest`, `vite`, `tauri build`). C'est l'unique étape lente du démarrage — on la fait une fois, ici.

## Étape 6 — Annoncer et travailler

Affiche un récap court : tâche + sous-tâches, contexte pertinent, et « worktree `feat/<slug>` prêt, dépendances installées ». Propose un plan de travail. Puis **code la tâche dans le worktree**.

## Étape 7 — À la fin du travail : ne rien faire d'autre

Quand la tâche est terminée (code écrit, vérifié), **n'enchaîne sur rien automatiquement** — ni `/build-app`, ni `/land`, ni `/done`. Préviens simplement l'utilisateur que la tâche est finie et **attends qu'il indique l'étape suivante**. C'est lui qui décide quand tester (`/build-app`) ou poser sur `dev` (`/land`).

## Ce que ce skill ne fait PAS

- Builder ou lancer l'app (→ `/build-app`)
- Fusionner sur `dev` ou nettoyer le worktree (→ `/land`)
- Passer la tâche en Review (→ `/done`, déclenché par `/land`)
- Pousser quoi que ce soit
