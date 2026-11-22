/**
 * Cardano network the extension syncs, fixed at build time (`GEROLAMINO_NETWORK=preview|preprod`
 * at `wxt build`; default preprod), with its protocol magic and slot clock.
 */
import { PREPROD_MAGIC, PREVIEW_MAGIC, SlotClockPreprod, SlotClockPreview } from "consensus";

declare const __GEROLAMINO_NETWORK__: string;

export type ExtNetwork = "preprod" | "preview";

export const NETWORK: ExtNetwork = __GEROLAMINO_NETWORK__ === "preview" ? "preview" : "preprod";

export const NETWORK_MAGIC: number = NETWORK === "preview" ? PREVIEW_MAGIC : PREPROD_MAGIC;

export const NetworkSlotClock = NETWORK === "preview" ? SlotClockPreview : SlotClockPreprod;
