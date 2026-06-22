// Extract a slim file/folder icon map + the referenced SVGs from the
// `material-icon-theme` package (MIT) into `public/file-icons/`, which the editor
// serves statically and resolves at runtime (see src/features/editor/fileIcons.ts).
//
// The generated assets are COMMITTED, so the build needs no dependency. The
// `material-icon-theme` package is NOT a project dependency (its transitive
// `core-js` install script trips pnpm's pre-run deps check and breaks dev/build).
// To regenerate (e.g. to pull newer icons):
//
//     pnpm add -D material-icon-theme && pnpm gen:file-icons && pnpm remove material-icon-theme
//
// Committed output: public/file-icons/icons.json + public/file-icons/*.svg.

import { mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pkgDir = resolve(root, "node_modules/material-icon-theme");
const theme = JSON.parse(readFileSync(resolve(pkgDir, "dist/material-icons.json"), "utf8"));
const outDir = resolve(root, "public/file-icons");

// iconName -> svg basename (e.g. "typescript" -> "typescript.svg").
const svgOf = (iconName) => {
  const def = theme.iconDefinitions[iconName];
  if (!def?.iconPath) return null;
  return basename(def.iconPath);
};

// Build a name->svg map from a name->iconName source, dropping unresolved entries.
const remap = (src) => {
  const out = {};
  for (const [key, iconName] of Object.entries(src ?? {})) {
    const svg = svgOf(iconName);
    if (svg) out[key.toLowerCase()] = svg;
  }
  return out;
};

const slim = {
  fileNames: remap(theme.fileNames),
  fileExtensions: remap(theme.fileExtensions),
  folderNames: remap(theme.folderNames),
  folderNamesExpanded: remap(theme.folderNamesExpanded),
  defaults: {
    file: svgOf(theme.file),
    folder: svgOf(theme.folder),
    folderOpen: svgOf(theme.folderExpanded),
  },
};

// The set of SVGs actually referenced — copy only these (not the full 1245).
const used = new Set();
for (const m of [slim.fileNames, slim.fileExtensions, slim.folderNames, slim.folderNamesExpanded]) {
  for (const svg of Object.values(m)) used.add(svg);
}
for (const svg of Object.values(slim.defaults)) if (svg) used.add(svg);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
let copied = 0;
for (const svg of used) {
  try {
    copyFileSync(resolve(pkgDir, "icons", svg), resolve(outDir, svg));
    copied++;
  } catch {
    // A referenced icon missing from the package is skipped (the resolver falls
    // back to the default icon for that name).
  }
}
writeFileSync(resolve(outDir, "icons.json"), JSON.stringify(slim));

const stat = (m) => Object.keys(m).length;
console.log(
  `file-icons: ${copied} svg copiés · map fileNames=${stat(slim.fileNames)} ` +
    `fileExt=${stat(slim.fileExtensions)} folders=${stat(slim.folderNames)} ` +
    `foldersOpen=${stat(slim.folderNamesExpanded)}`,
);
