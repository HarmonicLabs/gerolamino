// `./Peer.ts` re-exports `PeerRegistry` as a stub Context.Service tag; the
// full `PeerRegistry.Live` layer lives in `./handler.ts`. The latter
// wins the name collision — explicit selective re-export below.
export {
  AdvanceCursor,
  BlockRange,
  ConnectToPeer,
  Disconnect,
  GetCursor,
  Peer,
  PeerEndpoint,
  PeerError,
  PeerId,
  RequestBlocks,
  SubmitOutcome,
  SubmitTx,
} from "./Peer.ts";
export {
  PeerConnectionFactory,
  PeerConnectionFactoryLive,
  PeerConnections,
  PeerConnectionsLive,
  PeerHandlersLive,
  PeerMeta,
  PeerRegistry,
  PeerRegistryLive,
  SocketLayerFactory,
  rejectPeer,
  type PeerConnectionHandle,
} from "./handler.ts";
export {
  buildIntersectionPoints,
  effectiveCursor,
  FreshnessResult,
  IntersectionReply,
  intersectionToOption,
  onIntersectionReply,
  wasReset,
} from "./cursor-freshness.ts";
