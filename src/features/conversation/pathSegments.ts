// Pure helpers to render a file-path token as a segmented chip: directory segments,
// filename, and an optional `:line(:col)` suffix. The CSS modes decide the visual
// treatment (Classic dims separators only; Warm/Minimal make the filename salient and
// colour the line number) — this module just splits the string. Kept pure + tested.

export interface PathParts {
  /** Leading directory segments (may be empty for a bare filename). An absolute path
   *  like `/a/b` yields a leading empty segment so the rendered `/` prefix is kept. */
  dirs: string[];
  /** The last path segment — the filename (minus any `:line` suffix). */
  file: string;
  /** The trailing `:line` or `:line:col` suffix, empty when absent. */
  line: string;
}

/** A token is treated as a path (→ segmented chip) only when it contains a slash.
 *  Bare `foo.json` / `array.map` inline code stays plain to avoid false positives. */
export function looksLikePath(raw: string): boolean {
  return raw.includes("/");
}

/** Split a path token into directory segments, filename and `:line` suffix. */
export function segmentPath(raw: string): PathParts {
  const lm = raw.match(/(:\d+(?::\d+)?)$/);
  const line = lm ? lm[1] : "";
  let body = line ? raw.slice(0, raw.length - line.length) : raw;
  // Drop a leading "./" so "./src/a.ts" doesn't render a bogus "." directory segment.
  if (body.startsWith("./")) body = body.slice(2);
  const segs = body.split("/");
  const file = segs.length ? segs[segs.length - 1] : body;
  const dirs = segs.slice(0, -1);
  return { dirs, file, line };
}

/** Whether the last segment looks like a FILE (has an extension) rather than a directory.
 *  Drives the icon choice (document vs folder); a bare "src/features" reads as a folder. */
export function looksLikeFile(file: string): boolean {
  return /\.[^./\\]+$/.test(file);
}
