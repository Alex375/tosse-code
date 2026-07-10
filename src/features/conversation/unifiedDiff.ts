// Parse a unified (git-style) diff into the SAME `DiffLine[]` shape DiffView renders for a
// Claude Edit — so a Codex `fileChange` (which ships a pre-computed per-file unified diff
// string, not old/new text) renders as a proper red/green diff instead of a raw <pre> dump.
// Framework-free and reusable for any unified diff (could later unify Claude's diff path).
import type { JsonValue } from "../../ipc/client";
import type { DiffLine } from "./lineDiff";

// `@@ -oldStart[,oldCount] +newStart[,newCount] @@` — the counts are optional (git omits
// them when 1). We only need the two START line numbers to seed the gutters.
const HUNK_HEADER = /^@@+\s-(\d+)(?:,\d+)?\s\+(\d+)(?:,\d+)?\s@@/;

/**
 * Parse a single file's unified diff into `DiffLine[]`. Robust to leading file headers
 * (`diff --git`, `--- a/…`, `+++ b/…`, `index …`, `rename …`): everything before the first
 * `@@` hunk is skipped, so a `---`/`+++` header is never mistaken for a removed/added line.
 * Line numbers are seeded from each hunk header and advance per body line. `\ No newline at
 * end of file` markers are dropped. Returns `[]` for empty/garbage input (never throws).
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  if (!diff) return out;
  // Drop a single trailing newline so `split` doesn't manufacture a bogus empty line at the
  // end (a genuinely empty context line is encoded as " ", handled below).
  const body = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of body.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = HUNK_HEADER.exec(raw);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
        inHunk = true;
      }
      // The hunk header itself is not a rendered content line.
      continue;
    }
    if (!inHunk) continue; // file headers before the first hunk
    const sign = raw[0];
    if (sign === "+") {
      out.push({ type: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (sign === "-") {
      out.push({ type: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (sign === "\\") {
      // "\ No newline at end of file" — diff metadata, not file content.
      continue;
    } else {
      // Context: a leading space (normal) or a bare empty line inside the hunk (some tools
      // emit trailing context without the space). Advance BOTH gutters.
      out.push({
        type: "context",
        text: sign === " " ? raw.slice(1) : raw,
        oldNo: oldNo++,
        newNo: newNo++,
      });
    }
  }
  return out;
}

/** One file touched by a Codex ApplyPatch card. */
export interface PatchChange {
  path: string;
  diff: string;
}

/**
 * Extract the per-file changes of a Codex `ApplyPatch` card. The RESULT is authoritative:
 * the card's `input` is frozen at `item/started`, whose change list can be empty (the diffs
 * ride on the completed result), so we read the result first and fall back to the input only
 * when there is no result yet (a still-running card). Never throws on a malformed payload.
 */
export function applyPatchChanges(
  input: JsonValue,
  result: JsonValue | undefined,
): PatchChange[] {
  const fromResult = extractChanges(result);
  return fromResult.length ? fromResult : extractChanges(input);
}

/** Pull a `{ changes: [{path, diff}, …] }` array out of an arbitrary JSON value. */
function extractChanges(v: JsonValue | undefined): PatchChange[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  const changes = (v as Record<string, JsonValue>).changes;
  if (!Array.isArray(changes)) return [];
  const out: PatchChange[] = [];
  for (const c of changes) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const rec = c as Record<string, JsonValue>;
    out.push({
      path: typeof rec.path === "string" ? rec.path : "",
      diff: typeof rec.diff === "string" ? rec.diff : "",
    });
  }
  return out;
}
