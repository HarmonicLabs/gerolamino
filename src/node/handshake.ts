/**
 * Node-to-node handshake for a browser node. A browser cannot accept connections, so it proposes
 * `initiatorOnlyDiffusionMode: true` (the relay must not open responder-side protocols towards it or
 * count it as a duplex peer) and `peerSharing: 0` (it has no peers to share). The versions are the ones
 * a Gerolamo relay accepts (its handshake responder takes 14 and 15 and picks the highest mutual one).
 *
 * The proposal is built and sent here rather than through `HandshakeClient.propose(versionTable)`:
 * in @harmoniclabs/ouroboros-miniprotocols-ts 0.0.5-dev7 `isVersionTableMap` tests the string keys of
 * `Object.keys` with `isExtendedVersionNumber`, which only accepts numbers, so a version table is never
 * recognised and is mistaken for a single VersionData ("VersionData :: invalid networkMagic: undefined").
 * `HandshakeClient` is still used to parse the reply.
 */
import {
    HandshakeAcceptVersion,
    HandshakeClient,
    HandshakeProposeVersion,
    HandshakeQueryReply,
    HandshakeRefuse,
    MiniProtocol,
    VersionData,
    type Multiplexer,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";

export const N2N_VERSIONS = [14, 15] as const;

export function browserVersionData(networkMagic: number): VersionData {
    return new VersionData({ networkMagic, initiatorOnlyDiffusionMode: true, peerSharing: false, query: false }, { includePeerSharing: true, includeQuery: true });
}

export function browserVersionTable(networkMagic: number): Record<number, VersionData> {
    const table: Record<number, VersionData> = {};
    for (const v of N2N_VERSIONS) table[v] = browserVersionData(networkMagic);
    return table;
}

/** The MsgProposeVersions bytes a browser node sends. */
export function encodeBrowserPropose(networkMagic: number): Uint8Array {
    return new HandshakeProposeVersion({ versionTable: browserVersionTable(networkMagic) }, true).toCborBytes();
}

export interface HandshakeResult { version: number; remote: { initiatorOnlyDiffusionMode: boolean; peerSharing: boolean; networkMagic: number } }

export async function proposeBrowserHandshake(mux: Multiplexer, networkMagic: number, timeoutMs = 15_000): Promise<HandshakeResult> {
    const client = new HandshakeClient(mux);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const reply = await new Promise<HandshakeAcceptVersion | HandshakeRefuse | HandshakeQueryReply>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`handshake timed out after ${timeoutMs} ms`)), timeoutMs);
            client.once("accept", resolve);
            client.once("refuse", resolve);
            client.once("queryReply", resolve);
            client.once("error", reject);
            mux.send(encodeBrowserPropose(networkMagic), { hasAgency: true, protocol: MiniProtocol.Handshake });
        });
        if (reply instanceof HandshakeRefuse) throw new Error(`handshake refused: ${describeRefuse(reply)}`);
        if (reply instanceof HandshakeQueryReply) throw new Error("handshake: relay answered a version query");
        const vd = reply.versionData as VersionData;
        return { version: Number(reply.versionNumber), remote: { initiatorOnlyDiffusionMode: !!vd.initiatorOnlyDiffusionMode, peerSharing: !!vd.peerSharing, networkMagic: Number(vd.networkMagic) } };
    } finally {
        if (timer) clearTimeout(timer);
        client.terminate();
    }
}

function describeRefuse(r: HandshakeRefuse): string {
    const reason: any = (r as any).reason;
    if (!reason) return "unknown";
    const name = reason.constructor?.name ?? "reason";
    const detail = reason.validVersions ? ` (relay accepts ${[...reason.validVersions].join(", ")})` : reason.errorMessage ? `: ${reason.errorMessage}` : "";
    return name + detail;
}
