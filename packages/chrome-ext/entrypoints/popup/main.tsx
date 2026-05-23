import { Effect, Schedule } from "effect";
import { render } from "solid-js/web";
import { loadSettingsFromChromeStorageWithRetry } from "../shared/bootstrap-settings.ts";
import { makeOffscreenUploadClient } from "./upload-rpc-client.ts";
import { isE2eDirectOffscreenRpc, uploadRpcLayer } from "./upload-rpc-layer.ts";

/** Playwright-only: `?e2eRestart=1` + `__GEROLAMINO_E2E_DIRECT_OFFSCREEN_RPC__` forks bootstrap-sync without the setup form. */
const maybeRunE2eBootstrapRestart = (): void => {
  if (new URLSearchParams(globalThis.location.search).get("e2eRestart") !== "1") return;
  if (!isE2eDirectOffscreenRpc()) return;
  Effect.runFork(
    Effect.gen(function* () {
      const settings = yield* loadSettingsFromChromeStorageWithRetry(20, 100);
      const client = yield* makeOffscreenUploadClient();
      yield* client
        .RequestRestart({ settings })
        .pipe(Effect.retry(Schedule.recurs(3)));
    }).pipe(Effect.scoped, Effect.provide(uploadRpcLayer()), Effect.orDie),
  );
};

maybeRunE2eBootstrapRestart();

// Dashboard's Tailwind v4 base — must come before the popup's local style.css so
// the local file (and the dashboard's per-component classes) compile against
// the right token palette + utilities.
import "dashboard/styles.css";
import "./style.css";
import App from "./App";

render(() => <App />, document.getElementById("root")!);
