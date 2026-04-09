import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@/lib/electron";
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
    // Window label is unavailable outside the Electron bridge.
  }

  return null;
}

const overlayMode = detectOverlayMode();
if (overlayMode) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}

if (import.meta.env.DEV && typeof performance !== "undefined") {
  performance.mark("app-bootstrap-start");
  console.debug("[perf] app-bootstrap-start");
}

async function bootstrap() {
  console.log("[main] Bootstrap starting");
  const rootElement = document.getElementById("root");
  console.log("[main] Root element:", rootElement);

  if (!rootElement) {
    console.error("[main] Root element not found!");
    return;
  }

  const root = ReactDOM.createRoot(rootElement);
  console.log("[main] Root created");

  if (overlayMode) {
    console.log("[main] Loading overlay root");
    try {
      const { OverlayRoot } = await import("./overlay-root");
      console.log("[main] Overlay root loaded");
      root.render(
        <React.StrictMode>
          <OverlayRoot overlayMode={overlayMode} />
        </React.StrictMode>
      );
      console.log("[main] Overlay rendered");
    } catch (err) {
      console.error("[main] Failed to load overlay root:", err);
    }
    return;
  }

  console.log("[main] Loading App");
  try {
    const { default: App } = await import("./App");
    console.log("[main] App loaded");
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
    console.log("[main] App rendered");
  } catch (err) {
    console.error("[main] Failed to load App:", err);
  }
}

void bootstrap();
