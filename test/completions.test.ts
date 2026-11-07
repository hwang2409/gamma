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
  expect(model.choose(0)).toEqual({ value: "ask $review  later", caret: 12 });
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
