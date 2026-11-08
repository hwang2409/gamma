import { describe, expect, test } from "bun:test";
import { KEY_DEFINITIONS, KEY_ROWS, VIM_KEY_ROWS, composerHint, keysReceipt } from "../src/keys";
import { normalKey, startVim, type Draft } from "../src/vim";

describe("keyboard help", () => {
  test("documents the complete browser key table and terminal exclusions", () => {
    expect(KEY_ROWS.length).toBeGreaterThan(12);
    expect(keysReceipt()).toContain("browser and assistive technology keys take precedence");
    expect(keysReceipt()).toContain("/restart");
    expect(keysReceipt()).toContain("not a gamma action");
    expect(keysReceipt()).toContain("!shell");
    expect(keysReceipt()).toContain("$EDITOR");
    expect(keysReceipt()).toContain("/paste                             open the browser file picker");
    expect(composerHint(false)).toContain("enter");
  });

  test("declared vim rows reach the vim state machine", () => {
    const draft: Draft = { text: "one two\\nthree", cursor: 0 };
    for (const row of VIM_KEY_ROWS) {
      for (const key of row.key.split(" ")) {
        const step = key.length > 1 ? [...key].reduce((current, part) => normalKey(current.vim, current.draft, part), { vim: startVim(draft), draft }) : normalKey(startVim(draft), draft, key);
        expect(step).toBeDefined();
      }
    }
    expect(KEY_DEFINITIONS.filter(([, , section]) => section === "vim").length).toBe(VIM_KEY_ROWS.length);
  });
});
