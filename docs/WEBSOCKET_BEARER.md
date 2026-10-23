# N2N over WebSocket: what Gerolamino needs from a peer

This page is the working basis for a CIP that lets any Cardano node serve browser nodes. The draft itself is in the
Gerolamo repository, `CIP/n2n-over-websocket/README.md`. It describes what
Gerolamino does as a client today and what Gerolamo does as a server. The open questions at the end are what
the CIP still has to settle.

## Transport

- **Connection.** A WebSocket (RFC 6455); `wss://` in production, through TLS at the node or a reverse proxy.
- **Payload.** Binary messages only. The concatenation of all message payloads in one direction is exactly the
  byte stream a TCP N2N peer would send: Ouroboros multiplexer segments, each an 8-byte header plus up to 65 535
  payload bytes.
- **Message boundaries.** Senders should put whole segments in each message. Receivers must accept a segment
  split across messages, and several segments in one message, as with TCP.
- **No subprotocol.** None is negotiated today; the CIP may define one (see the open questions).

## Endpoint

| Path | Status |
|---|---|
| `/n2n` | canonical on Gerolamo |
| `/` | accepted by Gerolamo |
| `/relay` | accepted by Gerolamo, because the first Gerolamino build always appended it |

Other paths get HTTP 404. The server rejects the upgrade with HTTP 503 when it is at its connection limit.

## Mini-protocols

The same N2N protocols, numbers and state machines as over TCP:

| Number | Protocol | Gerolamino |
|---|---|---|
| 0 | handshake | uses |
| 2 | chain-sync | uses |
| 3 | block-fetch | uses |
| 4 | tx-submission | uses |
| 8 | keep-alive | uses |
| 10 | peer-sharing | does not use |
| 7 | light query | Gerolamo extension, used |

Light query is a Gerolamo extension for the epoch nonce, pool stake, immutable chunk files and, since 2026-10-23,
read-only Blockfrost queries (`[8, id, path]` → `[9, id, status, json]`, answered by the peer's own Blockfrost API;
GET only, 30 per 10 s per peer, answers up to 512 KiB). Gerolamino answers what its stored blocks contain itself and
asks the peer for the rest (ledger state, blocks before its start point). A peer without request 8 answers `[255]`. With it, a browser
node can verify headers and start from a Mithril-certified chunk without a second channel. Whether it belongs in
the CIP is an open question.

## Handshake

- **Versions.** The client proposes N2N v14 and v15; the server answers with the highest common version.
- **Initiator-only.** A browser cannot accept connections or serve the chain, so the client sets
  `initiatorOnlyDiffusionMode: true` and `peerSharing: 0`. The server must not start initiator protocols toward
  it.
- **Server side.** Gerolamo answers WebSocket peers with `initiatorOnlyDiffusionMode: true`, so neither side
  expects duplex use.

## Liveness

- **Client.** Gerolamino sends keep-alive every 20 s or less. A Chrome MV3 extension also needs traffic at least
  every 30 s to keep its service worker alive.
- **Server.** Gerolamo closes a connection idle for 120 s, and its own outbound sessions close when a keep-alive
  reply is overdue for 60 s.

## What a browser node needs from the server

- **Chain-sync.** Headers from genesis or from a recent point.
- **Block-fetch.** Ranges of blocks.
- **A way to verify headers.** The epoch nonce and pool stake; today via light query.
- **A trusted start.** A complete immutable chunk to start from, which can be checked against a Mithril
  certificate; today via light query, or HTTP from the Mithril aggregator for the certificates.

## Decided for the CIP: service announcement (2026-10-23)

Optional services are announced, never probed, and never in the N2N handshake's version data.

- **Why not the version data.** For N2N v14/v15 it is a fixed record (network magic, initiator-only, peer sharing,
  query); cardano-node decodes it strictly, so an extra field breaks the handshake, and changing it needs a new N2N
  version in ouroboros-network.
- **Why not probing.** A node's multiplexer may drop the connection on traffic for a mini-protocol it does not run,
  so a client must know before it sends on the light-query protocol.
- **Layer 1, at connection setup: the WebSocket subprotocol.** The client offers, best first,
  `Sec-WebSocket-Protocol: cardano-n2n.v1+lightquery, cardano-n2n.v1`; the server selects the richest it supports.
  A plain N2N node (cardano-node or Dingo behind a proxy) selects `cardano-n2n.v1`: standard protocols only. The
  browser reads the choice from `ws.protocol` before any N2N byte, and it is the only response detail browser
  JavaScript can see. A server that selects nothing is treated as standard-only.
- **Layer 2, inside the light query: capabilities in the hello.** `[4]` → `[5, magic, version, capabilities]`, where
  `capabilities` lists the request types the peer serves and their limits (nonce, stake, chunks, Blockfrost queries
  with rate and answer size). Clients ask only for what is listed.
- **Discovery uses the same names.** The record that tells browsers where WebSocket relays are lists the same
  services, so a browser can choose peers before connecting: standard-only peers for chain-sync, block-fetch and
  cross-checking; light-query peers for nonce, stake, certified starts and ledger queries.

## Open questions for the CIP

1. **Path.** One canonical path (`/n2n`?), or discovery?
2. **Subprotocol.** A `Sec-WebSocket-Protocol` name, for example `cardano-n2n.v1`, so servers can refuse
   unknown clients cleanly.
3. **Discovery.**
   - Pool relay registrations carry IP, DNS or SRV for TCP only.
   - Options: a field in extended pool metadata, an SRV record convention, or peer-sharing extended with a
     WebSocket address type.
4. **Light query.** Standardise nonce and stake (and chunk) queries as a mini-protocol, or require a separate
   HTTP API?
5. **Browser limits.**
   - Origin checks: servers should not rely on them.
   - Connection caps per IP.
   - Range limits for block-fetch.
6. **Back-pressure.** Whether to cap in-flight bytes per WebSocket, since browsers buffer without bound.
