# gamma

public prototype surface for testing fulcrum as an npm consumer.

## run

gamma packs the sibling fulcrum checkout into local tarballs before development. this tests the same package contents and dependency rewrites that npm users receive.

```sh
cd ~/me/fun/gamma
bun run fulcrum:pack
bun install
```

terminal 1:

```sh
cd ~/me/fun/gamma
zeta serve --ws 8765 --ws-origin http://localhost:5190
```

terminal 2:

```sh
cd ~/me/fun/gamma
bun run dev
```

open http://localhost:5190.

`predev` and `prebuild` repack only when the sibling fulcrum head or working tree changes. set `FULCRUM_DIR` when fulcrum is not at `../fulcrum`. the app imports only public package exports.

## keyboard help

run `/keys` in gamma for the same browser key table used by the composer hint. help is grouped into composer, menus, vim normal mode, browser actions, and exclusions. browser and assistive-technology conventions take precedence over terminal shortcuts.

<!-- keyboard-help:start -->
| action | gamma behavior |
| --- | --- |
| `/keys` | show this keyboard help |
| `/paste` | open the browser file picker |
| `/restart` | terminal-only; not a gamma action |
| `!shell` | terminal-only; raw shell mode is not a gamma action |
| `$EDITOR` | terminal-only; editor integration is not a gamma action |
<!-- keyboard-help:end -->

vim help lists only the supported subset. it is declared in `src/keys.ts` and checked against the transitions in `src/vim.ts`.
