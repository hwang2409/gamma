# Fonts

gamma bundles its typefaces; the browser never fetches a font from a CDN.
Vite copies the files from these packages into the build.

| family | package | license |
| --- | --- | --- |
| Atkinson Hyperlegible Next (variable, 200 to 800, roman and italic) | `@fontsource-variable/atkinson-hyperlegible-next` | SIL Open Font License 1.1 |
| Atkinson Hyperlegible Mono (variable, 200 to 800, roman and italic) | `@fontsource-variable/atkinson-hyperlegible-mono` | SIL Open Font License 1.1 |

Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors
(https://github.com/googlefonts/atkinson-hyperlegible-next), and Copyright
2020-2024 The Atkinson Hyperlegible Mono Project Authors
(https://github.com/googlefonts/atkinson-hyperlegible-next-mono). The full license text ships in each
package as `LICENSE` (`node_modules/@fontsource-variable/*/LICENSE`).

Why this family: it was drawn by the Braille Institute so that easily
confused characters (`l 1 I`, `0 O`, `rn m`) stay distinct. In an agent
console you approve what you read, so legibility of commands and paths is
the point. The sans carries the UI and prose; the mono is used only for
machine text (commands, paths, arguments, tool output, code).
