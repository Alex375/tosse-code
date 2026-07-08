import { clsx } from "clsx";
import type { JsonValue } from "../../ipc/client";
import { Expandable } from "../../ui/Expandable";
import { imageDataUrl } from "./composerAttachments";
import styles from "./ToolCard.module.css";

/** An image carried by a tool_result — e.g. a `Read` of a screenshot. The CLI returns
 *  the bytes as a content block `{ type:"image", source:{ type:"base64", media_type, data } }`.
 *  Without special handling this block gets JSON.stringify'd into a giant base64 string
 *  (the "bytecode" the user sees instead of the picture). */
interface ResultImage {
  mediaType: string;
  dataBase64: string;
}

function isRecord(v: JsonValue): v is Record<string, JsonValue> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Extract base64 image blocks from a tool_result content array (empty when there are none,
 *  or when content is a plain string/object). Pure + exported for unit testing. */
export function imageBlocksFromContent(content: JsonValue): ResultImage[] {
  if (!Array.isArray(content)) return [];
  const out: ResultImage[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "image") continue;
    const source = block.source;
    if (!isRecord(source) || source.type !== "base64") continue;
    const { media_type: mediaType, data } = source;
    if (typeof mediaType === "string" && typeof data === "string") {
      out.push({ mediaType, dataBase64: data });
    }
  }
  return out;
}

/** Defensive renderer: tool_result content can be string | array | object | null.
 *  Image blocks are handled separately (rendered as a visual preview), so they are
 *  SKIPPED here rather than stringified into base64 bytecode. */
function contentToText(content: JsonValue): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean")
    return String(content);
  if (Array.isArray(content)) {
    return content
      .filter((block) => !(isRecord(block) && block.type === "image"))
      .map((block) => {
        if (isRecord(block) && typeof block.text === "string") return block.text;
        return JSON.stringify(block, null, 2);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

/** True when a tool_result carries no textual output (null, empty, or whitespace) —
 *  e.g. a command that printed nothing. Image-only results are also "empty" here
 *  (they have no text), so callers must check for images separately. Surfaced as a
 *  discreet note rather than a blank box. Pure + exported for unit testing. */
export function isEmptyResult(content: JsonValue): boolean {
  return contentToText(content).trim() === "";
}

export function ToolResultBody({
  content,
  isError,
}: {
  content: JsonValue;
  isError: boolean;
}) {
  const images = imageBlocksFromContent(content);
  const text = contentToText(content);
  const hasText = text.trim() !== "";

  // No textual output AND no image on SUCCESS (the common "command printed nothing"
  // case) → a discreet muted note instead of an empty <pre>.
  if (!isError && !hasText && images.length === 0) {
    return <div className={styles.emptyNote}>Aucune sortie.</div>;
  }

  // An errored result keeps its red bubble, but an empty body must still say something —
  // a blank red box would carry no information (the CLI almost always attaches a message,
  // but a null/empty error result is possible). An image-only error still shows the image.
  const errorPlaceholder = isError && !hasText && images.length === 0;
  const shown = errorPlaceholder ? "(erreur sans message)" : text;

  return (
    <div className={styles.result}>
      {images.length ? (
        <div className={styles.resultImages}>
          {images.map((img, i) => (
            <img
              key={i}
              className={styles.resultImage}
              src={imageDataUrl(img)}
              alt="Image lue par l'outil"
            />
          ))}
        </div>
      ) : null}
      {hasText || errorPlaceholder ? (
        <Expandable fadeColor={isError ? "var(--error-bg)" : undefined}>
          <pre className={clsx(styles.pre, isError && styles.errorOutput)}>{shown}</pre>
        </Expandable>
      ) : null}
    </div>
  );
}
