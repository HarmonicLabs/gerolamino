/**
 * Opening an N2N WebSocket: offer the subprotocols that announce services, best first (CIP draft in the Gerolamo
 * repository, CIP/n2n-over-websocket); a relay from before the announcement selects none, which Chrome treats as a
 * failed handshake, so one retry goes without them.
 */
import { N2N_WS_SUBPROTOCOL, N2N_WS_SUBPROTOCOL_LIGHTQUERY } from "./lightQuery";

export interface OpenOptions {
    WebSocketImpl?: typeof WebSocket;
    timeoutMs?: number;
    /** Stop retrying (the caller was stopped meanwhile). */
    stopped?: () => boolean;
    log?: (line: string) => void;
}

export async function openN2NSocket(endpoint: string, o: OpenOptions = {}): Promise<WebSocket> {
    try { return await openWith(endpoint, [N2N_WS_SUBPROTOCOL_LIGHTQUERY, N2N_WS_SUBPROTOCOL], o); }
    catch (e) {
        if (o.stopped?.()) throw e;
        o.log?.("the relay did not take a subprotocol; connecting as to a relay from before the service announcement");
        return openWith(endpoint, undefined, o);
    }
}

function openWith(endpoint: string, protocols: string[] | undefined, o: OpenOptions): Promise<WebSocket> {
    const WS = o.WebSocketImpl ?? WebSocket;
    return new Promise<WebSocket>((resolve, reject) => {
        const ws = protocols ? new WS(endpoint, protocols) : new WS(endpoint);
        ws.binaryType = "arraybuffer";
        const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error(`connect to ${endpoint} timed out`)); }, o.timeoutMs ?? 15_000);
        ws.addEventListener("open", () => { clearTimeout(timer); resolve(ws); }, { once: true });
        ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`cannot connect to ${endpoint}`)); }, { once: true });
    });
}
