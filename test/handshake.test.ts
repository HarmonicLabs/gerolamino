import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborMap, CborSimple, CborUInt } from "@harmoniclabs/cbor";
import { HandshakeProposeVersion, VersionData } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { isVersionTableMap } from "@harmoniclabs/ouroboros-miniprotocols-ts/dist/protocols/handshake/HandshakeVersionTable/HandshakeVersionTable.js";
import { browserVersionTable, encodeBrowserPropose, N2N_VERSIONS } from "../src/node/handshake";

describe("browser N2N handshake proposal", () => {
    test("proposes versions 14 and 15, each [magic, initiatorOnly = true, peerSharing = 0, query = false]", () => {
        const msg = Cbor.parse(encodeBrowserPropose(2)) as CborArray;
        expect(Number((msg.array[0] as CborUInt).num)).toBe(0); // MsgProposeVersions
        const table = msg.array[1] as CborMap;
        expect(table.map.map((e) => Number((e.k as CborUInt).num))).toEqual([...N2N_VERSIONS]);
        for (const e of table.map) {
            const vd = (e.v as CborArray).array;
            expect(Number((vd[0] as CborUInt).num)).toBe(2);
            expect((vd[1] as CborSimple).simple).toBe(true);
            expect(Number((vd[2] as CborUInt).num)).toBe(0);
            expect((vd[3] as CborSimple).simple).toBe(false);
        }
        // and the library parses it back the way a relay would
        const back = HandshakeProposeVersion.fromCbor(encodeBrowserPropose(1));
        expect(Object.keys(back.versionTable).map(Number)).toEqual([14, 15]);
        expect((back.versionTable as any)[15].initiatorOnlyDiffusionMode).toBe(true);
        expect((back.versionTable as any)[15].networkMagic).toBe(1);
    });

    test("regression guard: the library does not recognise a version table (why handshake.ts encodes the proposal itself)", () => {
        // If this starts passing, HandshakeClient.propose(versionTable) works and handshake.ts can use it again.
        expect(isVersionTableMap(browserVersionTable(2))).toBe(false);
        expect(browserVersionTable(2)[14]).toBeInstanceOf(VersionData);
    });
});
