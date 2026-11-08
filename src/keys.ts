export type KeySection = "composer" | "suggestions" | "menus" | "vim" | "browser" | "exclusions";
export type KeyDefinition = {
  readonly id: string;
  readonly key: string;
  readonly action: string;
  readonly section: KeySection;
  readonly vimTokens?: readonly string[];
  readonly hint?: { readonly idle: string; readonly steer: string };
};

/** Gamma-specific bindings. Native button activation stays a browser convention and is not repeated here. */
export const KEY_DEFINITIONS = [
  { id: "composer.submit", key: "enter", action: "send or steer", section: "composer", hint: { idle: "enter to send", steer: "enter to steer" } },
  { id: "composer.newline", key: "shift+enter", action: "new line", section: "composer", hint: { idle: "shift+enter for a new line", steer: "shift+enter for a new line" } },
  { id: "composer.stop-escape", key: "escape", action: "stop a running turn when vim is off", section: "composer" },
  { id: "composer.stop-control-c", key: "ctrl+c", action: "stop a running turn from an empty field or vim normal mode", section: "composer" },
  { id: "composer.slash", key: "/", action: "open slash command suggestions", section: "composer" },
  { id: "composer.skill", key: "$", action: "open skill suggestions", section: "composer" },

  { id: "suggestions.accept", key: "tab / enter", action: "accept the highlighted suggestion", section: "suggestions" },
  { id: "suggestions.move", key: "↑ / ↓", action: "move through suggestions", section: "suggestions" },
  { id: "suggestions.close", key: "escape", action: "close suggestions", section: "suggestions" },

  { id: "model.move", key: "↑ / ↓", action: "move through models", section: "menus" },
  { id: "model.edge", key: "home / end", action: "move to the first or last model", section: "menus" },
  { id: "model.choose", key: "enter", action: "choose the highlighted model", section: "menus" },
  { id: "model.typeahead", key: "type a model name", action: "jump to a matching model", section: "menus" },
  { id: "model.close", key: "escape", action: "close the model menu", section: "menus" },
  { id: "theme.open", key: "↑ / ↓", action: "open the theme menu", section: "menus" },
  { id: "theme.move", key: "↑ / ↓ / home / end", action: "move through themes", section: "menus" },
  { id: "theme.choose", key: "enter / space", action: "choose the highlighted theme", section: "menus" },
  { id: "theme.close", key: "escape / tab", action: "close the theme menu", section: "menus" },
  { id: "dialog.trap", key: "tab / shift+tab", action: "keep focus inside an open dialog", section: "menus" },
  { id: "dialog.close", key: "escape", action: "close or cancel an open dialog", section: "menus" },

  { id: "vim.redo", key: "ctrl+r", action: "redo unless the platform reserves ctrl+r for browser reload", section: "vim", vimTokens: ["ctrl+r"] },
  { id: "vim.normal", key: "escape", action: "return to vim normal mode", section: "vim", vimTokens: ["escape"] },
  { id: "vim.browser-aliases", key: "backspace / delete", action: "move left or delete a character in vim normal mode", section: "vim" },
  { id: "vim.character-motion", key: "h j k l", action: "move left, down, up, or right", section: "vim", vimTokens: ["h", "j", "k", "l"] },
  { id: "vim.word-motion", key: "w b e", action: "move by word", section: "vim", vimTokens: ["w", "b", "e"] },
  { id: "vim.edge-motion", key: "0 ^ $ G gg", action: "move to a line edge or document edge", section: "vim", vimTokens: ["0", "^", "$", "G", "gg"] },
  { id: "vim.insert", key: "i a I A", action: "insert before, after, or at a line edge", section: "vim", vimTokens: ["i", "a", "I", "A"] },
  { id: "vim.open-line", key: "o O", action: "insert a line below or above", section: "vim", vimTokens: ["o", "O"] },
  { id: "vim.delete", key: "x D C", action: "delete a character or to the line end", section: "vim", vimTokens: ["x", "D", "C"] },
  { id: "vim.operator", key: "d c y", action: "start delete, change, or yank commands", section: "vim", vimTokens: ["d", "c", "y"] },
  { id: "vim.combination", key: "dd dw yy cw cc", action: "delete, change, or yank text", section: "vim", vimTokens: ["dd", "dw", "yy", "cw", "cc"] },
  { id: "vim.paste", key: "p", action: "paste the vim register", section: "vim", vimTokens: ["p"] },
  { id: "vim.undo", key: "u", action: "undo the last vim change", section: "vim", vimTokens: ["u"] },

  { id: "browser.keys", key: "/keys", action: "show this keyboard help", section: "browser" },
  { id: "browser.paste", key: "/paste", action: "open the browser file picker", section: "browser" },
  { id: "browser.vim", key: "/vim", action: "turn vim keys on or off", section: "browser" },
  { id: "browser.precedence", key: "browser and assistive technology keys", action: "take precedence over TUI key conventions", section: "exclusions" },
  { id: "exclusion.restart", key: "/restart", action: "terminal-only; not a gamma action", section: "exclusions" },
  { id: "exclusion.shell", key: "!shell", action: "terminal-only; raw shell mode is not a gamma action", section: "exclusions" },
  { id: "exclusion.editor", key: "$EDITOR", action: "terminal-only; editor integration is not a gamma action", section: "exclusions" },
] as const satisfies readonly KeyDefinition[];

export const VIM_KEY_ROWS = KEY_DEFINITIONS.filter((definition) => definition.section === "vim");

const groups: readonly KeySection[] = ["composer", "suggestions", "menus", "vim", "browser", "exclusions"];
const labels: Record<KeySection, string> = {
  composer: "composer",
  suggestions: "command and skill suggestions",
  menus: "model, theme, and dialogs",
  vim: "vim normal mode",
  browser: "browser actions",
  exclusions: "browser precedence and terminal-only exclusions",
};
const byId = (id: string): KeyDefinition => {
  const definition = KEY_DEFINITIONS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`missing keyboard definition: ${id}`);
  return definition;
};

export function composerHint(steer: boolean) {
  return ["composer.submit", "composer.newline"].map((id) => {
    const hint = byId(id).hint;
    if (!hint) throw new Error(`missing composer hint: ${id}`);
    return steer ? hint.steer : hint.idle;
  }).join(" · ");
}

export function keysReceipt() {
  return groups.map((section) => `${labels[section]}\n${KEY_DEFINITIONS
    .filter((definition) => definition.section === section)
    .map(({ key, action }) => `${key.padEnd(34)} ${action}`)
    .join("\n")}`).join("\n\n");
}

/** Ctrl+R is reload on Windows and Linux. macOS browsers reserve Command+R instead. */
export function browserUsesControlRForReload(platform: string) {
  return !/darwin|mac|iphone|ipad|ipod/i.test(platform);
}

const readmeIds = ["browser.keys", "browser.paste", "exclusion.restart", "exclusion.shell", "exclusion.editor"];
export function readmeKeyboardTable() {
  return ["| action | gamma behavior |", "| --- | --- |", ...readmeIds.map((id) => {
    const { key, action } = byId(id);
    return `| \`${key}\` | ${action} |`;
  })].join("\n");
}
