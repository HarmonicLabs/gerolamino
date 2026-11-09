import { describe, expect, test } from "bun:test";
import { DAPP_API_VERSION, DAPP_BUILD } from "../src/extension/dappVersion";

describe("dApp version identity", () => {
    test("build id tracks package.json so a screenshot identifies the artefact", async () => {
        const pkg = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()) as { version: string };
        expect(DAPP_BUILD).toBe(`gerolamino-${pkg.version}`);
    });

    test("dappApiVersion is a plain semver string", () => {
        expect(DAPP_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
});
