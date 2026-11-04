# gamma

private prototype surface for testing fulcrum as an npm consumer.

## run

terminal 1:

```sh
cd ~/me/fun/gamma
zeta serve --ws 8765 --ws-origin http://localhost:5190
```

terminal 2:

```sh
cd ~/me/fun/gamma
bun install
bun run dev
```

open http://localhost:5190.

fulcrum packages are consumed through `file:` dependencies. `predev` and `prebuild` build the sibling fulcrum packages first. the app imports only public package exports.
