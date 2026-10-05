/**
 * The syntax highlighter itself. Only `highlight.ts` imports it, lazily, so
 * highlight.js grammars load as their own chunk the first time code shows.
 *
 * lowlight returns a syntax tree; it renders to React elements, never to an
 * HTML string, so highlighted code is as safe as plain text.
 */

import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { common, createLowlight } from "lowlight";
import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

const lowlight = createLowlight(common);

export function supports(language: string): boolean {
  return lowlight.registered(language);
}

export function render(code: string, language: string): ReactNode {
  return toJsxRuntime(lowlight.highlight(language, code), { Fragment, jsx, jsxs });
}
