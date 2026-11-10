import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppearanceProvider } from "./AppearanceProvider";
import { preventFileNavigation } from "./fileDrag";
import "./style.css";
import "./appearance.css";
import "./settings.css";
import "./browser.css";

// Suppress WebView menus (reload, lookup, translation, etc.) across the app,
// including portal content and editable fields. Custom menu handlers still run.
document.addEventListener("contextmenu", (event) => event.preventDefault(), {
  capture: true,
});

// HTML5 file drops are enabled in the main WebView. The guard runs on the
// capture phase, before component handlers: never navigate away from the app
// or let a dropped file name land in an editable field when a file misses the
// composer (including settings/no-task views).
document.addEventListener("dragover", preventFileNavigation, true);
document.addEventListener("drop", preventFileNavigation, true);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppearanceProvider>
      <App />
    </AppearanceProvider>
  </React.StrictMode>,
);
