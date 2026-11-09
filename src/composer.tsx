import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type Dispatch, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { addImage, readImage, type QueuedImage } from "./image-queue";
import { hasPendingDelivery, type RunStateStore } from "./run-state";
import { escape, normalKey, startVim, type Draft, type Step, type Vim } from "./vim";
import { CompletionModel, type CompletionSnapshot } from "./completions";
import type { CommandController, ComposerAction } from "./commands";
import { browserUsesControlRForReload, composerHint } from "./keys";

// gamma's composer. It keeps @fulcrum/react's composer parts (data-part names, so the shipped styles apply) and adds what
// that component has no seam for yet: attachments, vim keys, and footer controls. Fulcrum follow-up: give Composer slots
// for these, then this file shrinks to the vim keymap.

export type ComposerState = "idle" | "steerable" | "read-only";
export type Submit = (action: ComposerAction, images: readonly QueuedImage[], intent: { steer: boolean; deliveryId: string; sourceText: string }) => Promise<unknown>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)) || "unknown error";
const attempt = (action: () => unknown) => new Promise<unknown>((resolve) => resolve(action()));
const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes("Files");
function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, options: { steer: boolean; normal: boolean; vimOn: boolean; text: string; vim: Vim; draft(): Draft; apply(step: Step): void; submit(): void; stop(): void }) {
  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
  const key = event.key;
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
  if (event.ctrlKey && !event.metaKey && key.toLowerCase() === "c" && options.steer && (options.normal || !options.text)) { event.preventDefault(); options.stop(); return; }
  if (key === "Enter" && !event.shiftKey && (plain || options.normal)) { event.preventDefault(); options.submit(); return; }
  if (key === "Escape" && options.steer && !options.vimOn) { event.preventDefault(); options.stop(); return; }
  if (!options.vimOn) return;
  if (key === "Escape") { event.preventDefault(); return options.apply(escape(options.vim, options.draft())); }
  if (options.vim.mode === "insert") return;
  if (event.ctrlKey && !event.metaKey && key.toLowerCase() === "r" && !browserUsesControlRForReload(navigator.platform)) { event.preventDefault(); return options.apply(normalKey(options.vim, options.draft(), "ctrl+r")); }
  if (!plain) return;
  const mapped = key === "Backspace" ? "h" : key === "Delete" ? "x" : key;
  if (mapped.length === 1) { event.preventDefault(); options.apply(normalKey(options.vim, options.draft(), mapped)); }
}

function AttachmentsStrip({ images, onOpen, onRemove }: { images: readonly QueuedImage[]; onOpen?(block: { url: string; mediaType: string; alt: string }): void; onRemove(index: number): void }) {
  return images.length ? <ul className="attachments" aria-label="attached images">{images.map((image, index) => <li key={image.url} data-part="attachment">
    <button type="button" className="attachment-preview" aria-label={`open image: ${image.name}`} onClick={() => onOpen?.({ url: image.url, mediaType: image.mime_type, alt: image.name })}><img src={image.url} alt="" /></button>
    <span title={image.name}>{image.name}</span><button type="button" className="composer-tool" aria-label={`remove ${image.name}`} onClick={() => onRemove(index)}>×</button>
  </li>)}</ul> : null;
}

function SubmitStopSlot({ steer, stopping, onStop, stopRef }: { steer: boolean; stopping: boolean; onStop?: () => void; stopRef?: (button: HTMLButtonElement | null) => void | (() => void) }) {
  if (!onStop) return null;
  return steer ? <button ref={stopRef} type="button" data-part="composer-stop" data-action="stop" aria-label="stop the running turn" aria-disabled={stopping || undefined} onClick={onStop}>{stopping ? "stopping" : "stop"}</button> : <span className="composer-stop-slot" aria-hidden="true">stop</span>;
}

function hint({ vim, mode, steer, images }: { vim: boolean; mode: Vim["mode"]; steer: boolean; images: boolean }) {
  const send = steer ? "enter to steer" : "enter to send";
  if (steer && images) return "images send when the turn ends · stop it or wait";
  if (!vim) return steer ? `${composerHint(true)} · esc stop` : composerHint(false);
  if (mode === "insert") return `${send} · esc normal · ^c to stop`;
  return `${send} · i type · u undo${steer ? " · ^c stop" : ""}`;
}

