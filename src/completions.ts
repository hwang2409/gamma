import { findCommandCompletionToken, type CommandController, type CompletionRow, type CompletionToken } from "./commands";

export type CompletionSnapshot = {
  open: boolean;
  rows: readonly CompletionRow[];
  activeIndex: number;
};

export type CompletionKeyResult = {
  handled: boolean;
  accepted?: { value: string; caret: number };
};

const CLOSED: CompletionSnapshot = { open: false, rows: [], activeIndex: 0 };

export class CompletionModel {
  private sequence = 0;
  private value = "";
  private caret = 0;
  private token?: CompletionToken;
  private state = CLOSED;
  /** Value and selection of the last update; kept across Escape so a repeated select event does not reopen. */
  private input?: string;
  /** Escape closed the menu for the current input; a new command source must not reopen it. */
  private dismissed = false;
  private readonly listeners = new Set<() => void>();

  constructor(private controller: CommandController) {}

  /** The run's command source changed (the run attached, reconnected, or reopened): ask the new one about the token being typed. */
  setController(controller: CommandController) {
    if (controller === this.controller) return;
    this.controller = controller;
    if (this.input !== undefined && this.token && !this.dismissed) this.update(this.value, this.caret);
  }

  readonly getSnapshot = (): CompletionSnapshot => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private setState(state: CompletionSnapshot) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /** A select event: it often repeats the last input, which must keep the active row and keep an Escape-closed menu closed. */
  select(value: string, selectionStart: number, selectionEnd = selectionStart) {
    if (`${selectionStart}:${selectionEnd}:${value}` !== this.input) this.update(value, selectionStart, selectionEnd);
  }

  update(value: string, selectionStart: number, selectionEnd = selectionStart) {
    this.input = `${selectionStart}:${selectionEnd}:${value}`;
    this.dismissed = false;
    this.value = value;
    this.caret = selectionStart;
    this.token = selectionStart === selectionEnd ? findCommandCompletionToken(value.slice(0, selectionStart)) : undefined;
    const sequence = ++this.sequence;
    this.setState(CLOSED);
    if (!this.token) return;
    const token = this.token;
    void this.controller.completions(value.slice(0, selectionStart)).then(
      (rows) => {
        if (sequence !== this.sequence || !this.sameToken(token)) return;
        this.setState({ open: rows.length > 0, rows, activeIndex: 0 });
      },
      () => { if (sequence === this.sequence) this.setState(CLOSED); },
    );
  }

  private sameToken(token: CompletionToken) {
    const current = findCommandCompletionToken(this.value.slice(0, this.caret));
    return current?.trigger === token.trigger && current.start === token.start && current.prefix === token.prefix;
  }

  accept(index = this.state.activeIndex): { value: string; caret: number } | undefined {
    const row = this.state.rows[index];
    if (!this.state.open || !row || !this.token || !this.sameToken(this.token)) return;
    const before = this.value.slice(0, this.token.start);
    const after = this.value.slice(this.caret);
    const insert = `${row.trigger}${row.name}${!/^\s/.test(after) ? " " : ""}`;
    return { value: before + insert + after, caret: before.length + insert.length };
  }

  choose(index: number) {
    const accepted = this.accept(index);
    this.close();
    return accepted;
  }

  /** `modified`: Shift, Alt, Ctrl, or Meta is held; then Tab and Enter keep their normal meaning and close the menu. */
  key(key: string, isComposing = false, modified = false): CompletionKeyResult {
    if (isComposing || !this.state.open) return { handled: false };
    if (key === "Escape") { const input = this.input; this.close(); this.input = input; this.dismissed = true; return { handled: true }; }
    if ((key === "Tab" || key === "Enter") && modified) { this.close(); return { handled: false }; }
    if (key === "ArrowUp" || key === "ArrowDown") {
      const delta = key === "ArrowDown" ? 1 : -1;
      const count = this.state.rows.length;
      this.setState({ ...this.state, activeIndex: (this.state.activeIndex + delta + count) % count });
      return { handled: true };
    }
    if (key === "Tab" || key === "Enter") {
      const accepted = this.accept();
      this.close();
      return { handled: true, accepted };
    }
    return { handled: false };
  }

  close() {
    this.input = undefined;
    this.sequence++;
    this.setState(CLOSED);
  }
}
