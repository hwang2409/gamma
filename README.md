# gamma

public prototype surface for testing fulcrum as an npm consumer.

## setup

gamma uses packed fulcrum packages through their public exports, like an npm consumer. clone fulcrum on `main` next to gamma, or set `FULCRUM_DIR` to the fulcrum checkout and revision you want to test. a fresh fulcrum checkout needs its build dependencies before gamma can pack it.

```sh
git clone https://github.com/hwang2409/fulcrum.git ../fulcrum
FULCRUM_DIR="${FULCRUM_DIR:-../fulcrum}"
bun install --cwd "$FULCRUM_DIR" --frozen-lockfile --ignore-scripts
FULCRUM_DIR="$FULCRUM_DIR" bun run fulcrum:pack
bun install --force
```

`fulcrum:pack` defaults to `../fulcrum`. it needs bun and the fulcrum checkout's build dependencies, but it does not need gamma's `node_modules`. `--force` refreshes the lockfile integrity for the newly packed archives. if `bun install` runs before the pack step, bun reports `error: ENOENT extracting tarball from @fulcrum/zeta`; run `bun run fulcrum:pack`, then retry the install.

## run

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
