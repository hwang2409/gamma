import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { CompletionModel } from "../src/completions";
import type { CommandController, CompletionRow } from "../src/commands";
import { KEY_DEFINITIONS, VIM_KEY_ROWS, browserUsesControlRForReload, composerHint, keysReceipt, readmeKeyboardTable } from "../src/keys";
import { escape, normalKey, startVim, type Draft, type Step, type Vim } from "../src/vim";

const requiredActions = [
  "composer.submit", "composer.newline", "composer.stop-escape", "composer.stop-control-c", "composer.slash", "composer.skill",
  "suggestions.accept", "suggestions.move", "suggestions.close",
  "model.move", "model.edge", "model.choose", "model.typeahead", "model.close",
  "theme.open", "theme.move", "theme.choose", "theme.close", "dialog.trap", "dialog.close",
  "vim.redo", "vim.normal", "vim.browser-aliases", "vim.character-motion", "vim.word-motion", "vim.edge-motion", "vim.insert", "vim.open-line", "vim.delete", "vim.operator", "vim.combination", "vim.paste", "vim.undo",
  "browser.keys", "browser.paste", "browser.vim", "browser.precedence", "exclusion.restart", "exclusion.shell", "exclusion.editor",
] as const;

const rows: CompletionRow[] = [
  { trigger: "/", name: "status", description: "show status", sourceBadge: "builtin" },
  { trigger: "/", name: "story", description: "write story", sourceBadge: "project" },
];
const controller: CommandController = {
  prepareComposerInput: async (text) => ({ kind: "send", text }),
  completions: async () => rows,
  refreshCatalog: async () => {},
};
const opened = async () => {
  const model = new CompletionModel(controller);
  model.update("/st", 3);
  await Promise.resolve();
  return model;
};

describe("keyboard help", () => {
  test("lists every gamma-specific handler action exactly once", () => {
    expect(KEY_DEFINITIONS.map(({ id }) => id)).toEqual(requiredActions);
    expect(new Set(KEY_DEFINITIONS.map(({ id }) => id)).size).toBe(KEY_DEFINITIONS.length);
    expect(keysReceipt()).not.toContain("jump to the first or last suggestion");
    expect(keysReceipt()).toContain("/paste                             open the browser file picker");
    expect(keysReceipt()).toContain("browser and assistive technology keys take precedence");
  });

  test("suggestion rows drive the real completion model", async () => {
    const moving = await opened();
    expect(moving.key("ArrowUp")).toEqual({ handled: true });
    expect(moving.getSnapshot().activeIndex).toBe(1);
    expect(moving.key("ArrowDown")).toEqual({ handled: true });
    expect(moving.getSnapshot().activeIndex).toBe(0);
    expect(moving.key("Tab")).toEqual({ handled: true, accepted: { value: "/status ", caret: 8 } });

    const choosing = await opened();
    expect(choosing.key("Enter")).toEqual({ handled: true, accepted: { value: "/status ", caret: 8 } });
    const closing = await opened();
    expect(closing.key("Escape")).toEqual({ handled: true });
    expect(closing.getSnapshot().open).toBe(false);
    expect(closing.key("Home")).toEqual({ handled: false });
    expect(closing.key("End")).toEqual({ handled: false });
  });

  test("composer hint and README are exact projections of the definitions", async () => {
    expect(composerHint(false)).toBe("enter to send · shift+enter for a new line");
    expect(composerHint(true)).toBe("enter to steer · shift+enter for a new line");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const documented = readme.match(/<!-- keyboard-help:start -->\n([\s\S]*?)\n<!-- keyboard-help:end -->/)?.[1];
    expect(documented).toBe(readmeKeyboardTable());
  });

  test("browser reload wins over vim redo on Windows and Linux", () => {
    expect(browserUsesControlRForReload("Win32")).toBe(true);
    expect(browserUsesControlRForReload("Linux x86_64")).toBe(true);
    expect(browserUsesControlRForReload("darwin")).toBe(false);
    expect(browserUsesControlRForReload("MacIntel")).toBe(false);
    expect(browserUsesControlRForReload("iPhone")).toBe(false);
  });
});

const base: Draft = { text: "one two\nthree", cursor: 4 };
const normal = (draft = base): Step => {
  const entered = startVim(draft);
  return escape(entered, { ...draft, cursor: Math.min(draft.text.length, draft.cursor + 1) });
};
const withVim = (patch: Partial<Vim>, draft = base): Step => {
  const step = normal(draft);
  return { draft: step.draft, vim: { ...step.vim, ...patch } };
};
const run = (token: string): Step => {
  if (token === "escape") return escape(startVim(base), { text: "one two!\nthree", cursor: 8 });
  let step = token === "u"
    ? withVim({ undo: [{ text: "old", cursor: 1 }] })
    : token === "ctrl+r"
      ? withVim({ redo: [{ text: "new", cursor: 2 }] })
      : token === "p"
        ? withVim({ register: { text: "X", line: false } })
        : normal();
  for (const key of token === "ctrl+r" ? [token] : [...token]) step = normalKey(step.vim, step.draft, key);
  return step;
};
const shown = ({ vim, draft }: Step) => JSON.stringify({
  mode: vim.mode,
  pending: vim.pending,
  text: draft.text,
  cursor: draft.cursor,
  register: vim.register,
  undo: vim.undo,
  redo: vim.redo,
  insertFrom: vim.insertFrom,
});

