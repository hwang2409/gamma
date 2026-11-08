export type KeyDefinition = readonly [key: string, action: string, section: "composer" | "menus" | "vim" | "browser" | "exclusions"];

/** The browser bindings are the source for the composer hint and /keys receipt. */
export const KEY_DEFINITIONS = [
  ["enter", "send or steer", "composer"],
  ["shift+enter", "new line", "composer"],
  ["escape", "stop a running turn or close a menu", "composer"],
  ["ctrl+c", "stop the current turn", "composer"],
  ["/", "open slash commands", "composer"],
  ["$", "open skills", "composer"],
  ["tab", "accept the highlighted suggestion", "menus"],
  ["↑ / ↓", "move through suggestions", "menus"],
  ["home / end", "jump to the first or last suggestion", "menus"],
  ["enter", "choose the highlighted suggestion", "menus"],
  ["escape", "close suggestions", "menus"],
  ["/keys", "show this keyboard help", "browser"],
  ["/paste", "open the browser file picker", "browser"],
  ["vim toggle", "turn vim keys on or off", "browser"],
  ["ctrl+r", "redo in vim normal mode", "vim"],
  ["escape", "return to vim normal mode", "vim"],
  ["h j k l", "move left, down, up, or right", "vim"],
  ["w b e", "move by word", "vim"],
  ["0 ^ $ G", "move to a line edge or document edge", "vim"],
  ["i a I A", "insert before, after, or at a line edge", "vim"],
  ["o O", "insert a line below or above", "vim"],
  ["x D C", "delete a character or to the line end", "vim"],
  ["d c y", "start delete, change, or yank commands", "vim"],
  ["gg dd dw yy cw cc", "jump, delete, change, or yank text", "vim"],
  ["p", "paste the vim register", "vim"],
  ["u", "undo the last vim change", "vim"],
  ["browser and assistive technology keys", "take precedence over TUI key conventions", "exclusions"],
  ["/restart", "terminal-only; not a gamma action", "exclusions"],
  ["!shell", "terminal-only; raw shell mode is not a gamma action", "exclusions"],
  ["$EDITOR", "terminal-only; editor integration is not a gamma action", "exclusions"],
] as const satisfies readonly KeyDefinition[];

/** Kept as tuples for callers that only need the key/action pair. */
export const KEY_ROWS = KEY_DEFINITIONS.map(([key, action]) => [key, action] as const);

/** Declarative vim rows. Tests exercise each row through normalKey, the vim state machine. */
export const VIM_KEY_ROWS = KEY_DEFINITIONS
  .filter(([, , section]) => section === "vim")
  .map(([key, action]) => ({ key, action }));

const groups = ["composer", "menus", "vim", "browser", "exclusions"] as const;
const labels = { composer: "composer", menus: "menus and suggestions", vim: "vim normal mode", browser: "browser actions", exclusions: "not gamma actions" } as const;

export function composerHint(steer: boolean) {
  return `${KEY_ROWS[0][0]} to ${steer ? "steer" : "send"} · ${KEY_ROWS[1][0]} for a new line`;
}

export function keysReceipt() {
  return [
    ...groups.map((section) => `${labels[section]}\n${KEY_DEFINITIONS
      .filter(([, , candidate]) => candidate === section)
      .map(([key, action]) => `${key.padEnd(34)} ${action}`)
      .join("\n")}`),
  ].join("\n\n");
}
