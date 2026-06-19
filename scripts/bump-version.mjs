// Bump the app version in lockstep across the three places it lives:
//   - src-tauri/tauri.conf.json  (runtime source of truth, shown in Settings)
//   - package.json               (front / monorepo)
//   - src-tauri/Cargo.toml        (Rust crate) + Cargo.lock entry
//
// Usage:  pnpm bump <patch|minor|major|X.Y.Z>
// See CLAUDE.md « Versioning & releases » for the policy. After bumping, commit
// (chore(release): vX.Y.Z) and push to main, then run the Release workflow.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_CONF = join(ROOT, "src-tauri", "tauri.conf.json");
const PACKAGE_JSON = join(ROOT, "package.json");
const CARGO_TOML = join(ROOT, "src-tauri", "Cargo.toml");
const CARGO_LOCK = join(ROOT, "src-tauri", "Cargo.lock");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function nextVersion(current, arg) {
  if (SEMVER.test(arg)) return arg; // explicit X.Y.Z
  const m = current.match(SEMVER);
  if (!m) fail(`version courante illisible : "${current}" (attendu X.Y.Z)`);
  let [major, minor, patch] = m.slice(1).map(Number);
  switch (arg) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
    default:
      fail(`argument invalide : "${arg}". Attendu : patch | minor | major | X.Y.Z`);
  }
}

const arg = process.argv[2];
if (!arg) fail("usage : pnpm bump <patch|minor|major|X.Y.Z>");

// Read the current version from the runtime source of truth.
const tauriConf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
const current = tauriConf.version;
const next = nextVersion(current, arg);
if (next === current) fail(`la version est déjà ${current}`);

// 1. tauri.conf.json
tauriConf.version = next;
writeFileSync(TAURI_CONF, JSON.stringify(tauriConf, null, 2) + "\n");

// 2. package.json
const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
pkg.version = next;
writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + "\n");

// 3. Cargo.toml — only the [package] version (first `version = "..."` line).
let cargoToml = readFileSync(CARGO_TOML, "utf8");
cargoToml = cargoToml.replace(/^version = "[^"]*"/m, `version = "${next}"`);
writeFileSync(CARGO_TOML, cargoToml);

// 4. Cargo.lock — the tosse-code package entry, if the lockfile exists.
if (existsSync(CARGO_LOCK)) {
  let lock = readFileSync(CARGO_LOCK, "utf8");
  lock = lock.replace(
    /(name = "tosse-code"\nversion = ")[^"]*(")/,
    `$1${next}$2`,
  );
  writeFileSync(CARGO_LOCK, lock);
}

console.log(`✓ Version : ${current} → ${next}`);
console.log("  Mis à jour : tauri.conf.json, package.json, Cargo.toml, Cargo.lock");
console.log(`  Étapes suivantes : git commit -am "chore(release): v${next}" && git push, puis lancer le workflow Release.`);