/** Marks the edges that have rows past them, so CSS shades only those (attributes, not state: scrolling never re-renders). */
function markEdges(node: HTMLElement | null) {
  if (!node) return;
  node.toggleAttribute("data-more-above", node.scrollTop > 0.5);
  node.toggleAttribute("data-more-below", node.scrollTop + node.clientHeight < node.scrollHeight - 0.5);
}

function Suggestions({ id, snapshot, onAccept }: { id: string; snapshot: CompletionSnapshot; onAccept(index: number): void }) {
  const list = useRef<HTMLDivElement>(null);
  // aria-activedescendant moves no focus, so the list scrolls the active row into view itself.
  useLayoutEffect(() => {
    if (!snapshot.open) return;
    document.getElementById(`${id}-${snapshot.activeIndex}`)?.scrollIntoView({ block: "nearest" });
    markEdges(list.current);
  }, [id, snapshot]);
  if (!snapshot.open) return null;
  return <div ref={list} id={id} className="command-listbox" role="listbox" aria-label="command suggestions" onScroll={(event) => markEdges(event.currentTarget)}>{snapshot.rows.map((row, index) => <button
    type="button"
    role="option"
    id={`${id}-${index}`}
    aria-selected={index === snapshot.activeIndex}
    className="command-option"
    aria-label={`${row.trigger}${row.name}: ${row.description}`}
    key={`${row.trigger}${row.name}`}
    onPointerDown={(event) => { event.preventDefault(); onAccept(index); }}
  ><span className="command-name">{row.trigger}{row.name}</span><span className="command-description">{row.description}</span>{row.sourceBadge ? <span className="command-source">{row.sourceBadge}</span> : null}</button>)}</div>;
}

type ComposerBodyProps = {
  field: { id: string; state: ComposerState; vimOn: boolean; vim: Vim; text: string; input: RefObject<HTMLTextAreaElement | null>; completion: CompletionSnapshot; listboxId: string; onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void; onChange(value: string, start: number, end: number): void; onSelect(value: string, start: number, end: number): void; onAccept(index: number): void };
  attachments: { images: readonly QueuedImage[]; error: string; dragging: boolean; files: RefObject<HTMLInputElement | null>; onPaste(event: ClipboardEvent): void; onImageOpen?(block: { url: string; mediaType: string; alt: string }): void; onRemove(index: number): void; onFiles(files: Iterable<File>): Promise<void>; setDragging: Dispatch<SetStateAction<boolean>> };
  submission: { steer: boolean; sending: boolean; stopping: boolean; error?: string; message: string; canSubmit: boolean; onSubmit(event: FormEvent): void; onStop?: () => void; onStopRef?: (button: HTMLButtonElement | null) => void | (() => void) };
  footer?: ReactNode;
};

