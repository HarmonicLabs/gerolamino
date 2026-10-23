# N2N over WebSocket: what Gerolamino needs from a peer

This page is the working basis for a CIP that lets any Cardano node serve browser nodes. It describes what
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

Light query is a Gerolamo extension for the epoch nonce, pool stake and immutable chunk files. With it, a browser
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
