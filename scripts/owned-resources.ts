import type { ChildProcess } from "node:child_process";

export type OwnedChild = Pick<ChildProcess, "exitCode" | "kill"> & { once?: ChildProcess["once"] };

/** Exact resources created by one gate invocation, in the cleanup order required by the proof contract. */
export class OwnedResources {
  readonly children: OwnedChild[] = [];
  tempRoot: string | null = null;
  worktree: string | null = null;

  child<T extends OwnedChild>(value: T): T { this.children.push(value); return value; }
  createdTemp(path: string) { if (this.tempRoot) throw new Error("temporary root already recorded"); this.tempRoot = path; }
  createdWorktree(path: string) { if (this.worktree) throw new Error("worktree already recorded"); this.worktree = path; }

  async cleanup(removeTemp: (path: string) => Promise<void>, removeWorktree: (path: string) => Promise<void>) {
    for (const child of [...this.children].reverse()) if (child.exitCode === null) {
      const exited = child.once ? new Promise<void>((resolve) => child.once!("exit", () => resolve())) : Promise.resolve();
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (this.tempRoot) await removeTemp(this.tempRoot);
    if (this.worktree) await removeWorktree(this.worktree);
  }
}
