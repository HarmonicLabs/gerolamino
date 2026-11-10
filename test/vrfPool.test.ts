import { describe, expect, test } from "bun:test";
import { locateHeader } from "../src/node/chunkFormat";
import { parseHeaderCrypto } from "../src/node/headerVerify";
import { networkByMagic } from "../src/node/networks";
import { createInlineVrfVerifier, createVrfPool, defaultPoolSize, inlineVerdict, type VrfTask, type WorkerLike } from "../src/node/vrfPool";
import { verifyHeaderTask } from "../src/node/vrfVerify";
import { preprodFixture } from "./lib/chunkReader";

const fx = preprodFixture();
const net = networkByMagic(1)!;
const taskOf = (block: Uint8Array, nonce: Uint8Array): VrfTask => {
    const l = locateHeader(block);
    return {
        headerBytes: block.subarray(l.headerOffset, l.headerOffset + l.headerSize),
        eraTag: l.eraTag,
        nonce,
        slotsPerKESPeriod: net.slotsPerKESPeriod,
        maxKESEvolutions: net.maxKESEvolutions
    };
};
const conway = taskOf(fx.conway, fx.nonceEpoch310);
const shelley = taskOf(fx.shelley, fx.nonceEpoch4);

function fakeWorker(behaviour: "echo" | "error" | "silent" | "garbage", jitterMs = 10): WorkerLike {
    const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage(message: any) {
            if (behaviour === "silent") return;
            if (behaviour === "error") { setTimeout(() => worker.onerror?.({ message: "boom" }), 1); return; }
            if (behaviour === "garbage") { setTimeout(() => worker.onmessage?.({ data: { id: message.id, verdict: { opcertOk: "yes" } } }), 1); return; }
            // answer in a random order to prove the pool re-orders results
            setTimeout(() => worker.onmessage?.({ data: { id: message.id, verdict: verifyHeaderTask(message.task) } }), Math.random() * jitterMs);
        }
    };
    return worker;
}

describe("header crypto verifier", () => {
    test("inline verifier is the reference verdict for real fixtures", () => {
        expect(inlineVerdict(conway)).toEqual(verifyHeaderTask(conway));
        expect(inlineVerdict(conway)).toMatchObject({ opcertOk: true, kesOk: true, vrfOk: true });
        expect(inlineVerdict(shelley)).toMatchObject({ opcertOk: true, kesOk: true, vrfOk: true });
        const bad: VrfTask = { ...conway, nonce: fx.nonceEpoch4 };
        expect(inlineVerdict(bad).vrfOk).toBe(false);
    });

    test("no Worker available degrades to inline", async () => {
        const verifier = createVrfPool({ workerFactory: null });
        expect(verifier.kind).toBe("inline");
        expect(verifier.size).toBe(0);
        const [v] = await verifier.verifyBatch([conway]);
        expect(v).toMatchObject({ opcertOk: true, kesOk: true, vrfOk: true });
        expect(createInlineVrfVerifier().kind).toBe("inline");
        expect(defaultPoolSize()).toBeGreaterThanOrEqual(1);
    });

    test("pool results come back in submission order whatever order workers finish in", async () => {
        const verifier = createVrfPool({ size: 2, workerFactory: () => fakeWorker("echo", 25) });
        expect(verifier.kind).toBe("workers");
        expect(verifier.size).toBe(2);
        const tasks = [conway, shelley, conway, shelley, conway];
        const verdicts = await verifier.verifyBatch(tasks);
        expect(verdicts.length).toBe(tasks.length);
        // every result must equal the inline verdict for ITS OWN task (a mis-ordered reply shows up here)
        for (let i = 0; i < tasks.length; i++) expect(verdicts[i]).toEqual(inlineVerdict(tasks[i]!));
        verifier.close();
    });

    test("a worker error falls back to an inline verdict, never to a rejection", async () => {
        const verifier = createVrfPool({ size: 1, workerFactory: () => fakeWorker("error") });
        const [v] = await verifier.verifyBatch([conway]);
        expect(v).toMatchObject({ opcertOk: true, kesOk: true, vrfOk: true });
        verifier.close();
    });

    test("garbage from a worker is not a verdict: it is verified inline", async () => {
        const verifier = createVrfPool({ size: 1, workerFactory: () => fakeWorker("garbage") });
        const [v] = await verifier.verifyBatch([conway]);
        expect(v).toMatchObject({ opcertOk: true, kesOk: true, vrfOk: true });
        verifier.close();
    });

    test("a silent worker times out into an inline verdict", async () => {
        const verifier = createVrfPool({ size: 1, workerFactory: () => fakeWorker("silent"), timeoutMs: 30 });
        const t0 = Date.now();
        const [v] = await verifier.verifyBatch([conway]);
        expect(v).toMatchObject({ opcertOk: true, kesOk: true, vrfOk: true });
        expect(Date.now() - t0).toBeLessThan(2000);
        verifier.close();
    });

    test("workers are terminated after idling, and respawn on the next batch", async () => {
        let made = 0;
        let terminated = 0;
        const factory = () => {
            made++;
            const w = fakeWorker("echo", 3);
            const inner = w.terminate.bind(w);
            w.terminate = () => { terminated++; inner(); };
            return w;
        };
        const verifier = createVrfPool({ size: 2, workerFactory: factory, idleMs: 25 });
        const [v] = await verifier.verifyBatch([conway]);
        expect(v).toMatchObject({ opcertOk: true, kesOk: true, vrfOk: true });
        expect(made).toBe(2);
        expect(terminated).toBe(0);
        await new Promise((r) => setTimeout(r, 80));       // past idleMs
        expect(terminated).toBe(2);                          // the idle pool released its memory
        const [again] = await verifier.verifyBatch([shelley]);
        expect(again.opcertOk).toBe(true);
        expect(made).toBe(4);                                // respawned on demand
        verifier.close();
    }, 30_000);

    test("a tampered header is still rejected through the pool", async () => {
        const verifier = createVrfPool({ size: 2, workerFactory: () => fakeWorker("echo", 5) });
        const tampered: VrfTask = { ...conway, nonce: fx.nonceEpoch4 };
        const [v] = await verifier.verifyBatch([tampered]);
        expect(v.vrfOk).toBe(false);
        verifier.close();
    });
});
