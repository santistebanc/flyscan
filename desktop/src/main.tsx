/**
 * Mounts the app, and makes sure nothing fails quietly.
 *
 * An error in here reaches a console nobody has open — least of all in the
 * desktop shell, where there is no console to open. So anything unhandled is
 * sent to the sidecar's error log, where it sits beside the failures from the
 * scrapers with the same shape and can be read back with
 * `flight-scraper errors`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { FlightScraperApi } from "./api";
import { apiConnection } from "./platform";
import "./styles.css";
import "./theme.css";
import "./flightTimeline.css";
import "./details.css";
import "./filters.css";

/** Whatever the page was doing when it broke, for whoever reads this later. */
const surroundings = () => ({
  url: location.href,
  viewport: `${window.innerWidth}x${window.innerHeight}`,
  agent: navigator.userAgent,
});

apiConnection()
  .then(({ base, apiKey }) => {
    const api = new FlightScraperApi(base, apiKey);

    window.addEventListener("error", (event) => {
      void api.report("window", event.message || String(event.error), {
        ...surroundings(),
        at: `${event.filename}:${event.lineno}:${event.colno}`,
        stack: event.error instanceof Error ? event.error.stack : undefined,
      });
    });

    // A rejected promise nobody caught: the shape most of this app's failures
    // take, since almost everything here is a fetch.
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      void api.report("promise", reason instanceof Error ? reason.message : String(reason), {
        ...surroundings(),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    });
  })
  .catch(() => {
    /* No sidecar to tell. Nothing else here depends on this. */
  });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
