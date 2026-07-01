---
name: build-dev
description: |
  Build et lance l'app **Tosse Code dev build** depuis le worktree PRINCIPAL sur la branche `dev`, avec ses données ISOLÉES de la prod. Utilise ce skill quand :
  - L'utilisateur tape `/build-dev`
  - L'utilisateur dit « build la dev », « build l'app sur dev », « compile dev pour tester », « je veux tester la dev »
  - Tu veux voir tourner l'état courant de `dev` (p. ex. juste après un `/land`) dans une vraie fenêtre, pas seulement en tests unitaires
  À la différence de `/build-app` (qui build UNE feature dans SON worktree, avec un identifiant par feature), ce skill build le **worktree principal** sur `dev` sous une identité FIXE `Tosse Code dev build` (`com.tosse.desktop.dev`) — jamais l'app de prod `/Applications/Tosse Code.app`.
---

# Build-dev — Builder et lancer l'app de test « dev »

Ce skill produit un bundle macOS de l'app depuis le **worktree principal, sur la branche `dev`** (l'état intégré du projet, pas une feature isolée), nommé **`Tosse Code dev build`**, et le lance. Il garantit que ce build **ne touche jamais les données de la prod**.

C'est l'équivalent de `/build-app` mais pour l'**arbre de travail principal** : on teste `dev` tel qu'il est (typiquement après avoir posé une ou plusieurs features via `/land`), pas une branche de feature dans un worktree.

## ⚠️ L'invariant à ne jamais casser : identité distincte de la prod

Alexandre **dogfoode** : son app de prod est `/Applications/Tosse Code.app` (`identifier: com.tosse.desktop`), et ses **vraies conversations** vivent dans `~/Library/Application Support/com.tosse.desktop/`.

`tauri build` réutilise par défaut **le même `identifier`** → la **même base SQLite** → un build lancé tel quel **écrase / pollue les conversations réelles**.

La parade est déjà versionnée : le fichier **`src-tauri/dev-build.conf.json`** fixe `productName: "Tosse Code dev build"` et `identifier: "com.tosse.desktop.dev"`. Les données de ce build vivent donc dans `~/Library/Application Support/com.tosse.desktop.dev/` — un dossier séparé, partagé par tous les builds « dev » (c'est voulu : un environnement de test « dev » persistant). **Zéro risque pour la prod.**

## Étape 1 — Vérifier qu'on est bien sur le worktree principal, sur `dev`

Ce skill build **l'arbre de travail principal**, pas un worktree de feature.

```bash
git rev-parse --show-toplevel   # doit être .../Repos/tosse-code, PAS .../.claude/worktrees/<slug>
git branch --show-current       # doit être dev
```

- Si tu es dans un **worktree de feature** (`.claude/worktrees/<slug>`) → ce n'est pas le bon skill : pour tester une feature isolée, utilise `/build-app` ; pour d'abord poser la feature sur `dev`, utilise `/land`. Signale-le et arrête-toi.
- Si la branche n'est pas `dev` → propose de faire `git checkout dev` avant de continuer (le skill build ce qui est sur `dev`).

Ce skill build l'**état courant du disque** sur `dev` (y compris d'éventuels changements non committés). Si tu veux tester le dernier `dev` distant, propose un `git fetch origin && git merge --ff-only origin/dev` **avant** de builder — mais ne le fais pas d'office.

## Étape 2 — S'assurer des dépendances

```bash
pnpm install   # normalement déjà présent sur le worktree principal ; ne relance que si node_modules manque
```

## Étape 3 — Builder avec la config « dev build » versionnée

Pas d'overlay à générer : la config existe déjà. **Ne modifie jamais** `src-tauri/tauri.conf.json` (config de prod, versionnée).

```bash
pnpm tauri build --config src-tauri/dev-build.conf.json
```

⚠️ C'est un build **release** : compte plusieurs minutes (compilation Rust). C'est normal — préviens l'utilisateur que ça compile.

## Étape 4 — Lancer l'app

Le bundle sort dans `src-tauri/target/release/bundle/macos/` sous le `productName` :

```bash
open "src-tauri/target/release/bundle/macos/Tosse Code dev build.app"
```

## Étape 5 — Rapporter

Indique à l'utilisateur :
- le chemin du `.app` lancé,
- qu'il s'agit de l'état de **`dev`** (worktree principal),
- que ses données sont **isolées** (`com.tosse.desktop.dev`, dossier de données séparé) → aucun impact sur sa prod.

## Ce que ce skill ne fait PAS

- Builder une feature dans son worktree (→ `/build-app`)
- Modifier `tauri.conf.json` (config de prod intouchée)
- Générer des artefacts de mise à jour (`dev-build.conf.json` les désactive)
- Fusionner quoi que ce soit sur `dev`, pousser, ou nettoyer un worktree (→ `/land`)
- Toucher l'app de prod `/Applications/Tosse Code.app` (identité distincte)
- Signer / notariser le bundle
