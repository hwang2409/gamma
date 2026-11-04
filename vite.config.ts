import { defineConfig } from "vite";
import { zetaDiscoveryPlugin } from "@fulcrum/zeta/discovery";

// Its own port, so `--ws-origin http://localhost:5180` names this app and not the playground on 5173.
export default defineConfig({
  plugins: [zetaDiscoveryPlugin()],
  server: { port: 5180, strictPort: true, cors: false },
  preview: { port: 5180, strictPort: true },
});
