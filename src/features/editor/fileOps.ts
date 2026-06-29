// Pure path helpers for the file explorer's mutating operations (new file / new
// folder / rename / copy / paste). No IPC, no React — just string logic, so
// collision-free naming, path joining and name validation are trivially testable.
// Paths are absolute POSIX (our only platform separator is "/").

/** Join a directory and a child name with a single "/". */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : dir + "/" + name;
}

/** Split a filename into its stem and extension (the extension INCLUDES the
 *  leading dot). A leading dot is not an extension separator, so a dotfile like
 *  ".gitignore" keeps its full name as the stem with an empty extension — a
 *  duplicate becomes ".gitignore copy", not ".gitignore copy" mangled at the dot. */
export function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** The VS Code-style collision name for the Nth duplicate of `name`: n≤1 → "stem
 *  copy.ext", n≥2 → "stem copy N.ext". */
export function copyName(name: string, n: number): string {
  const { stem, ext } = splitName(name);
  const suffix = n <= 1 ? " copy" : ` copy ${n}`;
  return `${stem}${suffix}${ext}`;
}

/** Resolve a non-colliding destination path for `name` inside `dir`, probing the
 *  filesystem via `exists`. Tries the bare name first, then "name copy", "name
 *  copy 2", … — returning the first free absolute path. */
export async function uniqueDest(
  dir: string,
  name: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  const bare = joinPath(dir, name);
  if (!(await exists(bare))) return bare;
  for (let n = 1; n < 1000; n++) {
    const candidate = joinPath(dir, copyName(name, n));
    if (!(await exists(candidate))) return candidate;
  }
  // Pathological: 1000 collisions. Fall back to a name almost certainly free.
  return joinPath(dir, copyName(name, Date.now()));
}

/** Whether `child` is `ancestor` itself or sits anywhere beneath it — used to
 *  forbid pasting/moving a folder into its own subtree. */
export function isWithin(ancestor: string, child: string): boolean {
  return child === ancestor || child.startsWith(ancestor + "/");
}

/** Validate a name typed into the inline editor. Returns a French error string, or
 *  null when the name is acceptable: non-empty, no path separator, not "."/"..". */
export function validateName(name: string): string | null {
  const t = name.trim();
  if (!t) return "Le nom ne peut pas être vide.";
  if (t === "." || t === "..") return "Nom réservé.";
  if (t.includes("/")) return "Le nom ne peut pas contenir « / ».";
  return null;
}
