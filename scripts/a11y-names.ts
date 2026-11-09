// ARIA-snapshot checks shared by the fake a11y gate and the real-zeta smoke.

/** Lines of an ARIA snapshot for an interactive role with no accessible name, which a screen reader reads as just "button". */
export function unnamed(snapshot: string) {
  return snapshot.split("\n").filter((line) => /^\s*- (button|link|textbox|combobox|checkbox|switch|option|listbox|dialog|slider|menuitem|tab)(\s*\[[^\]]*\])*:?\s*$/.test(line));
}
/** Control names that end in a decorative arrow, which screen readers read out as "downwards arrow". */
export function glyphNames(snapshot: string) {
  return snapshot.split("\n").filter((line) => /^\s*- '?(button|link|option) "[^"]*[\u2190-\u21ff\u2b00-\u2bff]"/.test(line));
}

