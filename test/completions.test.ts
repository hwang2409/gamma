import { expect, test } from "bun:test";
import { CompletionModel } from "../src/completions";
import type { CommandController, CompletionRow } from "../src/commands";

const rows: CompletionRow[] = [
  { trigger: "/", name: "status", description: "show status", sourceBadge: "builtin" },
  { trigger: "/", name: "story", description: "write story", sourceBadge: "project" },
];

function controller(reply: (value: string) => Promise<CompletionRow[]> = async () => rows): CommandController {
  return { prepareComposerInput: async (text) => ({ kind: "send", text }), completions: reply, refreshCatalog: async () => {} };
}

async function opened(value = "/st") {
  const model = new CompletionModel(controller());
  model.update(value, value.length);
  await Promise.resolve();
  return model;
}

test("one snapshot owns rows, wrapping, escape, and keyboard acceptance", async () => {
  const model = await opened();
  expect(model.getSnapshot()).toEqual({ open: true, rows, activeIndex: 0 });
  expect(model.key("ArrowUp").handled).toBe(true);
  expect(model.getSnapshot().activeIndex).toBe(1);
  expect(model.key("ArrowDown").handled).toBe(true);
  expect(model.key("Tab")).toEqual({ handled: true, accepted: { value: "/status ", caret: 8 } });
  expect(model.getSnapshot().open).toBe(false);

  model.update("/st", 3);
  await Promise.resolve();
  expect(model.key("Escape")).toEqual({ handled: true });
  expect(model.getSnapshot().open).toBe(false);
});

test("slash insertion preserves existing separators and text after the caret", async () => {
  const model = await opened("/st next");
  model.update("/st next", 3);
  await Promise.resolve();
  expect(model.key("Enter").accepted).toEqual({ value: "/status next", caret: 7 });
});

test("dollar insertion replaces only the active token and always includes its trailing space", async () => {
  const skill = [{ ...rows[0], trigger: "$" as const, name: "review" }];
  const model = new CompletionModel(controller(async () => skill));
  model.update("ask $re later", 7);
  await Promise.resolve();
  expect(model.choose(0)).toEqual({ value: "ask $review later", caret: 11 });
});

test("selection and ime leave normal textarea behavior untouched", async () => {
  const model = await opened();
  expect(model.key("Enter", true)).toEqual({ handled: false });
  model.update("/st", 0, 3);
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
});

test("stale catalog replies cannot reopen a changed token", async () => {
  let resolve!: (rows: CompletionRow[]) => void;
  const model = new CompletionModel(controller(() => new Promise((done) => { resolve = done; })));
  model.update("/st", 3);
  model.update("ordinary text", 13);
  resolve(rows);
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
});

test("pointer acceptance uses the chosen row without changing focus itself", async () => {
  const model = await opened();
  expect(model.choose(1)).toEqual({ value: "/story ", caret: 7 });
  expect(model.getSnapshot().open).toBe(false);
});

test("escape stays closed when a select event repeats the same one-shot input", async () => {
  const model = await opened("/st");
  expect(model.key("Escape")).toEqual({ handled: true });
  model.select("/st", 3, 3);
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
  model.update("/sta", 4, 4);
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(true);
});

test("shift+tab and shift+enter keep their normal meaning and never accept", async () => {
  for (const key of ["Tab", "Enter"]) {
    const model = await opened("/st");
    expect(model.key(key, false, true)).toEqual({ handled: false });
    expect(model.getSnapshot().open).toBe(false);
  }
});

test("a repeated select event keeps the active row", async () => {
  const model = await opened("/st");
  model.key("ArrowDown");
  model.select("/st", 3, 3);
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ open: true, rows, activeIndex: 1 });
});

test("a new command source answers the token being typed, but never reopens an Escape-closed menu", async () => {
  const model = new CompletionModel(controller(async () => []));
  model.update("/st", 3);
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
  model.setController(controller(), { value: "/st", caret: 3 });
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ open: true, rows, activeIndex: 0 });

  expect(model.key("Escape")).toEqual({ handled: true });
  model.setController(controller(), { value: "/st", caret: 3 });
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);

  model.update("", 0);
  model.setController(controller(), { value: "", caret: 0 });
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
});

test("a new command source asks about the field's text, not the input before a submit cleared it", async () => {
  const model = new CompletionModel(controller(async () => []));
  model.update("/status", 7);
  await Promise.resolve();
  // The submit consumed the draft with no input event, so only the field knows it is empty now.
  const asked: string[] = [];
  model.setController(controller(async (value) => { asked.push(value); return rows; }), { value: "", caret: 0 });
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
  expect(asked).toEqual([]);
});
