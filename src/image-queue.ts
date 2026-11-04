export const MAX_IMAGES = 4;
export const MAX_BYTES = 512 * 1024;
export type QueuedImage = { name: string; mime_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string; url: string; size: number };
const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export async function readImage(file: File): Promise<QueuedImage> {
  if (!allowed.has(file.type)) throw new Error("only png, jpeg, gif, and webp images are supported");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const data = btoa(String.fromCharCode(...bytes));
  return { name: file.name || "image.png", mime_type: file.type as QueuedImage["mime_type"], data, url: URL.createObjectURL(file), size: bytes.byteLength };
}
export function addImage(queue: readonly QueuedImage[], image: QueuedImage) {
  if (queue.length >= MAX_IMAGES) throw new Error("up to 4 images can be sent");
  if (queue.reduce((sum, item) => sum + item.size, 0) + image.size > MAX_BYTES) throw new Error("images must be 512 KiB or smaller in total");
  return [...queue, image];
}
