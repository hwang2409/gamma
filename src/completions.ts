// Provisional path_complete shape from design-serve-capability-registry.md sections 4 (z2) and 5.1; Zeta z2 has not shipped it.
export type CompletionRequest = {
  session_id: string;
  text_before_cursor: string;
};

export type CompletionEntry = {
  text: string;
  start_position: number;
  display: string;
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
  error: boolean;
};

export type CompletionKeyResult = {
  handled: boolean;
  submitted: boolean;
  accepted?: { value: string; caret: number };
};

type Token = { start: number; query: string };

// Matches Zeta src/zeta/tui/completion.py:19-20 against text before the caret.
const PATH_TOKEN = /(?<!\S)@(?:"(?<quoted>[^"\n]*)|(?<unquoted>[^\s]*))$/;
const CLOSED: CompletionSnapshot = { open: false, entries: [], truncated: false, activeIndex: 0, error: false };
const MAX_TEXT_BEFORE_CURSOR_BYTES = 4096;
const UTF8 = new TextEncoder();

function tokenAt(value: string, caret: number): Token | undefined {
  if (caret < 0 || caret > value.length) return;
  const match = PATH_TOKEN.exec(value.slice(0, caret));
  if (!match || match.index === undefined) return;
  return {
    start: match.index,
    query: match.groups?.quoted ?? match.groups?.unquoted ?? "",
  };
}

function positionAtCodePointOffset(value: string, caret: number, offset: number): number {
  const codePoints = Array.from(value.slice(0, caret));
  return codePoints.slice(0, Math.max(0, codePoints.length + offset)).join("").length;
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
  private state = CLOSED;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly request: (params: CompletionRequest) => Promise<CompletionResponse>,
    private readonly sessionId: string,
    private readonly featureNegotiated: boolean,
  ) {}

  readonly getSnapshot = (): CompletionSnapshot => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get snapshot(): CompletionSnapshot { return this.state; }

  private setState(state: CompletionSnapshot): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  update(value: string, selectionStart: number, selectionEnd = selectionStart): void {
    this.value = value;
    this.caret = selectionStart;
    const textBeforeCursor = value.slice(0, selectionStart);
    this.token = this.featureNegotiated && UTF8.encode(textBeforeCursor).length <= MAX_TEXT_BEFORE_CURSOR_BYTES
      ? findCompletionToken(value, selectionStart, selectionEnd)
      : undefined;
    const sequence = ++this.sequence;
    this.setState({ ...CLOSED });
    if (!this.token) return;
    const { query, start } = this.token;
    void this.request({ session_id: this.sessionId, text_before_cursor: textBeforeCursor }).then(
      (response) => {
        if (!this.isCurrent(sequence, query, start)) return;
        const entries = response.entries.filter(
          (entry) => Number.isInteger(entry.start_position) && entry.start_position <= 0,
        );
        this.setState({
          open: entries.length > 0,
          entries,
          truncated: response.truncated,
          activeIndex: 0,
          error: false,
        });
      },
      () => {
        if (!this.isCurrent(sequence, query, start)) return;
        this.setState({ ...CLOSED, error: true });
      },
    );
  }

  private isCurrent(sequence: number, query: string, start: number): boolean {
    const current = tokenAt(this.value, this.caret);
    return sequence === this.sequence && this.token?.query === query && current?.start === start;
  }

  accept(): { value: string; caret: number } | undefined {
    if (!this.state.open || !this.token) return;
    const entry = this.state.entries[this.state.activeIndex];
    if (!entry || !tokenAt(this.value, this.caret)) return;
    const replaceStart = positionAtCodePointOffset(this.value, this.caret, entry.start_position);
    const value = this.value.slice(0, replaceStart) + entry.text + this.value.slice(this.caret);
    return { value, caret: replaceStart + entry.text.length };
  }

  key(key: "ArrowUp" | "ArrowDown" | "Tab" | "Enter" | "Escape", isComposing = false): CompletionKeyResult {
    if (isComposing) return { handled: false, submitted: false };
    if (key === "Escape") {
      if (!this.state.open) return { handled: false, submitted: false };
      this.sequence++;
      this.setState({ ...this.state, open: false });
      return { handled: true, submitted: false };
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      if (!this.state.open) return { handled: false, submitted: false };
      const delta = key === "ArrowDown" ? 1 : -1;
      const count = this.state.entries.length;
      this.setState({ ...this.state, activeIndex: (this.state.activeIndex + delta + count) % count });
      return { handled: true, submitted: false };
    }
    if (key === "Tab" || (key === "Enter" && this.state.open)) {
      if (!this.state.open) return { handled: false, submitted: false };
      const accepted = this.accept();
      this.sequence++;
      this.setState({ ...this.state, open: false });
      return { handled: true, submitted: false, accepted };
    }
    return { handled: false, submitted: key === "Enter" };
  }
}