function ComposerBody({ field: { id, state, vimOn, vim, text, input, completion, listboxId, onKeyDown, onChange, onSelect, onAccept }, attachments: { images, error: attachError, dragging, files, onPaste, onImageOpen, onRemove, onFiles, setDragging }, submission: { steer, sending, stopping, error, message, canSubmit, onSubmit, onStop, onStopRef }, footer }: ComposerBodyProps) {
  return (
    <form data-part="composer" data-state={state} data-error={error ? "submit" : undefined} data-pending={sending ? "submit" : stopping ? "stop" : undefined} data-drop={dragging ? "active" : undefined} data-vim={vimOn ? vim.mode : undefined} aria-label="message" aria-busy={sending || stopping || undefined} onSubmit={onSubmit} onPaste={onPaste}
      onDragEnter={(event) => { if (hasFiles(event)) { event.preventDefault(); setDragging(true); } }}
      onDragOver={(event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); void onFiles(event.dataTransfer.files); }}>
      {dragging ? <div className="drop-hint" aria-hidden="true">drop images to attach</div> : null}
      <AttachmentsStrip images={images} onOpen={onImageOpen} onRemove={onRemove} />
      {attachError ? <p className="attach-error" role="alert">{attachError}</p> : null}
      <Suggestions id={listboxId} snapshot={completion} onAccept={onAccept} />
      <div data-part="composer-field" data-value={text}><textarea ref={input} rows={1} value={text} placeholder={steer ? "steer the running turn" : "message zeta"} aria-label="message" aria-describedby={`${id}-hint ${id}-message`} role="combobox" aria-autocomplete="list" aria-expanded={completion.open} aria-controls={listboxId} aria-activedescendant={completion.open ? `${listboxId}-${completion.activeIndex}` : undefined} onChange={(event) => onChange(event.target.value, event.target.selectionStart, event.target.selectionEnd)} onSelect={(event) => onSelect(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)} onKeyDown={onKeyDown} /></div>
      <div data-part="composer-bar">
        {vimOn ? <span className="vim-mode" data-mode={vim.mode} aria-live="polite">{vim.mode === "insert" ? "INSERT" : "NORMAL"}</span> : null}
        <p data-part="composer-status" data-tone={error ? "danger" : message ? "busy" : undefined} title={error}><span data-part="composer-hint" id={`${id}-hint`} hidden={Boolean(message)}>{hint({ vim: vimOn, mode: vim.mode, steer, images: images.length > 0 })}</span><span data-part="composer-message" id={`${id}-message`} role="status">{message}</span></p>
        <div className="composer-tools">{footer}<button type="button" className="composer-tool attach" aria-label="attach images" title="attach images (or paste, or drop)" onClick={() => files.current?.click()}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10.5 4.5 5.4 9.6a1.5 1.5 0 0 0 2.1 2.1l5.3-5.3a3 3 0 0 0-4.2-4.2L3.2 7.6a4.5 4.5 0 0 0 6.4 6.4l4.4-4.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" /></svg></button>
          <input ref={files} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => { if (event.target.files) void onFiles([...event.target.files]); event.currentTarget.value = ""; }} />
          <SubmitStopSlot steer={steer} stopping={stopping} onStop={onStop} stopRef={onStopRef} /><button type="submit" data-part="composer-submit" data-action={steer ? "steer" : "send"} aria-label={steer ? "steer the running turn" : "send message"} aria-disabled={!canSubmit || undefined}>{steer ? "steer" : "send"}</button>
        </div>
      </div>
    </form>
  );
}

function useComposerDraft(vimOn: boolean, text: string, onChange: (text: string) => void) {
  const input = useRef<HTMLTextAreaElement>(null);
  const cursor = useRef<number | null>(null);
  const [vim, setVim] = useState<Vim>(() => startVim({ text, cursor: text.length }));
  const normal = vimOn && vim.mode === "normal";
  useEffect(() => { if (!vimOn) setVim(startVim({ text: "", cursor: 0 })); }, [vimOn]);
  useLayoutEffect(() => {
    const field = input.current;
    if (!field || cursor.current === null) return;
    const at = cursor.current;
    cursor.current = null;
    const block = normal && at < field.value.length && field.value[at] !== "\n" ? 1 : 0;
    field.setSelectionRange(at, at + block);
  });
  const apply = ({ vim: next, draft }: Step) => { setVim(next); onChange(draft.text); cursor.current = draft.cursor; };
  const current = (): Draft => ({ text, cursor: input.current?.selectionStart ?? text.length });
  return { input, text, setText: onChange, vim, normal, apply, current };
}

function useAttachments(input: RefObject<HTMLTextAreaElement | null>, images: readonly QueuedImage[], onChange: (images: readonly QueuedImage[]) => void, onRemove: (index: number) => void) {
  const files = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const setQueue = (next: readonly QueuedImage[]) => onChange(next);
  useEffect(() => {
    const block = (event: globalThis.DragEvent) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); };
    addEventListener("dragover", block);
    addEventListener("drop", block);
    return () => { removeEventListener("dragover", block); removeEventListener("drop", block); };
  }, []);
  const addFiles = useCallback(async (list: Iterable<File>) => {
    let queue = imagesRef.current;
    const failures = new Map<string, string[]>();
    for (const file of list) {
      let image: QueuedImage | undefined;
      try { image = await readImage(file); queue = addImage(queue, image); }
      catch (cause) {
        if (image) URL.revokeObjectURL(image.url);
        const reason = errorText(cause);
        failures.set(reason, [...(failures.get(reason) ?? []), file.name]);
      }
    }
    setQueue(queue);
    setAttachError([...failures].map(([reason, names]) => `${names.join(", ")}: ${reason}`).join(" · "));
  }, []);
  const remove = (index: number) => {
    if (!imagesRef.current[index]) return;
    onRemove(index);
    setAttachError("");
    requestAnimationFrame(() => {
      const buttons = input.current?.form?.querySelectorAll<HTMLButtonElement>("[data-part='attachment'] button");
      (buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)] ?? input.current)?.focus();
    });
  };
  const onPaste = (event: ClipboardEvent) => {
    const pasted = [...event.clipboardData.files];
    if (!pasted.length) return;
    event.preventDefault();
    void addFiles(pasted);
  };
  return { files, images, current: imagesRef, attachError, dragging, setDragging, addFiles, remove, onPaste };
}

