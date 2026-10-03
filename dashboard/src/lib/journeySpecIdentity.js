// Stable step identity for journey specs.
// sid: assigned once, never derived from position — the runtime resolves
// on_outcome edges by sid first (advance_journey, Phase 5), so deleting or
// reordering steps can no longer re-point in-flight leads.

function randomSid(taken) {
  let sid;
  do {
    sid = Array.from({ length: 8 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  } while (taken.has(sid));
  return sid;
}

export function ensureStepSids(steps = []) {
  const taken = new Set(steps.map((s) => s?.sid).filter(Boolean));
  return steps.map((step) => {
    if (step?.sid) return step;
    const sid = randomSid(taken);
    taken.add(sid);
    return { ...step, sid };
  });
}

export function allocateStepIndex(steps = []) {
  if (!steps.length) return 0;
  return Math.max(...steps.map((s) => Number(s?.index) || 0)) + 1;
}

export function stepBySid(steps = [], sid) {
  if (!sid) return null;
  return steps.find((s) => s?.sid === sid) || null;
}