import { expect, test } from "bun:test";
import { escape, normalKey, startVim, type Draft, type Step } from "../src/vim";

/** Types `keys` in NORMAL from `text` with the cursor at `cursor`; "<r>" is ctrl+r. */
function normal(text: string, cursor: number, keys: string[]): Step {
  let step = escape(startVim({ text, cursor }), { text, cursor: cursor + 1 > text.length ? cursor : cursor + 1 });
  step = { vim: { ...step.vim, undo: [] }, draft: { text, cursor } };
  for (const key of keys) step = normalKey(step.vim, step.draft, key);
  return step;
}
const keys = (value: string) => value.match(/<r>|./g)!.map((key) => (key === "<r>" ? "ctrl+r" : key));
const shown = ({ draft }: { draft: Draft }) => `${draft.text.slice(0, draft.cursor)}|${draft.text.slice(draft.cursor)}`;

test("motions: h l j k, w b e, 0 ^ $, gg G", () => {
  const text = "  alpha beta.gamma\nsecond line\n  third";
  expect(shown(normal(text, 4, keys("l")))).toBe("  alp|ha beta.gamma\nsecond line\n  third");
  expect(shown(normal(text, 4, keys("hhhhh")))).toBe("|  alpha beta.gamma\nsecond line\n  third");
  expect(shown(normal(text, 2, keys("w")))).toBe("  alpha |beta.gamma\nsecond line\n  third");
  expect(shown(normal(text, 2, keys("ww")))).toBe("  alpha beta|.gamma\nsecond line\n  third");
  expect(shown(normal(text, 2, keys("e")))).toBe("  alph|a beta.gamma\nsecond line\n  third");
  expect(shown(normal(text, 13, keys("b")))).toBe("  alpha beta|.gamma\nsecond line\n  third");
  expect(shown(normal(text, 8, keys("$")))).toBe("  alpha beta.gamm|a\nsecond line\n  third");
  expect(shown(normal(text, 8, keys("0")))).toBe("|  alpha beta.gamma\nsecond line\n  third");
  expect(shown(normal(text, 8, keys("^")))).toBe("  |alpha beta.gamma\nsecond line\n  third");
  expect(shown(normal(text, 17, keys("j")))).toBe("  alpha beta.gamma\nsecond lin|e\n  third");
  expect(shown(normal(text, 17, keys("jk")))).toBe("  alpha be|ta.gamma\nsecond line\n  third");
  expect(shown(normal(text, 4, keys("G")))).toBe("  alpha beta.gamma\nsecond line\n  |third");
  expect(shown(normal(text, 30, keys("gg")))).toBe("  |alpha beta.gamma\nsecond line\n  third");
});

test("edits: x dd dw cw cc D C, then u and ctrl+r", () => {
  expect(shown(normal("hello", 0, keys("x")))).toBe("|ello");
  expect(shown(normal("one\ntwo\nthree", 5, keys("dd")))).toBe("one\n|three");
  expect(shown(normal("one\ntwo", 5, keys("dd")))).toBe("|one");
  expect(shown(normal("fix the build", 0, keys("dw")))).toBe("|the build");
  const cw = normal("fix the build", 4, keys("cw"));
  expect(cw.vim.mode).toBe("insert");
  expect(shown(cw)).toBe("fix | build");
  expect(shown(normal("one\ntwo\nthree", 5, keys("cc")))).toBe("one\n|\nthree");
  expect(shown(normal("keep this", 4, keys("D")))).toBe("kee|p");
  expect(normal("keep this", 4, keys("C")).vim.mode).toBe("insert");
  expect(shown(normal("fix the build", 0, keys("dwu")))).toBe("|fix the build");
  expect(shown(normal("fix the build", 0, keys("dwu<r>")))).toBe("|the build");
  expect(shown(normal("fix the build", 0, keys("dwdwuu")))).toBe("|fix the build");
});

test("an insert is one undo step; cw and its typing are one step", () => {
  let step: Step = { vim: startVim({ text: "", cursor: 0 }), draft: { text: "hello", cursor: 5 } };
  step = escape(step.vim, step.draft);
  expect(shown(step)).toBe("hell|o");
  step = normalKey(step.vim, step.draft, "u");
  expect(step.draft.text).toBe("");
  let change = normal("fix the build", 4, keys("cw"));
  change = escape(change.vim, { text: "fix a build", cursor: 5 });
  change = normalKey(change.vim, change.draft, "u");
  expect(change.draft.text).toBe("fix the build");
});

test("i a I A o O enter INSERT where vim does", () => {
  const at = (key: string) => shown(normal("  ab\ncd", 2, [key]));
  expect(at("i")).toBe("  |ab\ncd");
  expect(at("a")).toBe("  a|b\ncd");
  expect(at("I")).toBe("  |ab\ncd");
  expect(at("A")).toBe("  ab|\ncd");
  expect(at("o")).toBe("  ab\n|\ncd");
  expect(at("O")).toBe("|\n  ab\ncd");
  expect(normal("  ab\ncd", 2, ["o"]).vim.mode).toBe("insert");
});

test("p puts after yy, dd, x, and dw", () => {
  expect(shown(normal("one\ntwo", 0, keys("yyp")))).toBe("one\n|one\ntwo");
  expect(shown(normal("one\ntwo", 0, keys("ddp")))).toBe("two\n|one");
  expect(shown(normal("ab", 0, keys("xp")))).toBe("b|a");
  expect(shown(normal("fix the", 0, keys("dw$p")))).toBe("thefix| ");
});
