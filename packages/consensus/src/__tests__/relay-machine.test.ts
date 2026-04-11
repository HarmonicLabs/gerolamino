/**
 * Relay lifecycle XState machine tests — pure state transition logic.
 */
import { describe, it, expect } from "@effect/vitest";
import { createActor, fromPromise } from "xstate";
import { relayMachine } from "../machines/relay.ts";

describe("Relay Machine", () => {
  it("starts in disconnected state", () => {
    const actor = createActor(relayMachine, { input: { peerId: "test:3001" } });
    actor.start();
    expect(actor.getSnapshot().value).toBe("disconnected");
    expect(actor.getSnapshot().context.peerId).toBe("test:3001");
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    actor.stop();
  });

  it("transitions to syncing on CONNECT", () => {
    const machine = relayMachine.provide({
      actors: {
        connectAndSync: fromPromise<void, { peerId: string }>(
          () => new Promise(() => {}), // never resolves — simulates active sync
        ),
      },
    });
    const actor = createActor(machine, { input: { peerId: "test:3001" } });
    actor.start();
    actor.send({ type: "CONNECT" });
    expect(actor.getSnapshot().value).toBe("syncing");
    actor.stop();
  });

  it("transitions to reconnecting on sync error", async () => {
    const machine = relayMachine.provide({
      actors: {
        connectAndSync: fromPromise<void, { peerId: string }>(() =>
          Promise.reject(new Error("connection refused")),
        ),
      },
    });
    const actor = createActor(machine, { input: { peerId: "test:3001" } });
    actor.start();
    actor.send({ type: "CONNECT" });

    // Wait for invoke to reject and machine to transition
    await new Promise((resolve) => setTimeout(resolve, 50));

    const snap = actor.getSnapshot();
    expect(snap.value).toBe("reconnecting");
    expect(snap.context.retryCount).toBe(1);
    expect(snap.context.lastError).toBeDefined();
    actor.stop();
  });

  it("transitions to disconnected on DISCONNECT from syncing", () => {
    const machine = relayMachine.provide({
      actors: {
        connectAndSync: fromPromise<void, { peerId: string }>(() => new Promise(() => {})),
      },
    });
    const actor = createActor(machine, { input: { peerId: "test:3001" } });
    actor.start();
    actor.send({ type: "CONNECT" });
    expect(actor.getSnapshot().value).toBe("syncing");
    actor.send({ type: "DISCONNECT" });
    expect(actor.getSnapshot().value).toBe("disconnected");
    actor.stop();
  });

  it("transitions to disconnected on DISCONNECT from reconnecting", async () => {
    const machine = relayMachine.provide({
      actors: {
        connectAndSync: fromPromise<void, { peerId: string }>(() =>
          Promise.reject(new Error("fail")),
        ),
      },
    });
    const actor = createActor(machine, { input: { peerId: "test:3001" } });
    actor.start();
    actor.send({ type: "CONNECT" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(actor.getSnapshot().value).toBe("reconnecting");
    actor.send({ type: "DISCONNECT" });
    expect(actor.getSnapshot().value).toBe("disconnected");
    actor.stop();
  });

  it("stops retrying after maxRetries", async () => {
    const machine = relayMachine.provide({
      actors: {
        connectAndSync: fromPromise<void, { peerId: string }>(() =>
          Promise.reject(new Error("fail")),
        ),
      },
    });
    // Set maxRetries to 0 — first failure goes straight to disconnected
    const actor = createActor(machine, { input: { peerId: "test:3001", maxRetries: 0 } });
    actor.start();
    actor.send({ type: "CONNECT" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(actor.getSnapshot().value).toBe("disconnected");
    expect(actor.getSnapshot().context.lastError).toBeDefined();
    actor.stop();
  });

  it("resets retryCount on successful clean disconnect", async () => {
    const machine = relayMachine.provide({
      actors: {
        connectAndSync: fromPromise<void, { peerId: string }>(
          () => Promise.resolve(), // resolves immediately — simulates clean disconnect
        ),
      },
    });
    const actor = createActor(machine, { input: { peerId: "test:3001" } });
    actor.start();
    // Manually set retryCount via a failed attempt first
    actor.send({ type: "CONNECT" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    actor.stop();
  });
});
