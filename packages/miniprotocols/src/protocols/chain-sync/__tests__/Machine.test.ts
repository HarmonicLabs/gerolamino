/**
 * ChainSync state machine tests — verify protocol state transitions and agency.
 */
import { describe, it, expect } from "@effect/vitest";
import { createActor } from "xstate";
import { chainSyncMachine } from "../Machine.ts";

describe("ChainSync Machine", () => {
  it("starts in Idle (client agency)", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe("Idle");
    actor.stop();
  });

  it("RequestNext: Idle → CanAwait", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "CLIENT_REQUEST_NEXT" });
    expect(actor.getSnapshot().value).toBe("CanAwait");
    actor.stop();
  });

  it("RollForward: CanAwait → Idle", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "CLIENT_REQUEST_NEXT" });
    actor.send({ type: "SERVER_ROLL_FORWARD" });
    expect(actor.getSnapshot().value).toBe("Idle");
    actor.stop();
  });

  it("RollBackward: CanAwait → Idle", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "CLIENT_REQUEST_NEXT" });
    actor.send({ type: "SERVER_ROLL_BACKWARD" });
    expect(actor.getSnapshot().value).toBe("Idle");
    actor.stop();
  });

  it("AwaitReply: CanAwait → MustReply", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "CLIENT_REQUEST_NEXT" });
    actor.send({ type: "SERVER_AWAIT_REPLY" });
    expect(actor.getSnapshot().value).toBe("MustReply");
    actor.stop();
  });

  it("RollForward from MustReply: MustReply → Idle", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "CLIENT_REQUEST_NEXT" });
    actor.send({ type: "SERVER_AWAIT_REPLY" });
    actor.send({ type: "SERVER_ROLL_FORWARD" });
    expect(actor.getSnapshot().value).toBe("Idle");
    actor.stop();
  });

  it("FindIntersect: Idle → Intersect", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "CLIENT_FIND_INTERSECT" });
    expect(actor.getSnapshot().value).toBe("Intersect");
    actor.stop();
  });

  it("IntersectFound: Intersect → Idle", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "CLIENT_FIND_INTERSECT" });
    actor.send({ type: "SERVER_INTERSECT_FOUND" });
    expect(actor.getSnapshot().value).toBe("Idle");
    actor.stop();
  });

  it("IntersectNotFound: Intersect → Idle", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "CLIENT_FIND_INTERSECT" });
    actor.send({ type: "SERVER_INTERSECT_NOT_FOUND" });
    expect(actor.getSnapshot().value).toBe("Idle");
    actor.stop();
  });

  it("Done: Idle → Done (final)", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "CLIENT_DONE" });
    expect(actor.getSnapshot().value).toBe("Done");
    expect(actor.getSnapshot().status).toBe("done");
    actor.stop();
  });

  it("agency enforcement: server events ignored in Idle", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "SERVER_ROLL_FORWARD" }); // should be ignored
    expect(actor.getSnapshot().value).toBe("Idle"); // stays Idle
    actor.stop();
  });

  it("agency enforcement: client events ignored in CanAwait", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "CLIENT_REQUEST_NEXT" });
    expect(actor.getSnapshot().value).toBe("CanAwait");
    actor.send({ type: "CLIENT_REQUEST_NEXT" }); // should be ignored
    expect(actor.getSnapshot().value).toBe("CanAwait"); // stays CanAwait
    actor.stop();
  });

  it("full protocol cycle: FindIntersect → RequestNext → RollForward → Done", () => {
    const actor = createActor(chainSyncMachine);
    actor.start();
    actor.send({ type: "CLIENT_FIND_INTERSECT" });
    actor.send({ type: "SERVER_INTERSECT_FOUND" });
    actor.send({ type: "CLIENT_REQUEST_NEXT" });
    actor.send({ type: "SERVER_ROLL_FORWARD" });
    actor.send({ type: "CLIENT_DONE" });
    expect(actor.getSnapshot().status).toBe("done");
    actor.stop();
  });
});
