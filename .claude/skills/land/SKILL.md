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

`dev` a **presque toujours avancé** depuis la création de ton worktree : d'autres agents y ont posé de nouvelles features entre le moment où tu as coupé ta branche et maintenant. Deux cas.

### Cas A — Aucun conflit (fast-forward ou merge propre)

Le merge passe tout seul. Rien de spécial : va directement à l'étape 6 (revérification).

### Cas B — Un ou plusieurs conflits

`git merge` s'arrête et laisse les fichiers en conflit dans l'arbre. **Ne résous JAMAIS en bloc ni à l'aveugle.** L'objectif est double et **non négociable** : **ni ton travail, ni les nouvelles features de `dev` ne doivent être cassés.** Les deux doivent continuer à marcher aussi bien qu'avant le merge — c'est aussi important que ta feature.

Procède **fichier par fichier**, jamais en gros :

```bash
git diff --name-only --diff-filter=U   # la liste des fichiers en conflit
```

Pour **chaque** fichier en conflit :

1. **Ouvre-le et lis chaque zone de conflit.** Repère bien les deux côtés : entre `<<<<<<< HEAD` et `=======` = ce que **`dev`** a fait (le travail des autres agents) ; entre `=======` et `>>>>>>> feat/<slug>` = **ton** travail.
2. **Comprends l'intention des DEUX côtés avant de toucher quoi que ce soit.** Que cherche à faire le code de `dev` ? Que cherche à faire le tien ? Ce ne sont pas des lignes à trancher pour « choisir un gagnant » — ce sont deux intentions à **réconcilier**.
3. **Conflit simple / mécanique** (imports ajoutés des deux côtés, ajouts indépendants dans des zones voisines, formatage, renommage local sans ambiguïté…) → **combine les deux côtés** en préservant **les deux** intentions, puis résous-le.
4. **Conflit plus complexe** (les deux côtés modifient la même logique, la même signature, le même flux ; ou tu ne vois pas d'emblée comment les deux cohabitent) → **prends le temps.** Concrètement :
   - Lis le **fichier entier**, pas seulement la zone de conflit — le contexte autour explique souvent le pourquoi.
   - Va voir les **autres fichiers modifiés des deux côtés** pour comprendre dans quel changement global s'inscrit chaque bout de code (`git diff HEAD...MERGE_HEAD` pour le côté `dev`, `git diff HEAD...feat/<slug>` pour le tien). Un conflit isolé ne se résout bien que replacé dans le changement complet dont il fait partie.
   - Écris alors une résolution qui **satisfait les deux** : plus de marqueurs de conflit **et** tout reste fonctionnel des deux côtés (ta feature ET les nouvelles features de `dev`).
5. **Si, après avoir vraiment cherché à comprendre, tu n'es pas certain de ne rien casser** (logique ambiguë, comportement de `dev` que tu n'arrives pas à cerner) → **arrête-toi et demande** à l'utilisateur plutôt que de deviner. Un mauvais merge sur `dev` impacte tous les autres agents.

Quand toutes les zones sont résolues, finalise le merge :

```bash
git add <fichiers résolus>
git commit          # message de merge par défaut : ok
```

Puis **résume brièvement à l'utilisateur** quels conflits tu as rencontrés et comment tu les as tranchés (surtout les complexes) — pour transparence. Inutile d'attendre sa validation si tu es confiant ; mais s'il y avait le moindre doute, c'est le moment de le signaler.

## Étape 6 — Vérifier après le merge (impératif, surtout après un conflit)

`dev` a bougé — et si tu as résolu des conflits, tu viens de réécrire du code touchant **les deux côtés**. Revérifie que **tout** tient ensemble : ton travail comme les features de `dev`.

```bash
pnpm typecheck && pnpm test
cargo test --lib    # depuis src-tauri/, si du Rust est impliqué dans le merge
```

Si quoi que ce soit casse, la cause la plus probable est la résolution du conflit : **reprends-la**, ne pousse pas du rouge sur `dev`. En cas de merge non trivial, envisage aussi `/build-dev` pour voir l'app tourner sur le `dev` fusionné avant de pousser.

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
- Résoudre des conflits **à l'aveugle** ou forcer un merge douteux : il les résout fichier par fichier, en comprenant les deux côtés, et s'arrête pour demander en cas de doute réel
