import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getSenderHealthDisplay,
  getSenderUsageLabel,
  SENDER_HEALTH_OPTIONS,
  SENDER_POOL_OPTIONS,
} from "../src/lib/senderHealth.js";

test("sender health maps disconnected and paused senders before color fields", () => {
  assert.equal(getSenderHealthDisplay({ active: true, health_status: "green" }).label, "Disconnected");
  assert.equal(
    getSenderHealthDisplay({ active: false, google_connected_at: "2026-01-01T00:00:00Z", health_status: "green" }).label,
    "Paused"
  );
});

test("sender health maps daily limits and review states", () => {
  assert.equal(
    getSenderHealthDisplay({
      active: true,
      google_connected_at: "2026-01-01T00:00:00Z",
      daily_limit: 10,
      sent_today: 10,
      health_status: "green",
    }).label,
    "At daily limit"
  );
  assert.equal(
    getSenderHealthDisplay({
      active: true,
      google_connected_at: "2026-01-01T00:00:00Z",
      daily_limit: 10,
      sent_today: 1,
      health_status: "red",
    }).label,
    "Needs review"
  );
});

test("sender health maps healthy and limited states", () => {
  assert.equal(
    getSenderHealthDisplay({
      active: true,
      google_connected_at: "2026-01-01T00:00:00Z",
      daily_limit: 10,
      sent_today: 1,
      health_status: "green",
      warmup_stage: "active",
    }).label,
    "Healthy"
  );
  assert.equal(
    getSenderHealthDisplay({
      active: true,
      google_connected_at: "2026-01-01T00:00:00Z",
      daily_limit: 10,
      sent_today: 1,
      health_status: "yellow",
    }).label,
    "Limited"
  );
});

test("sender option labels stay readable while preserving values", () => {
  assert.deepEqual(SENDER_HEALTH_OPTIONS.map((option) => option.value), ["green", "yellow", "red"]);
  assert.deepEqual(SENDER_HEALTH_OPTIONS.map((option) => option.label), ["Healthy", "Limited", "Needs review"]);
  assert.deepEqual(SENDER_POOL_OPTIONS.map((option) => option.value), ["warming", "active", "paused", "burnt"]);
  assert.equal(getSenderUsageLabel({ sent_today: 12, daily_limit: 100 }), "12 / 100 sent today");
});
