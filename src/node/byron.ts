/**
 * Byron headers and Ouroboros-BFT (PBFT) checks for the browser node.
 *
 * Byron is not Shelley: the header is `[protocolMagic, prevBlock, bodyProof, consensusData, extraData]`
 * (main blocks) or the EBB shape, the block hash is blake2b-256 of `0x82 ‖ byronType ‖ rawHeader`,
 * and the block signature is an ed25519 signature by the delegate key over raw header slices. The
 * Ouroboros-BFT state checks the signature, genesis delegation certificate and registered delegate
 * pair, slot monotonicity, and the k-window signature threshold.
 *
 * This is ported from Gerolamo's `src/consensus/byron/ByronCrypto.ts` and `ByronOBFT.ts`. The pure-TS
 * SHA3-256 comes from the @noble/hashes copy that ledger-ts already carries; no Buffer or node: imports.
 */
import { Cbor, CborArray, CborBytes, CborTag, CborUInt, LazyCborArray } from "@harmoniclabs/cbor";
import { blake2b_224, blake2b_256 } from "@harmoniclabs/crypto";
import { ByronBlockHeaderBody, ByronEbbHead } from "@harmoniclabs/cardano-ledger-ts";
import { sha3_256 } from "@noble/hashes/sha3";
import { toHex, fromHex } from "@harmoniclabs/uint8array-utils";
import { ed25519Verify } from "./vrf";
import previewGenesis from "./config/byron-preview.json";
import preprodGenesis from "./config/byron-preprod.json";

/** Byron slots per epoch; preprod and mainnet Byron share this value. */
export const BYRON_SLOTS_PER_EPOCH = 21600;

export interface ByronGenesisConfig {
    protocolConsts: { k: number; protocolMagic: number };
    heavyDelegation: Record<string, { omega: number; issuerPk: string; delegatePk: string; cert: string }>;
    bootStakeholders?: Record<string, number>;
    nonAvvmBalances?: Record<string, string>;
    avvmDistr?: Record<string, string>;
}

const GENESIS: Record<string, ByronGenesisConfig> = {
    preview: previewGenesis as unknown as ByronGenesisConfig,
    preprod: preprodGenesis as unknown as ByronGenesisConfig,
};
export function byronGenesisFor(network: string): ByronGenesisConfig | null {
    return GENESIS[network] ?? null;
}

export const BYRON_EBB = 0;
export const BYRON_MAIN = 1;
export const isByronEra = (era: number): boolean => era === BYRON_EBB || era === BYRON_MAIN;

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/** Current 64-bit header hash base58/hex helper without Buffer. */
function bytesOfHash(h: any): Uint8Array | null {
    const b = typeof h?.toBuffer === "function" ? h.toBuffer() : typeof h?.toBytes === "function" ? h.toBytes() : h;
    return b instanceof Uint8Array ? b : null;
}

/** Pure base64 decode (the genesis JSON uses base64 for Byron XPub keys). */
export function base64ToBytes(s: string): Uint8Array {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const c0 = alphabet.indexOf(clean[i]!) & 63;
        const c1 = alphabet.indexOf(clean[i + 1]!) & 63;
        const c2 = alphabet.indexOf(clean[i + 2]!) & 63;
        const c3 = alphabet.indexOf(clean[i + 3]!) & 63;
        if (o < out.length) out[o++] = (c0 << 2) | (c1 >> 4);
        if (o < out.length) out[o++] = (((c1 & 15) << 4) | (c2 >> 2)) & 0xff;
        if (o < out.length) out[o++] = (((c2 & 3) << 6) | c3) & 0xff;
    }
    return out;
}

function cborUInt(n: bigint | number): Uint8Array { return Cbor.encode(new CborUInt(BigInt(n))).toBuffer(); }
function cborBytes(b: Uint8Array): Uint8Array { return Cbor.encode(new CborBytes(b)).toBuffer(); }

/** Byron `KeyHash` of a 64-byte XPub, hex. */
export function byronKeyHash(xpub: Uint8Array): string {
    if (xpub.length !== 64) throw new Error(`byronKeyHash: expected 64-byte XPub, got ${xpub.length}`);
    return toHex(blake2b_224(sha3_256(concatBytes(new Uint8Array([0x58, 0x40]), xpub))));
}

export function signTagCertificate(protocolMagic: number): Uint8Array {
    return concatBytes(new Uint8Array([0x0a]), cborUInt(protocolMagic));
}

