import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppearanceProvider } from "./AppearanceProvider";
import "./style.css";
import "./appearance.css";
import "./settings.css";
import "./browser.css";

// Suppress WebView menus (reload, lookup, translation, etc.) across the app,
// including portal content and editable fields. Custom menu handlers still run.
document.addEventListener("contextmenu", (event) => event.preventDefault(), {
  capture: true,
});

// HTML5 file drops are enabled in the main WebView. Never navigate away from
// the app when a file misses the composer (including settings/no-task views).
function preventFileNavigation(event: DragEvent) {
  if (Array.from(event.dataTransfer?.types ?? []).includes("Files"))
    event.preventDefault();
}
document.addEventListener("dragover", preventFileNavigation);
document.addEventListener("drop", preventFileNavigation);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppearanceProvider>
      <App />
    </AppearanceProvider>
  </React.StrictMode>,
);
