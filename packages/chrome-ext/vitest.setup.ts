/**
 * Vitest setup for chrome-ext popup UI tests.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

type StorageCallback = () => void;

const localBag = new Map<string, unknown>();
const sessionBag = new Map<string, unknown>();

const makeStorageArea = (bag: Map<string, unknown>) => ({
  get: (
    keys: string | ReadonlyArray<string> | Record<string, unknown> | null,
    callback?: (items: Record<string, unknown>) => void,
  ) => {
    const result: Record<string, unknown> = {};
    if (keys === null) {
      for (const [k, v] of bag) result[k] = v;
    } else if (typeof keys === "string") {
      result[keys] = bag.get(keys);
    } else if (Array.isArray(keys)) {
      for (const k of keys) result[k] = bag.get(k);
    } else {
      for (const k of Object.keys(keys)) result[k] = bag.get(k);
    }
    callback?.(result);
    return Promise.resolve(result);
  },
  set: (items: Record<string, unknown>, callback?: StorageCallback) => {
    for (const [k, v] of Object.entries(items)) bag.set(k, v);
    callback?.();
    return Promise.resolve();
  },
  remove: (keys: string | ReadonlyArray<string>, callback?: StorageCallback) => {
    const list = typeof keys === "string" ? [keys] : [...keys];
    for (const k of list) bag.delete(k);
    callback?.();
    return Promise.resolve();
  },
  clear: (callback?: StorageCallback) => {
    bag.clear();
    callback?.();
    return Promise.resolve();
  },
});

Object.assign(globalThis, {
  chrome: {
    storage: {
      local: makeStorageArea(localBag),
      session: makeStorageArea(sessionBag),
    },
    runtime: {
      id: "vitest-extension-id",
      getURL: (path: string) => `chrome-extension://vitest/${path}`,
      connect: () => ({
        onMessage: { addListener: () => undefined },
        postMessage: () => undefined,
        disconnect: () => undefined,
      }),
    },
    tabs: {
      create: async () => ({ id: 1 }),
    },
  },
});
