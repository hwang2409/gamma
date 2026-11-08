import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

const inside = (parent: string, child: string) => {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
};

export function assertPrivateProofHome(home: string | undefined, proofWorktree: string) {
  if (!home) throw new Error("real-zeta proof requires an explicit private ZETA_HOME");
  const resolved = resolve(home);
  const defaultHome = resolve(homedir(), ".zeta");
  if (resolved === defaultHome || inside(defaultHome, resolved)) throw new Error("real-zeta proof must never use the default ~/.zeta home or a child of it");
  if (!inside(tmpdir(), resolved) && !inside(resolve("/tmp"), resolved) && !inside(proofWorktree, resolved)) throw new Error("real-zeta proof ZETA_HOME must be under the proof worktree or /tmp");
  return resolved;
}
