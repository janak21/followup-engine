import assert from "node:assert/strict";
import { test } from "node:test";

import { insertStepAfter, buildNewStep } from "../src/app/journeys/builder/lib/insertStep.js";

// A call step has multiple outcomes (answered / no_answer / ...); a fresh one's
// outcomes are all terminal { exit } until wired.
const callStep = (index, sid) => ({
  index,
  sid,
  type: "call",
  x: 250,
  y: 200,
  on_outcome: {
    answered: { exit: "completed" },
    no_answer: { exit: "completed" },
  },
});

test("buildNewStep: fresh index, sid, and registry default outcomes", () => {
  const steps = [callStep(0, "aaaa0000")];
  const s = buildNewStep({ steps, newType: "sms" });
  assert.equal(s.index, 1); // max(0)+1
  assert.ok(s.sid && s.sid !== "aaaa0000", "gets a fresh sid");
  assert.equal(s.type, "sms");
  // sms registry outcomes are sent/failed/opt_out, all terminal by default
  assert.ok(s.on_outcome.sent && s.on_outcome.sent.exit, "default outcomes are terminal");
});

test("insert from trigger: links trigger, appends step, no outcome touched", () => {
  const steps = [callStep(0, "aaaa0000")];
  const before = JSON.parse(JSON.stringify(steps));
  const { steps: next, triggerNextStep } = insertStepAfter({
    steps,
    triggerNextStep: null,
    sourceNodeId: "trigger",
    outcomeKey: "default",
    newType: "sms",
  });

  const added = next[next.length - 1];
  assert.equal(triggerNextStep, added.index, "trigger now points at the new step");
  assert.equal(next.length, 2);
  // pre-existing step is byte-for-byte unchanged
  assert.deepEqual(next[0], before[0]);
});

test("insert from a step outcome: wires exactly that outcome to the new step", () => {
  const steps = [callStep(0, "aaaa0000")];
  const { steps: next, triggerNextStep } = insertStepAfter({
    steps,
    triggerNextStep: 0,
    sourceNodeId: "0",
    outcomeKey: "no_answer",
    newType: "sms",
  });

  const added = next[next.length - 1];
  const source = next.find((s) => s.index === 0);

  // the wired outcome points at the new step with { next_step, next_sid }
  assert.deepEqual(source.on_outcome.no_answer, {
    next_step: added.index,
    next_sid: added.sid,
  });
  // the OTHER outcome is untouched (still terminal)
  assert.deepEqual(source.on_outcome.answered, { exit: "completed" });
  // trigger link is untouched
  assert.equal(triggerNextStep, 0);
  // new step exists and is appended
  assert.equal(added.type, "sms");
  assert.equal(next.length, 2);
});

test("insert does not mutate the input steps array or its members", () => {
  const steps = [callStep(0, "aaaa0000")];
  const snapshot = JSON.parse(JSON.stringify(steps));
  insertStepAfter({
    steps,
    triggerNextStep: 0,
    sourceNodeId: "0",
    outcomeKey: "answered",
    newType: "wait",
  });
  assert.deepEqual(steps, snapshot, "input array/members are not mutated");
});

test("new index is allocated above the current max, not by array length", () => {
  // indices 0 and 5 (gap) -> next should be 6
  const steps = [callStep(0, "aaaa0000"), callStep(5, "bbbb1111")];
  const { steps: next } = insertStepAfter({
    steps,
    triggerNextStep: 0,
    sourceNodeId: "5",
    outcomeKey: "no_answer",
    newType: "email",
  });
  const added = next[next.length - 1];
  assert.equal(added.index, 6);
  assert.equal(next.find((s) => s.index === 5).on_outcome.no_answer.next_step, 6);
});
