/**
 * Worker entry for header crypto (see vrfPool.ts). It answers one task at a time with the verdict from the
 * same `verifyHeaderTask` the main thread uses, so a worker can only confirm or refuse, never reinterpret.
 */
import { verifyHeaderTask, type HeaderVerdict, type VrfTask } from "./vrfVerify";

interface Request { id: number; task: VrfTask }

self.onmessage = (event: MessageEvent<Request>) => {
    const data = event?.data;
    if (!data || typeof data.id !== "number" || !data.task) return;
    let verdict: HeaderVerdict;
    try {
        verdict = verifyHeaderTask(data.task);
    } catch (e) {
        // a throw is not a verdict: answer with a refusal so the pool verifies inline
        verdict = { opcertOk: false, kesOk: false, vrfOk: false, detail: [`worker: ${(e as Error)?.message ?? String(e)}`] };
    }
    (self as any).postMessage({ id: data.id, verdict });
};