export function signTagBlock(protocolMagic: number, issuerXPub: Uint8Array): Uint8Array {
    return concatBytes(new Uint8Array([0x30, 0x31]), issuerXPub, new Uint8Array([0x09]), cborUInt(protocolMagic));
}

export interface ByronDelegationCertificate {
    epoch: bigint;
    issuerXPub: Uint8Array;
    delegateXPub: Uint8Array;
    signature: Uint8Array;
}

/** Verify a heavyweight delegation certificate: issuer → delegate for `epoch`. */
export function verifyByronDelegationCert(cert: ByronDelegationCertificate, protocolMagic: number): boolean {
    if (cert.issuerXPub.length !== 64 || cert.delegateXPub.length !== 64 || cert.signature.length !== 64) return false;
    const payload = cborBytes(concatBytes(new Uint8Array([0x30, 0x30]), cert.delegateXPub, cborUInt(cert.epoch)));
    const message = concatBytes(signTagCertificate(protocolMagic), payload);
    return ed25519Verify(cert.signature, message, cert.issuerXPub.slice(0, 32));
}

export interface ByronMainHeaderSlices {
    prevBlock: Uint8Array;
    proof: Uint8Array;
    slotId: Uint8Array;
    difficulty: Uint8Array;
    extra: Uint8Array;
    headerPubKey: Uint8Array;
    blockSig: { type: number; cert: ByronDelegationCertificate | null; signature: Uint8Array };
}

/** Slice a raw Byron main-block header without re-encoding anything. */
export function sliceByronMainHeader(rawHeader: Uint8Array): ByronMainHeaderSlices {
    const header = Cbor.parseLazy(rawHeader);
    if (!(header instanceof LazyCborArray) || header.array.length < 5) throw new Error("sliceByronMainHeader: header is not a 5-element array");
    const consensus = Cbor.parseLazy(header.array[3]!);
    if (!(consensus instanceof LazyCborArray) || consensus.array.length < 4) throw new Error("sliceByronMainHeader: consensus data malformed");
    const pub = Cbor.parse(consensus.array[1]!);
    if (!(pub instanceof CborBytes)) throw new Error("sliceByronMainHeader: pubkey not bytes");
    const sigObj = Cbor.parse(consensus.array[3]!);
    if (!(sigObj instanceof CborArray) || sigObj.array.length < 2 || !(sigObj.array[0] instanceof CborUInt)) throw new Error("sliceByronMainHeader: blockSig malformed");
    const type = Number(sigObj.array[0].num);
    let cert: ByronDelegationCertificate | null = null;
    let signature: Uint8Array;
    if (type === 2) {
        const inner = sigObj.array[1];
        if (!(inner instanceof CborArray) || inner.array.length < 2) throw new Error("sliceByronMainHeader: dlg blockSig malformed");
        const c = inner.array[0], s = inner.array[1];
        if (!(c instanceof CborArray) || c.array.length < 4 ||
            !(c.array[0] instanceof CborUInt) || !(c.array[1] instanceof CborBytes) || !(c.array[2] instanceof CborBytes) || !(c.array[3] instanceof CborBytes) ||
            !(s instanceof CborBytes)) throw new Error("sliceByronMainHeader: delegation certificate malformed");
        cert = { epoch: c.array[0].num, issuerXPub: c.array[1].bytes, delegateXPub: c.array[2].bytes, signature: c.array[3].bytes };
        signature = s.bytes;
    } else if (sigObj.array[1] instanceof CborBytes) {
        signature = sigObj.array[1].bytes;
    } else {
        throw new Error(`sliceByronMainHeader: unsupported blockSig type ${type}`);
    }
    return {
        prevBlock: header.array[1]!, proof: header.array[2]!, slotId: consensus.array[0]!,
        difficulty: consensus.array[2]!, extra: header.array[4]!, headerPubKey: pub.bytes,
        blockSig: { type, cert, signature },
    };
}

export function byronToSignBytes(s: ByronMainHeaderSlices): Uint8Array {
    return concatBytes(new Uint8Array([0x85]), s.prevBlock, s.proof, s.slotId, s.difficulty, s.extra);
}

export interface ByronBlockSignatureCheck {
    ok: boolean;
    reason?: string;
    issuerKeyHash?: string;
    signerKeyHash?: string;
}

