const tools = new Map<string, ReadonlySet<string>>();
const listeners = new Map<string, Set<() => void>>();
const empty = new Set<string>();

export function alwaysAllowed(sessionId: string) {
  return tools.get(sessionId) ?? empty;
}

export function subscribeAlwaysAllowed(sessionId: string, listener: () => void) {
  const session = listeners.get(sessionId) ?? new Set();
  session.add(listener);
  listeners.set(sessionId, session);
  return () => {
    session.delete(listener);
    if (!session.size) listeners.delete(sessionId);
  };
}

export function markAlwaysAllowed(sessionId: string, toolId: string) {
  tools.set(sessionId, new Set(tools.get(sessionId) ?? []).add(toolId));
  listeners.get(sessionId)?.forEach((listener) => listener());
}
