import { describe, expect, test } from "bun:test";
import { BrowserNode } from "../src/node/browserNode";
import { NodeRunner, nextBackoff } from "../src/node/runner";

/** A WebSocket stand-in: refuses to connect, or opens and then closes without a word. */
function fakeWebSocket(mode: "refuse" | "open-then-close") {
    let created = 0;
    class FakeWS extends EventTarget {
        binaryType = "arraybuffer";
        readyState = 0;
        constructor(readonly url: string) {
            super();
            created++;
            setTimeout(() => {
                if (mode === "refuse") { this.dispatchEvent(new Event("error")); return; }
                this.readyState = 1; this.dispatchEvent(new Event("open"));
                setTimeout(() => { this.readyState = 3; const ev = new Event("close"); (ev as any).code = 1006; this.dispatchEvent(ev); }, 5);
            }, 1);
        }
        send(_b: unknown) {}
        close() { this.readyState = 3; }
    }
    return { WS: FakeWS as unknown as typeof WebSocket, created: () => created };
}

describe("node runner", () => {
    test("backoff doubles from the minimum up to the maximum", () => {
        expect(nextBackoff(1000, 1000, 60_000)).toBe(2000);
        expect(nextBackoff(40_000, 1000, 60_000)).toBe(60_000);
        expect(nextBackoff(0, 1000, 60_000)).toBe(1000);
    });

    test("an unreachable relay is retried with growing backoff; stop() ends the loop", async () => {
        const { WS, created } = fakeWebSocket("refuse");
        const r = new NodeRunner({ config: { relayUrl: "ws://unreachable.invalid/n2n", network: "preview", startMode: "tip" }, WebSocketImpl: WS, minBackoffMs: 10, maxBackoffMs: 40 });
        r.start();
        await Bun.sleep(200);
        const s = r.stats();
        expect(created()).toBeGreaterThanOrEqual(3);
        expect(s.connects).toBe(created());
        expect(s.backoffMs).toBe(40);
        expect(s.errors.some((e) => e.includes("cannot connect"))).toBe(true);
        await r.stop();
        const n = created();
        await Bun.sleep(80);
        expect(created()).toBe(n);
        expect(r.stats().running).toBe(false);
    });

    test("a connection that drops during the handshake ends start() with reason 'closed' (it does not hang)", async () => {
        const { WS } = fakeWebSocket("open-then-close");
        const node = new BrowserNode({ endpoint: "ws://x/n2n", networkMagic: 2, WebSocketImpl: WS });
        const res = await Promise.race([node.start(), Bun.sleep(3000).then(() => ({ reason: "hung" as const }))]);
        expect(res.reason).toBe("closed");
        expect(node.stats.state).toBe("error");
    });

    test("stop() during connect resolves start() as stopped", async () => {
        const { WS } = fakeWebSocket("open-then-close");
        const node = new BrowserNode({ endpoint: "ws://x/n2n", networkMagic: 2, WebSocketImpl: WS });
        const p = node.start();
        node.stop();
        expect((await p).reason).toBe("stopped");
    });
});
