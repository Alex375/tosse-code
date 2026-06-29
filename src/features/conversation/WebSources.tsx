// Dedicated detail rendering for the web-research tools (WebSearch / WebFetch),
// in place of the generic <pre> dump (ToolResultBody). WebSearch → a list of
// clickable source chips (favicon + title + host) followed by the model's prose
// summary; WebFetch → the single fetched source chip + the page markdown. Chips
// open the URL in the OS browser via the opener plugin (the same path useExtensions
// uses for OAuth links), never an in-app navigation. Mirrors MentionPathChip's
// "authoritative, always-clickable" shape, but for external URLs instead of files.

import { useMemo, useState } from "react";
import { Globe } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import { Expandable } from "../../ui/Expandable";
import { StreamMarkdown } from "./StreamMarkdown";
import { faviconUrl, hostOf, parseWebSearch } from "./webResults";

/** Markdown body of a web result, height-capped like every other tool output
 *  (a fetched page is routinely thousands of lines — keep it from flooding the
 *  transcript, full content one "Voir plus" away). */
function WebMarkdown({ text }: { text: string }) {
  return (
    <Expandable>
      <div className="cv-web-summary">
        <StreamMarkdown text={text} />
      </div>
    </Expandable>
  );
}

/** A clickable external-source chip: favicon (→ Globe on error) + title + host. */
function SourceChip({ url, title }: { url: string; title: string }) {
  const host = hostOf(url);
  const fav = faviconUrl(url);
  const [broken, setBroken] = useState(false);
  // When the title is just the host (WebFetch's single source), don't repeat it.
  const showHost = host && title.trim() !== host;

  return (
    <button
      type="button"
      className="cv-src"
      title={url}
      onClick={(e) => {
        e.stopPropagation();
        void openUrl(url);
      }}
    >
      {fav && !broken ? (
        <img
          className="cv-src-fav"
          src={fav}
          alt=""
          width={16}
          height={16}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <Globe className="cv-src-fav cv-src-fav-ico" size={14} aria-hidden />
      )}
      <span className="cv-src-title">{title}</span>
      {showHost ? <span className="cv-src-host">{host}</span> : null}
    </button>
  );
}

function WebSearchDetail({ text }: { text: string }) {
  const { links, summary } = useMemo(() => parseWebSearch(text), [text]);
  const empty = links.length === 0 && summary.trim() === "";
  return (
    <div className="cv-web">
      {links.length > 0 ? (
        <>
          <div className="cv-web-lead">
            {links.length} source{links.length > 1 ? "s" : ""}
          </div>
          <div className="cv-web-sources">
            {links.map((l, i) => (
              <SourceChip key={`${i}-${l.url}`} url={l.url} title={l.title} />
            ))}
          </div>
        </>
      ) : null}
      {summary ? <WebMarkdown text={summary} /> : null}
      {empty ? <div className="cv-web-empty">Aucune source.</div> : null}
    </div>
  );
}

function WebFetchDetail({ url, text }: { url: string | null; text: string }) {
  return (
    <div className="cv-web">
      {url ? (
        <div className="cv-web-sources">
          <SourceChip url={url} title={hostOf(url)} />
        </div>
      ) : null}
      {text.trim() ? (
        <WebMarkdown text={text} />
      ) : (
        <div className="cv-web-empty">Aucun contenu récupéré.</div>
      )}
    </div>
  );
}

/** Detail body for WebSearch / WebFetch. `text` is the flattened tool_result. */
export function WebToolDetail({
  name,
  input,
  text,
}: {
  name: string;
  input: JsonValue;
  text: string;
}) {
  if (name === "WebSearch") return <WebSearchDetail text={text} />;
  return <WebFetchDetail url={field(input, "url") ?? null} text={text} />;
}
