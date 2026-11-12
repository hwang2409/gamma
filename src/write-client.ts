import type { ZetaClient, ZetaRole } from "@fulcrum/zeta";

export class ObserverWriteError extends Error {
  readonly kind = "observer";
  constructor() { super("observer connections are read-only"); this.name = "ObserverWriteError"; }
}

type ClientState = { readonly client: ZetaClient | null; readonly authority: ZetaRole | null };

export type WriteClient = {
  /** Returns a stable client facade. Every property access and method call re-checks current authority. */
  get(): ZetaClient | null;
};

/** The one authority seam for every mutating zeta call. Read paths use the connection client directly. */
export function createWriteClient(current: () => ClientState): WriteClient {
  const authorized = () => {
    const state = current();
    if (state.authority === "observer") throw new ObserverWriteError();
    return state.authority === "controller" ? state.client : null;
  };
  const facade = new Proxy({} as ZetaClient, {
    get(_target, property) {
      const value = authorized()?.[property as keyof ZetaClient];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const client = authorized();
        if (!client) throw new Error("not connected to zeta serve");
        const method = client[property as keyof ZetaClient] as (...values: unknown[]) => unknown;
        return method.apply(client, args);
      };
    },
  });
  return { get() { return authorized() ? facade : null; } };
}
