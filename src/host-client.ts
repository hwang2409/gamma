import type { SessionStore } from "@fulcrum/zeta";
import { useEffect, useState } from "react";
import type { Artifact, HostCommand } from "./host/types";

const base = "/__gamma";
const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `gamma host answered ${response.status}`);
  return body as T;
};
export type Registration = { registration_id: string; command: HostCommand };
export const hostBindings = {
  async register(sessionId?: string): Promise<Registration> {
    return request("/sessions", { method: "POST", body: JSON.stringify(sessionId ? { session_id: sessionId } : {}) });
  },
  async bind(registrationId: string, sessionId: string) {
    await request(`/sessions/${encodeURIComponent(registrationId)}/bind`, { method: "POST", body: JSON.stringify({ session_id: sessionId }) });
  },
};
export const artifactContentUrl = (artifact: Artifact) => `${base}/sessions/${encodeURIComponent(artifact.session_id)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/versions/${artifact.version}/content`;

export function useArtifacts(sessionId: string, store: SessionStore) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  useEffect(() => {
    let disposed = false; let priorTool: string | null | undefined;
    const syncContext = () => {
      const active = Object.keys(store.getState().activeToolIds); const tool = active.at(-1) ?? null;
      if (tool === priorTool) return; priorTool = tool;
      void request(`/sessions/${encodeURIComponent(sessionId)}/context`, { method: "POST", body: JSON.stringify({ tool_call_id: tool }) });
    };
    const load = async () => {
      try { const result = await request<{ artifacts: Artifact[] }>(`/sessions/${encodeURIComponent(sessionId)}/artifacts`); if (!disposed) setArtifacts(result.artifacts); }
      catch { /* a reconnect can rotate registration between polls */ }
    };
    syncContext(); void load();
    const unsubscribe = store.subscribe(syncContext); const timer = setInterval(load, 500);
    return () => { disposed = true; clearInterval(timer); unsubscribe(); };
  }, [sessionId, store]);
  return artifacts;
}
