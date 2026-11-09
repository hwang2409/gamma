import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// fulcrum's status tokens are marks (squares, rails, borders), not text colors: their themed values do not keep
// 4.5:1 as text. A status word is fg or muted; the mark next to it carries the tone (gamma's app.css header).
const STATUS = new Set(["--fulcrum-ok", "--fulcrum-warn", "--fulcrum-danger"]);
const root = join(import.meta.dir, "..");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path, ext) : ext.test(entry.name) ? [path] : [];
  });
}

type Declaration = { file: string; line: number; property: string; value: string };

function declarations(file: string, css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found: Declaration[] = [];
  let line = 1;
  let at = 0;
  for (const match of text.matchAll(/(?<=[{;]\s*)(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+)/g)) {
    for (; at < match.index; at++) if (text[at] === "\n") line++;
    found.push({ file, line, property: match[1]!, value: match[2]!.trim() });
  }
  return found;
}

const refs = (value: string) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!);

/** Every `color:` that can resolve to a status token, directly or through a chain of custom properties. */
export function statusTextColors(own: Declaration[], consumers: Declaration[] = []): string[] {
  const values = new Map<string, string[]>();
  for (const { property, value } of [...own, ...consumers]) if (property.startsWith("--")) values.set(property, [...(values.get(property) ?? []), value]);
  const status = (name: string, seen = new Set<string>()): boolean =>
    STATUS.has(name) || (!seen.has(name) && (values.get(name) ?? []).some((value) => refs(value).some((ref) => status(ref, new Set(seen).add(name)))));
  // gamma's own `color:` rules, and properties gamma sets that a fulcrum `color:` rule reads.
  const ownSets = new Set(own.filter((d) => d.property.startsWith("--")).map((d) => d.property));
  const fulcrumReads = new Set(consumers.filter((d) => d.property === "color").flatMap((d) => refs(d.value)).filter((name) => ownSets.has(name) && !STATUS.has(name)));
  return [
    ...own.filter((d) => d.property === "color" && refs(d.value).some((ref) => status(ref))),
    ...own.filter((d) => fulcrumReads.has(d.property) && refs(d.value).some((ref) => status(ref))),
  ].map((d) => `${relative(root, d.file)}:${d.line} ${d.property}: ${d.value}`);
}

/** Inline React style objects: a `color` key whose value names a status token (or builds a fulcrum token name). */
export function inlineStatusColors(file: string, source: string): string[] {
  return [...source.matchAll(/\bcolor\s*:\s*(["'`])([^"'`]*?)\1/g)]
    .filter((match) => /var\(--fulcrum-(ok|warn|danger|\$\{)/.test(match[2]!))
    .map((match) => `${relative(root, file)}:${source.slice(0, match.index).split("\n").length} ${match[0]}`);
}

describe("status tokens are marks, never text color", () => {
  test("the check catches a direct use, a custom-property chain, and a fulcrum rule fed by gamma", () => {
    const own = declarations("plant.css", ".a { color: var(--fulcrum-danger); } .b { --t: var(--fulcrum-warn); } .c { --u: var(--t); } .d { color: var(--u, red); } .e { --mark: var(--fulcrum-ok); } .f { color: var(--fulcrum-fg); border-color: var(--fulcrum-danger); }");
    const fulcrum = declarations("fulcrum.css", ".x { color: var(--mark); }");
    expect(statusTextColors(own, fulcrum).map((hit) => hit.split(" ")[1])).toEqual(["color:", "color:", "--mark:"]);
    expect(inlineStatusColors("plant.tsx", "<b style={{ color: \"var(--fulcrum-ok)\", background: `var(--fulcrum-${name})` }} />")).toHaveLength(1);
  });

  test("gamma CSS and inline styles never color text with a status token", () => {
    const own = files(join(root, "src"), /\.css$/).flatMap((file) => declarations(file, readFileSync(file, "utf8")));
    const fulcrumCss = Bun.resolveSync("@fulcrum/react/styles.css", root);
    const consumers = declarations(fulcrumCss, readFileSync(fulcrumCss, "utf8"));
    const inline = files(join(root, "src"), /\.tsx$/).flatMap((file) => inlineStatusColors(file, readFileSync(file, "utf8")));
    expect([...statusTextColors(own, consumers), ...inline]).toEqual([]);
  });
});
