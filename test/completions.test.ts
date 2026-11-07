import { expect, test } from "bun:test";
import { CompletionModel, findCompletionToken, type CompletionResponse } from "../src/completions";

const entry = (insert_text: string, display_text = insert_text, kind: "file" | "directory" = "file") => ({ insert_text, display_text, kind });
function pending() {
  let resolve!: (response: CompletionResponse) => void;
  const request = (query: string) => new Promise<CompletionResponse>((r) => { resolve = (response) => r(response); void query; });
  return { request, reply: (response: CompletionResponse) => resolve(response) };
}

 test("replaces the @ token at the start, middle, and end with insert_text", async () => {
  for (const [before, expected, caret, expectedCaret] of [
    ["@re", "@report.txt", 3, 11],
    ["say @re now", "say @report.txt now", 7, 15],
    ["say @re", "say @report.txt", 7, 15],
  ] as const) {
    const model = new CompletionModel(async () => ({ entries: [entry("report.txt", "report")], truncated: false }), true);
    model.update(before, caret);
    await Promise.resolve();
    expect(model.key("Enter")).toEqual({ handled: true, submitted: false, accepted: { value: expected, caret: expectedCaret } });
  }
});

test("keeps server quoting and directory slash, and does not use display_text", async () => {
  const model = new CompletionModel(async () => ({ entries: [entry("folder with space/", "folder with space", "directory"), entry("other", "different")], truncated: false }), true);
  model.update('open @"fol', 10);
  await Promise.resolve();
  expect(model.key("Enter").accepted).toEqual({ value: 'open @"folder with space/', caret: 25 });
});

test("finds only a token that starts after whitespace and supports a caret in its prefix", () => {
  expect(findCompletionToken("say @path/file.txt", 9)?.query).toBe("path");
  expect(findCompletionToken("sayx@path", 9)).toBeUndefined();
  expect(findCompletionToken("@\"space path", 12)?.query).toBe("space path");
});

test("edits invalidate an in-flight response and stale replies do not open the menu", async () => {
  const first = pending();
  const second = pending();
  let call = 0;
  const model = new CompletionModel((query) => { call++; return call === 1 ? first.request(query) : second.request(query); }, true);
  model.update("@one", 4);
  model.update("@two", 4);
  first.reply({ entries: [entry("old")], truncated: false });
  await Promise.resolve();
  expect(model.snapshot.open).toBe(false);
  second.reply({ entries: [entry("new")], truncated: false });
  await Promise.resolve();
  expect(model.snapshot.entries[0]?.insert_text).toBe("new");
  model.update("plain", 5);
  expect(model.snapshot.open).toBe(false);
});

test("supports wrapping arrows, tab, escape, and closed enter submission", async () => {
  const model = new CompletionModel(async () => ({ entries: [entry("one"), entry("two")], truncated: true }), true);
  model.update("@", 1);
  await Promise.resolve();
  expect(model.key("ArrowUp").handled).toBe(true);
  expect(model.snapshot.activeIndex).toBe(1);
  expect(model.key("ArrowDown").handled).toBe(true);
  expect(model.snapshot.activeIndex).toBe(0);
  expect(model.key("Escape")).toEqual({ handled: true, submitted: false });
  expect(model.key("Enter")).toEqual({ handled: false, submitted: true });
});

test("ime composition never accepts, submits, or opens without the feature", async () => {
  const model = new CompletionModel(async () => ({ entries: [entry("x")], truncated: false }), true);
  model.update("@", 1);
  await Promise.resolve();
  expect(model.key("Enter", true)).toEqual({ handled: false, submitted: false });
  const absent = new CompletionModel(async () => ({ entries: [entry("x")], truncated: false }), false);
  absent.update("@x", 2);
  await Promise.resolve();
  expect(absent.snapshot.open).toBe(false);
  expect(absent.key("Enter", true)).toEqual({ handled: false, submitted: false });
});