/** Verify a Byron main-block signature: type 2 delegation, type 0 direct. */
export function verifyByronBlockSignature(rawHeader: Uint8Array, protocolMagic: number): ByronBlockSignatureCheck {
    const s = sliceByronMainHeader(rawHeader);
    if (s.headerPubKey.length !== 64) return { ok: false, reason: "header pubkey not 64 bytes" };
    const toSign = byronToSignBytes(s);
    if (s.blockSig.type === 2) {
        const cert = s.blockSig.cert!;
        if (!verifyByronDelegationCert(cert, protocolMagic)) return { ok: false, reason: "delegation certificate signature invalid" };
        if (toHex(cert.issuerXPub) !== toHex(s.headerPubKey)) return { ok: false, reason: "certificate issuer is not the header pubkey" };
        const message = concatBytes(signTagBlock(protocolMagic, cert.issuerXPub), toSign);
        const ok = ed25519Verify(s.blockSig.signature, message, cert.delegateXPub.slice(0, 32));
        return { ok, reason: ok ? undefined : "block signature invalid", issuerKeyHash: byronKeyHash(cert.issuerXPub), signerKeyHash: byronKeyHash(cert.delegateXPub) };
    }
    if (s.blockSig.type === 0) {
        const message = concatBytes(signTagBlock(protocolMagic, s.headerPubKey), toSign);
        const ok = ed25519Verify(s.blockSig.signature, message, s.headerPubKey.slice(0, 32));
        const kh = byronKeyHash(s.headerPubKey);
        return { ok, reason: ok ? undefined : "block signature invalid", issuerKeyHash: kh, signerKeyHash: kh };
    }
    return { ok: false, reason: `unsupported blockSig type ${s.blockSig.type}` };
}

/** Byron header hash: `blake2b-256(0x82 ‖ byronType ‖ rawHeader)`. */
export function byronHeaderHash(byronType: number, rawHeader: Uint8Array): string {
    if (!isByronEra(byronType)) throw new Error(`byronHeaderHash: invalid Byron block type ${byronType}`);
    const prefixed = new Uint8Array(rawHeader.length + 2);
    prefixed[0] = 0x82; prefixed[1] = byronType;
    prefixed.set(rawHeader, 2);
    return toHex(blake2b_256(prefixed));
}

export interface ByronHeaderParsed {
    eraTag: number;
    byronType: number;
    isEbb: boolean;
    rawHeader: Uint8Array;
    hash: string;
    prevHash: string | null;
    slot: number;
    /** Byron headers do not carry the Shelley block number; callers use chain-sync if they need it. */
    blockNo: number;
}

/** Parse a Byron header (raw `#6.24` payload) and compute its hash, parent and absolute slot. */
export function parseByronHeader(rawHeader: Uint8Array, byronType: number): ByronHeaderParsed {
    if (!isByronEra(byronType)) throw new Error(`invalid Byron header type ${byronType}`);
    const header = byronType === BYRON_EBB ? ByronEbbHead.fromCbor(rawHeader) : ByronBlockHeaderBody.fromCbor(rawHeader);
    const prev = bytesOfHash((header as any).prevBlock);
    const prevHash = prev ? toHex(prev) : null;
    const slot = byronType === BYRON_EBB
        ? Number((header as any).consensusData.epoch) * BYRON_SLOTS_PER_EPOCH
        : Number((header as any).consensusData.slotId.epoch) * BYRON_SLOTS_PER_EPOCH + Number((header as any).consensusData.slotId.slot);
    return {
        eraTag: byronType, byronType, isEbb: byronType === BYRON_EBB, rawHeader,
        hash: byronHeaderHash(byronType, rawHeader), prevHash, slot, blockNo: 0,
    };
}

/** Parse the Byron-specific ChainSync header wrapper `[[type, sizeHint], #6.24(header)]`. */
export function parseByronChainSyncHeader(wrapped: CborArray): ByronHeaderParsed {
    if (wrapped.array.length < 2) throw new Error("Byron header wrapper is not [prefix, tag24]");
    const prefix = wrapped.array[0];
    if (!(prefix instanceof CborArray) || !(prefix.array[0] instanceof CborUInt)) throw new Error("Byron header prefix is not [type, sizeHint]");
    const byronType = Number(prefix.array[0].num);
    const tag = wrapped.array[1];
    if (!(tag instanceof CborTag) || !(tag.data instanceof CborBytes)) throw new Error("Byron header is not #6.24(bytes)");
    return parseByronHeader(tag.data.bytes, byronType);
}

