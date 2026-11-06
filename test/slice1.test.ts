import { describe, expect, test } from "bun:test";
import { addImage, MAX_BYTES, MAX_IMAGES, readImage, type QueuedImage } from "../src/image-queue";
import { settingModel, settingsRequest, catalogModels, catalogProviders } from "../src/settings";

const image = (size: number): QueuedImage => ({ name: "a.png", mime_type: "image/png", data: "AA==", url: "blob:a", size });
describe("slice 1 settings", () => {
  test("sanitizes server settings and resends the current model", () => {
    expect(settingModel({ model: "gpt", approval_mode: "allow", ignored: true })).toEqual({ model: "gpt", approval_mode: "allow" });
    expect(settingsRequest({ model: "gpt", approval_mode: "ask" }, { approval_mode: "allow" })).toEqual({ model: "gpt", approval_mode: "allow" });
    expect(catalogModels({ models: [{ id: "gpt" }, "fast"] })).toEqual(["gpt", "fast"]);
    expect(catalogProviders({ providers: { "claude-opus-4-6": "claude", bad: 1 } })).toEqual({ "claude-opus-4-6": "claude" });
  });
});
describe("slice 1 image queue", () => {
  test("enforces zeta count and byte limits", async () => {
    let queue: QueuedImage[] = [];
    for (let i = 0; i < MAX_IMAGES; i++) queue = addImage(queue, image(1));
    expect(() => addImage(queue, image(1))).toThrow("up to 4");
    expect(() => addImage([], image(MAX_BYTES + 1))).toThrow("512 KiB");
    await expect(readImage(new File([new Uint8Array(MAX_BYTES + 1)], "large.png", { type: "image/png" }))).rejects.toThrow("512 KiB");
    const nearLimit = await readImage(new File([new Uint8Array(MAX_BYTES - 1)], "near-limit.png", { type: "image/png" }));
    expect(nearLimit.data).toHaveLength(Math.ceil((MAX_BYTES - 1) / 3) * 4);
  });
});
