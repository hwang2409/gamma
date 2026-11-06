import { expect, test } from "bun:test";
import { createComposerDrafts } from "../src/composer";
import type { QueuedImage } from "../src/image-queue";

const image = (url: string) => ({ url, name: `${url}.png`, mime_type: "image/png", data: "", size: 1, width: 1, height: 1 }) as QueuedImage;

test("composer drafts keep recent runs and revoke attachments when a run is evicted", () => {
  const revoked: string[] = [];
  const original = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  try {
    const drafts = createComposerDrafts(2);
    drafts.set("a", { text: "private a", images: [image("blob:a")] });
    drafts.set("b", { text: "draft b", images: [image("blob:b")] });
    drafts.set("c", { text: "draft c", images: [] });
    expect(drafts.get("a")).toEqual({ text: "", images: [] });
    expect(drafts.get("b").text).toBe("draft b");
    expect(revoked).toEqual(["blob:a"]);
    drafts.dispose();
    expect(revoked).toEqual(["blob:a", "blob:b"]);
  } finally { URL.revokeObjectURL = original; }
});
