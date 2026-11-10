/**
 * Header crypto off the main thread.
 *
 * One Conway header costs ~60 ms of verification, almost all of it the VRF. That work is pure: given the
 * header bytes, the epoch nonce and the network's KES parameters, the verdict is fixed. So it can run in a
 * worker while the main thread fetches bodies and applies the ledger.
 *
 * Rules this module keeps:
 * - A worker may only refuse work or return a verdict computed by the same `verifyHeaderCrypto`. There is no
 *   path where an unverified header is accepted: a task that fails, times out, or finds no worker is verified
 *   inline instead.
 * - Results come back in submission order, whatever order the workers finish in.
 * - Without `Worker` (Bun tests, a hostile embedding) the pool degrades to the inline verifier.
 */
import { verifyHeaderTask, type HeaderVerdict, type VrfTask } from "./vrfVerify";

export type { HeaderVerdict, VrfTask } from "./vrfVerify";

/** Verify on this thread. The reference behaviour every other path must match. */
export const inlineVerdict = verifyHeaderTask;

export interface VrfVerifier {
    /** "workers" when a real pool is running, "inline" when everything is verified on this thread. */
    readonly kind: "workers" | "inline";
    /** How many workers are running (0 for inline). */
    readonly size: number;
    /** Verify in submission order. Never rejects for infrastructure reasons: it falls back to inline. */
    verifyBatch(tasks: VrfTask[]): Promise<HeaderVerdict[]>;
    close(): void;
}

export interface WorkerLike {
    postMessage(message: unknown): void;
    terminate(): void;
    onmessage: ((event: { data: any }) => void) | null;
    onerror: ((event: any) => void) | null;
}

export interface VrfPoolOptions {
    /** Worker count. Defaults to min(4, hardwareConcurrency - 1), at least 1. */
    size?: number;
    /** Constructor for the worker; injectable for tests. `null` forces the inline verifier. */
    workerFactory?: (() => WorkerLike) | null;
    /** A task that has not come back in this long is verified inline instead. Default 20 s. */
    timeoutMs?: number;
}

export function createInlineVrfVerifier(): VrfVerifier {
    return {
        kind: "inline",
        size: 0,
        verifyBatch: async (tasks) => tasks.map(inlineVerdict),
        close: () => {}
    };
}

export function defaultPoolSize(): number {
    const cores = (globalThis as any).navigator?.hardwareConcurrency ?? 4;
    return Math.max(1, Math.min(4, Math.floor(cores) - 1));
}

function defaultWorkerFactory(): (() => WorkerLike) | null {
    if (typeof (globalThis as any).Worker !== "function") return null;
    return () => new (globalThis as any).Worker(new URL("./vrfWorker.js", import.meta.url), { type: "module" }) as WorkerLike;
}

export function createVrfPool(options: VrfPoolOptions = {}): VrfVerifier {
    const factory = options.workerFactory !== undefined ? options.workerFactory : defaultWorkerFactory();
    if (!factory) return createInlineVrfVerifier();

    const size = Math.max(1, options.size ?? defaultPoolSize());
    const timeoutMs = options.timeoutMs ?? 20_000;
    const workers: WorkerLike[] = [];
    const current = new Map<WorkerLike, { id: number; task: VrfTask }>();
    const pending = new Map<number, { resolve: (v: HeaderVerdict) => void; timer: ReturnType<typeof setTimeout> }>();
    const queue: Array<{ id: number; task: VrfTask }> = [];
    let nextId = 1;
    let closed = false;

    const settle = (id: number, verdict: HeaderVerdict) => {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.resolve(verdict);
    };

    const pump = () => {
        if (closed) return;
        for (const worker of workers) {
            if (!queue.length) return;
            if (current.has(worker)) continue;
            const item = queue.shift()!;
            current.set(worker, item);
            try {
                worker.postMessage({ id: item.id, task: item.task });
            } catch {
                current.delete(worker);
                settle(item.id, inlineVerdict(item.task));
            }
        }
    };

    for (let i = 0; i < size; i++) {
        let worker: WorkerLike;
        try {
            worker = factory();
        } catch {
            break;
        }
        worker.onmessage = (event) => {
            const data = event?.data ?? {};
            const item = current.get(worker);
            current.delete(worker);
            if (typeof data.id !== "number") { pump(); return; }
            const verdict = data.verdict as HeaderVerdict | undefined;
            const valid = verdict
                && typeof verdict.opcertOk === "boolean"
                && typeof verdict.kesOk === "boolean"
                && typeof verdict.vrfOk === "boolean";
            if (valid) settle(data.id, { opcertOk: verdict!.opcertOk, kesOk: verdict!.kesOk, vrfOk: verdict!.vrfOk, detail: Array.isArray(verdict!.detail) ? verdict!.detail : [] });
            else if (item && item.id === data.id) settle(item.id, inlineVerdict(item.task));
            pump();
        };
        worker.onerror = () => {
            const item = current.get(worker);
            current.delete(worker);
            if (item) settle(item.id, inlineVerdict(item.task));
            pump();
        };
        workers.push(worker);
    }

    if (!workers.length) return createInlineVrfVerifier();

    return {
        kind: "workers",
        size: workers.length,
        verifyBatch: async (tasks) => {
            const results = await Promise.all(tasks.map((task) => new Promise<HeaderVerdict>((resolve) => {
                const id = nextId++;
                const timer = setTimeout(() => {
                    if (!pending.delete(id)) return;
                    resolve(inlineVerdict(task));
                }, timeoutMs);
                pending.set(id, { resolve, timer });
                queue.push({ id, task });
                pump();
            })));
            return results;
        },
        close: () => {
            closed = true;
            for (const worker of workers) {
                try { worker.terminate(); } catch { /* already gone */ }
            }
            workers.length = 0;
            for (const [, entry] of pending) {
                clearTimeout(entry.timer);
                entry.resolve({ opcertOk: false, kesOk: false, vrfOk: false, detail: ["the verifier was closed before this header was checked"] });
            }
            pending.clear();
            queue.length = 0;
            current.clear();
        }
    };
}
