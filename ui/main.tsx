import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

/** The one place the browser and the application meet. */
const root = document.getElementById("root");

if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