export interface ByronObftHeaderCheck {
    ok: boolean;
    reason?: string;
    issuerKeyHash?: string;
    signerKeyHash?: string;
}

export interface ByronObftOptions {
    k?: number;
    signatureThreshold?: number;
    log?: (line: string) => void;
}

/** Ouroboros-BFT validating-chain state (genesis delegation plus on-chain delegation schedule). */
export class ByronObftState {
    readonly protocolMagic: number;
    readonly k: number;
    readonly maxSignaturesPerWindow: number;
    readonly genesisKeys: Set<string>;
    private readonly activeDelegation = new Map<string, string>();
    private scheduled: Array<{ activateAtSlot: bigint; issuerKeyHash: string; delegateKeyHash: string }> = [];
    private window: string[] = [];
    private lastSignedSlot: bigint | null = null;
    private readonly log: (line: string) => void;

    constructor(genesis: ByronGenesisConfig, opts: ByronObftOptions = {}) {
        this.protocolMagic = genesis.protocolConsts.protocolMagic;
        this.k = opts.k ?? genesis.protocolConsts.k;
        this.maxSignaturesPerWindow = Math.floor((opts.signatureThreshold ?? 0.22) * this.k);
        this.log = opts.log ?? (() => {});
        this.genesisKeys = new Set(Object.keys(genesis.heavyDelegation));
        for (const [issuerKh, d] of Object.entries(genesis.heavyDelegation)) {
            const issuer = base64ToBytes(d.issuerPk);
            const delegate = base64ToBytes(d.delegatePk);
            if (byronKeyHash(issuer) !== issuerKh) throw new Error(`Byron genesis: heavyDelegation key ${issuerKh} does not hash its issuerPk`);
            const cert: ByronDelegationCertificate = { epoch: BigInt(d.omega), issuerXPub: issuer, delegateXPub: delegate, signature: fromHex(d.cert) };
            if (!verifyByronDelegationCert(cert, this.protocolMagic)) throw new Error(`Byron genesis: heavyDelegation certificate for ${issuerKh} does not verify`);
            this.activeDelegation.set(issuerKh, byronKeyHash(delegate));
        }
    }

    delegationMap(): Map<string, string> { return new Map(this.activeDelegation); }

    private isAuthorisedPair(issuerKh: string, delegateKh: string, atSlot: bigint): boolean {
        this.activatePending(atSlot);
        if (this.activeDelegation.get(issuerKh) === delegateKh) return true;
        return this.scheduled.some((s) => s.issuerKeyHash === issuerKh && s.delegateKeyHash === delegateKh);
    }

    private activatePending(slot: bigint): void {
        if (!this.scheduled.length) return;
        const due = this.scheduled.filter((s) => s.activateAtSlot <= slot);
        if (!due.length) return;
        for (const s of due) {
            this.activeDelegation.set(s.issuerKeyHash, s.delegateKeyHash);
            this.log(`Byron delegation active: ${s.issuerKeyHash.slice(0, 12)} → ${s.delegateKeyHash.slice(0, 12)} (slot ${slot})`);
        }
        this.scheduled = this.scheduled.filter((s) => s.activateAtSlot > slot);
    }

    /** Full main-block header check; EBBs are not signed and are not counted in the window. */
    validateMainHeader(rawHeader: Uint8Array, slot: bigint): ByronObftHeaderCheck {
        const sig = verifyByronBlockSignature(rawHeader, this.protocolMagic);
        if (!sig.ok) return { ok: false, reason: sig.reason ?? "signature invalid" };
        return this.validateSignedMainHeader(slot, sig.issuerKeyHash!, sig.signerKeyHash!);
    }

