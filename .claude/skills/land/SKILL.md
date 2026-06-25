---
name: land
description: |
  Pose le travail d'un worktree sur la branche `dev` du worktree principal, nettoie le worktree, puis lance `/done`. Utilise ce skill quand :
  - L'utilisateur tape `/land`
  - L'utilisateur dit « mets ça sur dev », « balance la feature sur dev », « on intègre », « pose le travail »
  - Une feature développée dans un worktree (via `/start`) est finie et vérifiée, et doit rejoindre `dev`
  C'est l'étape de fin du workflow tosse-code : la feature de Claude doit finir sur la branche `dev` du worktree principal. Gère les merges concurrents et les conflits prudemment.
---

# Land — Poser la feature sur `dev`

Ce skill prend la branche de feature du worktree courant et la fusionne dans `dev` sur le **worktree principal**, pousse, supprime le worktree, puis clôture la tâche via `/done`.

**Objectif final** : peu importe le détail, la feature doit se retrouver sur la branche `dev` du **worktree principal**. C'est tout.

> Ce skill ne s'applique que si tu travailles **dans un worktree** (flux `/start`). Si tu n'es pas dans un worktree, le travail est déjà sur la branche courante : saute les étapes worktree, va directement à « mettre dev à jour / committer / pousser / `/done` ».

## Étape 1 — Vérifier que le travail est fini

Le code doit compiler et les tests passer. Si tu n'as pas vérifié récemment, lance d'abord :

```bash
pnpm typecheck && pnpm test
cargo test --lib   # depuis src-tauri/, si du Rust a changé
```

Si ça casse, **arrête-toi** : on ne pose pas du travail rouge sur `dev`.

## Étape 2 — Worktree propre

Commit tout ce qui reste dans le worktree (message descriptif). `git status` doit être clean avant de continuer — sinon la suppression du worktree échouera et la fusion serait partielle.

## Étape 3 — Sortir du worktree avec l'outil Claude

```
ExitWorktree({ action: "keep" })
```

`keep` (pas `remove`) : on garde le worktree sur le disque le temps de fusionner. La session revient au worktree principal. (`ExitWorktree` refuse de toute façon de `remove` un worktree entré via `path` — la suppression réelle se fait à l'étape 7 avec `git worktree remove`.)

Note le nom du slug / de la branche `feat/<slug>` avant de sortir.

## Étape 4 — Mettre `dev` à jour (worktree principal)

```bash
git checkout dev
git fetch origin
git merge --ff-only origin/dev
```

**Garde-fou « merge concurrent »** : `dev` est partagé avec d'autres agents. Si un merge est déjà en cours dans le worktree principal (`.git/MERGE_HEAD` présent) ou si l'arbre de travail est sale avec des changements qui ne sont pas les tiens → **un autre merge est en cours et te bloque** : arrête-toi, explique la situation, et demande à l'utilisateur de te **prévenir quand cet autre merge est terminé**. Reprends seulement après son feu vert. (Si rien ne te bloque, continue normalement — pas besoin de t'arrêter par précaution.)

## Étape 5 — Fusionner la feature dans `dev`

```bash
git merge feat/<slug>
```

`dev` a pu avancer depuis la création du worktree, donc un **conflit** est possible. **En cas de conflit : NE résous PAS en aveugle.** Arrête-toi, montre les fichiers en conflit à l'utilisateur, et attends sa validation sur la façon de résoudre. Un mauvais merge sur `dev` impacte tous les autres agents.

## Étape 6 — Vérifier après le merge

`dev` a bougé : revérifie que tout tient ensemble.

```bash
pnpm typecheck && pnpm test
```

## Étape 7 — Pousser `dev`, puis nettoyer le worktree

Pousse **automatiquement** (pas de question — c'est le comportement voulu de ce skill) :

```bash
git push origin dev
```

Puis supprime le worktree et sa branche (maintenant fusionnée) :

```bash
git worktree remove .claude/worktrees/<slug>
git branch -d feat/<slug>
```

L'ordre compte : on retire d'abord le worktree (qui avait `feat/<slug>` checké out), ce qui libère la branche, puis on la supprime. `git branch -d` (minuscule) ne réussit que si la branche est bien fusionnée — c'est une sécurité voulue ; si ça refuse, c'est que le merge n'a pas pris, ne force pas, enquête.

## Étape 8 — Clôturer la tâche

Lance le skill `/done` (outil Skill). Il résume le travail, met à jour le contexte de la tâche et la passe en **Review**. Ce repo n'a pas de `/deploy`, donc `/done` ne déclenchera rien d'autre — c'est `/land` qui a joué le rôle de mise en intégration.

## Ce que ce skill ne fait PAS

- Pousser ou merger sur `main` (→ `/release`)
- Passer la tâche en « Fait » (réservé à un humain)
- Résoudre des conflits de merge sans validation de l'utilisateur
