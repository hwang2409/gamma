import { describe, expect, test } from "bun:test";
import { FEATURES } from "../src/connection";

// Zeta 473784f docs/serve-protocol.md:606-660,1123,1527 defines these requests, event, and feature.
test("gamma negotiates session grants", () => {
  expect(FEATURES).toContain("session_grants");
});

type Event = {
  change: "grant" | "revoke" | "clear" | "reset";
  changed: string[];
  grants: Snapshot;
};
type Snapshot = {
  session_id: string;
  default: "allow" | "deny" | "ask";
  precedence: string[];
  rules: { deny: string[]; ask: string[]; allow: string[] };
  session_grants: string[];
};

const snapshot = (session_id: string, session_grants: string[] = []): Snapshot => ({
  session_id,
  default: "ask",
  precedence: ["deny", "ask", "allow"],
  rules: { deny: ["dangerous"], ask: ["write"], allow: [...session_grants] },
  session_grants,
});

async function setup(initial = snapshot("session-1"), readOnly = false) {
  const { createSessionGrantsModel } = await import("../src/session-grants");
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Set<(event: Event) => void>();
  let current = initial;
  const client = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "session_grants") return current;
      if (method === "revoke_session_grants") {
        const removed = "clear" in params ? [...current.session_grants] : current.session_grants.filter((grant) => grant === params.grant);
        current = snapshot(current.session_id, current.session_grants.filter((grant) => !removed.includes(grant)));
        return { removed, grants: current };
      }
      throw new Error(`unexpected ${method}`);
    },
    onSessionGrantsChanged: (listener: (event: Event) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const model = createSessionGrantsModel(client, "session-1", readOnly);
  return { model, calls, emit: (event: Event) => listeners.forEach((listener) => listener(event)), setCurrent: (next: Snapshot) => { current = next; } };
}

describe("session grants model", () => {
  test("reads on attach and replaces state from only the viewed session's events", async () => {
    const { model, calls, emit } = await setup(snapshot("session-1", ["bash"]));
    await model.load();
    expect(calls).toEqual([{ method: "session_grants", params: {} }]);
    expect(model.state.snapshot?.session_grants).toEqual(["bash"]);

    emit({ change: "revoke", changed: ["bash"], grants: snapshot("session-other") });
    expect(model.state.snapshot?.session_grants).toEqual(["bash"]);
    emit({ change: "revoke", changed: ["bash"], grants: snapshot("session-1") });
    expect(model.state.snapshot?.session_grants).toEqual([]);
    model.stop();
  });

  test("a new connection model has no cached snapshot and reads again", async () => {
    const first = await setup(snapshot("session-1", ["bash"]));
    await first.model.load();
    first.model.stop();

    const second = await setup(snapshot("session-1"));
    expect(second.model.state.snapshot).toBeNull();
    await second.model.load();
    expect(second.calls).toEqual([{ method: "session_grants", params: {} }]);
    expect(second.model.state.snapshot?.session_grants).toEqual([]);
    second.model.stop();
  });

  test("revoke and clear send the exact accepted parameter shapes and response wins over an earlier event", async () => {
    const { model, calls, emit } = await setup(snapshot("session-1", ["bash", "read"]));
    await model.load();
    const revoke = model.revoke("bash");
    emit({ change: "revoke", changed: ["bash"], grants: snapshot("session-1", ["read"]) });
    await revoke;
    expect(calls.at(-1)).toEqual({ method: "revoke_session_grants", params: { grant: "bash" } });
    expect(model.state.snapshot?.session_grants).toEqual(["read"]);

    await model.clear();
    expect(calls.at(-1)).toEqual({ method: "revoke_session_grants", params: { clear: true } });
    expect(model.state.snapshot?.session_grants).toEqual([]);
    model.stop();
  });

  test("read-only state blocks mutations without sending", async () => {
    const { model, calls } = await setup(snapshot("session-1", ["bash"]), true);
    await model.load();
    await expect(model.revoke("bash")).rejects.toThrow("read-only observer");
    expect(calls).toEqual([{ method: "session_grants", params: {} }]);
    model.stop();
  });

  test("malformed reads become an error state instead of crashing", async () => {
    const { createSessionGrantsModel } = await import("../src/session-grants");
    const model = createSessionGrantsModel({ request: async () => ({ nope: true }), onSessionGrantsChanged: () => () => {} }, "session-1");
    await expect(model.load()).rejects.toThrow("invalid session grants response");
    expect(model.state.status).toBe("error");
    expect(model.state.error).toBe("invalid session grants response");
    model.stop();
  });
});
