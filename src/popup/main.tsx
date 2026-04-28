import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/app/App";
import "@/styles/globals.css";

function reportFloatingHeight() {
  if (window.parent === window) return;

  const shell = document.querySelector(".bookmark-popup-window");
  const height = Math.ceil(shell?.getBoundingClientRect().height ?? document.documentElement.scrollHeight);

  window.parent.postMessage(
    {
      type: "remarks:resize",
      height,
    },
    "*"
  );
}

function observeFloatingHeight() {
  if (window.parent === window) return;

  const root = document.getElementById("root");
  if (!root) return;

  const scheduleReport = () => requestAnimationFrame(reportFloatingHeight);
  const resizeObserver = new ResizeObserver(scheduleReport);

  resizeObserver.observe(root);
  resizeObserver.observe(document.body);
  window.addEventListener("load", scheduleReport);
  window.addEventListener("hashchange", scheduleReport);
  scheduleReport();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

observeFloatingHeight();
