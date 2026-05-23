import { describe, expect, it } from "vitest";
import {
  decodeRpcEnvelope,
  rpcClientIdsForWireResponse,
} from "../../entrypoints/offscreen/rpc-transport.ts";

describe("decodeRpcEnvelope", () => {
  it("accepts a request envelope", () => {
    const data = { _tag: "Request", id: "1" };
    const env = decodeRpcEnvelope({
      _kind: "request",
      clientId: 0,
      data,
    });
    expect(env).toEqual({ _kind: "request", clientId: 0, data });
  });

  it("accepts a response envelope", () => {
    const data = { _tag: "Exit", requestId: "1" };
    const env = decodeRpcEnvelope({
      _kind: "response",
      clientId: 0,
      data,
    });
    expect(env).toEqual({ _kind: "response", clientId: 0, data });
  });

  it("rejects non-objects and malformed payloads", () => {
    expect(decodeRpcEnvelope(null)).toBeNull();
    expect(decodeRpcEnvelope({ _kind: "request", clientId: 0, data: 42 })).toBeNull();
    expect(decodeRpcEnvelope({ _kind: "nope", clientId: 0, data: { _tag: "Request" } })).toBeNull();
  });
});

describe("rpcClientIdsForWireResponse", () => {
  it("maps wire clientId 2 to Effect RpcClient registered id 0 (popup upload)", () => {
    expect(rpcClientIdsForWireResponse(2, new Set([0]))).toEqual([0]);
  });

  it("falls back to 0 before Protocol.run registers the client", () => {
    expect(rpcClientIdsForWireResponse(2, new Set())).toEqual([0]);
  });
});
