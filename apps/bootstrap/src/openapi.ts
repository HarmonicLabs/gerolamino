/**
 * API documentation specs for the Gerolamo bootstrap server.
 */
import { MessageTag } from "bootstrap";

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Gerolamo Bootstrap Server",
    version: "0.1.0",
    description:
      "Streams Mithril snapshot data and proxies Ouroboros miniprotocols for Cardano browser nodes.",
  },
  paths: {
    "/info": {
      get: {
        summary: "Snapshot metadata",
        responses: {
          "200": {
            description: "Snapshot metadata",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/bootstrap": {
      get: {
        summary: "Bootstrap WebSocket",
        responses: { "101": { description: "WebSocket upgrade" } },
      },
    },
  },
};

const tlvFrameDescription = "TLV frame: [tag: u8][length: u32 BE][payload: u8[length]]";

export const asyncapiSpec = {
  asyncapi: "3.0.0",
  info: {
    title: "Gerolamo Bootstrap WebSocket Protocol",
    version: "0.1.0",
    description: `Binary TLV-framed protocol. Frame format: ${tlvFrameDescription}`,
  },
  channels: {
    bootstrap: {
      address: "/bootstrap",
      messages: {
        Init: { $ref: "#/components/messages/Init" },
        Block: { $ref: "#/components/messages/Block" },
        LedgerState: { $ref: "#/components/messages/LedgerState" },
        LedgerMeta: { $ref: "#/components/messages/LedgerMeta" },
        LmdbEntries: { $ref: "#/components/messages/LmdbEntries" },
        Progress: { $ref: "#/components/messages/Progress" },
        Complete: { $ref: "#/components/messages/Complete" },
      },
    },
  },
  components: {
    messages: {
      Init: { name: "Init", title: `Tag 0x${MessageTag.Init.toString(16).padStart(2, "0")}` },
      Block: { name: "Block", title: `Tag 0x${MessageTag.Block.toString(16).padStart(2, "0")}` },
      LedgerState: {
        name: "LedgerState",
        title: `Tag 0x${MessageTag.LedgerState.toString(16).padStart(2, "0")}`,
      },
      LedgerMeta: {
        name: "LedgerMeta",
        title: `Tag 0x${MessageTag.LedgerMeta.toString(16).padStart(2, "0")}`,
      },
      LmdbEntries: {
        name: "LmdbEntries",
        title: `Tag 0x${MessageTag.LmdbEntries.toString(16).padStart(2, "0")}`,
      },
      Progress: {
        name: "Progress",
        title: `Tag 0x${MessageTag.Progress.toString(16).padStart(2, "0")}`,
      },
      Complete: {
        name: "Complete",
        title: `Tag 0x${MessageTag.Complete.toString(16).padStart(2, "0")}`,
      },
    },
  },
};
