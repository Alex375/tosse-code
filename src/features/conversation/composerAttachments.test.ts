import { describe, expect, it, beforeEach } from "vitest";
import {
  attachmentFromBlob,
  attachmentsFor,
  basename,
  imageDataUrl,
  MAX_ATTACH_BYTES,
  normalizeWireMime,
  useComposerAttachments,
  wireImageMimeForPath,
  type ImageAttachmentDraft,
} from "./composerAttachments";

describe("wireImageMimeForPath", () => {
  it("maps model-attachable image extensions to their wire MIME", () => {
    expect(wireImageMimeForPath("/a/b/shot.png")).toBe("image/png");
    expect(wireImageMimeForPath("photo.JPG")).toBe("image/jpeg");
    expect(wireImageMimeForPath("x.jpeg")).toBe("image/jpeg");
    expect(wireImageMimeForPath("x.jfif")).toBe("image/jpeg");
    expect(wireImageMimeForPath("anim.gif")).toBe("image/gif");
    expect(wireImageMimeForPath("pic.webp")).toBe("image/webp");
  });

  it("returns null for non-attachable files (routed to a path mention instead)", () => {
    expect(wireImageMimeForPath("notes.md")).toBeNull();
    expect(wireImageMimeForPath("main.rs")).toBeNull();
    // Image-ish but NOT accepted as an image block by the model.
    expect(wireImageMimeForPath("icon.svg")).toBeNull();
    expect(wireImageMimeForPath("photo.heic")).toBeNull();
    expect(wireImageMimeForPath("Makefile")).toBeNull();
  });
});

describe("normalizeWireMime", () => {
  it("keeps the four supported types and normalizes aliases", () => {
    expect(normalizeWireMime("image/png")).toBe("image/png");
    expect(normalizeWireMime("image/jpeg")).toBe("image/jpeg");
    expect(normalizeWireMime("image/jpg")).toBe("image/jpeg");
    expect(normalizeWireMime("image/apng")).toBe("image/png");
    expect(normalizeWireMime("IMAGE/GIF")).toBe("image/gif");
    expect(normalizeWireMime("image/webp")).toBe("image/webp");
  });

  it("rejects unsupported types", () => {
    expect(normalizeWireMime("image/svg+xml")).toBeNull();
    expect(normalizeWireMime("application/pdf")).toBeNull();
    expect(normalizeWireMime("text/plain")).toBeNull();
  });
});

describe("basename", () => {
  it("returns the last path segment, tolerating trailing slashes", () => {
    expect(basename("/a/b/c.png")).toBe("c.png");
    expect(basename("c.png")).toBe("c.png");
    expect(basename("/a/b/")).toBe("b");
  });
});

describe("imageDataUrl", () => {
  it("builds a data URL from mediaType + base64", () => {
    expect(imageDataUrl({ mediaType: "image/png", dataBase64: "AAAA" })).toBe(
      "data:image/png;base64,AAAA",
    );
  });
});

describe("attachments store", () => {
  const conv = "conv-1";
  const att = (id: string): ImageAttachmentDraft => ({
    id,
    name: `${id}.png`,
    mediaType: "image/png",
    dataBase64: "AAAA",
  });

  beforeEach(() => {
    useComposerAttachments.setState({ byConv: {} });
  });

  it("adds, removes, and clears per conversation", () => {
    const s = useComposerAttachments.getState();
    s.add(conv, att("a"));
    s.add(conv, att("b"));
    s.add("other", att("c"));
    expect(attachmentsFor(conv).map((a) => a.id)).toEqual(["a", "b"]);
    expect(attachmentsFor("other").map((a) => a.id)).toEqual(["c"]);

    s.remove(conv, "a");
    expect(attachmentsFor(conv).map((a) => a.id)).toEqual(["b"]);

    s.clear(conv);
    expect(attachmentsFor(conv)).toEqual([]);
    // Clearing one conversation must not touch another.
    expect(attachmentsFor("other").map((a) => a.id)).toEqual(["c"]);
  });

  it("clearAll drops every conversation's attachments", () => {
    const s = useComposerAttachments.getState();
    s.add(conv, att("a"));
    s.add("other", att("c"));
    s.clearAll();
    expect(attachmentsFor(conv)).toEqual([]);
    expect(attachmentsFor("other")).toEqual([]);
    expect(useComposerAttachments.getState().byConv).toEqual({});
  });

  it("returns a stable empty array for an unknown conversation", () => {
    expect(attachmentsFor("nope")).toEqual([]);
  });
});

describe("attachmentFromBlob", () => {
  it("returns null for an unsupported blob type", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/svg+xml" });
    expect(await attachmentFromBlob(blob, "x.svg")).toBeNull();
  });

  it("rejects a blob over the size ceiling without reading it", async () => {
    // A stub blob past the cap — attachmentFromBlob must bail on size before FileReader.
    const huge = { type: "image/png", size: MAX_ATTACH_BYTES + 1 } as unknown as Blob;
    const res = await attachmentFromBlob(huge, "big.png");
    expect(res && "error" in res ? res.error : null).toMatch(/too large/i);
  });

  it("reads a small supported image into a wire-ready base64 draft", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const res = await attachmentFromBlob(blob, "small.png");
    expect(res && !("error" in res) ? res.mediaType : null).toBe("image/png");
    expect(res && !("error" in res) ? res.dataBase64.length > 0 : false).toBe(true);
  });
});
