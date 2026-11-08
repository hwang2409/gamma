export type CommandReceipt = { text: string; tone: "quiet" | "error"; action?: { label: string; run(): void } };

export function createReceiptStore() {
  const receipts = new Map<string, CommandReceipt>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(runId: string) { return receipts.get(runId) ?? null; },
    set(runId: string, receipt: CommandReceipt) { receipts.set(runId, receipt); emit(); },
    dismiss(runId: string) { if (receipts.delete(runId)) emit(); },
    dispose() { receipts.clear(); listeners.clear(); },
  };
}

export type ReceiptStore = ReturnType<typeof createReceiptStore>;