    validateSignedMainHeader(slot: bigint, issuerKh: string, signerKh: string): ByronObftHeaderCheck {
        if (!this.genesisKeys.has(issuerKh)) return { ok: false, reason: `issuer ${issuerKh} is not a genesis key`, issuerKeyHash: issuerKh, signerKeyHash: signerKh };
        if (!this.isAuthorisedPair(issuerKh, signerKh, slot)) return { ok: false, reason: `delegate ${signerKh} is not the registered delegate of ${issuerKh}`, issuerKeyHash: issuerKh, signerKeyHash: signerKh };
        if (this.lastSignedSlot != null && slot < this.lastSignedSlot) return { ok: false, reason: `slot ${slot} < last signed slot ${this.lastSignedSlot}`, issuerKeyHash: issuerKh, signerKeyHash: signerKh };
        let count = 1;
        for (const kh of this.window) if (kh === issuerKh) count++;
        if (count > this.maxSignaturesPerWindow) return { ok: false, reason: `issuer ${issuerKh} signed ${count} of the last ${this.k} blocks (max ${this.maxSignaturesPerWindow})`, issuerKeyHash: issuerKh, signerKeyHash: signerKh };
        return { ok: true, issuerKeyHash: issuerKh, signerKeyHash: signerKh };
    }

    /** Record an applied Byron main block (window, last slot and any delegation certificates in its body). */
    noteApplied(rawHeader: Uint8Array, slot: bigint, rawBody?: Uint8Array): void {
        const s = sliceByronMainHeader(rawHeader);
        this.noteAppliedIssuer(byronKeyHash(s.headerPubKey), slot, rawBody);
    }

    noteAppliedIssuer(issuerKh: string, slot: bigint, rawBody?: Uint8Array): void {
        this.window.push(issuerKh);
        if (this.window.length > this.k) this.window.splice(0, this.window.length - this.k);
        this.lastSignedSlot = slot;
        if (rawBody) this.scheduleFromBody(rawBody, slot);
    }

    private scheduleFromBody(rawBody: Uint8Array, slot: bigint): void {
        try {
            const body = Cbor.parseLazy(rawBody);
            if (!(body instanceof LazyCborArray) || body.array.length < 3) return;
            const dlg = Cbor.parse(body.array[2]!);
            if (!(dlg instanceof CborArray)) return;
            for (const c of dlg.array) {
                if (!(c instanceof CborArray) || c.array.length < 4 ||
                    !(c.array[0] instanceof CborUInt) || !(c.array[1] instanceof CborBytes) || !(c.array[2] instanceof CborBytes) || !(c.array[3] instanceof CborBytes)) continue;
                const cert: ByronDelegationCertificate = { epoch: c.array[0].num, issuerXPub: c.array[1].bytes, delegateXPub: c.array[2].bytes, signature: c.array[3].bytes };
                const issuerKh = byronKeyHash(cert.issuerXPub);
                if (!this.genesisKeys.has(issuerKh) || !verifyByronDelegationCert(cert, this.protocolMagic)) continue;
                this.scheduled.push({ activateAtSlot: slot + BigInt(2 * this.k), issuerKeyHash: issuerKh, delegateKeyHash: byronKeyHash(cert.delegateXPub) });
            }
        } catch {
            this.log(`Byron dlgPayload parse failed at slot ${slot}`);
        }
    }

    restoreDelegation(map: ReadonlyMap<string, string>, scheduled: ReadonlyArray<{ slot: bigint; delegator: string; delegate: string }>): void {
        this.activeDelegation.clear();
        for (const [g, d] of map) if (this.genesisKeys.has(g)) this.activeDelegation.set(g, d);
        this.scheduled = scheduled.map((s) => ({ activateAtSlot: s.slot, issuerKeyHash: s.delegator, delegateKeyHash: s.delegate }));
    }

    seed(headers: Array<{ rawHeader: Uint8Array; slot: bigint }>): void {
        this.window = [];
        this.lastSignedSlot = null;
        for (const h of headers.slice(-this.k)) {
            try {
                const s = sliceByronMainHeader(h.rawHeader);
                this.window.push(byronKeyHash(s.headerPubKey));
                this.lastSignedSlot = h.slot;
            } catch { /* EBB */ }
        }
    }

    snapshot(): { windowSize: number; lastSignedSlot: string | null; issuers: Record<string, number>; scheduled: number } {
        const issuers: Record<string, number> = {};
        for (const kh of this.window) issuers[kh] = (issuers[kh] ?? 0) + 1;
        return { windowSize: this.window.length, lastSignedSlot: this.lastSignedSlot?.toString() ?? null, issuers, scheduled: this.scheduled.length };
    }
}

/** Network genesis with its magic; null for an unsupported network. */
export function byronObftFor(network: string, opts: ByronObftOptions = {}): ByronObftState | null {
    const g = byronGenesisFor(network);
    return g ? new ByronObftState(g, opts) : null;
}
