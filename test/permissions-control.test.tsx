import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionsControl } from "../src/controls";
import type { SessionGrantsModel, SessionGrantsState } from "../src/session-grants";

const state = (readOnly: boolean): SessionGrantsState => ({
  status: "ready",
  readOnly,
  snapshot: {
    session_id: "session-1",
    default: "ask",
    precedence: ["deny", "ask", "allow"],
    rules: { deny: [], ask: ["write"], allow: ["bash"] },
    session_grants: ["bash", "read"],
  },
});

const model = (value: SessionGrantsState): SessionGrantsModel => ({
  state: value,
  subscribe: () => () => {},
  load: async () => {},
  revoke: async () => { throw new Error("not called during render"); },
  clear: async () => { throw new Error("not called during render"); },
  stop: () => {},
});

test("read-only permissions keep rules visible and hide every mutation control", () => {
  const readOnly = renderToStaticMarkup(<PermissionsControl model={model(state(true))} openRequest={1} />);
  expect(readOnly).toContain("permissions: 2 session grants");
  expect(readOnly).toContain("read-only observer");
  expect(readOnly).not.toContain(">revoke<");
  expect(readOnly).not.toContain("clear all");

  const writable = renderToStaticMarkup(<PermissionsControl model={model(state(false))} openRequest={1} />);
  expect(writable).toContain(">revoke<");
  expect(writable).toContain("clear all");
});
