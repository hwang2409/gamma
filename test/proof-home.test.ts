import { expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertPrivateProofHome } from "../scripts/proof-home";

const worktree = "/Users/henry/me/fun/zeta/.worktrees/parity-g3-proof";

test("real-zeta proofs accept only explicit private homes under tmp or the proof worktree", () => {
  expect(assertPrivateProofHome(join(tmpdir(), "gamma-proof-123", "zeta-home"), worktree)).toBe(join(tmpdir(), "gamma-proof-123", "zeta-home"));
  expect(assertPrivateProofHome(join(worktree, ".proof-home"), worktree)).toBe(join(worktree, ".proof-home"));
  expect(() => assertPrivateProofHome(undefined, worktree)).toThrow("explicit private ZETA_HOME");
  expect(() => assertPrivateProofHome(join(homedir(), ".zeta"), worktree)).toThrow("must never use the default ~/.zeta");
  expect(() => assertPrivateProofHome(join(homedir(), ".zeta", "scratch", "gamma", "proof"), worktree)).toThrow("must never use the default ~/.zeta");
  expect(() => assertPrivateProofHome(join(homedir(), "gamma-proof"), worktree)).toThrow("must be under the proof worktree or the system temp directory");
});
