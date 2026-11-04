import { describe, expect, test } from "bun:test";
import { addImage, MAX_BYTES, MAX_IMAGES, type QueuedImage } from "../src/image-queue";
import { settingModel, settingsRequest, catalogModels } from "../src/settings";

const image = (size: number): QueuedImage => ({ name: "a.png", mime_type: "image/png", data: "AA==", url: "blob:a", size });
describe("slice 1 settings", () => {
  test("sanitizes server settings and resends the current model", () => {
    expect(settingModel({ model: "gpt", approval_mode: "allow", ignored: true })).toEqual({ model: "gpt", approval_mode: "allow" });
    expect(settingsRequest({ model: "gpt", approval_mode: "ask" }, { approval_mode: "allow" })).toEqual({ model: "gpt", approval_mode: "allow" });
    expect(catalogModels({ models: [{ id: "gpt" }, "fast"] })).toEqual(["gpt", "fast"]);
  });
});
describe("slice 1 image queue", () => {
  test("enforces zeta count and byte limits", () => {
    let queue: QueuedImage[] = [];
    for (let i = 0; i < MAX_IMAGES; i++) queue = addImage(queue, image(1));
    expect(() => addImage(queue, image(1))).toThrow("up to 4");
    expect(() => addImage([], image(MAX_BYTES + 1))).toThrow("512 KiB");
  });
});
