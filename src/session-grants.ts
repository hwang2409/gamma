import {
  clearSessionGrants,
  getSessionGrants,
  isSessionGrantError,
  revokeSessionGrant,
  type RevokeSessionGrantsResult,
  type SessionGrantsChanged,
  type SessionGrantsSnapshot,
} from "@fulcrum/zeta";

type GrantsClient = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onSessionGrantsChanged(listener: (event: SessionGrantsChanged) => void): () => void;
};

export type SessionGrantsState = {
  status: "idle" | "loading" | "ready" | "error";
  snapshot: SessionGrantsSnapshot | null;
  readOnly: boolean;
  error?: string;
};

export type SessionGrantsModel = {
  readonly state: SessionGrantsState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  revoke(grant: string): Promise<RevokeSessionGrantsResult | null>;
  clear(): Promise<RevokeSessionGrantsResult>;
  stop(): void;
};

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Owns one viewed session's live grants. A fresh client gets a fresh model, so reconnect always reads again. */
export function createSessionGrantsModel(client: GrantsClient, sessionId: string, readOnly = false): SessionGrantsModel {
  let state: SessionGrantsState = { status: "idle", snapshot: null, readOnly };
  const listeners = new Set<() => void>();
  const set = (next: SessionGrantsState) => { state = next; listeners.forEach((listener) => listener()); };
  const accept = (snapshot: SessionGrantsSnapshot) => {
    if (snapshot.session_id !== sessionId) return false;
    set({ status: "ready", snapshot, readOnly: state.readOnly });
    return true;
  };
  const fail = (error: unknown) => {
    const text = message(error);
    set({ ...state, status: "error", error: text });
    return error instanceof Error ? error : new Error(text);
  };
  let unsubscribe: (() => void) | null = null;
  const listen = () => { unsubscribe ??= client.onSessionGrantsChanged((event) => { accept(event.grants); }); };

  const load = async () => {
    listen();
    set({ ...state, status: "loading", error: undefined });
    try {
      const snapshot = await getSessionGrants(client);
      if (!snapshot || !accept(snapshot)) throw new Error("invalid session grants response");
    } catch (error) { throw fail(error); }
  };
  const mutate = async (operation: () => Promise<RevokeSessionGrantsResult | null>) => {
    if (state.readOnly) throw new Error("read-only observer");
    try {
      const result = await operation();
      if (!result || !accept(result.grants)) throw new Error("invalid session grants response");
      return result;
    } catch (error) {
      if ((error as { code?: unknown }).code === -32008) {
        set({ ...state, readOnly: true, error: undefined });
        throw new Error("read-only observer");
      }
      throw fail(error);
    }
  };

  return {
    get state() { return state; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    load,
    async revoke(grant) {
      try { return await mutate(() => revokeSessionGrant(client, grant)); }
      catch (error) {
        if (isSessionGrantError(error) && error.data.code === "session_grant_not_found") {
          await load();
          return null;
        }
        throw error;
      }
    },
    async clear() {
      const result = await mutate(() => clearSessionGrants(client));
      if (!result) throw new Error("invalid session grants response");
      return result;
    },
    stop() { unsubscribe?.(); unsubscribe = null; listeners.clear(); },
  };
}
