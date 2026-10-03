// Pure, UI-free step insertion for the guided "+" flow.
//
// Given the current steps + trigger link, a source ("trigger" or a step index),
// the outcome being wired, and the new step type, this returns the next
// { steps, triggerNextStep } with:
//   - a brand-new step appended (fresh index + sid, registry defaults)
//   - the source wired to it, producing the EXACT same on_outcome / triggerNextStep
//     data a manual drag-to-connect would produce:
//       trigger  -> triggerNextStep = newIndex
//       step     -> on_outcome[outcomeKey] = { next_step: newIndex, next_sid }
//
// No React, DOM, or component state — safe to unit-test in isolation.

// Relative (not "@/") imports so this module is loadable both by Next's
// bundler and by the node:test runner, which does not resolve the "@/" alias.
import { STEP_TYPES, defaultOutcomesFor, templateChannelFor } from "../../../../lib/journeyStepTypes.js"
import { ensureStepSids, allocateStepIndex } from "../../../../lib/journeySpecIdentity.js"

// Build a new step of `newType` with the same defaults the toolbox palette
// uses (registry defaultDelay/defaultsExtra, a default template for the
// step's channel when one exists, and the registry's default outcome map).
export function buildNewStep({ steps, newType, templates = [] }) {
  const cfg = STEP_TYPES[newType] || {}
  const newIndex = allocateStepIndex(steps)
  const tplChannel = templateChannelFor(newType)
  const defaultTpl = tplChannel ? templates.find((t) => t.channel === tplChannel) : null
  const defaultKey = defaultTpl ? defaultTpl.template_key : undefined

  return ensureStepSids([
    {
      index: newIndex,
      type: newType,
      x: 250,
      y: 200 + steps.length * 150,
      delay: cfg.defaultDelay || { amount: 0, unit: "minutes" },
      ...(cfg.defaultsExtra || {}),
      ...(defaultKey ? { template_key: defaultKey } : {}),
      on_outcome: defaultOutcomesFor(newType),
    },
  ])[0]
}

/**
 * Insert a new step and wire the chosen source outcome to it.
 *
 * @returns {{ steps: Array, triggerNextStep: number|null }}
 */
export function insertStepAfter({
  steps,
  triggerNextStep,
  sourceNodeId,
  outcomeKey,
  newType,
  templates = [],
}) {
  const currentSteps = Array.isArray(steps) ? steps : []
  const newStep = buildNewStep({ steps: currentSteps, newType, templates })

  // Trigger source: link the trigger to the new step. outcomeKey is ignored
  // (the trigger has a single implicit "default" output).
  if (sourceNodeId === "trigger") {
    return {
      steps: [...currentSteps, newStep],
      triggerNextStep: newStep.index,
    }
  }

  // Step source: point that exact outcome at the new step, leaving every other
  // step and every other outcome untouched.
  const sourceIndex = Number(sourceNodeId)
  const nextSteps = currentSteps.map((s) => {
    if (s.index !== sourceIndex) return s
    return {
      ...s,
      on_outcome: {
        ...(s.on_outcome || {}),
        [outcomeKey]: { next_step: newStep.index, next_sid: newStep.sid },
      },
    }
  })

  return {
    steps: [...nextSteps, newStep],
    triggerNextStep,
  }
}
