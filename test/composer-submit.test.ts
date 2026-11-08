import { expect, test } from "bun:test";
import { canSubmitComposer } from "../src/composer";

test("an active slash command can be checked without sending its attached image", () => {
  expect(canSubmitComposer(false, "/plan", 1, false, true)).toBe(true);
  expect(canSubmitComposer(false, "steer this", 1, false, true)).toBe(false);
  expect(canSubmitComposer(false, "/plan", 1, true, true)).toBe(false);
});

test("gamma's own commands submit while sending is paused; zeta commands and messages wait", () => {
  expect(canSubmitComposer(true, "/keys", 0, false, false)).toBe(true);
  expect(canSubmitComposer(true, "/theme dracula", 0, false, false)).toBe(true);
  expect(canSubmitComposer(true, "/status", 0, false, false)).toBe(false);
  expect(canSubmitComposer(true, "hello", 0, false, false)).toBe(false);
});
