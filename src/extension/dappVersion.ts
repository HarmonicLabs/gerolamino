/**
 * Versions a page can read off `window.cardano.gerolamino`.
 *
 * Two different numbers on purpose:
 * - `apiVersion` is CIP-30's initial-API string and stays `"1"` (in inpage.ts).
 * - `dappApiVersion` is Gerolamino's own dApp API revision, bumped when methods are added or changed.
 * - `build` identifies the shipped artefact, so a support screenshot is enough to tell which extension
 *   answered. `test/dappVersion.test.ts` fails if `DAPP_BUILD` drifts from package.json's version.
 */
export const DAPP_API_VERSION = "0.2.0";
export const DAPP_BUILD = "gerolamino-0.3.0";
