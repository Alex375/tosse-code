// Parsing + helpers for the web-research tools (WebSearch / WebFetch). Their
// tool_result is a plain STRING — Claude Code does not hand us structured JSON —
// so the structure has to be recovered from the text (verified against real
// captures, see src-tauri/.../fixtures/capture_websearch.jsonl):
//
//   WebSearch content:
//     Web search results for query: "<query>"
//
//     Links: [{"title":"…","url":"…"}, …]
//
//     <optional prose summary written by the model>
//
//   WebFetch content:
//     <markdown of the fetched page>      (no link list — the single source is input.url)
//
// Pure + framework-free so it is unit-testable and the renderer (WebSources.tsx)
// stays thin. NOTE: the WebSearch link objects carry only title+url — there is no
// per-result snippet on the wire.

export interface WebLink {
  title: string;
  url: string;
}

export interface WebSearchParsed {
  /** The searched query, recovered from the header line (null if absent). */
  query: string | null;
  /** The result links (title + url); empty when the text isn't the expected shape. */
  links: WebLink[];
  /** Any prose after the `Links: […]` array (the model's summary), trimmed. May be "". */
  summary: string;
}

/** Hostname without a leading `www.`, or the raw input when it isn't a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * A favicon image URL for the host (Google's S2 service). Returns null when the
 * input doesn't parse as a URL. The chip lazy-loads this and falls back to a
 * local Globe glyph on error, so a failed/blocked request costs nothing visible.
 */
export function faviconUrl(url: string): string | null {
  let host: string | null = null;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

/**
 * Slice the balanced JSON array starting at `start` in `s`, string-aware so a
 * `]` inside a title doesn't end it early. Returns the `[…]` substring and the
 * index just past it, or `{ json: null }` when no balanced array is found.
 */
function sliceJsonArray(s: string, start: number): { json: string | null; end: number } {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return { json: s.slice(start, i + 1), end: i + 1 };
    }
  }
  return { json: null, end: s.length };
}

/**
 * Parse a WebSearch tool_result string into its query, link list and trailing
 * summary. Defensive: any deviation from the expected shape degrades to
 * `links: []` with `summary` holding the whole text, so the renderer never hides
 * content it failed to structure.
 */
export function parseWebSearch(text: string): WebSearchParsed {
  const queryMatch = text.match(/Web search results for query:\s*"([^"]*)"/);
  const query = queryMatch ? queryMatch[1] : null;

  const linksAt = text.indexOf("Links:");
  if (linksAt < 0) {
    return { query, links: [], summary: text.trim() };
  }

  const after = text.slice(linksAt + "Links:".length);
  const arrAt = after.indexOf("[");
  if (arrAt < 0) {
    return { query, links: [], summary: text.trim() };
  }

  const { json, end } = sliceJsonArray(after, arrAt);
  if (json) {
    try {
      const arr = JSON.parse(json) as unknown;
      if (Array.isArray(arr)) {
        // A valid array is authoritative even when empty: the sources are exactly
        // these, and the summary is whatever follows the array. A zero-result
        // search (`Links: []`) thus yields no chips and an empty summary — never the
        // raw `Links: []` scaffolding (which the whole-text fallback would leak).
        const links: WebLink[] = arr
          .filter(
            (x): x is { title?: unknown; url: string } =>
              !!x && typeof x === "object" && typeof (x as { url?: unknown }).url === "string",
          )
          .map((x) => ({
            url: x.url,
            // No usable title → show just the host (SourceChip then dedupes it),
            // not the full raw URL.
            title: typeof x.title === "string" && x.title.trim() ? x.title : hostOf(x.url),
          }));
        return { query, links, summary: after.slice(end).trim() };
      }
    } catch {
      // Malformed JSON: fall through and keep the whole text below.
    }
  }

  // No parsable array → keep the whole text so nothing is lost.
  return { query, links: [], summary: text.trim() };
}
