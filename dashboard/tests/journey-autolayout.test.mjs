import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeLayout,
  Y_GAP,
  X_GAP,
  START_Y,
  CENTER_X,
} from "../src/app/journeys/builder/lib/autoLayout.js";

// Helper: a step wired to a single "next" outcome pointing at `next`, or a
// terminal step when `next` is null.
const step = (index, next) => ({
  index,
  on_outcome:
    next === null || next === undefined
      ? { done: { exit: "completed" } }
      : { next: { next_step: next } },
});

test("linear chain: strictly increasing y, constant x", () => {
  const steps = [step(0, 1), step(1, 2), step(2, null)];
  const { trigger, steps: pos } = computeLayout({ triggerNextStep: 0, steps });

  assert.deepEqual(trigger, { x: CENTER_X, y: START_Y });

  const ys = [pos[0].y, pos[1].y, pos[2].y];
  // strictly increasing downward
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2], `y should increase: ${ys}`);
  // one node per depth -> all share the trigger's x
  assert.equal(pos[0].x, CENTER_X);
  assert.equal(pos[1].x, CENTER_X);
  assert.equal(pos[2].x, CENTER_X);
  // trigger -> 0 -> 1 -> 2 are consecutive depths
  assert.equal(pos[0].y, START_Y + Y_GAP);
  assert.equal(pos[1].y, START_Y + 2 * Y_GAP);
  assert.equal(pos[2].y, START_Y + 3 * Y_GAP);
});

test("branch: two outcomes -> two children at same depth, different x, no overlap", () => {
  const branching = {
    index: 0,
    on_outcome: {
      yes: { next_step: 1 },
      no: { next_step: 2 },
    },
  };
  const steps = [branching, step(1, null), step(2, null)];
  const { steps: pos } = computeLayout({ triggerNextStep: 0, steps });

  // same depth
  assert.equal(pos[1].y, pos[2].y);
  // different horizontal position
  assert.notEqual(pos[1].x, pos[2].x);
  // no overlap: separated by at least one X_GAP
  assert.ok(Math.abs(pos[1].x - pos[2].x) >= X_GAP, `children too close: ${pos[1].x} vs ${pos[2].x}`);
  // children sit one depth below the branching parent
  assert.equal(pos[1].y, pos[0].y + Y_GAP);
});

test("merge: two parents -> one child, single position deeper than both parents", () => {
  // trigger -> 0; 0 branches to 1 and 2; both 1 and 2 -> 3 (merge)
  const branching = {
    index: 0,
    on_outcome: { yes: { next_step: 1 }, no: { next_step: 2 } },
  };
  const steps = [branching, step(1, 3), step(2, 3), step(3, null)];
  const { steps: pos } = computeLayout({ triggerNextStep: 0, steps });

  // single position for the merge node
  assert.ok(pos[3], "merge node must have a position");
  // deeper than BOTH parents (longest-path layering)
  assert.ok(pos[3].y > pos[1].y, "merge below parent 1");
  assert.ok(pos[3].y > pos[2].y, "merge below parent 2");
  // exactly one depth below the (equal-depth) parents
  assert.equal(pos[3].y, pos[1].y + Y_GAP);
});

test("cycle / back-edge: terminates and every node gets a position", () => {
  // trigger -> 0 -> 1 -> 2, and 2 loops back to 0 (e.g. wait-for-reply retry)
  const steps = [
    step(0, 1),
    step(1, 2),
    { index: 2, on_outcome: { retry: { next_step: 0 }, done: { exit: "completed" } } },
  ];
  const { trigger, steps: pos } = computeLayout({ triggerNextStep: 0, steps });

  // did not hang, and all nodes positioned
  assert.ok(trigger);
  for (const i of [0, 1, 2]) {
    assert.ok(pos[i], `step ${i} must have a position`);
    assert.equal(typeof pos[i].x, "number");
    assert.equal(typeof pos[i].y, "number");
  }
});

test("deterministic: two calls on the same input are equal", () => {
  const build = () => [
    { index: 0, on_outcome: { a: { next_step: 1 }, b: { next_step: 2 } } },
    step(1, 3),
    step(2, 3),
    step(3, null),
  ];
  const a = computeLayout({ triggerNextStep: 0, steps: build() });
  const b = computeLayout({ triggerNextStep: 0, steps: build() });
  assert.deepEqual(a, b);
});

test("no trigger target: trigger still placed at top, steps still positioned", () => {
  const steps = [step(0, 1), step(1, null)];
  const { trigger, steps: pos } = computeLayout({ triggerNextStep: null, steps });
  // With no wired target, the trigger and the orphan root step share depth 0,
  // so the trigger sits at the top row (y = START_Y) but shares the horizontal
  // spread rather than staying dead-center.
  assert.equal(trigger.y, START_Y);
  assert.ok(pos[0] && pos[1]);
});
