/**
 * A minimal Chrome DevTools Protocol client over Bun's WebSocket: request/response by id, events, and
 * flattened target sessions (`Target.attachToTarget({ flatten: true })`). Dev-only (the e2e test).
 */
export interface CdpEvent { method: string; params: any; sessionId?: string }

export class Cdp {
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
    private listeners = new Set<(e: CdpEvent) => void>();
    private constructor(private readonly ws: WebSocket) {
        ws.addEventListener("message", (ev) => {
            const msg = JSON.parse(String(ev.data));
            if (typeof msg.id === "number") {
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
            } else if (msg.method) for (const l of this.listeners) l(msg);
        });
        ws.addEventListener("close", () => { for (const p of this.pending.values()) p.reject(new Error("CDP connection closed")); this.pending.clear(); });
    }

    static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const t = setTimeout(() => reject(new Error(`CDP connect timeout ${url}`)), timeoutMs);
            ws.addEventListener("open", () => { clearTimeout(t); resolve(new Cdp(ws)); }, { once: true });
            ws.addEventListener("error", () => { clearTimeout(t); reject(new Error(`CDP connect failed ${url}`)); }, { once: true });
        });
    }

    send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: timeout`)); }, timeoutMs);
            this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); }, method });
            this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        });
    }

    on(l: (e: CdpEvent) => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }

    /** Evaluate an expression in a session; awaits promises and returns the value (JSON). */
    async evaluate<T = any>(sessionId: string, expression: string, timeoutMs = 30_000): Promise<T> {
        const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs);
        if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result?.value as T;
    }

    close(): void { try { this.ws.close(); } catch { /* ignore */ } }
}
