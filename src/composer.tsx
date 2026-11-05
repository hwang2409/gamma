import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { addImage, readImage, type QueuedImage } from "./image-queue";
import { escape, normalKey, startVim, type Draft, type Step, type Vim } from "./vim";

// gamma's composer. It keeps @fulcrum/react's composer parts (data-part names, so the shipped styles apply) and adds what
// that component has no seam for yet: attachments, vim keys, and footer controls. Fulcrum follow-up: give Composer slots
// for these, then this file shrinks to the vim keymap.

export type ComposerState = "idle" | "steerable" | "read-only";
export type Submit = (text: string, images: readonly QueuedImage[], intent: { steer: boolean }) => Promise<unknown>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)) || "unknown error";
/** Only the sent text leaves the draft: what the user typed while it was in flight stays (fulcrum's rule). */
const unsentDraft = (current: string, sent: string) => (current.startsWith(sent) ? current.slice(sent.length) : current);
const attempt = (action: () => unknown) => new Promise<unknown>((resolve) => resolve(action()));
const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes("Files");

function hint({ vim, mode, steer, images }: { vim: boolean; mode: Vim["mode"]; steer: boolean; images: boolean }) {
  const send = steer ? "enter to steer the running turn" : "enter to send";
  if (steer && images) return "images send when the turn ends · stop it or wait";
  if (!vim) return `${send} · shift+enter for a new line`;
  if (mode === "insert") return `${send} · esc for normal mode`;
  return `${send} · i to type · u to undo${steer ? " · ctrl+c to stop" : ""}`;
}

