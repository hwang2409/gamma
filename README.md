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
