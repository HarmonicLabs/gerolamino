/**
 * Certificates already verified back to genesis in this session. A later walk (another artifact of the same or a
 * later epoch) stops when it reaches one, so only the new certificates are checked: a transaction proof after the
 * stake check costs a hop or two, not the whole chain.
 */
import type { Certificate } from "./certificate";
import { verifyCertificateChain, type CertificateRetriever } from "./verifier";

const VERIFIED = new Set<string>();

export async function verifyChainCached(cert: Certificate, genesisVkey: Uint8Array, retrieve: CertificateRetriever): Promise<{ hops: number; cached: boolean }> {
    const chain = await verifyCertificateChain(cert, { genesisVkey, retrieve, verifiedCache: VERIFIED, yieldEvery: 1 });
    if (!chain.genesisHash && !chain.stoppedAtCache) throw new Error("Mithril: certificate chain did not reach genesis");
    for (const h of chain.hops) VERIFIED.add(h.hash);
    return { hops: chain.hops.length, cached: chain.stoppedAtCache };
}

/** Certificates a walk elsewhere (the Mithril start) verified to genesis. */
export function rememberVerified(hashes: Iterable<string>): void { for (const h of hashes) VERIFIED.add(h); }

/** For tests. */
export function forgetVerifiedCertificates(): void { VERIFIED.clear(); }
