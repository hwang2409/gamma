import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fulcrum = resolve(process.env.FULCRUM_DIR ?? resolve(root, "../fulcrum"));
const vendor = resolve(root, "vendor/fulcrum");
const packages = ["core", "react", "zeta", "markdown", "highlight", "mermaid", "virtual"] as const;

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", fulcrum, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

async function sourceFingerprint() {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(git("rev-parse", "HEAD"));
  hash.update(git("diff", "HEAD", "--binary"));
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean).sort();
  for (const file of untracked) {
    hash.update(file);
    hash.update(await readFile(resolve(fulcrum, file)));
  }
  return `${git("rev-parse", "HEAD").toString().trim()} ${hash.digest("hex")}`;
}

const source = await sourceFingerprint();
const previous = await readFile(resolve(vendor, ".source"), "utf8").catch(() => "");
if (previous.trim() === source) {
  console.log(`fulcrum packages already match ${source.split(" ")[0]}`);
  process.exit(0);
}

const run = (command: string[], cwd: string) => {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
};

run(["bun", "run", "build:packages"], fulcrum);
await rm(vendor, { recursive: true, force: true });
await mkdir(vendor, { recursive: true });
for (const name of packages) {
  const filename = `fulcrum-${name}.tgz`;
  const archive = resolve(vendor, filename);
  run(["bun", "pm", "pack", "--filename", archive], resolve(fulcrum, "packages", name));
  const installed = resolve(root, "node_modules", "@fulcrum", name);
  await rm(installed, { recursive: true, force: true });
  await mkdir(installed, { recursive: true });
  run(["tar", "-xzf", archive, "--strip-components=1", "-C", installed], root);
  console.log(`packed @fulcrum/${name} as ${basename(filename)}`);
}
await writeFile(resolve(vendor, ".source"), `${source}\n`);
