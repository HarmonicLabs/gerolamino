/**
 * Gerolamino's Mithril entry point: the three functions the node loads at run time (src/node/mithrilLoader.ts), from
 * @harmoniclabs/mithril-ts. Built into its own bundle (dist/mithril.js) and imported only when needed, so the default
 * start does not carry the verifier. The certificate cache stays where earlier Gerolamino versions kept it
 * (OPFS `gerolamino/mithril-certs/<network>`), so a reinstall does not walk the chain again.
 */
import {
    mithrilAnchor as anchor,
    mithrilStake as stake,
    mithrilTxProof as txProof,
    OpfsCertificateStore,
    type CertificateStore,
    type MithrilAnchorOptions,
    type MithrilStakeOptions,
    type MithrilTxProofOptions,
} from "@harmoniclabs/mithril-ts";

const hasOpfs = (): boolean => typeof (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator?.storage?.getDirectory === "function";
const store = (network: string, given: CertificateStore | null | undefined): CertificateStore | null | undefined =>
    given !== undefined ? given : hasOpfs() ? OpfsCertificateStore.forNetwork(network, ["gerolamino", "mithril-certs"]) : undefined;

export const mithrilAnchor = (o: MithrilAnchorOptions) => anchor({ ...o, store: store(o.network, o.store) });
export const mithrilStake = (o: MithrilStakeOptions) => stake({ ...o, store: store(o.network, o.store) });
export const mithrilTxProof = (o: MithrilTxProofOptions) => txProof({ ...o, store: store(o.network, o.store) });
