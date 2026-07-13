// Composer image attachments — the "+" button and paste-an-image flows.
//
// State is IN-MEMORY and per-conversation (keyed by the stable conv id), NOT
// persisted: base64 image blobs would bloat localStorage, and an attachment is a
// transient part of the message being composed. It survives a conversation switch
// (the pane remounts, but the store doesn't) and is cleared on send. The typed text
// draft lives separately in `composerDrafts` (that one IS persisted).
//
// Only the four media types the model accepts as `image` blocks are attachable
// (png / jpeg / gif / webp — verified against the `claude` binary). Any other file
// picked via "+" is inserted as a path mention in the text instead (Claude reads it
// with its own tools); see ConductorComposer.

import { create } from "zustand";
import { commands } from "../../ipc/client";
import type { UserTurnImage } from "../../store/types";

/** An attachment in the composer: a `UserTurnImage` plus a local id for list keys
 *  and removal. `dataBase64` is raw base64 (no `data:` prefix), wire-ready. */
export interface ImageAttachmentDraft extends UserTurnImage {
  id: string;
}

interface AttachmentsState {
  /** Attachments per conversation stable id. */
  byConv: Record<string, ImageAttachmentDraft[]>;
  add: (convId: string, att: ImageAttachmentDraft) => void;
  remove: (convId: string, id: string) => void;
  clear: (convId: string) => void;
  /** Drop every conversation's attachments — for a full data wipe. */
  clearAll: () => void;
}

export const useComposerAttachments = create<AttachmentsState>((set) => ({
  byConv: {},
  add: (convId, att) =>
    set((s) => ({ byConv: { ...s.byConv, [convId]: [...(s.byConv[convId] ?? []), att] } })),
  remove: (convId, id) =>
    set((s) => ({
      byConv: { ...s.byConv, [convId]: (s.byConv[convId] ?? []).filter((a) => a.id !== id) },
    })),
  clear: (convId) =>
    set((s) => {
      if (!s.byConv[convId]?.length) return s;
      const next = { ...s.byConv };
      delete next[convId];
      return { byConv: next };
    }),
  clearAll: () => set((s) => (Object.keys(s.byConv).length ? { byConv: {} } : s)),
}));

/** Forget one conversation's attachments — call when it's deleted so the in-memory
 *  map doesn't accumulate orphan base64 blobs. Mirrors clearComposerDraft. */
export function clearComposerAttachments(convId: string): void {
  useComposerAttachments.getState().clear(convId);
}

/** Drop every conversation's attachments — call on a full data wipe ("Delete
 *  all"). Mirrors clearAllComposerDrafts. */
export function clearAllComposerAttachments(): void {
  useComposerAttachments.getState().clearAll();
}

const EMPTY: ImageAttachmentDraft[] = [];

/** Reactive selector: this conversation's current attachments (stable empty array). */
export function useConvAttachments(convId: string): ImageAttachmentDraft[] {
  return useComposerAttachments((s) => s.byConv[convId] ?? EMPTY);
}

/** Imperative read (for the send path). */
export function attachmentsFor(convId: string): ImageAttachmentDraft[] {
  return useComposerAttachments.getState().byConv[convId] ?? EMPTY;
}

// ---- media-type gating ------------------------------------------------------

// Extension → wire media type, restricted to what the model accepts as an image
// block. A picked file whose extension isn't here is NOT an attachable image.
const EXT_WIRE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const SUPPORTED_WIRE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The wire media type for a path if it is a model-attachable image, else null. */
export function wireImageMimeForPath(path: string): string | null {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  return EXT_WIRE_MIME[ext] ?? null;
}

/** Normalize a browser blob MIME (paste/drop) to a supported wire type, or null. */
export function normalizeWireMime(mime: string): string | null {
  const m = mime.toLowerCase();
  if (m === "image/jpg") return "image/jpeg";
  if (m === "image/apng") return "image/png";
  return SUPPORTED_WIRE_MIME.has(m) ? m : null;
}

// ---- building attachments ---------------------------------------------------

/** The last path segment of a POSIX-ish path. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `att_${Math.abs(hashString(String(performance.now())))}`;

// Deterministic fallback id (no Math.random) for environments without crypto.
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

/** Outcome of trying to attach a picked file path. `null` = not an attachable image
 *  (caller should treat it as a file mention). `{ error }` = a real, surfaceable
 *  failure (unreadable / too large). */
export type PathAttachResult = ImageAttachmentDraft | { error: string } | null;

/** Read a picked image file's bytes (base64) via the fs service. Returns null when
 *  the path isn't a model-attachable image, so the caller inserts a path mention. */
export async function attachmentFromPath(path: string): Promise<PathAttachResult> {
  const mediaType = wireImageMimeForPath(path);
  if (!mediaType) return null;
  const res = await commands.readImage(path);
  if (res.status === "error") return { error: `Failed to read image: ${res.error}` };
  if (res.data.too_large) return { error: `Image too large: ${basename(path)}` };
  return { id: uid(), name: basename(path), mediaType, dataBase64: res.data.data_base64 };
}

// Byte ceiling for an attached image, mirroring the fs service's MAX_FILE_BYTES
// (src-tauri/src/fs/mod.rs) so BOTH the file-picker path (guarded by read_image's
// too_large) and the paste path enforce the same limit — a full-res base64 blob on
// the wire + in memory would otherwise stall the webview.
export const MAX_ATTACH_BYTES = 16 * 1024 * 1024;

/** Turn a pasted/dropped image blob into an attachment (FileReader → base64). Returns
 *  null when the blob isn't a supported image type, or `{ error }` when it exceeds
 *  MAX_ATTACH_BYTES (the paste path has no fs-layer size guard, unlike the picker). */
export function attachmentFromBlob(blob: Blob, name: string): Promise<PathAttachResult> {
  const mediaType = normalizeWireMime(blob.type);
  if (!mediaType) return Promise.resolve(null);
  if (blob.size > MAX_ATTACH_BYTES) {
    const mib = Math.round(MAX_ATTACH_BYTES / (1024 * 1024));
    return Promise.resolve({ error: `Image too large (max ${mib} MiB): ${name}` });
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? { id: uid(), name, mediaType, dataBase64: url.slice(comma + 1) } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/** A `data:` URL for rendering an attachment/turn image as a thumbnail. */
export function imageDataUrl(img: { mediaType: string; dataBase64: string }): string {
  return `data:${img.mediaType};base64,${img.dataBase64}`;
}
