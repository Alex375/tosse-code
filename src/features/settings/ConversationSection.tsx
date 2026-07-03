// Settings → Conversation. Picks the GLOBAL Markdown rendering mode. Layout: a left rail
// of the three modes, and a large live conversation preview on the right that renders in
// the selected mode (like the exploration mockups). Selecting a mode writes the global
// pref (display store) — it takes effect immediately everywhere: thread, sub-agent
// transcripts, and `.md` previews.
import { useEffect, useRef } from "react";
import { StreamMarkdown } from "../conversation/StreamMarkdown";
import { useDisplay, type MarkdownMode } from "../../store/display";
import { ClaudeMark, Ico } from "../../ui/kit";
import { PageHead } from "./SettingsKit";

const MODES: Array<{ id: MarkdownMode; label: string; desc: string }> = [
  { id: "classic", label: "Classic", desc: "Le rendu historique, encadré (GitHub)." },
  { id: "warm", label: "Warm", desc: "Doux, accents coral, code coloré, nom de fichier saillant." },
  { id: "minimal", label: "Minimal", desc: "Neutre, typographique, très aéré." },
];

// A rich sample that exercises everything that differs between modes: headings, bold +
// inline code + a file path with a line number, a fenced code block, a blockquote, a
// table, ordered + unordered + task lists, and a link.
const USER_MSG = "Explique le superviseur de sessions et montre un exemple.";
const AI_MSG = [
  "## Architecture du superviseur",
  "Le superviseur maintient **un process `claude` par session**, piloté en *stream-json bidirectionnel*. Contrairement à `claude -p`, le process **vit toute la session**. Voir la [spec du protocole](https://example.com).",
  "",
  "### Composants clés",
  "- **transport** — spawn + reader / writer / stderr",
  "- **control** — canal `control_request` / `control_response`",
  "- **assembler** — normalisation des messages UI",
  "",
  "> Note — le `cwd` n'est pas figé : l'agent peut le déplacer via les worktrees. L'UI suit toujours le `cwd` live.",
  "",
  "### Exemple",
  "```rust",
  "pub async fn spawn_session(cwd: &Path) -> Result<Session> {",
  '    let mut child = Command::new("claude")',
  '        .args(["--output-format", "stream-json", "--verbose"])',
  "        .spawn()?;",
  "    Ok(Session::new(child))",
  "}",
  "```",
  "",
  "La normalisation vit dans `src/features/conversation/StreamMarkdown.tsx:47`.",
  "",
  "| Mode | Persistant | Usage |",
  "| --- | --- | --- |",
  "| stream-json | oui | dialogue interactif |",
  "| one-shot `-p` | non | scripts / CI |",
  "",
  "### Cycle de vie",
  "1. Spawn paresseux au premier message",
  "2. Handshake `initialize`",
  "3. Boucle d'events jusqu'à `result`",
  "",
  "### Reste à faire",
  "- [x] canal de contrôle",
  "- [ ] tools IDE (`openDiff`, `getDiagnostics`)",
].join("\n");

export function ConversationSection() {
  const mode = useDisplay((s) => s.markdownMode);
  const set = useDisplay((s) => s.set);
  // The preview is an illustration: make its whole subtree inert so its interactive bits
  // (the code block's copy button) aren't focusable/clickable.
  const convRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (convRef.current) convRef.current.inert = true;
  }, []);

  return (
    <div className="mdset">
      <PageHead
        title="Conversation"
        subtitle={
          <>
            Le style de rendu du Markdown, appliqué partout : conversations, sous-agents et aperçu
            des fichiers <code>.md</code>. Choisis un mode — l'aperçu montre le résultat.
          </>
        }
      />
      <div className="mdset-body">
        <div className="mdset-rail" role="group" aria-label="Mode de rendu Markdown">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className="mdset-opt"
              aria-pressed={mode === m.id}
              data-on={mode === m.id ? "" : undefined}
              onClick={() => set({ markdownMode: m.id })}
            >
              <span className="mdset-opt-top">
                <span className="mdset-opt-name">{m.label}</span>
                {mode === m.id ? <Ico name="check" className="sm mdset-opt-check" /> : null}
              </span>
              <span className="mdset-opt-desc">{m.desc}</span>
            </button>
          ))}
        </div>

        <div className="mdset-stage" aria-label="Aperçu de la conversation">
          <div className="mdset-conv" ref={convRef}>
            <div className="mdset-umsg">{USER_MSG}</div>
            <div className="mdset-airow">
              <span className="mdset-avatar">
                <ClaudeMark className="sm" />
              </span>
              <div className="mdset-aibody">
                <StreamMarkdown text={AI_MSG} mode={mode} demoFilePaths />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
