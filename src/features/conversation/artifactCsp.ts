// The Content-Security-Policy we inject into an artifact's HTML before rendering it in the
// side-region preview iframe.
//
// WHY THIS EXISTS: on claude.ai an artifact page is served behind a STRICT CSP that blocks every
// external host — no CDN script, no remote font, no image from another origin, no fetch / XHR /
// WebSocket. That policy is a large part of why opening an artifact is safe at all. In-app we
// have NEITHER half of that guarantee for free:
//   - the app's own Tauri CSP is `null` (`tauri.conf.json` `security.csp`), so nothing is
//     restricted at the webview level;
//   - the iframe's `sandbox` (no `allow-same-origin`) only gives the document a NULL ORIGIN. That
//     isolates the artifact from the app and its storage, but a null origin can still open
//     sockets, fetch remote URLs and load remote subresources.
// Without this policy, previewing an artifact inside Flight Deck would be strictly MORE
// permissive than opening the exact same page on claude.ai — an artifact could quietly phone
// home (or exfiltrate its own contents) from within our window. So we re-create the guarantee
// locally, in the document itself, since we cannot set response headers on a `srcDoc` document.

/**
 * The policy. `default-src 'none'` denies everything, then each directive re-allows exactly what a
 * SELF-CONTAINED artifact legitimately needs: inline code/style and `data:`/`blob:` payloads it
 * carries or builds itself. No directive ever names a host or scheme that can reach the network,
 * so every external origin is refused by construction — adding one is the one edit that would
 * break the guarantee.
 */
export const ARTIFACT_CSP = [
  // Deny by default. Anything not re-allowed below (external scripts/styles/frames/objects,
  // `<object>`/`<embed>`, nested browsing contexts, manifests…) is blocked.
  "default-src 'none'",
  // Artifacts are single self-contained documents: an inline `<script>` is the norm, and some
  // embed a template/bundler shim that needs `eval`. `blob:` covers scripts a page builds for
  // itself at runtime. No host source is listed ⇒ no external script can ever load.
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  // Inline `<style>` blocks AND `style=""` attributes (both are covered by 'unsafe-inline').
  "style-src 'unsafe-inline'",
  // Embedded assets only: an artifact inlines its images/fonts/media as data URIs (or generates
  // them as blobs, e.g. a canvas export). A remote URL is refused.
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  // Workers are legitimate (an artifact may offload work), but only from its own blob.
  "worker-src blob:",
  // The whole point: NO network. Blocks fetch/XHR/WebSocket/EventSource/sendBeacon outright —
  // this is what makes an in-app preview no more capable than the hosted page.
  "connect-src 'none'",
  // A form POST is an exfiltration channel CSP treats separately from `connect-src`.
  "form-action 'none'",
  // `<base href>` would silently re-point every relative URL in the document; deny it so the
  // directives above can't be routed around.
  "base-uri 'none'",
].join("; ");

/** The element we splice in. Kept short: it sits before any `<meta charset>` the document
 *  declares, and the charset sniffing window is the first 1024 bytes — this is ~350. */
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;

// Anchored: only a doctype that is ALREADY first counts. A leading run of whitespace or comments
// (a licence header) is still "first" to the parser, so it is skipped too — the insertion point
// lands right AFTER the doctype, never before it (see the quirks-mode warning below).
// ⚠️ Every piece is UNAMBIGUOUS on purpose: ONE whitespace char per iteration (not `\s+` nested in
// a `*`) and a comment body that can only end at its FIRST `-->` (not a lazy `[\s\S]*?`). Both
// "obvious" spellings nest a quantifier inside a quantifier, so a crafted artifact — a long run of
// comments with no doctype after them — would backtrack exponentially on every single render.
const LEADING_DOCTYPE_RE = /^(?:\s|<!--(?:[^-]|-(?!->))*-->)*<!doctype\b[^>]*>/i;

function spliceAt(html: string, index: number, insert: string): string {
  return html.slice(0, index) + insert + html.slice(index);
}

/**
 * Return `html` with the artifact CSP meta injected ahead of every token but the doctype.
 *
 * ⚠️ WE NEVER SEARCH THE STRING FOR `<head>` OR `<html>` — do not "improve" this by preferring the
 * document's own head. Two independent reasons, both VERIFIED in a `srcDoc` iframe carrying the
 * viewer's exact `sandbox`:
 *
 *  1. A regex cannot tell real markup from a `<head` that merely OCCURS in the text — and an
 *     artifact file is very often a FRAGMENT (the Artifact tool tells the model to omit
 *     doctype/html/head; the skeleton is added at publish time). A common fragment shape is an
 *     "export as HTML" button holding a whole document in a JS template literal, whose `<head` wins
 *     the race. Splicing there emits the meta as inert characters: the document then parses with
 *     ZERO policy elements and issues its network requests with no violation logged — silently,
 *     exactly the capability this module exists to remove — while the artifact's own code is
 *     corrupted (inside a double-quoted JS string our `content="` closes the literal ⇒ SyntaxError).
 *
 *  2. Even on REAL markup, a tag's position in the SOURCE is not where the parser's head BEGINS. In
 *     `<!doctype html><script src=…></script><html><head>…` the script is reached in "before html":
 *     the parser opens an implied `<html>` then an implied `<head>`, FETCHES the script, and only
 *     then discards the explicit `<head>` token as a parse error. A meta spliced after that ignored
 *     token lands BEHIND the request it was meant to block — and a meta CSP only governs resources
 *     requested after it is parsed, so the remote script loads unrestricted while the rest of the
 *     page is policed, which makes the hole look like the policy is working.
 *
 * The earliest position is always legal, so that is simply where it goes: a `<meta>` ahead of
 * `<html>` is adopted by the parser's IMPLIED head (it becomes head's first child), and a later
 * `<html lang=…>` start tag merges its attributes onto the element already open — nothing is
 * displaced, nothing is lost, no wrapper of our own is needed.
 *
 * ⚠️ Equally, do not "simplify" this to a bare prepend: a doctype that is not first is IGNORED and
 * the artifact silently drops into QUIRKS MODE (box model, line height, table sizing shift under
 * the user, with no error anywhere). Right after a leading doctype is the one position that
 * satisfies both constraints. A `srcDoc` document is standards-mode regardless, but the invariant
 * costs one anchored regex and survives any reuse of this helper outside the iframe.
 *
 * Pure and O(1)-ish: no DOM, no I/O, ONE anchored probe — never a scan of a possibly multi-MB
 * document, and it runs on every artifact render.
 *
 * NOTE: a document that ships its OWN CSP meta does not weaken ours — multiple policies all
 * apply, and a resource must satisfy every one of them.
 */
export function withArtifactCsp(html: string): string {
  const doctype = LEADING_DOCTYPE_RE.exec(html);
  return spliceAt(html, doctype ? doctype[0].length : 0, CSP_META);
}
