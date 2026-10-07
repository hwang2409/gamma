import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Self-hosted fonts, bundled by Vite and served with the app; no CDN.
// OFL-1.1, see web/FONTS.md. unicode-range keeps unused subsets unloaded.
import "@fontsource-variable/atkinson-hyperlegible-next/wght.css";
import "@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css";
import "@fontsource-variable/atkinson-hyperlegible-mono/wght.css";
import "@fontsource-variable/atkinson-hyperlegible-mono/wght-italic.css";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ledger.css";
import "./styles/dock.css";
import "./styles/pages.css";
import "./styles/projects.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("the #root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
