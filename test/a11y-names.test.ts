import { expect, test } from "bun:test";
import { glyphNames, unnamed } from "../scripts/a11y-names";

test("unnamed finds interactive roles with no accessible name, with or without state", () => {
  const snapshot = ['- button "new run"', "- button", "  - button [disabled]", '- combobox "message"', "- listbox:", "- paragraph: text", '- button "steer" [disabled]: steer'].join("\n");
  expect(unnamed(snapshot)).toEqual(["- button", "  - button [disabled]", "- listbox:"]);
});

test("glyphNames finds a control name that ends in a decorative arrow", () => {
  const snapshot = ['    - button "waiting for your approval ↓"', '- button "waiting for your approval"', "- 'button \"jump to approval: $ ls\"'", '- paragraph "a ↓"'].join("\n");
  expect(glyphNames(snapshot)).toEqual(['    - button "waiting for your approval ↓"']);
});
