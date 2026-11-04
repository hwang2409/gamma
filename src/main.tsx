import "./fonts.css";
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";
import "@fulcrum/highlight/styles.css";
import "@fulcrum/mermaid/styles.css";
import "./app.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";

createRoot(document.getElementById("root")!).render(<App />);
