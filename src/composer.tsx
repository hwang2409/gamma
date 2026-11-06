import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type Dispatch, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { addImage, readImage, type QueuedImage } from "./image-queue";
import type { RunStateStore } from "./run-state";
import { escape, normalKey, startVim, type Draft, type Step, type Vim } from "./vim";

// gamma's composer. It keeps @fulcrum/react's composer parts (data-part names, so the shipped styles apply) and adds what
// that component has no seam for yet: attachments, vim keys, and footer controls. Fulcrum follow-up: give Composer slots
// for these, then this file shrinks to the vim keymap.

export type ComposerState = "idle" | "steerable" | "read-only";
export type Submit = (text: string, images: readonly QueuedImage[], intent: { steer: boolean; deliveryId: string }) => Promise<unknown>;

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
  if (event.ctrlKey && !event.metaKey && key.toLowerCase() === "r") { event.preventDefault(); return options.apply(normalKey(options.vim, options.draft(), "ctrl+r")); }
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
  if (!vim) return `${send} · esc to stop · shift+enter for a new line`;
  if (mode === "insert") return `${send} · esc normal · ^c to stop`;
  return `${send} · i type · u undo${steer ? " · ^c stop" : ""}`;
}

type ComposerBodyProps = {
  field: { id: string; state: ComposerState; vimOn: boolean; vim: Vim; text: string; input: RefObject<HTMLTextAreaElement | null>; onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void; onChange(value: string): void };
  attachments: { images: readonly QueuedImage[]; error: string; dragging: boolean; files: RefObject<HTMLInputElement | null>; onPaste(event: ClipboardEvent): void; onImageOpen?(block: { url: string; mediaType: string; alt: string }): void; onRemove(index: number): void; onFiles(files: Iterable<File>): Promise<void>; setDragging: Dispatch<SetStateAction<boolean>> };
  submission: { steer: boolean; sending: boolean; stopping: boolean; error?: string; message: string; canSubmit: boolean; onSubmit(event: FormEvent): void; onStop?: () => void; onStopRef?: (button: HTMLButtonElement | null) => void | (() => void) };
  footer?: ReactNode;
};

function ComposerBody({ field: { id, state, vimOn, vim, text, input, onKeyDown, onChange }, attachments: { images, error: attachError, dragging, files, onPaste, onImageOpen, onRemove, onFiles, setDragging }, submission: { steer, sending, stopping, error, message, canSubmit, onSubmit, onStop, onStopRef }, footer }: ComposerBodyProps) {
  return (
    <form data-part="composer" data-state={state} data-error={error ? "submit" : undefined} data-pending={sending ? "submit" : stopping ? "stop" : undefined} data-drop={dragging ? "active" : undefined} data-vim={vimOn ? vim.mode : undefined} aria-label="message" aria-busy={sending || stopping || undefined} onSubmit={onSubmit} onPaste={onPaste}
      onDragEnter={(event) => { if (hasFiles(event)) { event.preventDefault(); setDragging(true); } }}
      onDragOver={(event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); void onFiles(event.dataTransfer.files); }}>
      {dragging ? <div className="drop-hint" aria-hidden="true">drop images to attach</div> : null}
      <AttachmentsStrip images={images} onOpen={onImageOpen} onRemove={onRemove} />
      {attachError ? <p className="attach-error" role="alert">{attachError}</p> : null}
      <div data-part="composer-field" data-value={text}><textarea ref={input} rows={1} value={text} placeholder={steer ? "steer the running turn" : "message zeta"} aria-label="message" aria-describedby={`${id}-hint ${id}-message`} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} /></div>
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
    const failures: string[] = [];
    for (const file of list) {
      let image: QueuedImage | undefined;
      try { image = await readImage(file); queue = addImage(queue, image); }
      catch (cause) { if (image) URL.revokeObjectURL(image.url); failures.push(`${file.name}: ${errorText(cause)}`); }
    }
    setQueue(queue);
    setAttachError([...new Set(failures)].join(" · "));
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

