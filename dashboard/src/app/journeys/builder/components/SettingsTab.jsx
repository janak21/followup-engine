"use client"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import CustomSelect from "@/components/ui/custom-select"
import { getJourneyNodeDisplay } from "@/lib/journeyStepTypes"

function SettingsTab({ aiAgentId, aiAgentsList, goals, journeyId, journeyKey, name, setAiAgentId, setGoals, setHasUnsavedChanges, setJourneyKey, setName, setStopOnReply, steps, stopOnReply }) {
  return (
          <div className="flex-1 overflow-y-auto p-8 max-w-2xl mx-auto space-y-6">
            <Card className="border border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20 backdrop-blur-md rounded-2xl shadow-xl">
              <CardHeader>
                <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white">Journey Settings</CardTitle>
                <CardDescription>Configure naming and metadata properties for this follow-up spec.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="s-name">Journey Name</Label>
                  <Input 
                    id="s-name" 
                    value={name} 
                    onChange={(e) => setName(e.target.value)}
                    className="bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-xl"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="s-key">Unique Key</Label>
                  <Input
                    id="s-key"
                    value={journeyKey}
                    disabled={!!journeyId}
                    onChange={(e) => setJourneyKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                    className="bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-xl font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="s-stop-on-reply">When the lead replies</Label>
                  <CustomSelect
                    value={stopOnReply}
                    onChange={(val) => { setStopOnReply(val); setHasUnsavedChanges(true) }}
                    options={[
                      { value: "stop", label: "Stop this journey (recommended)" },
                      { value: "continue", label: "Keep going" },
                    ]}
                    triggerClassName="w-full h-10 px-3 bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl text-xs focus:outline-none text-zinc-900 dark:text-white flex items-center justify-between"
                  />
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    "Keep going" lets this journey keep sending after a reply (useful for reactivation chains). Other journeys on the same lead are unaffected; opt-out and suppression still stop all sends.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="border border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20 backdrop-blur-md rounded-2xl shadow-xl">
              <CardHeader>
                <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white flex items-center gap-2">
                  Reply Goal
                </CardTitle>
                <CardDescription>
                  Decide what happens to this journey when the lead replies.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {(() => {
                  const repliedGoal = goals.find(goal => goal?.event === "replied") || null
                  const enabled = Boolean(repliedGoal)
                  const goalAction = repliedGoal?.action || "exit"
                  const stepOptions = steps
                    .filter(step => step.type !== "exit_flow")
                    .map(step => {
                      const display = getJourneyNodeDisplay(step.type)
                      return {
                        value: String(step.index),
                        label: `Step ${step.index}: ${step.label || step.action_name || display.label}`,
                      }
                    })
                  const updateRepliedGoal = (patch) => {
                    const base = repliedGoal || { id: "goal_1", event: "replied", action: "exit" }
                    const nextGoal = { ...base, ...patch }
                    setGoals([
                      ...goals.filter(goal => goal?.event !== "replied"),
                      nextGoal,
                    ])
                    setHasUnsavedChanges(true)
                  }
                  const disableGoal = () => {
                    setGoals(goals.filter(goal => goal?.event !== "replied"))
                    setHasUnsavedChanges(true)
                  }

                  return (
                    <>
                      <label className="flex items-center justify-between gap-4 rounded-xl border border-black/10 dark:border-white/10 bg-zinc-50 dark:bg-black/30 px-3 py-2">
                        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">When lead replies</span>
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(e) => e.target.checked ? updateRepliedGoal({ action: "exit" }) : disableGoal()}
                          className="h-4 w-4 accent-zinc-900 dark:accent-white"
                        />
                      </label>

                      {enabled && (
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-zinc-500 uppercase">Action</Label>
                            <CustomSelect
                              value={goalAction}
                              onChange={(val) => updateRepliedGoal({ action: val, ...(val === "exit" ? { goto_step: undefined } : {}) })}
                              options={[
                                { value: "exit", label: "End this journey as replied" },
                                { value: "goto", label: "Go to a specific step" },
                              ]}
                              triggerClassName="w-full h-10 px-3 bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl text-xs focus:outline-none text-zinc-900 dark:text-white flex items-center justify-between"
                            />
                          </div>

                          {goalAction === "goto" && (
                            <div className="space-y-1.5">
                              <Label className="text-xs font-semibold text-zinc-500 uppercase">Target step</Label>
                              <CustomSelect
                                value={repliedGoal.goto_step !== undefined && repliedGoal.goto_step !== null ? String(repliedGoal.goto_step) : ""}
                                onChange={(val) => updateRepliedGoal(val === "" ? { goto_step: undefined } : { goto_step: Number(val) })}
                                options={[
                                  { value: "", label: "-- Choose step --" },
                                  ...stepOptions,
                                ]}
                                triggerClassName="w-full h-10 px-3 bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl text-xs focus:outline-none text-zinc-900 dark:text-white flex items-center justify-between"
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )
                })()}
              </CardContent>
            </Card>

            {/* AI Reply Agent — per-journey override.
                When set, this specific agent will handle any inbound reply
                from a lead in this journey. When null, the tenant default
                agent fires (Settings → AI Agents). Use different agents
                per use case: Speed-to-Lead vs Reactivation vs Cold Follow-up. */}
            <Card className="border border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20 backdrop-blur-md rounded-2xl shadow-xl">
              <CardHeader>
                <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white flex items-center gap-2">
                  AI Reply Agent
                </CardTitle>
                <CardDescription>
                  Which AI agent handles inbound replies for leads in this journey. Overrides the tenant default. Emails and SMS both use it.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="s-ai-agent">Agent</Label>
                  <select
                    id="s-ai-agent"
                    value={aiAgentId || ""}
                    onChange={(e) => setAiAgentId(e.target.value || null)}
                    className="w-full h-10 bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white text-sm rounded-xl px-3 outline-none focus:border-black/20 dark:focus:border-white/20"
                  >
                    <option value="">Use tenant default</option>
                    {aiAgentsList.map((a) => (
                      <option key={a.id} value={a.id} disabled={!a.enabled}>
                        {a.name} {!a.enabled ? "(disabled)" : ""} — {a.provider}/{a.model}
                      </option>
                    ))}
                  </select>
                  {aiAgentsList.length === 0 && (
                    <p className="text-[11px] text-zinc-500 dark:text-gray-400">
                      No agents configured yet. Create one at <code className="font-mono bg-zinc-100 dark:bg-white/5 px-1 rounded">Settings → AI Agents</code>.
                    </p>
                  )}
                  {aiAgentId && !aiAgentsList.find((a) => a.id === aiAgentId)?.enabled && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">
                      This agent is currently disabled — AI replies for this journey will fall back to the tenant default.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
  )
}

export { SettingsTab }
