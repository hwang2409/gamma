import { expect, test } from "bun:test";
import { canSubmitComposer } from "../src/composer";

test("an active slash command can be checked without sending its attached image", () => {
  expect(canSubmitComposer(false, "/plan", 1, false, true)).toBe(true);
  expect(canSubmitComposer(false, "steer this", 1, false, true)).toBe(false);
  expect(canSubmitComposer(false, "/plan", 1, true, true)).toBe(false);
});
