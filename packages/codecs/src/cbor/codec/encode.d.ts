import { Config, Effect } from "effect";
import { CborEncodeError } from "../CborError";
import { type CborValue } from "../CborValue";
export declare const INITIAL_CAPACITY: Config.Config<number>;
export declare const MAX_CAPACITY: Config.Config<number>;
export interface EncodeCapacities {
    readonly initialCapacity: number;
    readonly maxCapacity: number;
}
export declare const encodeSync: (obj: CborValue, capacities?: EncodeCapacities) => Uint8Array;
export declare const encode: (obj: CborValue) => Effect.Effect<Uint8Array, CborEncodeError>;
//# sourceMappingURL=encode.d.ts.map