"use client"
import { Activity, GitFork, Loader2, RefreshCw, Search, X } from "lucide-react"
import { Card } from "@/components/ui/card"
import { getDeliveryStatusDisplay, getJourneyStatusDisplay, getStatusPillClass } from "@/lib/statusDisplay"
import { getJourneyNodeDisplay } from "@/lib/journeyStepTypes"
import { explainActionFailure } from "@/lib/errorDisplay"

function ExecutionsTab({ executions, executionsLoading, executionsSearch, filteredExecutions, name, refreshExecutions, selectedExecution, setExecutionsSearch, setSelectedExecution }) {
  return (
          <div className="flex-1 overflow-hidden flex flex-col lg:flex-row bg-zinc-50 dark:bg-zinc-950/20">
            {/* Left Pane: Enrolled Leads List */}
            <div className="w-full lg:w-1/2 h-1/2 lg:h-full border-b lg:border-b-0 lg:border-r border-black/5 dark:border-white/10 flex flex-col bg-white/30 dark:bg-[#09090a]/40 backdrop-blur-md">
              {/* Search & Refresh bar */}
              <div className="p-4 border-b border-black/5 dark:border-white/10 flex items-center justify-between gap-3 shrink-0">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-400" />
                  <input
                    type="text"
	                    placeholder="Search current journey leads..."
                    value={executionsSearch}
                    onChange={(e) => setExecutionsSearch(e.target.value)}
                    className="pl-8 pr-3 bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 text-xs h-9 rounded-xl w-full text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/30 transition-all"
                  />
                </div>
                <button
                  type="button"
                  onClick={refreshExecutions}
                  className="p-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-white/5 text-zinc-500 hover:text-zinc-900 dark:hover:text-white border border-black/5 dark:border-white/10 transition-colors"
                  title="Refresh enrollments list"
                  aria-label="Refresh enrollments list"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${executionsLoading ? "animate-spin" : ""}`} />
                </button>
              </div>

              {/* Enrolled Leads Scroll Area */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {executionsLoading && filteredExecutions.length === 0 && (
	                  <div className="flex flex-col items-center justify-center py-12 gap-2 text-zinc-400">
	                    <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
	                    <span className="text-xs">Loading current journey leads...</span>
	                  </div>
                )}
                {!executionsLoading && filteredExecutions.length === 0 && (
                  <div className="text-center py-12">
                    <GitFork className="h-10 w-10 text-zinc-300 dark:text-zinc-700 mx-auto mb-2" />
	                    <p className="text-xs text-zinc-500 dark:text-zinc-400 italic">No current leads found for this journey.</p>
                  </div>
                )}
	                {filteredExecutions.map(e => {
	                  const isSelected = selectedExecution?.lead?.id === e.lead.id
	                  const journeyDisplay = getJourneyStatusDisplay(e.lead.journey_status, e.lead)

                  return (
                    <button
                      type="button"
                      key={e.lead.id}
                      onClick={() => {
                        setSelectedExecution(e)
                      }}
                      aria-pressed={isSelected}
                      className={`group w-full text-left border rounded-2xl p-4 transition-all duration-200 cursor-pointer flex items-center justify-between gap-3 ${
                        isSelected
                          ? "bg-blue-500/10 border-blue-500/30 text-blue-900 dark:text-blue-200"
                          : "bg-white/40 dark:bg-white/[0.01] border-black/5 dark:border-white/5 hover:border-black/10 dark:hover:border-white/10 hover:bg-white/60 dark:hover:bg-white/[0.03]"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold truncate leading-snug">
                          {e.lead.name || e.lead.email || e.lead.phone || "Unknown Lead"}
                        </div>
                        <div className="text-[10px] text-zinc-500 dark:text-gray-400 truncate mt-0.5">
                          {e.lead.email || e.lead.phone || "No contact info"}
                        </div>
                        <div className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-1.5 flex items-center gap-1.5">
	                          <span>Lead created: {new Date(e.started_at).toLocaleDateString()}</span>
                          <span>•</span>
                          <span>Last action: {new Date(e.last_action_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1.5 shrink-0">
	                        <span className={getStatusPillClass(journeyDisplay.variant)} title={journeyDisplay.title}>
	                          {journeyDisplay.label}
	                        </span>
                        <span className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
	                          Step #{(e.lead.current_step ?? 0) + 1}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Right Pane: Interactive Execution Timeline Audit Log */}
            <div className="w-full lg:w-1/2 h-1/2 lg:h-full flex flex-col bg-white/10 dark:bg-black/10">
              {selectedExecution ? (
                <div className="flex-1 flex flex-col overflow-hidden">
                  {/* Header */}
                  <div className="p-4 border-b border-black/5 dark:border-white/10 bg-white/40 dark:bg-white/[0.01] flex items-center justify-between shrink-0">
                    <div>
                      <h3 className="text-xs font-bold text-zinc-700 dark:text-gray-300 uppercase tracking-wider">
                        Lead Execution Audit
                      </h3>
                      <h4 className="text-sm font-semibold text-zinc-900 dark:text-white mt-0.5">
                        {selectedExecution.lead.name || "Unknown Lead"}
                      </h4>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedExecution(null)
                      }}
                      className="p-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-white/5 text-zinc-400 hover:text-zinc-700 dark:hover:text-white"
                      title="Clear selection"
                      aria-label="Clear selected lead"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Actions History Timeline */}
                  <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    <div className="relative border-l border-zinc-200 dark:border-white/10 pl-6 ml-3 space-y-6">
                      {/* Enrolled starting point node */}
                      <div className="relative">
                        <div className="absolute -left-[31px] top-0.5 w-4 h-4 rounded-full border border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400 flex items-center justify-center z-10 shadow-md">
                          <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                        </div>
                        <div className="text-xs font-semibold text-zinc-800 dark:text-white leading-snug">
	                          Lead record created
                        </div>
                        <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono mt-0.5">
                          {new Date(selectedExecution.started_at).toLocaleString()}
                        </div>
                      </div>

                      {/* Map through executions actions */}
	                      {selectedExecution.actions.map((act) => {
	                        const isFailed = act.status === "failed" || act.status === "failed_permanent"
	                        const isPending = act.status === "pending"
	                        const isCompleted = act.status === "completed"
	                        const deliveryDisplay = getDeliveryStatusDisplay(act.status, act)
                          const actionDisplay = getJourneyNodeDisplay(act.action_type)

                        return (
                          <div key={act.id} className="relative">
                            {/* Bullet indicator */}
                            <div className={`absolute -left-[33px] top-1 w-5 h-5 rounded-full border flex items-center justify-center z-10 shadow-md ${
                              isCompleted ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400" :
                              isFailed ? "bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400" :
                              isPending ? "bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400" :
                              "bg-zinc-950/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-zinc-500"
                            }`}>
                              <Activity className="w-3 h-3" />
                            </div>

                            {/* Details Card */}
                            <div className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 rounded-2xl p-4 space-y-2 hover:border-black/10 dark:hover:border-white/10 transition-colors">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-semibold text-zinc-900 dark:text-white capitalize">
                                  Step #{act.step_index}: {actionDisplay.label}
                                </span>
	                                <span className={getStatusPillClass(deliveryDisplay.variant)} title={deliveryDisplay.title}>
	                                  {deliveryDisplay.label}
	                                </span>
                              </div>

                              {act.template_key && (
                                <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono">
                                  Template: {act.template_key}
                                </div>
                              )}

                              <div className="text-[10px] text-zinc-500 dark:text-zinc-400 flex items-center justify-between gap-2 flex-wrap">
                                <span>Scheduled: {act.run_at ? new Date(act.run_at).toLocaleString() : "—"}</span>
                                {act.completed_at && (
                                  <span>Executed: {new Date(act.completed_at).toLocaleString()}</span>
                                )}
                              </div>

                              {act.error_message && (() => {
                                const explained = explainActionFailure(act.error_message)
                                return (
                                  <div className="p-2.5 bg-rose-500/5 border border-rose-500/15 rounded-xl leading-relaxed space-y-1.5">
                                    {explained ? (
                                      <>
                                        <div className="text-[11px] font-semibold text-rose-700 dark:text-rose-400">{explained.cause}</div>
                                        <div className="text-[10px] text-zinc-600 dark:text-zinc-300">{explained.suggestion}</div>
                                        <details className="text-[10px]">
                                          <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400 select-none hover:underline">
                                            Show raw error
                                          </summary>
                                          <div className="mt-1 font-mono text-rose-700/80 dark:text-rose-400/80 whitespace-pre-wrap break-all">
                                            {act.error_message}
                                          </div>
                                        </details>
                                      </>
                                    ) : (
                                      <div className="text-[10px] text-rose-700 dark:text-rose-400 whitespace-pre-wrap break-all">
                                        {act.error_message}
                                      </div>
                                    )}
                                  </div>
                                )
                              })()}

                              {act.result && Object.keys(act.result).length > 0 && (
                                <details className="text-[10px]">
                                  <summary className="cursor-pointer text-blue-600 dark:text-blue-400 select-none hover:underline">
                                    View raw dispatch results
                                  </summary>
                                  <pre className="mt-1.5 p-2 bg-black/20 dark:bg-black/45 border border-black/5 dark:border-white/5 text-zinc-700 dark:text-zinc-300 rounded-xl overflow-x-auto text-[10px] font-mono leading-normal">
                                    {JSON.stringify(act.result, null, 2)}
                                  </pre>
                                </details>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-zinc-400">
                  <Activity className="h-12 w-12 text-zinc-300 dark:text-zinc-700 mb-3 animate-pulse" />
                  <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-300">No Lead Selected</h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 max-w-xs">
                    Select an enrolled lead from the left list to inspect its step-by-step execution timeline audit.
                  </p>
                </div>
              )}
            </div>
          </div>
  )
}

export { ExecutionsTab }
