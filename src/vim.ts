/** The composer's vim keys: a pure step function over the draft, so every key sequence is testable without a DOM. */
export type Draft = { readonly text: string; readonly cursor: number };
export type Vim = {
  readonly mode: "insert" | "normal";
  /** The first key of a two-key command (d, c, y, g). */
  readonly pending: string;
  readonly register: { readonly text: string; readonly line: boolean } | null;
  readonly undo: readonly Draft[];
  readonly redo: readonly Draft[];
  /** The draft when the current insert began; Esc turns the whole insert into one undo step. */
  readonly insertFrom: Draft | null;
};
export type Step = { vim: Vim; draft: Draft };

export const startVim = (draft: Draft): Vim => ({ mode: "insert", pending: "", register: null, undo: [], redo: [], insertFrom: draft });

const lineStart = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (text: string, at: number) => { const end = text.indexOf("\n", at); return end < 0 ? text.length : end; };
/** NORMAL keeps the cursor on a character of its line, never past the last one. */
const clamp = (text: string, at: number) => {
  const start = lineStart(text, Math.min(at, text.length));
  const end = lineEnd(text, start);
  return end > start ? Math.max(start, Math.min(at, end - 1)) : start;
};
const firstNonBlank = (text: string, at: number) => {
  const start = lineStart(text, at);
  const end = lineEnd(text, start);
  let index = start;
  while (index < end && /[ \t]/.test(text[index]!)) index++;
  return index < end ? index : start;
};
/** 0 blank, 1 word, 2 punctuation: vim's word classes. */
const kind = (char: string | undefined) => (char === undefined || /\s/.test(char) ? 0 : /\w/.test(char) ? 1 : 2);
const wordForward = (text: string, at: number) => {
  let index = at;
  const start = kind(text[index]);
  if (start) while (index < text.length && kind(text[index]) === start) index++;
  while (index < text.length && kind(text[index]) === 0) index++;
  return index;
};
const wordEnd = (text: string, at: number) => {
  let index = at + 1;
  while (index < text.length && kind(text[index]) === 0) index++;
  const word = kind(text[index]);
  while (index + 1 < text.length && kind(text[index + 1]) === word) index++;
  return Math.min(index, text.length - 1);
};
const wordBack = (text: string, at: number) => {
  let index = at - 1;
  while (index > 0 && kind(text[index]) === 0) index--;
  const word = kind(text[index]);
  while (index > 0 && kind(text[index - 1]) === word) index--;
  return Math.max(0, index);
};
// shortcut: j and k keep the current column, not the wanted one vim remembers across short lines; add it if missed.
const lineMove = (text: string, at: number, down: boolean) => {
  const start = lineStart(text, at);
  const column = at - start;
  if (down) {
    const end = lineEnd(text, at);
    if (end >= text.length) return at;
    const next = end + 1;
    return clamp(text, Math.min(next + column, lineEnd(text, next)));
  }
  if (start === 0) return at;
  const previous = lineStart(text, start - 1);
  return clamp(text, Math.min(previous + column, start - 1));
};

const cut = (text: string, from: number, to: number) => text.slice(0, from) + text.slice(to);
const insertAt = (text: string, at: number, value: string) => text.slice(0, at) + value + text.slice(at);

/** Esc in INSERT: back to NORMAL one character left, as vim does, with the insert as one undo step. */
export function escape(vim: Vim, draft: Draft): Step {
  if (vim.mode === "normal") return { vim: { ...vim, pending: "" }, draft };
  const changed = vim.insertFrom && vim.insertFrom.text !== draft.text;
  const cursor = draft.cursor > lineStart(draft.text, draft.cursor) ? draft.cursor - 1 : draft.cursor;
  return {
    vim: { ...vim, mode: "normal", pending: "", insertFrom: null, ...(changed ? { undo: [...vim.undo, vim.insertFrom!], redo: [] } : {}) },
    draft: { text: draft.text, cursor: clamp(draft.text, cursor) },
  };
}

