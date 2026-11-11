import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const realZetaGates = new Set([
  "real-zeta-compat-gate.ts", // requires real Zeta versions to verify compatibility across protocol generations
  "real-zeta-gate.ts", // requires a real Zeta server for end-to-end protocol behavior
  "real-zeta-grants-gate.ts", // requires real Zeta session-grant persistence and events
  "real-zeta-images-gate.ts", // requires real Zeta image input and storage behavior
]);

test("the ci gate script runs every self-contained gate", async () => {
  const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json() as { scripts: { gate: string } };
  const gateFiles = (await readdir(new URL("../scripts", import.meta.url)))
    .filter((file) => file.endsWith("-gate.ts") && !realZetaGates.has(file));
  const missing = gateFiles.filter((file) => !packageJson.scripts.gate.includes(`scripts/${file}`));

  expect(missing).toEqual([]);
});
