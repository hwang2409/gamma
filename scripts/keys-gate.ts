import { KEY_DEFINITIONS, VIM_KEY_ROWS, keysReceipt } from "../src/keys";
import { normalKey, startVim, type Draft } from "../src/vim";

const exclusions = ["/restart", "!shell", "$EDITOR"];
const receipt = keysReceipt();
if (KEY_DEFINITIONS.length <= 12) throw new Error("keyboard help is incomplete");
for (const exclusion of exclusions) if (!receipt.includes(exclusion)) throw new Error(`keyboard help omits ${exclusion}`);
const draft: Draft = { text: "one two\nthree", cursor: 0 };
for (const row of VIM_KEY_ROWS) for (const token of row.key.split(" ")) {
  [...token].reduce((step, key) => normalKey(step.vim, step.draft, key), { vim: startVim(draft), draft });
}
console.log(`keys gate passed: ${KEY_DEFINITIONS.length} rows, ${VIM_KEY_ROWS.length} vim rows`);