export function GammaComposer({ state, reason, vim: vimOn, onSubmit, onStop, footer, autoFocus }: {
  state: ComposerState;
  reason?: string;
  vim: boolean;
  onSubmit: Submit;
  onStop?(): Promise<unknown>;
  /** Controls for the footer row, before attach, stop, and send. */
  footer?: ReactNode;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [images, setImages] = useState<readonly QueuedImage[]>([]);
  const imagesRef = useRef<readonly QueuedImage[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const [vim, setVim] = useState<Vim>(() => startVim({ text: "", cursor: 0 }));
  const inFlight = useRef({ submit: false, stop: false });
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const cursor = useRef<number | null>(null);
  const steer = state === "steerable";
  const normal = vimOn && vim.mode === "normal";

  useEffect(() => { if (autoFocus) input.current?.focus({ preventScroll: true }); }, [autoFocus]);
  useEffect(() => { if (!vimOn) setVim(startVim({ text: "", cursor: 0 })); }, [vimOn]);
  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url)), []);
  // A file dropped beside the composer would replace the page with the image; only the composer takes files.
  useEffect(() => {
    const block = (event: globalThis.DragEvent) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); };
    addEventListener("dragover", block);
    addEventListener("drop", block);
    return () => { removeEventListener("dragover", block); removeEventListener("drop", block); };
  }, []);
  // NORMAL draws its cursor as a one-character selection, the way a block cursor reads in a terminal.
  useLayoutEffect(() => {
    const field = input.current;
    if (!field || cursor.current === null) return;
    const at = cursor.current;
    cursor.current = null;
    const block = normal && at < field.value.length && field.value[at] !== "\n" ? 1 : 0;
    field.setSelectionRange(at, at + block);
  });

  const setQueue = (next: readonly QueuedImage[]) => { imagesRef.current = next; setImages(next); };
  const addFiles = useCallback(async (list: Iterable<File>) => {
    let queue = imagesRef.current;
    let failure = "";
    for (const file of list) {
      try { queue = addImage(queue, await readImage(file)); } catch (cause) { failure = errorText(cause); }
    }
    setQueue(queue);
    setAttachError(failure);
  }, []);
  const remove = (index: number) => {
    const image = imagesRef.current[index];
    if (!image) return;
    URL.revokeObjectURL(image.url);
    const next = imagesRef.current.filter((_, item) => item !== index);
    setQueue(next);
    setAttachError("");
    // Focus stays in the tray: the next remove button, else the field.
    requestAnimationFrame(() => {
      const buttons = input.current?.form?.querySelectorAll<HTMLButtonElement>("[data-part='attachment'] button");
      (buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)] ?? input.current)?.focus();
    });
  };

  // The stop button goes when the turn ends; if it had focus, focus moves to the field, not to the page.
  const stopRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => { if (document.activeElement === button) input.current?.focus({ preventScroll: true }); };
  }, []);

  const apply = ({ vim: next, draft }: Step) => {
    setVim(next);
    setText(draft.text);
    cursor.current = draft.cursor;
  };
  const draft = (): Draft => ({ text, cursor: input.current?.selectionStart ?? text.length });

  const canSubmit = (text.trim() !== "" || images.length > 0) && !sending && !(steer && images.length > 0);
  const submit = () => {
    if (inFlight.current.submit || !canSubmit || state === "read-only") return;
    inFlight.current.submit = true;
    const sent = text;
    const sentImages = imagesRef.current;
    setSending(true);
    setError(undefined);
    attempt(() => onSubmit(sent, sentImages, { steer }))
      .then(
        () => {
          const rest = unsentDraft(input.current?.value ?? sent, sent);
          setText(rest);
          sentImages.forEach((image) => URL.revokeObjectURL(image.url));
          setQueue(imagesRef.current.filter((image) => !sentImages.includes(image)));
          setVim(startVim({ text: rest, cursor: rest.length }));
        },
        (failure: unknown) => setError(`could not ${steer ? "steer" : "send"}: ${errorText(failure)}`),
      )
      .finally(() => { inFlight.current.submit = false; setSending(false); });
  };
  const stop = () => {
    if (inFlight.current.stop || !onStop) return;
    inFlight.current.stop = true;
    setStopping(true);
    setError(undefined);
    attempt(onStop)
      .catch((failure: unknown) => setError(`could not stop: ${errorText(failure)}`))
      .finally(() => { inFlight.current.stop = false; setStopping(false); });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Never act during IME composition: its Enter and Esc belong to the input method.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const key = event.key;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (event.ctrlKey && !event.metaKey && key.toLowerCase() === "c" && steer && (normal || !text)) {
      event.preventDefault();
      stop();
      return;
    }
    if (key === "Enter" && !event.shiftKey && (plain || normal)) { event.preventDefault(); submit(); return; }
    if (!vimOn) return;
    if (key === "Escape") { event.preventDefault(); apply(escape(vim, draft())); return; }
    if (vim.mode === "insert") return;
    if (event.ctrlKey && !event.metaKey && key.toLowerCase() === "r") { event.preventDefault(); apply(normalKey(vim, draft(), "ctrl+r")); return; }
    if (!plain) return;
    const mapped = key === "Backspace" ? "h" : key === "Delete" ? "x" : key;
    // Every printable key is a command in NORMAL, so none of them types into the draft.
    if (mapped.length === 1) { event.preventDefault(); apply(normalKey(vim, draft(), mapped)); }
  };
  const onPaste = (event: ClipboardEvent) => {
    const pasted = [...event.clipboardData.files];
    if (!pasted.length) return;
    event.preventDefault();
    void addFiles(pasted);
  };
  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    input.current?.focus({ preventScroll: true });
    submit();
  };

  if (state === "read-only")
    return (
      <div tabIndex={-1} data-part="composer" data-state="read-only" role="group" aria-label="message">
        {text ? <div data-part="composer-field" data-value={text}><textarea rows={1} value={text} readOnly aria-label="message (draft, read-only)" /></div> : null}
        <p data-part="composer-reason">{reason}</p>
      </div>
    );

  const message = error ?? (stopping ? "stopping" : sending ? (steer ? "steering" : "sending") : "");
  return (
    <form
      data-part="composer"
      data-state={state}
      data-error={error ? "submit" : undefined}
      data-pending={sending ? "submit" : stopping ? "stop" : undefined}
      data-drop={dragging ? "active" : undefined}
      data-vim={vimOn ? vim.mode : undefined}
      aria-label="message"
      aria-busy={sending || stopping || undefined}
      onSubmit={onFormSubmit}
      onPaste={onPaste}
      onDragEnter={(event) => { if (hasFiles(event)) { event.preventDefault(); setDragging(true); } }}
      onDragOver={(event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles(event.dataTransfer.files); }}
    >
      {dragging ? <div className="drop-hint" aria-hidden="true">drop images to attach</div> : null}
      {images.length ? (
        <ul className="attachments" aria-label="attached images">
          {images.map((image, index) => (
            <li key={image.url} data-part="attachment">
              <img src={image.url} alt="" />
              <span title={image.name}>{image.name}</span>
              <button type="button" className="composer-tool" aria-label={`remove ${image.name}`} onClick={() => remove(index)}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      {attachError ? <p className="attach-error" role="status">{attachError}</p> : null}
      <div data-part="composer-field" data-value={text}>
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={steer ? "steer the running turn" : "message zeta"}
          aria-label="message"
          aria-describedby={`${id}-hint ${id}-message`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div data-part="composer-bar">
        {vimOn ? <span className="vim-mode" data-mode={vim.mode} aria-live="polite">{vim.mode === "insert" ? "INSERT" : "NORMAL"}</span> : null}
        <p data-part="composer-status" data-tone={error ? "danger" : message ? "busy" : undefined} title={error}>
          <span data-part="composer-hint" id={`${id}-hint`} hidden={Boolean(message)}>{hint({ vim: vimOn, mode: vim.mode, steer, images: images.length > 0 })}</span>
          <span data-part="composer-message" id={`${id}-message`} role="status">{message}</span>
        </p>
        <div className="composer-tools">
          {footer}
          <button type="button" className="composer-tool attach" aria-label="attach images" title="attach images (or paste, or drop)" onClick={() => files.current?.click()}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10.5 4.5 5.4 9.6a1.5 1.5 0 0 0 2.1 2.1l5.3-5.3a3 3 0 0 0-4.2-4.2L3.2 7.6a4.5 4.5 0 0 0 6.4 6.4l4.4-4.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" /></svg>
          </button>
          <input ref={files} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => { if (event.target.files) void addFiles([...event.target.files]); event.currentTarget.value = ""; }} />
          {steer && onStop ? (
            <button ref={stopRef} type="button" data-part="composer-stop" data-action="stop" aria-label="stop the running turn" aria-disabled={stopping || undefined} onClick={stop}>
              {stopping ? "stopping" : "stop"}
            </button>
          ) : null}
          <button type="submit" data-part="composer-submit" data-action={steer ? "steer" : "send"} aria-label={steer ? "steer the running turn" : "send message"} aria-disabled={!canSubmit || undefined}>
            {steer ? "steer" : "send"}
          </button>
        </div>
      </div>
    </form>
  );
}
