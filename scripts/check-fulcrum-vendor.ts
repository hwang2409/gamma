import { existsSync } from "node:fs";

const packages = ["core", "react", "zeta", "markdown", "highlight", "mermaid", "virtual"];
const missing = packages.filter((name) => !existsSync(new URL(`../vendor/fulcrum/fulcrum-${name}.tgz`, import.meta.url)));

if (missing.length) {
  console.error("Fulcrum packages are missing. Run `bun run fulcrum:pack`, then run `bun install` again.");
  process.exit(1);
}
