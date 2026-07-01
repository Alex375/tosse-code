// The effective Markdown mode for a rendered subtree, provided by StreamMarkdown and
// read by children that need it in JS (CodeBlock, to decide the header chrome).
//
// Why a context and not just the store: the Settings preview renders StreamMarkdown with
// an EXPLICIT mode prop (to show all three looks at once) — that forced mode must reach
// CodeBlock, which otherwise would read the GLOBAL store and mis-render the preview. The
// CSS variants key off `data-md-mode` on the root (see conductor-markdown-modes.css); this
// context is only for the bits of chrome that need the value in JS.
import { createContext, useContext } from "react";
import type { MarkdownMode } from "../../store/display";

export const MarkdownModeContext = createContext<MarkdownMode>("classic");

export function useMarkdownModeCtx(): MarkdownMode {
  return useContext(MarkdownModeContext);
}

/**
 * "Demo" flag for the Settings preview: there is no conversation cwd there, so path
 * tokens can't resolve to real files — yet we still want the file-path chip to show so
 * the mode's treatment is visible. When true, MentionInlineCode renders the chip for
 * path-shaped tokens regardless of resolution. In real conversations this stays false, so
 * only ACTUAL files get the chip (a slash-bearing non-file — e.g. a skill name — stays
 * plain, no misleading file icon).
 */
export const MarkdownDemoContext = createContext<boolean>(false);

export function useMarkdownDemo(): boolean {
  return useContext(MarkdownDemoContext);
}
