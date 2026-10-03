import assert from "node:assert/strict";
import { test } from "node:test";

import { ensureStepSids, allocateStepIndex } from "../src/lib/journeySpecIdentity.js";

test("ensureStepSids assigns sids only to steps lacking one, and keeps them stable", () => {
  const steps = [{ index: 0, type: "wait" }, { index: 1, type: "sms", sid: "aaaa1111" }];
  const out = ensureStepSids(steps);
  assert.match(out[0].sid, /^[0-9a-f]{8}$/);
  assert.equal(out[1].sid, "aaaa1111");
  const again = ensureStepSids(out);
  assert.equal(again[0].sid, out[0].sid);
});

test("ensureStepSids never assigns duplicate sids", () => {
  const steps = Array.from({ length: 50 }, (_, i) => ({ index: i, type: "wait" }));
  const sids = ensureStepSids(steps).map((s) => s.sid);
  assert.equal(new Set(sids).size, 50);
});

test("allocateStepIndex returns max+1 and never reuses gaps", () => {
  assert.equal(allocateStepIndex([{ index: 0 }, { index: 4 }]), 5);
  assert.equal(allocateStepIndex([]), 0);
});