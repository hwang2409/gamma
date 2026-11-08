import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionsControl, PermissionsPopover } from "../src/controls";
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
  expect(renderToStaticMarkup(<PermissionsControl model={model(state(true))} openRequest={0} />)).toContain("permissions: 2 session grants");
  const popover = (readOnly: boolean) => renderToStaticMarkup(<PermissionsPopover state={state(readOnly)} heading={{ current: null }} confirmClear={false} onClose={() => {}} onRevoke={() => {}} onClear={() => {}} />);
  const readOnly = popover(true);
  expect(readOnly).toContain("read-only observer");
  expect(readOnly).not.toContain(">revoke<");
  expect(readOnly).not.toContain("clear all");

  const writable = popover(false);
  expect(writable).toContain(">revoke<");
  expect(writable).toContain("clear all");
});

test("a remount after an earlier typed /permissions starts closed and shows the visible count", () => {
  // Dock keeps the request counter across reconnects; a fresh control must not reopen and steal focus.
  const remounted = renderToStaticMarkup(<PermissionsControl model={model(state(false))} openRequest={1} />);
  expect(remounted).not.toContain('role="dialog"');
  expect(remounted).toContain('aria-expanded="false"');
  expect(remounted).toMatch(/<span class="permissions-count"[^>]*>2<\/span>/);
});
