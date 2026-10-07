/**
 * Load one read-only resource into a small state machine.
 *
 * Every project view needs the same shape: show a spinner, then the data, an
 * "update Zeta" panel when the server lacks the feature, a message on failure,
 * or hand an expired token back to the shell. This hook owns that so the views
 * stay about layout.
 */

import { useEffect, useState } from "react";

import { isAuthError, isUnsupported } from "./api";

export type Resource<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "unsupported"; message: string }
  | { status: "error"; message: string };

export function useResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  onUnauthorized: () => void,
): Resource<T> {
  const [resource, setResource] = useState<Resource<T>>({ status: "loading" });

  useEffect(() => {
    let live = true;
    setResource({ status: "loading" });
    load()
      .then((data) => {
        if (live) {
          setResource({ status: "ready", data });
        }
      })
      .catch((cause: unknown) => {
        if (!live) {
          return;
        }
        if (isAuthError(cause)) {
          onUnauthorized();
          return;
        }
        if (isUnsupported(cause)) {
          setResource({ status: "unsupported", message: describe(cause) });
          return;
        }
        setResource({ status: "error", message: describe(cause) });
      });
    return () => {
      live = false;
    };
    // The caller passes an explicit dependency list for `load`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return resource;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
