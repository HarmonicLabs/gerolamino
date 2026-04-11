/**
 * Crypto worker entry point — runs in a separate OS thread (Bun Worker / Web Worker).
 *
 * Each worker has its own WASM instance (isolated JSC VirtualMachine).
 * Receives CryptoRequest via postMessage, returns CryptoResponse.
 *
 * Protocol:
 *   Main → Worker: [0, CryptoRequest]   (request)
 *   Main → Worker: [1]                  (close)
 *   Worker → Main: [0]                  (ready)
 *   Worker → Main: [1, CryptoResponse]  (response)
 */
import { Schema } from "effect";
import init, {
  ed25519_verify,
  kes_sum6_verify,
  check_vrf_leader,
  vrf_verify_proof,
  vrf_proof_to_hash,
} from "wasm-utils";
import {
  CryptoRequest,
  CryptoRequestKind,
  CryptoResponse,
  CryptoResponseKind,
} from "./crypto-protocol.ts";

declare const self: {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  postMessage(data: unknown, transfer?: ArrayBuffer[]): void;
};

const handleRequest = CryptoRequest.match({
  [CryptoRequestKind.VrfVerifyProof]: (req): CryptoResponse => ({
    _tag: CryptoResponseKind.BytesResult,
    data: vrf_verify_proof(req.vrfVk, req.vrfProof, req.vrfInput),
  }),
  [CryptoRequestKind.KesSum6Verify]: (req): CryptoResponse => ({
    _tag: CryptoResponseKind.BoolResult,
    valid: kes_sum6_verify(req.signature, req.period, req.publicKey, req.message),
  }),
  [CryptoRequestKind.Ed25519Verify]: (req): CryptoResponse => ({
    _tag: CryptoResponseKind.BoolResult,
    valid: ed25519_verify(req.message, req.signature, req.publicKey),
  }),
  [CryptoRequestKind.CheckVrfLeader]: (req): CryptoResponse => ({
    _tag: CryptoResponseKind.BoolResult,
    valid: check_vrf_leader(
      req.vrfOutputHex,
      req.sigmaNumerator,
      req.sigmaDenominator,
      req.activeSlotCoeffNum,
      req.activeSlotCoeffDen,
    ),
  }),
  [CryptoRequestKind.VrfProofToHash]: (req): CryptoResponse => ({
    _tag: CryptoResponseKind.BytesResult,
    data: vrf_proof_to_hash(req.vrfProof),
  }),
});

/** Worker entry point — called when this module is loaded as a Worker. */
const startWorker = () =>
  init().then(() => {
    self.postMessage([0]); // ready signal

    self.addEventListener("message", (event: MessageEvent) => {
      const msg = event.data;
      if (msg[0] === 1) {
        // close signal — no-op, Bun will terminate the thread
        return;
      }
      // msg = [0, CryptoRequest]
      // msg[1] is untyped from MessageEvent.data; validate _tag via Schema
      const raw: unknown = msg[1];
      if (!Schema.is(CryptoRequest)(raw)) {
        self.postMessage([2, "Invalid CryptoRequest from worker message"]);
        return;
      }
      const response = handleRequest(raw);

      // Transfer ArrayBuffer ownership for zero-copy response
      const transfers: ArrayBuffer[] = [];
      if (CryptoResponse.guards.BytesResult(response)) {
        const buf = response.data.buffer;
        if (!(buf instanceof SharedArrayBuffer)) transfers.push(buf);
      }

      self.postMessage([1, response], transfers);
    });
  });

// Only auto-start when loaded as a Worker entry point
startWorker();
