// Renders a plain string with any http(s) URL turned into a clickable link that opens
// in the OS browser via the opener plugin (never an in-app navigation — a bare
// `<a target="_blank">` isn't reliably opened externally by the Tauri webview, so we
// call openUrl explicitly, mirroring WebSources' SourceChip).
//
// Used on the light "preview" surfaces where the message text is otherwise dead plain
// text: the Flight Deck card's last-message peek + its popover, and the conversation
// LastMessagePin. Links are rendered as `role="link"` spans (NOT `<a>`) so they are
// valid HTML even when nested inside a clickable ancestor (the peek button, the pin
// button) — and they `stopPropagation` so clicking a link never also toggles the
// popover / scrolls the pin.

import { Fragment } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

// A Markdown link `[label](url)` (label shown, url opened) OR a bare http(s) URL.
// The Markdown alternative comes first so `[x](http://y)` isn't half-eaten by the
// bare-URL branch. Both surfaces need this: an agent often writes `[Google](url)`
// (clickable in the conversation via the opener plugin, but the Flight Deck preview
// is plain LinkText — without this the label "Google" would be dead text).
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/gi;

export interface LinkSegment {
  /** The text to DISPLAY (a Markdown link's label, or the URL itself). */
  text: string;
  /** Present when this segment is a link; the URL to open (may differ from `text`). */
  url?: string;
}

/** Split a string into alternating text / link segments, recognising both bare URLs
 *  and Markdown `[label](url)` links. For a bare URL, trailing sentence punctuation and
 *  an unbalanced closing paren are trimmed so "see https://x.com." / "(https://x.com)"
 *  don't capture the trailing char. Pure + exported for unit testing. */
export function splitLinks(text: string): LinkSegment[] {
  const segs: LinkSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index;
    let label: string;
    let url: string;
    let consumed: number;
    if (m[1] !== undefined && m[2] !== undefined) {
      // Markdown link: show the label, open the target, consume the whole `[..](..)`.
      label = m[1];
      url = m[2];
      consumed = m[0].length;
    } else {
      // Bare URL: display == url. Strip trailing sentence punctuation / quotes and an
      // unbalanced trailing ) (leaves it as text; keeps Wikipedia-style URLs intact).
      let raw = m[3];
      raw = raw.replace(/[.,;:!?'"]+$/, "");
      if (raw.endsWith(")") && !raw.includes("(")) raw = raw.replace(/\)+$/, "");
      if (!raw) continue;
      label = raw;
      url = raw;
      consumed = raw.length;
    }
    if (start > last) segs.push({ text: text.slice(last, start) });
    segs.push({ text: label, url });
    last = start + consumed;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs.length ? segs : [{ text }];
}

export function LinkText({ text, inButton = false }: { text: string; inButton?: boolean }) {
  const segs = splitLinks(text);
  // Fast path: no link → render the raw string (no extra spans).
  if (!segs.some((s) => s.url)) return <>{text}</>;

  return (
    <>
      {segs.map((s, i) =>
        s.url ? (
          <span
            key={i}
            className="cv-linktext"
            role="link"
            title={s.url}
            // Inside a clickable ancestor (peek/pin button) the link is not a
            // separate tab stop; standalone (popover) it is keyboard-reachable.
            tabIndex={inButton ? -1 : 0}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void openUrl(s.url!);
            }}
            onKeyDown={
              inButton
                ? undefined
                : (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      void openUrl(s.url!);
                    }
                  }
            }
          >
            {s.text}
          </span>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  );
}
