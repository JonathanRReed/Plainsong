import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import "./index.css";

function detectOverlayMode(): "dictation" | "recording" | null {
  const fromQuery = new URLSearchParams(window.location.search).get("overlay");
  if (fromQuery === "dictation" || fromQuery === "recording") {
    return fromQuery;
  }

  try {
    const label = getCurrentWindow().label;
    if (label === "dictation-overlay") return "dictation";
    if (label === "recording-overlay") return "recording";
  } catch {
    // Not running inside a Tauri window context.
  }

  return null;
}

const overlayMode = detectOverlayMode();
if (overlayMode) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
