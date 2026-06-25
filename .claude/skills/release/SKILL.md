---
name: release
description: |
  Coupe une release de Tosse Code : bump de version → push `dev` → PR `dev`→`main` → CI → PAUSE pour review → merge → déclenche le workflow de release GitHub. Utilise ce skill quand :
  - L'utilisateur tape `/release` ou `/release <patch|minor|major>`
  - L'utilisateur dit « fais une release », « publie une version », « sors une release », « on release »
  Le skill est automatique de bout en bout, avec UNE SEULE pause : après CI verte, il attend l'approbation de la review avant de merger dans `main`. À lancer par Alexandre (`Alex375`, admin) — le merge sur `main` et le job `authorize` de la release exigent ses droits.
---

# Release — Publier une version

Ce skill enchaîne tout le processus de release. Il est **automatique** sauf **une pause unique** : il s'arrête après la CI verte pour attendre la review humaine, puis reprend seul jusqu'à la publication.

**Pré-requis de gouvernance** (rappel) : `main` est protégée, tout passe par PR ; le check `test` doit être vert ; le code owner `@Alex375` approuve. Une release embarque **tout l'état courant de `dev`** dans `main` — c'est voulu, on ne demande pas de confirmation de périmètre.

## Étape 1 — Partir d'un `dev` propre et à jour

```bash
git checkout dev
git status            # doit être clean
git fetch origin
git merge --ff-only origin/dev
```

Si l'arbre n'est pas clean, arrête-toi : on ne release pas par-dessus du travail non committé.

## Étape 2 — Déterminer le niveau de bump

- Si l'utilisateur a fourni l'argument (`/release minor`, `patch`, `major`, ou une version `X.Y.Z`), utilise-le.
- Sinon, **déduis-le** des commits de `dev` depuis la dernière release et **annonce ton choix** : en `0.y.z` (cas actuel), nouveautés → `minor`, fix uniquement → `patch`. `major` seulement pour un changement incompatible (schéma SQLite sans migration, format de transcript, comportement cassé).

## Étape 3 — Bumper la version

```bash
pnpm bump <patch|minor|major|X.Y.Z>
```

Le script met à jour les 4 emplacements d'un coup (`tauri.conf.json`, `package.json`, `Cargo.toml`, `Cargo.lock`). **N'édite jamais ces versions à la main.**

## Étape 4 — Commiter et pousser `dev`

```bash
git add -A
git commit -m "chore(release): vX.Y.Z"
git push origin dev
```

## Étape 5 — Ouvrir la PR `dev` → `main`

```bash
gh pr create --base main --head dev \
  --title "Release vX.Y.Z" \
  --body "Release vX.Y.Z. Voir les commits de dev depuis la dernière release."
```

Récupère le numéro/URL de la PR pour la suite.

## Étape 6 — Attendre la CI verte

Le check requis est `test` (`.github/workflows/ci.yml`, ne tourne qu'à la PR vers `main`). **Surveille-le en ré-interrogeant périodiquement** :

```bash
gh pr checks <pr-number>
```

N'utilise **pas** un `gh pr checks --watch` bloquant : la CI peut dépasser le timeout des commandes. Ré-interroge jusqu'à ce que `test` soit `pass`. Si la CI échoue → arrête-toi et rapporte l'échec (ne merge pas).

## Étape 7 — ⏸️ PAUSE : attendre la review

C'est l'unique gate humain. **Arrête-toi ici.** Annonce :
- l'URL de la PR,
- que la CI est verte,
- que tu attends l'**approbation de la review** avant de merger.

**Ne merge pas sans le feu vert explicite de l'utilisateur.** Reprends à l'étape 8 seulement quand il confirme que la review est approuvée.

## Étape 8 — Fusionner dans `main`

Une fois CI verte **et** review approuvée :

```bash
gh pr merge <pr-number> --merge
```

(En tant qu'admin avec `enforce_admins=false`, Alexandre peut finaliser le merge même si une protection résiste.)

## Étape 9 — Déclencher la release

```bash
gh workflow run release.yml --ref main
```

Le workflow compile un bundle macOS universel et **publie directement** la release GitHub (`.dmg`, artefact updater signé `.app.tar.gz` + `.sig`, `latest.json`). Garde-fou intégré : il refuse si la version courante a déjà une release — d'où l'importance du bump à l'étape 3.

## Étape 10 — Suivre et rapporter

Suis le run (`gh run watch` ou `gh run list --workflow=release.yml`) jusqu'à la publication, puis donne à l'utilisateur l'**URL de la release**.

## Ce que ce skill ne fait PAS

- Demander une confirmation de périmètre (volontairement automatique)
- Éditer les versions à la main (toujours via `pnpm bump`)
- Pousser directement sur `main` (interdit — tout passe par la PR)
- Signer/notariser côté Apple (chantier séparé)