const expected: Record<string, string> = {
  "escape": '{"mode":"normal","pending":"","text":"one two!\\nthree","cursor":7,"register":null,"undo":[{"text":"one two\\nthree","cursor":4}],"redo":[],"insertFrom":null}',
  "ctrl+r": '{"mode":"normal","pending":"","text":"new","cursor":2,"register":null,"undo":[{"text":"one two\\nthree","cursor":4}],"redo":[],"insertFrom":null}',
  "h": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":3,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "j": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":12,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "k": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":4,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "l": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":5,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "w": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":8,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "b": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":0,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "e": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":6,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "0": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":0,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "^": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":0,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "$": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":6,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "G": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":8,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "gg": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":0,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "i": '{"mode":"insert","pending":"","text":"one two\\nthree","cursor":4,"register":null,"undo":[],"redo":[],"insertFrom":{"text":"one two\\nthree","cursor":4}}',
  "a": '{"mode":"insert","pending":"","text":"one two\\nthree","cursor":5,"register":null,"undo":[],"redo":[],"insertFrom":{"text":"one two\\nthree","cursor":4}}',
  "I": '{"mode":"insert","pending":"","text":"one two\\nthree","cursor":0,"register":null,"undo":[],"redo":[],"insertFrom":{"text":"one two\\nthree","cursor":4}}',
  "A": '{"mode":"insert","pending":"","text":"one two\\nthree","cursor":7,"register":null,"undo":[],"redo":[],"insertFrom":{"text":"one two\\nthree","cursor":4}}',
  "o": '{"mode":"insert","pending":"","text":"one two\\n\\nthree","cursor":8,"register":null,"undo":[],"redo":[],"insertFrom":{"text":"one two\\nthree","cursor":4}}',
  "O": '{"mode":"insert","pending":"","text":"\\none two\\nthree","cursor":0,"register":null,"undo":[],"redo":[],"insertFrom":{"text":"one two\\nthree","cursor":4}}',
  "x": '{"mode":"normal","pending":"","text":"one wo\\nthree","cursor":4,"register":{"text":"t","line":false},"undo":[{"text":"one two\\nthree","cursor":4}],"redo":[],"insertFrom":null}',
  "D": '{"mode":"normal","pending":"","text":"one \\nthree","cursor":3,"register":{"text":"two","line":false},"undo":[{"text":"one two\\nthree","cursor":4}],"redo":[],"insertFrom":null}',
  "C": '{"mode":"insert","pending":"","text":"one \\nthree","cursor":4,"register":{"text":"two","line":false},"undo":[{"text":"one two\\nthree","cursor":4}],"redo":[],"insertFrom":null}',
  "d": '{"mode":"normal","pending":"d","text":"one two\\nthree","cursor":4,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "c": '{"mode":"normal","pending":"c","text":"one two\\nthree","cursor":4,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "y": '{"mode":"normal","pending":"y","text":"one two\\nthree","cursor":4,"register":null,"undo":[],"redo":[],"insertFrom":null}',
  "dd": '{"mode":"normal","pending":"","text":"three","cursor":0,"register":{"text":"one two","line":true},"undo":[{"text":"one two\\nthree","cursor":4}],"redo":[],"insertFrom":null}',
  "dw": '{"mode":"normal","pending":"","text":"one \\nthree","cursor":3,"register":{"text":"two","line":false},"undo":[{"text":"one two\\nthree","cursor":4}],"redo":[],"insertFrom":null}',
  "yy": '{"mode":"normal","pending":"","text":"one two\\nthree","cursor":4,"register":{"text":"one two","line":true},"undo":[],"redo":[],"insertFrom":null}',
  "cw": '{"mode":"insert","pending":"","text":"one \\nthree","cursor":4,"register":{"text":"two","line":false},"undo":[{"text":"one two\\nthree","cursor":4}],"redo":[],"insertFrom":null}',
  "cc": '{"mode":"insert","pending":"","text":"\\nthree","cursor":0,"register":{"text":"one two","line":true},"undo":[{"text":"one two\\nthree","cursor":4}],"redo":[],"insertFrom":null}',
  "p": '{"mode":"normal","pending":"","text":"one tXwo\\nthree","cursor":5,"register":{"text":"X","line":false},"undo":[{"text":"one two\\nthree","cursor":4}],"redo":[],"insertFrom":null}',
  "u": '{"mode":"normal","pending":"","text":"old","cursor":1,"register":null,"undo":[],"redo":[{"text":"one two\\nthree","cursor":4}],"insertFrom":null}',
};

test("every declared vim token has an exact real state-machine transition", () => {
  const tokens = VIM_KEY_ROWS.flatMap(({ vimTokens = [] }) => [...vimTokens]);
  expect(tokens.sort()).toEqual(Object.keys(expected).sort());
  for (const token of tokens) expect(shown(run(token)), token).toBe(expected[token]);
});
