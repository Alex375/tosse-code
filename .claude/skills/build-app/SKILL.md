---
name: build-app
description: |
  Build et lance l'app Tosse Code depuis le worktree courant pour la tester comme une vraie app, AVEC SES DONNÉES ISOLÉES de la prod. Utilise ce skill quand :
  - L'utilisateur tape `/build-app`
  - L'utilisateur dit « build l'app », « compile l'app pour tester », « lance-moi l'app de cette feature », « je veux tester l'app »
  - Tu as fini (ou veux essayer) une feature et tu veux la voir tourner dans une vraie fenêtre, pas juste en tests unitaires
  Indispensable AVANT de tester visuellement une feature : un `tauri build` naïf réutiliserait l'identifiant de prod et ÉCRASERAIT la base SQLite de l'app de prod d'Alexandre. Ce skill garantit un identifiant distinct par feature.
---

# Build-app — Builder et lancer une app de test isolée

Ce skill produit un bundle macOS de l'app **propre à la feature courante**, nommé `TosseCode <slug>`, et le lance. Il garantit que ce build **ne touche jamais les données de la prod**.

## ⚠️ L'invariant à ne jamais casser : identifiant distinct

Alexandre **dogfoode** : son app de prod est `/Applications/Tosse Code.app` (`identifier: com.tosse.desktop`), et ses **vraies conversations** vivent dans `~/Library/Application Support/com.tosse.desktop/`.

`tauri build` et `tauri dev` réutilisent par défaut **le même `identifier`** → la **même base SQLite** → un build de test lancé tel quel **écrase / pollue les conversations réelles**.

La parade : donner au build un **`productName` ET un `identifier` distincts**, dérivés du slug de la feature. Dossier de données séparé → zéro risque pour la prod, et chaque feature a ses propres données de test.

## Étape 1 — Vérifier le contexte et dériver le slug

Tu dois être **dans un worktree** (le flux normal après `/start`). Le slug = le nom du dossier du worktree :

```bash
git rev-parse --show-toplevel   # .../.claude/worktrees/<slug>
```

Prends le `basename` comme `<slug>` (déjà en kebab-case `[a-z0-9-]` si créé par `/start`). Si tu n'es pas dans un worktree, demande confirmation avant de continuer (tu builderais le worktree principal).

## Étape 2 — S'assurer des dépendances

```bash
pnpm install   # seulement si node_modules est absent (worktree neuf)
```

## Étape 3 — Générer l'overlay de config (sans toucher au tauri.conf.json committé)

Crée un fichier de config **temporaire** qui sera fusionné par-dessus `tauri.conf.json` au build. **Ne modifie jamais** `src-tauri/tauri.conf.json` (config de prod, versionnée). Le fichier de référence `src-tauri/dev-build.conf.json` montre la forme attendue ; ici on le paramètre par feature.

Écris-le dans la sortie de build gitignorée, p. ex. `src-tauri/target/build-overlay-<slug>.json` (crée le dossier d'abord — `mkdir -p src-tauri/target` — il peut ne pas exister avant le tout premier build d'un worktree neuf) :

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "TosseCode <slug>",
  "identifier": "com.tosse.desktop.<slug>",
  "bundle": { "createUpdaterArtifacts": false }
}
```

`createUpdaterArtifacts: false` : un build de test ne doit pas générer d'artefacts de mise à jour signés.

## Étape 4 — Builder

```bash
pnpm tauri build --config src-tauri/target/build-overlay-<slug>.json
```

⚠️ C'est un build **release** : compte plusieurs minutes (compilation Rust). C'est normal — préviens l'utilisateur que ça compile.

## Étape 5 — Lancer l'app

Le bundle sort dans `src-tauri/target/release/bundle/macos/` sous le `productName` :

```bash
open "src-tauri/target/release/bundle/macos/TosseCode <slug>.app"
```

Comme chaque feature a un `productName` distinct, les bundles ne s'écrasent pas entre eux.

## Étape 6 — Rapporter

Indique à l'utilisateur :
- le chemin du `.app` lancé,
- que ses données sont **isolées** (`com.tosse.desktop.<slug>`, dossier de données séparé) → aucun impact sur sa prod ni sur les autres features.

## Ce que ce skill ne fait PAS

- Modifier `tauri.conf.json` (config de prod intouchée)
- Générer des artefacts de mise à jour
- Fusionner sur `dev` ou nettoyer le worktree (→ `/land`)
- **Purger l'identité Library `com.tosse.desktop.<slug>`** qu'il crée (données/caches/prefs isolés) : c'est `/land` (étape 7b) qui la supprime en même temps que le worktree, pour ne pas laisser d'identités mortes s'accumuler dans `~/Library`. Tant que la feature n'est pas landée, ces données restent (normal : tu peux relancer le build).
- Signer / notariser le bundle
