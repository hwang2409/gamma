/**
 * Syntax highlighting for code blocks and file-shaped tool I/O.
 *
 * `useHighlight` returns null until the highlighter chunk has loaded (and
 * for languages it does not know), so callers render plain text first and
 * the highlighted version replaces it in place. The chunk loads once, on the
 * first code block, from the app's own origin.
 */

import { useEffect, useState, type ReactNode } from "react";

type Engine = typeof import("./highlightEngine");

/** Longer text stays plain: highlighting it costs more than it helps. */
const MAX_CHARS = 40_000;

let engine: Engine | null = null;
let loading: Promise<Engine> | null = null;

function load(): Promise<Engine> {
  loading ??= import("./highlightEngine").then((loaded) => (engine = loaded));
  return loading;
}

export function useHighlight(code: string, language: string | null): ReactNode | null {
  const wanted = language !== null && language !== "" && code.length <= MAX_CHARS;
  const [ready, setReady] = useState(engine !== null);

  useEffect(() => {
    if (!wanted || ready) {
      return;
    }
    let current = true;
    void load().then(() => {
      if (current) {
        setReady(true);
      }
    });
    return () => {
      current = false;
    };
  }, [wanted, ready]);

  if (!wanted || !ready || engine === null || !engine.supports(language)) {
    return null;
  }
  return engine.render(code, language);
}

const BY_EXTENSION: Record<string, string> = {
  py: "python",
  pyi: "python",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "xml",
  xml: "xml",
  svg: "xml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  lua: "lua",
  r: "r",
  pl: "perl",
  mk: "makefile",
};

const BY_NAME: Record<string, string> = {
  makefile: "makefile",
  dockerfile: "bash",
};

/** A highlight.js language for a file path, by extension or name. */
export function languageForPath(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name in BY_NAME) {
    return BY_NAME[name] ?? null;
  }
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (BY_EXTENSION[name.slice(dot + 1)] ?? null) : null;
}