export function canSubmitComposer(blocked: boolean, text: string, imageCount: number, sending: boolean, steer: boolean) {
  return !blocked && (text.trim() !== "" || imageCount > 0) && !sending && !(steer && imageCount > 0 && !text.trimStart().startsWith("/"));
}

function useSubmission(state: ComposerState, blocked: boolean, commands: CommandController, onSubmit: Submit, onPreparationFailure: ((error: unknown, images: readonly QueuedImage[], text: string) => void) | undefined, onStop: (() => Promise<unknown>) | undefined, draft: ReturnType<typeof useComposerDraft>, attachments: ReturnType<typeof useAttachments>, store: RunStateStore, runId: string, pending: boolean) {
  const [stopping, setStopping] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef({ submit: false, stop: false });
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const steer = state === "steerable";
  const sending = pending || preparing;
  const canSubmit = canSubmitComposer(blocked, draft.text, attachments.images.length, sending, steer);
  const submit = () => {
    if (inFlight.current.submit || !canSubmit || state === "read-only") return;
    inFlight.current.submit = true;
    setPreparing(true);
    setError(undefined);
    const sent = draft.text;
    const sentImages = attachments.current.current;
    const deliveryId = store.deliveryIdFor(runId, sent, sentImages);
    commands.prepareComposerInput(sent).then((action) => {
      const imageDelivery = action.kind === "send" && sentImages.length > 0;
      if (imageDelivery) store.beginDelivery(runId, { id: deliveryId, attemptId: deliveryId, method: "send_images", text: sent, images: sentImages });
      return attempt(() => onSubmit(action, sentImages, { steer, deliveryId, sourceText: sent })).then(
        () => { if (imageDelivery) store.settleDelivery(runIdRef.current, deliveryId, "accepted"); },
        (failure: unknown) => { if (imageDelivery) store.settleDelivery(runIdRef.current, deliveryId, "rejected"); throw failure; },
      );
    }, (error: unknown) => { if (!onPreparationFailure) throw error; onPreparationFailure(error, sentImages, sent); }).catch((failure: unknown) => setError(`could not ${steer ? "steer" : "send"}: ${errorText(failure)}`))
      .finally(() => { inFlight.current.submit = false; setPreparing(false); });
  };
  const stop = () => {
    if (inFlight.current.stop || !onStop) return;
    inFlight.current.stop = true;
    setStopping(true);
    setError(undefined);
    attempt(onStop).catch((failure: unknown) => setError(`could not stop: ${errorText(failure)}`))
      .finally(() => { inFlight.current.stop = false; setStopping(false); });
  };
  return { steer, canSubmit, sending, stopping, error, submit, stop };
}

