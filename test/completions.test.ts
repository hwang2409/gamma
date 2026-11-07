import { expect, test } from "bun:test";
import {
  CompletionModel,
  findCompletionToken,
  type CompletionRequest,
  type CompletionResponse,
} from "../src/completions";

const SESSION_ID = "session-1";
const entry = (
  text: string,
  start_position: number,
  display = text,
  kind: "file" | "directory" = "file",
) => ({ text, start_position, display, kind });

function pending() {
  let resolve!: (response: CompletionResponse) => void;
  let reject!: (reason?: unknown) => void;
  const request = (_params: CompletionRequest) => new Promise<CompletionResponse>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {
    request,
    reply: (response: CompletionResponse) => resolve(response),
    reject: (reason?: unknown) => reject(reason),
  };
}

async function modelWith(input: string, caret: number, completion: ReturnType<typeof entry>) {
  const model = new CompletionModel(async () => ({ entries: [completion], truncated: false }), SESSION_ID, true);
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

test("sends the session and all composer text before the caret", async () => {
  const requests: CompletionRequest[] = [];
  const model = new CompletionModel(async (params) => {
    requests.push(params);
    return { entries: [], truncated: false };
  }, SESSION_ID, true);

  model.update("say @pa trailing", 7);
  await Promise.resolve();

  expect(requests).toEqual([{ session_id: SESSION_ID, text_before_cursor: "say @pa" }]);
});

test("applies server start_position to quoted tokens", async () => {
  const model = await modelWith('open @"a later', 8, entry('a b.txt"', -1, "a b.txt"));
  expect(model.key("Enter").accepted).toEqual({ value: 'open @"a b.txt" later', caret: 15 });
});

test("applies code-point start_position with astral characters before and inside the path", async () => {
  const input = "😀 open @a😀 later";
  const caret = "😀 open @a😀".length;
  const model = await modelWith(input, caret, entry("a😀.txt", -2));
  expect(model.key("Tab").accepted).toEqual({
    value: "😀 open @a😀.txt later",
    caret: "😀 open @a😀.txt".length,
  });
});

test("rejects a positive start_position as a malformed row", async () => {
  const model = await modelWith("open @a", 7, entry("bad", 1));
  expect(model.snapshot.open).toBe(false);
  expect(model.accept()).toBeUndefined();
});

test("uses server text for slash, absolute, and home variants", async () => {
  for (const [input, caret, completion, expected, expectedCaret] of [
    ["@do", 3, entry("docs/", -2, "docs/", "directory"), "@docs/", 6],
    ["@/tm", 4, entry("/tmp/report.txt", -3), "@/tmp/report.txt", 16],
    ["@~/no", 5, entry("~/notes.txt", -4), "@~/notes.txt", 12],
  ] as const) {
    const model = await modelWith(input, caret, completion);
    expect(model.key("Enter").accepted).toEqual({ value: expected, caret: expectedCaret });
  }
});

test("preserves text after a middle caret", async () => {
  const model = await modelWith("open @src/ma-old now", 12, entry("src/main.py", -6));
  expect(model.key("Tab")).toEqual({
    handled: true,
    submitted: false,
    accepted: { value: "open @src/main.py-old now", caret: 17 },
  });
  expect(model.snapshot.open).toBe(false);
});

test("requests at the UTF-8 byte limit and skips input over it", async () => {
  const requests: CompletionRequest[] = [];
  const model = new CompletionModel(async (params) => {
    requests.push(params);
    return { entries: [], truncated: false };
  }, SESSION_ID, true);
  const atLimit = `${"a".repeat(4090)}😀 @`;
  const overLimit = `${"a".repeat(4091)}😀 @`;

  model.update(atLimit, atLimit.length);
  model.update(overLimit, overLimit.length);
  await Promise.resolve();

  expect(new TextEncoder().encode(atLimit)).toHaveLength(4096);
  expect(new TextEncoder().encode(overLimit)).toHaveLength(4097);
  expect(requests).toEqual([{ session_id: SESSION_ID, text_before_cursor: atLimit }]);
});

test("publishes immediate, response, navigation, and close snapshots", async () => {
  const request = pending();
  const model = new CompletionModel(request.request, SESSION_ID, true);
  const snapshots = [] as ReturnType<typeof model.getSnapshot>[];
  const unsubscribe = model.subscribe(() => snapshots.push(model.getSnapshot()));

  model.update("@o", 2);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ open: false, error: false });
  request.reply({ entries: [entry("one", -1), entry("two", -1)], truncated: true });
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
  const model = new CompletionModel((params) => (++calls === 1 ? first.request(params) : second.request(params)), SESSION_ID, true);
  model.update("@one", 4);
  model.update("plain", 5);
  first.reply({ entries: [entry("old", -3)], truncated: false });
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
  const model = new CompletionModel(request.request, SESSION_ID, true);
  let notifications = 0;
  model.subscribe(() => notifications++);
  model.update("@path", 5);
  request.reject(new Error("disconnected"));
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ open: false, entries: [], truncated: false, activeIndex: 0, error: true });
  expect(notifications).toBe(2);
});

test("keeps an empty response closed and observable", async () => {
  const model = new CompletionModel(async () => ({ entries: [], truncated: false }), SESSION_ID, true);
  let notifications = 0;
  model.subscribe(() => notifications++);
  model.update("@none", 5);
  await Promise.resolve();
  expect(model.snapshot).toEqual({ open: false, entries: [], truncated: false, activeIndex: 0, error: false });
  expect(notifications).toBe(2);
});

test("does not request when the feature is off or text is selected", async () => {
  let requests = 0;
  const request = async (_params: CompletionRequest) => { requests++; return { entries: [entry("x", -1)], truncated: false }; };
  const absent = new CompletionModel(request, SESSION_ID, false);
  absent.update("@x", 2);
  const selected = new CompletionModel(request, SESSION_ID, true);
  selected.update("@path", 1, 4);
  await Promise.resolve();
  expect(requests).toBe(0);
  expect(absent.snapshot.open).toBe(false);
  expect(selected.snapshot.open).toBe(false);
});

test("handles arrows and enter only while the menu is open", async () => {
  const model = new CompletionModel(async () => ({ entries: [entry("one", 0), entry("two", 0)], truncated: true }), SESSION_ID, true);
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
  const model = await modelWith("@", 1, entry("x", 0));
  expect(model.key("Tab", true)).toEqual({ handled: false, submitted: false });
  expect(model.snapshot.open).toBe(true);
  expect(model.key("Enter", true)).toEqual({ handled: false, submitted: false });
  expect(model.snapshot.open).toBe(true);
});
