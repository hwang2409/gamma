export const KEY_ROWS = [
  ["enter", "send or steer"],
  ["shift+enter", "new line"],
  ["escape", "close a menu"],
  ["ctrl+c", "stop the current turn"],
  ["/", "open slash commands"],
  ["$", "open skills"],
] as const;

export function composerHint(steer: boolean) {
  return `${KEY_ROWS[0][0]} to ${steer ? "steer" : "send"} · ${KEY_ROWS[1][0]} for a new line`;
}

export function keysReceipt() {
  return KEY_ROWS.map(([key, action]) => `${key.padEnd(12)} ${action}`).join("\n");
}