export function GammaComposer({ state, reason, blockedReason, vim: vimOn, commands, onSubmit, onPreparationFailure, onStop, footer, autoFocus, onImageOpen, onFileInput, store, runId }: {
  state: ComposerState;
  reason?: string;
  blockedReason?: string;
  vim: boolean;
  commands: CommandController;
  onSubmit: Submit;
  /** Shows a failed command preparation; once it has, the composer shows no second error. */
  onPreparationFailure?(error: unknown, images: readonly QueuedImage[], text: string): void;
  onStop?(): Promise<unknown>;
  /** Controls for the footer row, before attach, stop, and send. */
  footer?: ReactNode;
  autoFocus?: boolean;
  onImageOpen?(block: { url: string; mediaType: string; alt: string }): void;
  onFileInput?(input: HTMLInputElement | null): void;
  store: RunStateStore;
  runId: string;
}) {
  const id = useId();
  const record = useSyncExternalStore(store.subscribe, () => store.get(runId));
  const saveText = useCallback((text: string) => store.edit(runId, { text }), [store, runId]);
  const saveImages = useCallback((attachments: readonly QueuedImage[]) => store.edit(runId, { attachments }), [store, runId]);
  const removeImage = useCallback((index: number) => store.removeAttachment(runId, index), [store, runId]);
  const draft = useComposerDraft(vimOn, record.text, saveText);
  const attachments = useAttachments(draft.input, record.attachments, saveImages, removeImage);
  const pending = hasPendingDelivery(record);
  // One model for the composer's life: a new command source re-asks about the typed token instead of dropping it.
  const [completions] = useState(() => new CompletionModel(commands));
  const completion = useSyncExternalStore(completions.subscribe, completions.getSnapshot);
  const submission = useSubmission(state, Boolean(blockedReason), commands, onSubmit, onPreparationFailure, onStop, draft, attachments, store, runId, pending);
  useEffect(() => { if (autoFocus && (!document.activeElement || document.activeElement === document.body)) draft.input.current?.focus({ preventScroll: true }); }, [autoFocus]);
  useEffect(() => {
    // Read the field, not the model's last input: a submit clears the draft without an input event.
    const field = draft.input.current;
    completions.setController(commands, field ? { value: field.value, caret: field.selectionStart } : { value: draft.text, caret: draft.text.length });
    void commands.refreshCatalog().catch(() => {});
  }, [completions, commands]);
  useEffect(() => { onFileInput?.(attachments.files.current); return () => onFileInput?.(null); }, [attachments.files, onFileInput]);
  const stopRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => { if (document.activeElement === button) draft.input.current?.focus({ preventScroll: true }); };
  }, []);
  const applyCompletion = (accepted: { value: string; caret: number } | undefined) => {
    if (!accepted) return;
    draft.input.current?.focus({ preventScroll: true });
    draft.setText(accepted.value);
    requestAnimationFrame(() => { draft.input.current?.focus({ preventScroll: true }); draft.input.current?.setSelectionRange(accepted.caret, accepted.caret); });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const choice = completions.key(event.key, event.nativeEvent.isComposing || event.keyCode === 229, event.shiftKey || event.altKey || event.ctrlKey || event.metaKey);
    if (choice.handled) { event.preventDefault(); applyCompletion(choice.accepted); return; }
    composerKeyDown(event, { steer: submission.steer, normal: draft.normal, vimOn, text: draft.text, vim: draft.vim, draft: draft.current, apply: draft.apply, submit: submission.submit, stop: submission.stop });
  };
  const onFormSubmit = (event: FormEvent) => { event.preventDefault(); draft.input.current?.focus({ preventScroll: true }); submission.submit(); };

  if (state === "read-only" && !draft.text && !reason) return null;
  if (state === "read-only") return <div tabIndex={-1} data-part="composer" data-state="read-only" role="group" aria-label="message">
    {draft.text ? <div data-part="composer-field" data-value={draft.text}><textarea rows={1} value={draft.text} readOnly aria-label="message (draft, read-only)" /></div> : null}
    {reason ? <p data-part="composer-reason">{reason}</p> : null}
  </div>;

  const message = submission.error ?? (submission.stopping ? "stopping" : submission.sending ? (submission.steer ? "steering" : "sending") : blockedReason ?? "");
  return <ComposerBody
    field={{ id, state, vimOn, vim: draft.vim, text: draft.text, input: draft.input, completion, listboxId: `${id}-commands`, onKeyDown, onChange: (value, start, end) => { draft.setText(value); completions.update(value, start, end); }, onSelect: (value, start, end) => completions.select(value, start, end), onAccept: (index) => applyCompletion(completions.choose(index)) }}
    attachments={{ images: attachments.images, error: attachments.attachError, dragging: attachments.dragging, files: attachments.files, onPaste: attachments.onPaste, onImageOpen, onRemove: attachments.remove, onFiles: attachments.addFiles, setDragging: attachments.setDragging }}
    submission={{ steer: submission.steer, sending: submission.sending, stopping: submission.stopping, error: submission.error, message, canSubmit: submission.canSubmit, onSubmit: onFormSubmit, onStop: onStop ? submission.stop : undefined, onStopRef: stopRef }}
    footer={footer}
  />;
}