function useSubmission(state: ComposerState, onSubmit: Submit, onStop: (() => Promise<unknown>) | undefined, draft: ReturnType<typeof useComposerDraft>, attachments: ReturnType<typeof useAttachments>, store: RunStateStore, runId: string, pending: boolean) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef({ submit: false, stop: false });
  const steer = state === "steerable";
  const sending = pending;
  const canSubmit = (draft.text.trim() !== "" || attachments.images.length > 0) && !sending && !(steer && attachments.images.length > 0);
  const submit = () => {
    if (inFlight.current.submit || !canSubmit || state === "read-only") return;
    inFlight.current.submit = true;
    const sent = draft.text;
    const sentImages = attachments.current.current;
    const deliveryId = `web-${crypto.randomUUID()}`;
    store.beginDelivery(runId, { id: deliveryId, method: sentImages.length ? "send_images" : steer ? "steer" : "send", text: sent, images: sentImages });
    setError(undefined);
    attempt(() => onSubmit(sent, sentImages, { steer, deliveryId })).then(
      () => store.settleDelivery(runId, deliveryId, "accepted"),
      (failure: unknown) => { store.settleDelivery(runId, deliveryId, "rejected"); setError(`could not ${steer ? "steer" : "send"}: ${errorText(failure)}`); },
    ).finally(() => { inFlight.current.submit = false; });
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

export function GammaComposer({ state, reason, vim: vimOn, onSubmit, onStop, footer, autoFocus, onImageOpen, store, runId }: {
  state: ComposerState;
  reason?: string;
  vim: boolean;
  onSubmit: Submit;
  onStop?(): Promise<unknown>;
  /** Controls for the footer row, before attach, stop, and send. */
  footer?: ReactNode;
  autoFocus?: boolean;
  onImageOpen?(block: { url: string; mediaType: string; alt: string }): void;
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
  const pending = [...record.deliveries.values()].some((delivery) => delivery.status === "pending");
  const submission = useSubmission(state, onSubmit, onStop, draft, attachments, store, runId, pending);
  useEffect(() => { if (autoFocus && (!document.activeElement || document.activeElement === document.body)) draft.input.current?.focus({ preventScroll: true }); }, [autoFocus]);
  const stopRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => { if (document.activeElement === button) draft.input.current?.focus({ preventScroll: true }); };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => composerKeyDown(event, { steer: submission.steer, normal: draft.normal, vimOn, text: draft.text, vim: draft.vim, draft: draft.current, apply: draft.apply, submit: submission.submit, stop: submission.stop });
  const onFormSubmit = (event: FormEvent) => { event.preventDefault(); draft.input.current?.focus({ preventScroll: true }); submission.submit(); };

  if (state === "read-only" && !draft.text && !reason) return null;
  if (state === "read-only") return <div tabIndex={-1} data-part="composer" data-state="read-only" role="group" aria-label="message">
    {draft.text ? <div data-part="composer-field" data-value={draft.text}><textarea rows={1} value={draft.text} readOnly aria-label="message (draft, read-only)" /></div> : null}
    {reason ? <p data-part="composer-reason">{reason}</p> : null}
  </div>;

  const message = submission.error ?? (submission.stopping ? "stopping" : submission.sending ? (submission.steer ? "steering" : "sending") : "");
  return <ComposerBody
    field={{ id, state, vimOn, vim: draft.vim, text: draft.text, input: draft.input, onKeyDown, onChange: draft.setText }}
    attachments={{ images: attachments.images, error: attachments.attachError, dragging: attachments.dragging, files: attachments.files, onPaste: attachments.onPaste, onImageOpen, onRemove: attachments.remove, onFiles: attachments.addFiles, setDragging: attachments.setDragging }}
    submission={{ steer: submission.steer, sending: submission.sending, stopping: submission.stopping, error: submission.error, message, canSubmit: submission.canSubmit, onSubmit: onFormSubmit, onStop: onStop ? submission.stop : undefined, onStopRef: stopRef }}
    footer={footer}
  />;
}
