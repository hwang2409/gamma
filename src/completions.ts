import type { RequestOptions } from "@fulcrum/zeta";
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

/**
 * `@` asks zeta only after this long without input. Every input clears a waiting lookup, so lookups also start at least
 * this far apart: at most 10 in any second, and never a queue of stale ones.
 */
const PATH_IDLE_MS = 100;

export type CompletionTimers = { setTimer(run: () => void, ms: number): unknown; clearTimer(timer: unknown): void };
const BROWSER_TIMERS: CompletionTimers = { setTimer: (run, ms) => setTimeout(run, ms), clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) };

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
  /** The `@` lookup waiting for input to go idle, and the one in flight; a newer input, close, or composition ends both. */
  private idle?: unknown;
  private remote?: AbortController;
  private composing = false;

  constructor(private controller: CommandController, private readonly timers: CompletionTimers = BROWSER_TIMERS) {}

  /** The run's command source changed (the run attached, reconnected, or reopened): ask the new one about the token still in the field. */
  setController(controller: CommandController, field: { value: string; caret: number }) {
    if (controller === this.controller) return;
    this.controller = controller;
    if (this.input !== undefined && this.token && !this.dismissed) this.update(field.value, field.caret);
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
    this.stopRemote();
    this.setState(CLOSED);
    if (!this.token || this.composing) return;
    if (this.token.trigger === "@") {
      this.idle = this.timers.setTimer(() => this.lookup(sequence), PATH_IDLE_MS);
      return;
    }
    this.ask(sequence);
  }

  private lookup(sequence: number) {
    this.idle = undefined;
    this.remote = new AbortController();
    this.ask(sequence, this.remote.signal);
  }

  private ask(sequence: number, signal?: AbortSignal) {
    const token = this.token!;
    const options: RequestOptions | undefined = signal && { signal };
    void this.controller.completions(this.value.slice(0, this.caret), options).then(
      (rows) => {
        if (sequence !== this.sequence || !this.sameToken(token)) return;
        this.setState({ open: rows.length > 0, rows, activeIndex: 0 });
      },
      () => { if (sequence === this.sequence) this.setState(CLOSED); },
    );
  }

  private stopRemote() {
    if (this.idle !== undefined) this.timers.clearTimer(this.idle);
    this.idle = undefined;
    this.remote?.abort();
    this.remote = undefined;
  }

  /** An input method is composing text: nothing completes, and the committed text asks once when it ends. */
  startComposition() {
    this.composing = true;
    this.sequence++;
    this.stopRemote();
    this.setState(CLOSED);
  }

  endComposition(value: string, selectionStart: number, selectionEnd = selectionStart) {
    this.composing = false;
    this.update(value, selectionStart, selectionEnd);
  }

  private sameToken(token: CompletionToken) {
    const current = findCommandCompletionToken(this.value.slice(0, this.caret));
    return current?.trigger === token.trigger && current.start === token.start && current.prefix === token.prefix;
  }

  accept(index = this.state.activeIndex): { value: string; caret: number } | undefined {
    const row = this.state.rows[index];
    if (!this.state.open || !row || !this.token || !this.sameToken(this.token)) return;
    const after = this.value.slice(this.caret);
    // Zeta's start_position, already in UTF-16 units: the row replaces the typed path after `@` and adds no space.
    if (row.trigger === "@") {
      const before = this.value.slice(0, this.caret + row.startPosition);
      return { value: before + row.text + after, caret: before.length + row.text.length };
    }
    const before = this.value.slice(0, this.token.start);
    const insert = `${row.trigger}${row.name}${!/^\s/.test(after) ? " " : ""}`;
    return { value: before + insert + after, caret: before.length + insert.length };
  }

  choose(index: number) {
    const row = this.state.rows[index];
    const accepted = this.accept(index);
    this.close();
    if (!accepted) return;
    // A directory is half a path: the list continues inside it, as in the TUI.
    if (row?.trigger === "@" && row.kind === "directory") this.update(accepted.value, accepted.caret);
    // Otherwise the field's select event echoes the accepted text, which (a path has no trailing space) must not reopen.
    else { this.input = `${accepted.caret}:${accepted.caret}:${accepted.value}`; this.dismissed = true; }
    return accepted;
  }

  /** `modified`: Shift, Alt, Ctrl, or Meta is held; then Tab and Enter keep their normal meaning and close the menu. */
  key(key: string, isComposing = false, modified = false): CompletionKeyResult {
    // A key outside composition means any composition is over, even if the field unmounted before its compositionend.
    if (!isComposing) this.composing = false;
    if (isComposing || !this.state.open) return { handled: false };
    if (key === "Escape") { const input = this.input; this.close(); this.input = input; this.dismissed = true; return { handled: true }; }
    if ((key === "Tab" || key === "Enter") && modified) { this.close(); return { handled: false }; }
    if (key === "ArrowUp" || key === "ArrowDown") {
      const delta = key === "ArrowDown" ? 1 : -1;
      const count = this.state.rows.length;
      this.setState({ ...this.state, activeIndex: (this.state.activeIndex + delta + count) % count });
      return { handled: true };
    }
    if (key === "Tab" || key === "Enter") return { handled: true, accepted: this.choose(this.state.activeIndex) };
    return { handled: false };
  }

  /** Also the teardown: it ends any `@` lookup, so nothing launches or publishes after the composer unmounts. */
  close() {
    this.input = undefined;
    this.sequence++;
    this.stopRemote();
    this.setState(CLOSED);
  }
}
