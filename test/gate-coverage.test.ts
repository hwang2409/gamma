import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const realZetaGates = new Set([
  "real-zeta-compat-gate.ts", // requires real Zeta versions to verify compatibility across protocol generations
  "real-zeta-gate.ts", // requires a real Zeta server for end-to-end protocol behavior
  "real-zeta-grants-gate.ts", // requires real Zeta session-grant persistence and events
  "real-zeta-images-gate.ts", // requires real Zeta image input and storage behavior
]);

const gateCommand = /^(bun scripts\/([^/\s]+-gate\.ts))$/;

function parseGateCommands(script: string): string[] {
  return script
    .split("&&")
    .map((command) => command.trim())
    .filter((command) => gateCommand.test(command));
}

function checkGateCoverage(script: string, gateFiles: readonly string[]) {
  const commands = parseGateCommands(script);
  const listed = new Set(commands.map((command) => command.match(gateCommand)![2]));
  const missing = gateFiles
    .filter((file) => !realZetaGates.has(file) && !listed.has(file));
  const stale = [...listed].filter((file) => !gateFiles.includes(file));
  return { missing, stale };
}

test("parseGateCommands ignores comments and substring mentions", () => {
  expect(parseGateCommands("bun scripts/command-gate.ts # bun scripts/missing-gate.ts")).toEqual([]);
  expect(parseGateCommands("echo bun scripts/missing-gate.ts")).toEqual([]);
  expect(parseGateCommands("bun scripts/command-gate.ts && bun scripts/fidelity-gate.ts")).toEqual([
    "bun scripts/command-gate.ts",
    "bun scripts/fidelity-gate.ts",
  ]);
});

test("checkGateCoverage reports a missing gate", () => {
  expect(checkGateCoverage("bun scripts/command-gate.ts", ["command-gate.ts", "fidelity-gate.ts"]).missing)
    .toEqual(["fidelity-gate.ts"]);
});

test("checkGateCoverage reports a stale gate command", () => {
  expect(checkGateCoverage("bun scripts/command-gate.ts && bun scripts/old-gate.ts", ["command-gate.ts"]).stale)
    .toEqual(["old-gate.ts"]);
});

test("the ci gate script runs every self-contained gate", async () => {
  const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json() as { scripts: { gate: string } };
  const gateFiles = (await readdir(new URL("../scripts", import.meta.url)))
    .filter((file) => file.endsWith("-gate.ts"));
  expect(checkGateCoverage(packageJson.scripts.gate, gateFiles)).toEqual({ missing: [], stale: [] });
});