/** One NORMAL key (a single character, or "ctrl+r"). Unknown keys do nothing; the caller keeps them out of the field. */
export function normalKey(vim: Vim, draft: Draft, key: string): Step {
  const { text, cursor } = draft;
  const start = lineStart(text, cursor);
  const end = lineEnd(text, cursor);
  const move = (to: number): Step => ({ vim: { ...vim, pending: "" }, draft: { text, cursor: clamp(text, to) } });
  /** A change from NORMAL: one undo step; `insert` enters INSERT at the cursor. */
  const change = (next: Draft, register = vim.register, insert = false): Step => ({
    vim: { ...vim, mode: insert ? "insert" : "normal", pending: "", register, undo: [...vim.undo, draft], redo: [], insertFrom: null },
    draft: insert ? next : { text: next.text, cursor: clamp(next.text, next.cursor) },
  });
  /** Enters INSERT without a change yet; Esc records the whole insert as one step from `from`. */
  const insert = (next: Draft, from: Draft = draft): Step => ({ vim: { ...vim, mode: "insert", pending: "", insertFrom: from }, draft: next });

  if (vim.pending) {
    const combo = vim.pending + key;
    const line = { text: text.slice(start, end), line: true };
    switch (combo) {
      case "gg": return move(firstNonBlank(text, 0));
      case "yy": return { vim: { ...vim, pending: "", register: line }, draft };
      case "dd": {
        const [from, to] = end < text.length ? [start, end + 1] : start > 0 ? [start - 1, end] : [start, end];
        const next = cut(text, from, to);
        return change({ text: next, cursor: firstNonBlank(next, Math.min(from, next.length)) }, line);
      }
      case "cc": return change({ text: cut(text, start, end), cursor: start }, line, true);
      case "dw":
      case "cw": {
        // cw on a word changes to its end, not to the next word (vim's special case); dw stops at the line end.
        let to = Math.min(wordForward(text, cursor), end);
        if (combo === "cw" && kind(text[cursor])) { to = cursor; while (to < end && kind(text[to]) === kind(text[cursor])) to++; }
        const register = { text: text.slice(cursor, to), line: false };
        return change({ text: cut(text, cursor, to), cursor }, register, combo === "cw");
      }
      default: return { vim: { ...vim, pending: "" }, draft };
    }
  }
  switch (key) {
    case "d": case "c": case "y": case "g": return { vim: { ...vim, pending: key }, draft };
    case "h": return move(cursor > start ? cursor - 1 : cursor);
    case "l": return move(cursor + 1 < end ? cursor + 1 : cursor);
    case "j": return move(lineMove(text, cursor, true));
    case "k": return move(lineMove(text, cursor, false));
    case "w": return move(wordForward(text, cursor));
    case "b": return move(wordBack(text, cursor));
    case "e": return move(wordEnd(text, cursor));
    case "0": return move(start);
    case "^": return move(firstNonBlank(text, cursor));
    case "$": return move(Math.max(start, end - 1));
    case "G": return move(firstNonBlank(text, text.length));
    case "x": return cursor < end ? change({ text: cut(text, cursor, cursor + 1), cursor }, { text: text[cursor]!, line: false }) : move(cursor);
    case "D": return change({ text: cut(text, cursor, end), cursor }, { text: text.slice(cursor, end), line: false });
    case "C": return change({ text: cut(text, cursor, end), cursor }, { text: text.slice(cursor, end), line: false }, true);
    case "i": return insert(draft);
    case "a": return insert({ text, cursor: Math.min(cursor + 1, end) });
    case "I": return insert({ text, cursor: firstNonBlank(text, cursor) });
    case "A": return insert({ text, cursor: end });
    case "o": return insert({ text: insertAt(text, end, "\n"), cursor: end + 1 });
    case "O": return insert({ text: insertAt(text, start, "\n"), cursor: start });
    case "p": {
      const register = vim.register;
      if (!register) return move(cursor);
      if (register.line) { const next = insertAt(text, end, `\n${register.text}`); return change({ text: next, cursor: firstNonBlank(next, end + 1) }); }
      const at = end > start ? cursor + 1 : cursor;
      return change({ text: insertAt(text, at, register.text), cursor: at + register.text.length - 1 });
    }
    case "u": {
      const previous = vim.undo.at(-1);
      if (!previous) return move(cursor);
      return { vim: { ...vim, pending: "", undo: vim.undo.slice(0, -1), redo: [...vim.redo, draft] }, draft: { text: previous.text, cursor: clamp(previous.text, previous.cursor) } };
    }
    case "ctrl+r": {
      const next = vim.redo.at(-1);
      if (!next) return move(cursor);
      return { vim: { ...vim, pending: "", redo: vim.redo.slice(0, -1), undo: [...vim.undo, draft] }, draft: { text: next.text, cursor: clamp(next.text, next.cursor) } };
    }
    default: return { vim: { ...vim, pending: "" }, draft };
  }
}
