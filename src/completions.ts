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
  error: boolean;
};

export type CompletionKeyResult = {
  handled: boolean;
  submitted: boolean;
  accepted?: { value: string; caret: number };
};

type Token = { start: number; queryStart: number; query: string };

// Matches zeta src/zeta/tui/completion.py:19-20 against text before the caret.
const PATH_TOKEN = /(?<!\S)@(?:"(?<quoted>[^"\n]*)|(?<unquoted>[^\s]*))$/;
const CLOSED: CompletionSnapshot = { open: false, entries: [], truncated: false, activeIndex: 0, error: false };

function tokenAt(value: string, caret: number): Token | undefined {
  if (caret < 0 || caret > value.length) return;
  const match = PATH_TOKEN.exec(value.slice(0, caret));
  if (!match || match.index === undefined) return;
  const quoted = match.groups?.quoted;
  return {
    start: match.index,
    queryStart: match.index + (quoted === undefined ? 1 : 2),
    query: quoted ?? match.groups?.unquoted ?? "",
  };
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
    private readonly request: (query: string) => Promise<CompletionResponse>,
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
    this.token = this.featureNegotiated ? findCompletionToken(value, selectionStart, selectionEnd) : undefined;
    const sequence = ++this.sequence;
    this.setState({ ...CLOSED });
    if (!this.token) return;
    const { query, start } = this.token;
    void this.request(query).then(
      (response) => {
        if (!this.isCurrent(sequence, query, start)) return;
        this.setState({
          open: response.entries.length > 0,
          entries: response.entries,
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
    const token = tokenAt(this.value, this.caret);
    if (!entry || !token) return;
    const value = this.value.slice(0, token.queryStart) + entry.insert_text + this.value.slice(this.caret);
    return { value, caret: token.queryStart + entry.insert_text.length };
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
