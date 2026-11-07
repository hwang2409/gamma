import { expect, test } from "bun:test";
import { CompletionModel, findCompletionToken, type CompletionResponse } from "../src/completions";

const entry = (insert_text: string, display_text = insert_text, kind: "file" | "directory" = "file") => ({ insert_text, display_text, kind });
function pending() {
  let resolve!: (response: CompletionResponse) => void;
  let reject!: (reason?: unknown) => void;
  const request = (query: string) => new Promise<CompletionResponse>((yes, no) => {
    resolve = yes;
    reject = no;
    void query;
  });
  return {
    request,
    reply: (response: CompletionResponse) => resolve(response),
    reject: (reason?: unknown) => reject(reason),
  };
}

async function modelWith(input: string, caret: number, insertText: string, kind: "file" | "directory" = "file") {
  const model = new CompletionModel(async () => ({ entries: [entry(insertText, "display only", kind)], truncated: false }), true);
  model.update(input, caret);
  await Promise.resolve();
  return model;
}

test("uses the zeta TUI token boundary, including embedded @ characters", () => {
  for (const [value, caret, query] of [
    ["@foo@bar", 8, "foo@bar"],
    ['@"foo@bar', 9, "foo@bar"],
    ["say @path/file.txt", 9, "path"],
    ['@"space path', 12, "space path"],
    ["first\n@next", 10, "nex"],
  ] as const) {
    expect(findCompletionToken(value, caret)?.query).toBe(query);
  }
  expect(findCompletionToken("sayx@path", 9)).toBeUndefined();
  expect(findCompletionToken('say @"closed"', 13)?.query).toBe('"closed"');
  expect(findCompletionToken("@one\ntwo", 8)).toBeUndefined();
  expect(findCompletionToken("@path", 1, 4)).toBeUndefined();
});

test("inserts server text for TUI quoting, slash, absolute, and home variants", async () => {
  for (const [input, caret, insertText, expected, expectedCaret, kind] of [
    ["@a", 2, '"a b.txt"', '@"a b.txt"', 10, "file"],
    ['@"a', 3, 'a b.txt"', '@"a b.txt"', 10, "file"],
    ["@do", 3, "docs/", "@docs/", 6, "directory"],
    ['@"do', 4, "docs/", '@"docs/', 7, "directory"],
    ["@/tm", 4, "/tmp/report.txt", "@/tmp/report.txt", 16, "file"],
    ["@~/no", 5, "~/notes.txt", "@~/notes.txt", 12, "file"],
  ] as const) {
    const model = await modelWith(input, caret, insertText, kind);
    expect(model.key("Enter").accepted).toEqual({ value: expected, caret: expectedCaret });
  }
});

test("accepts with tab and preserves text after a middle caret", async () => {
  const model = await modelWith("open @src/ma-old now", 12, "src/main.py");
  expect(model.key("Tab")).toEqual({
    handled: true,
    submitted: false,
    accepted: { value: "open @src/main.py-old now", caret: 17 },
  });
  expect(model.snapshot.open).toBe(false);
});

test("publishes immediate, response, navigation, and close snapshots", async () => {
  const request = pending();
  const model = new CompletionModel(request.request, true);
  const snapshots = [] as ReturnType<typeof model.getSnapshot>[];
  const unsubscribe = model.subscribe(() => snapshots.push(model.getSnapshot()));

  model.update("@o", 2);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ open: false, error: false });
  request.reply({ entries: [entry("one"), entry("two")], truncated: true });
  await Promise.resolve();
  expect(snapshots.at(-1)).toMatchObject({ open: true, truncated: true, activeIndex: 0 });
  model.key("ArrowUp");
  expect(snapshots.at(-1)?.activeIndex).toBe(1);
  model.key("Escape");
  expect(snapshots.at(-1)?.open).toBe(false);

  unsubscribe();
  const count = snapshots.length;
  model.update("plain", 5);
  expect(snapshots).toHaveLength(count);
});

test("drops fulfilled and rejected requests after the token or caret changes", async () => {
  const first = pending();
  const second = pending();
  let calls = 0;
  const model = new CompletionModel((query) => (++calls === 1 ? first.request(query) : second.request(query)), true);
  model.update("@one", 4);
  model.update("plain", 5);
  first.reply({ entries: [entry("old")], truncated: false });
  await Promise.resolve();
  expect(model.snapshot).toMatchObject({ open: false, error: false });

  model.update("@two", 4);
  model.update("plain", 2);
  second.reject(new Error("disconnected"));
  await Promise.resolve();
  expect(model.snapshot).toMatchObject({ open: false, error: false });
});

test("marks the current request as errored without opening the menu", async () => {
  const request = pending();
  const model = new CompletionModel(request.request, true);
  let notifications = 0;
  model.subscribe(() => notifications++);
  model.update("@path", 5);
  request.reject(new Error("disconnected"));
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ open: false, entries: [], truncated: false, activeIndex: 0, error: true });
  expect(notifications).toBe(2);
});

test("keeps an empty response closed and observable", async () => {
  const model = new CompletionModel(async () => ({ entries: [], truncated: false }), true);
  let notifications = 0;
  model.subscribe(() => notifications++);
  model.update("@none", 5);
  await Promise.resolve();
  expect(model.snapshot).toEqual({ open: false, entries: [], truncated: false, activeIndex: 0, error: false });
  expect(notifications).toBe(2);
});

test("does not request when the feature is off or text is selected", async () => {
  let requests = 0;
  const request = async () => { requests++; return { entries: [entry("x")], truncated: false }; };
  const absent = new CompletionModel(request, false);
  absent.update("@x", 2);
  const selected = new CompletionModel(request, true);
  selected.update("@path", 1, 4);
  await Promise.resolve();
  expect(requests).toBe(0);
  expect(absent.snapshot.open).toBe(false);
  expect(selected.snapshot.open).toBe(false);
});

test("handles arrows and enter only while the menu is open", async () => {
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

test("IME composition never accepts tab or enter", async () => {
  const model = await modelWith("@", 1, "x");
  expect(model.key("Tab", true)).toEqual({ handled: false, submitted: false });
  expect(model.snapshot.open).toBe(true);
  expect(model.key("Enter", true)).toEqual({ handled: false, submitted: false });
  expect(model.snapshot.open).toBe(true);
});
