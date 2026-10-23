/** Per-network constants the node needs without a genesis file (Shelley genesis values). */
export interface NetworkParams {
    name: "preview" | "preprod" | "mainnet";
    magic: number;
    /** Shelley-era epoch length in slots and the Shelley start (slot, epoch) for epoch arithmetic. */
    epochLength: number;
    shelleyStartSlot: number;
    shelleyStartEpoch: number;
    /** Unix time (s) of slot `shelleyStartSlot`; Shelley-era slots are one second. */
    shelleyStartUnix: number;
    slotsPerKESPeriod: number;
    maxKESEvolutions: number;
    /** Security parameter k; immutable chunks cover 10·k slots. */
    securityParam: number;
    chunkSlots: number;
}

export const NETWORKS: NetworkParams[] = [
    { name: "preview", magic: 2, epochLength: 86_400, shelleyStartSlot: 0, shelleyStartEpoch: 0, shelleyStartUnix: 1_666_656_000, slotsPerKESPeriod: 129_600, maxKESEvolutions: 62, securityParam: 432, chunkSlots: 4_320 },
    { name: "preprod", magic: 1, epochLength: 432_000, shelleyStartSlot: 86_400, shelleyStartEpoch: 4, shelleyStartUnix: 1_655_769_600, slotsPerKESPeriod: 129_600, maxKESEvolutions: 62, securityParam: 2_160, chunkSlots: 21_600 },
    { name: "mainnet", magic: 764_824_073, epochLength: 432_000, shelleyStartSlot: 4_492_800, shelleyStartEpoch: 208, shelleyStartUnix: 1_596_059_091, slotsPerKESPeriod: 129_600, maxKESEvolutions: 62, securityParam: 2_160, chunkSlots: 21_600 },
];

export function networkByMagic(magic: number): NetworkParams | undefined {
    return NETWORKS.find((n) => n.magic === magic);
}

export function networkByName(name: string): NetworkParams | undefined {
    return NETWORKS.find((n) => n.name === name);
}

export function epochOfSlot(n: NetworkParams, slot: number): number {
    return n.shelleyStartEpoch + Math.floor((slot - n.shelleyStartSlot) / n.epochLength);
}

/** Unix time (s) of a Shelley-era slot. */
export function slotToUnix(n: NetworkParams, slot: number): number {
    return n.shelleyStartUnix + (slot - n.shelleyStartSlot);
}

/** The first slot of a Shelley-era epoch. */
export function firstSlotOfEpoch(n: NetworkParams, epoch: number): number {
    return n.shelleyStartSlot + (epoch - n.shelleyStartEpoch) * n.epochLength;
}

/** Slot within its epoch. */
export function epochSlotOf(n: NetworkParams, slot: number): number {
    return (slot - n.shelleyStartSlot) % n.epochLength;
}

/** The slot at a Unix time (s); before the Shelley start it returns the Shelley start slot. */
export function unixToSlot(n: NetworkParams, unix: number): number {
    return n.shelleyStartSlot + Math.max(0, Math.floor(unix - n.shelleyStartUnix));
}
