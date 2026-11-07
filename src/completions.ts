// provisional path_complete shape from ~/.zeta/scratch/gamma-tui-parity.md, g2; zeta z2 has not shipped it.
export type CompletionEntry = {
  insert_text: string;
  display_text: string;
  kind: "file" | "directory";
};

export type CompletionResponse = {
  entries: CompletionEntry[];
  truncated: boolean;
};

export type CompletionSnapshot = {
  open: boolean;
  entries: CompletionEntry[];
  truncated: boolean;
  activeIndex: number;
};

export type CompletionKeyResult = {
  handled: boolean;
  submitted: boolean;
  accepted?: { value: string; caret: number };
};

type Token = { start: number; end: number; queryStart: number; query: string };

function tokenAt(value: string, caret: number): Token | undefined {
  if (caret < 0 || caret > value.length) return;
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const prefix = value.slice(lineStart, caret);
  const marker = prefix.lastIndexOf("@");
  if (marker < 0 || (marker > 0 && !/\s/.test(prefix[marker - 1]))) return;
  const start = lineStart + marker;
  const quoted = value[start + 1] === '"';
  const queryStart = start + (quoted ? 2 : 1);
  if (!quoted && /\s/.test(value.slice(queryStart, caret))) return;
  if (quoted) {
    const close = value.indexOf('"', queryStart);
    if (close >= 0 && close < caret) return;
    return { start, end: close >= 0 ? close + 1 : value.length, queryStart, query: value.slice(queryStart, caret) };
  }
  const end = value.slice(start).search(/\s/);
  const tokenEnd = end < 0 ? value.length : start + end;
  return { start, end: tokenEnd, queryStart, query: value.slice(queryStart, caret) };
}

export function findCompletionToken(value: string, selectionStart: number, selectionEnd = selectionStart): Token | undefined {
  if (selectionStart !== selectionEnd) return;
  return tokenAt(value, selectionStart);
}

export class CompletionModel {
  private sequence = 0;
  private value = "";
  private caret = 0;
  private token?: Token;
  private state: CompletionSnapshot = { open: false, entries: [], truncated: false, activeIndex: 0 };

  constructor(
    private readonly request: (query: string) => Promise<CompletionResponse>,
    private readonly featureNegotiated: boolean,
  ) {}

  get snapshot(): CompletionSnapshot { return this.state; }

  update(value: string, selectionStart: number, selectionEnd = selectionStart): void {
    this.value = value;
    this.caret = selectionStart;
    this.token = this.featureNegotiated ? findCompletionToken(value, selectionStart, selectionEnd) : undefined;
    const sequence = ++this.sequence;
    this.state = { open: false, entries: [], truncated: false, activeIndex: 0 };
    if (!this.token) return;
    const query = this.token.query;
    void this.request(query).then((response) => {
      if (sequence !== this.sequence || this.token?.query !== query || this.token.start !== tokenAt(this.value, this.caret)?.start) return;
      this.state = { open: response.entries.length > 0, entries: response.entries, truncated: response.truncated, activeIndex: 0 };
    });
  }

  accept(): { value: string; caret: number } | undefined {
    if (!this.state.open || !this.token) return;
    const entry = this.state.entries[this.state.activeIndex];
    const token = tokenAt(this.value, this.caret);
    if (!entry || !token) return;
    const replacementEnd = this.caret <= token.end ? this.caret : token.end;
    const value = this.value.slice(0, token.queryStart) + entry.insert_text + this.value.slice(replacementEnd);
    return { value, caret: token.queryStart + entry.insert_text.length };
  }

  key(key: "ArrowUp" | "ArrowDown" | "Tab" | "Enter" | "Escape", isComposing = false): CompletionKeyResult {
    if (isComposing) return { handled: false, submitted: false };
    if (key === "Escape") {
      if (!this.state.open) return { handled: false, submitted: false };
      this.sequence++;
      this.state = { ...this.state, open: false };
      return { handled: true, submitted: false };
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      if (!this.state.open) return { handled: false, submitted: false };
      const delta = key === "ArrowDown" ? 1 : -1;
      const count = this.state.entries.length;
      this.state = { ...this.state, activeIndex: (this.state.activeIndex + delta + count) % count };
      return { handled: true, submitted: false };
    }
    if (key === "Tab" || (key === "Enter" && this.state.open)) {
      if (!this.state.open) return { handled: false, submitted: false };
      const accepted = this.accept();
      this.sequence++;
      this.state = { ...this.state, open: false };
      return { handled: true, submitted: false, accepted };
    }
    return { handled: false, submitted: key === "Enter" };
  }
}
