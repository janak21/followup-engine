import assert from "node:assert/strict";
import { test } from "node:test";

test("apiCache BroadcastChannel and event dispatching logic", async () => {
  // Mock window and BroadcastChannel environment before importing apiCache
  const mockChannelInstances = [];
  const dispatchedEvents = [];

  class MockBroadcastChannel {
    constructor(name) {
      this.name = name;
      mockChannelInstances.push(this);
    }
    postMessage(data) {
      this.sentData = data;
    }
  }

  globalThis.window = {
    dispatchEvent(event) {
      dispatchedEvents.push(event);
    }
  };
  globalThis.CustomEvent = class {
    constructor(name, init) {
      this.type = name;
      this.detail = init?.detail;
    }
  };
  globalThis.BroadcastChannel = MockBroadcastChannel;

  // Import apiCache dynamically to ensure it runs with the mocked environment
  const apiCache = await import("../src/utils/apiCache.js");

  // Verify BroadcastChannel was initialized with correct name
  assert.equal(mockChannelInstances.length, 1, "Should initialize one BroadcastChannel");
  assert.equal(mockChannelInstances[0].name, "api-cache-channel", "Channel name should be api-cache-channel");

  // Test setCachedData
  dispatchedEvents.length = 0;
  apiCache.setCachedData("test_key", { foo: "bar" }, true);
  assert.deepEqual(apiCache.getCachedData("test_key"), { foo: "bar" });
  assert.deepEqual(mockChannelInstances[0].sentData, { type: "set", key: "test_key", data: { foo: "bar" } });

  // Test setCachedData without broadcast
  mockChannelInstances[0].sentData = null;
  apiCache.setCachedData("test_key2", { foo: "baz" }, false);
  assert.deepEqual(apiCache.getCachedData("test_key2"), { foo: "baz" });
  assert.equal(mockChannelInstances[0].sentData, null);

  // Test invalidateCachedData
  mockChannelInstances[0].sentData = null;
  apiCache.invalidateCachedData("test_key", true);
  assert.equal(apiCache.getCachedData("test_key"), null);
  assert.deepEqual(mockChannelInstances[0].sentData, { type: "invalidate", key: "test_key" });

  // Test clearCache
  mockChannelInstances[0].sentData = null;
  apiCache.clearCache(true);
  assert.equal(apiCache.getCachedData("test_key2"), null);
  assert.deepEqual(mockChannelInstances[0].sentData, { type: "clear" });

  // Test simulated cross-tab messages coming from the channel
  dispatchedEvents.length = 0;
  mockChannelInstances[0].onmessage({
    data: { type: "set", key: "crosstab_key", data: "crosstab_value" }
  });
  assert.equal(apiCache.getCachedData("crosstab_key"), "crosstab_value");
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0].type, "api-cache-updated");
  assert.deepEqual(dispatchedEvents[0].detail, { key: "crosstab_key", data: "crosstab_value" });

  // Test simulated invalidate message
  dispatchedEvents.length = 0;
  mockChannelInstances[0].onmessage({
    data: { type: "invalidate", key: "crosstab_key" }
  });
  assert.equal(apiCache.getCachedData("crosstab_key"), null);
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0].type, "api-cache-invalidated");
  assert.deepEqual(dispatchedEvents[0].detail, { key: "crosstab_key" });

  // Test simulated clear message
  apiCache.setCachedData("another_key", "val", false);
  dispatchedEvents.length = 0;
  mockChannelInstances[0].onmessage({
    data: { type: "clear" }
  });
  assert.equal(apiCache.getCachedData("another_key"), null);
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0].type, "api-cache-cleared");

  // Clean up global mocks
  delete globalThis.window;
  delete globalThis.BroadcastChannel;
  delete globalThis.CustomEvent;
});
