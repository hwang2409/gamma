import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OwnedResources } from "../scripts/owned-resources";

for (const point of ["after temp and worktree creation", "after child spawn"]) test(`real proof cleanup owns exact paths ${point}`, async () => {
  const parent = await mkdtemp(join(tmpdir(), "gamma-proof-cleanup-"));
  try {
    const temp = join(parent, "owned-temp");
    const worktree = join(parent, "owned-worktree");
    const sentinel = join(parent, "sentinel");
    const preexisting = join(parent, "preexisting-proof");
    await Promise.all([mkdir(temp), mkdir(worktree), mkdir(preexisting), writeFile(sentinel, "keep")]);
    let killed = 0;
    const resources = new OwnedResources();
    resources.createdTemp(temp); resources.createdWorktree(worktree);
    if (point === "after child spawn") resources.child({ exitCode: null, kill() { killed++; return true; } });
    await resources.cleanup((path) => rm(path, { recursive: true }), (path) => rm(path, { recursive: true }));
    expect(await stat(temp).then(() => true, () => false)).toBe(false);
    expect(await stat(worktree).then(() => true, () => false)).toBe(false);
    expect(await stat(sentinel).then(() => true, () => false)).toBe(true);
    expect(await stat(preexisting).then(() => true, () => false)).toBe(true);
    expect(killed).toBe(point === "after child spawn" ? 1 : 0);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
