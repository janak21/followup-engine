"use client"

// Operations dashboard.
//
// Single-page view of what the system is doing right now: stuck actions,
// recent failures, AI activity, cron job health, recent edge function
// responses. Built to replace the "ask Claude to query the DB" loop.
//
// Polls every 10s while the tab is visible. Operator-only — read view is
// pure summary; writes are scoped to "reset to pending" / "cancel" / "flush
// dispatcher now" on selected rows.

import { useEffect, useMemo, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  AlertTriangle, RefreshCw, Loader2, Clock, Bot, X,
  Sparkles, CheckCircle2, Cpu, Zap, AlertCircle, Play, Square, ShieldAlert,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { AppIcon } from "@/components/AppIcon"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useIsOperator } from "@/components/RoleProvider"
import { useToast } from "@/components/ui/toast"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import { getStatusPillClass } from "@/lib/statusDisplay"
import { explainActionFailure } from "@/lib/errorDisplay"
import { apiFetch } from "@/utils/apiFetch"
import {
  getAiDecisionDisplay,
  getAiIntentLabel,
  getOperationActionDisplay,
  getOperationStatusDisplay,
} from "@/lib/operationDisplay"

function fmtRelative(iso) {
  if (!iso) return "—"
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.round(ms / 1000)
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.round(s/60)}m ago`
  if (s < 86400) return `${Math.round(s/3600)}h ago`
  return `${Math.round(s/86400)}d ago`
}
function dollars(n) {
  if (!n) return "$0.0000"
  return `$${Number(n).toFixed(4)}`
}

export default function OperationsPage() {
  const isOperator = useIsOperator()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [autoRefresh, setAutoRefresh] = useState(true)
  const { pushToast } = useToast()
  const confirm = useConfirm()

  const fetchAll = async (silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    try {
      const j = await apiFetch("/api/operations")
      setData(j.data)
    } catch (err) {
      setError(err.message || "Load failed")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { fetchAll() }, [])

  // 10s polling while autoRefresh is on + tab visible.
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return
      fetchAll(true)
    }, 10_000)
    return () => clearInterval(id)
  }, [autoRefresh])

  const doOp = async (op, action_ids) => {
    try {
      const j = await apiFetch("/api/operations", { json: { op, action_ids } })
      pushToast("success", op === "flush_dispatcher" ? "Queued follow-up processing started" : `${j.count || action_ids?.length || 0} action(s) updated`)
      fetchAll(true)
    } catch (err) {
      pushToast("error", err.message || "Op failed")
    }
  }

  const pipelineTiles = useMemo(() => {
    const p = data?.pipeline || {}
    const sumBy = (statuses) => Object.entries(p)
      .filter(([k]) => statuses.includes(k.split("__")[1]))
      .reduce((s, [, v]) => s + v, 0)
    return {
      pending:     sumBy(["pending"]),
      in_progress: sumBy(["in_progress"]),
      failed:      sumBy(["failed", "failed_permanent"]),
      completed:   sumBy(["completed"]),
    }
  }, [data])

  return (
    <div className="space-y-6 pb-10">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
            <AppIcon name="operations" size={32} className="text-violet-500" />
            System health
          </h1>
          <p className="text-sm text-zinc-500 dark:text-gray-400 mt-1">
            Monitor processing queues, AI replies, and follow-up delivery health. {data?.generated_at && <span className="opacity-60">Refreshed {fmtRelative(data.generated_at)}.</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
              autoRefresh
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                : "bg-zinc-100 dark:bg-white/5 text-zinc-500 dark:text-gray-400 border-black/5 dark:border-white/10"
            }`}
            title="Toggle 10-second auto-refresh"
          >
            {autoRefresh ? <Play className="w-3 h-3" /> : <Square className="w-3 h-3" />}
            Auto-refresh
          </button>
          <Button onClick={() => fetchAll()} className="bg-zinc-900 dark:bg-white text-white dark:text-black rounded-xl text-xs h-9 px-3 inline-flex items-center gap-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          {isOperator && (
            <Button
              onClick={async () => {
                if (await confirm({
                  title: "Run queue now?",
                  message: "This manually runs queued follow-up processing. Use only if you understand the impact.",
                  confirmLabel: "Run queue",
                })) {
                  doOp("flush_dispatcher", [])
                }
              }}
              className="bg-zinc-100 hover:bg-zinc-200 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-300 border border-black/10 dark:border-white/10 rounded-xl text-xs h-9 px-3 inline-flex items-center gap-1.5"
              title="Developer action: manually run queued follow-up processing"
            >
              <Zap className="w-3.5 h-3.5" /> Run queue now
            </Button>
          )}
        </div>
      </div>

      {error && (
        <Alert variant="danger">{error}</Alert>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
        </div>
      ) : data && (
        <>
          {/* AI status banner — surfaces gotchas */}
          <AIStatusBanner s={data.ai_status} />

          {/* Pipeline tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Queued follow-ups" value={pipelineTiles.pending} sub="Pending actions created in the last 7 days." tone="amber" icon={Clock} />
            <Tile label="Processing now" value={pipelineTiles.in_progress} sub="Actions currently in progress from the last 7 days." tone="blue" icon={Cpu} />
            <Tile label="Failed follow-ups" value={pipelineTiles.failed} sub="Failed or permanently failed actions from the last 7 days." tone="rose" icon={AlertTriangle} />
            <Tile label="AI replies / 24h" value={data.ai_24h?.replied || 0} sub={`${data.ai_24h?.escalated || 0} sent to human review · ${dollars(data.ai_24h?.cost_usd || 0)} · latest 50 events`} tone="violet" icon={Sparkles} />
          </div>

          {/* Stuck actions */}
          <Section
            title="Stuck actions"
            subtitle="Follow-up actions that have been processing longer than expected. Review or retry them if they are blocking leads."
            count={data.stuck.length}
            empty="No stuck actions. Processing queue is clear."
          >
            {data.stuck.length > 0 && (
              <ActionTable
                rows={data.stuck}
                showLock
                renderActions={(row) => (
                  <Button size="sm" onClick={() => doOp("reset_pending", [row.id])}
                    className="bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-700 dark:text-gray-300 rounded-lg text-[10px] h-7 px-2">
                    Reset
                  </Button>
                )}
              />
            )}
            {data.stuck.length > 1 && isOperator && (
              <div className="px-6 py-3 border-t border-black/5 dark:border-white/5 flex justify-end">
                <Button onClick={() => doOp("reset_pending", data.stuck.map((r) => r.id))}
                  className="bg-amber-500/15 hover:bg-amber-500/25 text-amber-700 dark:text-amber-300 border border-amber-500/30 rounded-lg text-[11px] h-8 px-3 inline-flex items-center gap-1.5">
                  Reset all stuck ({data.stuck.length})
                </Button>
              </div>
            )}
          </Section>

          {/* Recent failures */}
          <Section
            title="Recent failures (24h)"
            count={data.recent_failures.length}
            empty="No failed actions in the last 24 hours."
            subtitle="Follow-up actions that failed or were cancelled in the last 24 hours."
          >
            {data.recent_failures.length > 0 && (
              <ActionTable
                rows={data.recent_failures}
                renderActions={(row) => row.status !== "cancelled" && (
                  <Button size="sm" onClick={() => doOp("reset_pending", [row.id])}
                    className="bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-700 dark:text-gray-300 rounded-lg text-[10px] h-7 px-2">
                    Retry
                  </Button>
                )}
              />
            )}
          </Section>

          {/* AI activity */}
          <Section
            title="AI activity (24h)"
            count={data.ai_24h.recent.length}
            empty="No AI decisions in the last 24h."
            subtitle={`AI replied ${data.ai_24h.replied} · Sent to human review ${data.ai_24h.escalated} · Failed ${data.ai_24h.failed} · Cost ${dollars(data.ai_24h.cost_usd)}`}
          >
            {data.ai_24h.recent.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow className="border-black/5 dark:border-white/5">
                    <TableHead className="px-6 text-[10px] uppercase tracking-wider text-zinc-500">When</TableHead>
                    <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">Outcome</TableHead>
                    <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">Lead reply type</TableHead>
                    <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">Confidence</TableHead>
                    <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.ai_24h.recent.map((e) => {
                    const decision = getAiDecisionDisplay(e)
                    return (
                      <TableRow key={e.id} className="border-black/5 dark:border-white/5">
                        <TableCell className="px-6 text-[11px] text-zinc-500 dark:text-gray-400">{fmtRelative(e.created_at)}</TableCell>
                        <TableCell>
                          <span className={getStatusPillClass(decision.variant, "uppercase")}>
                            {decision.label}
                          </span>
                          {decision.reason && (
                            <div className="text-[10px] text-zinc-500 dark:text-gray-400 mt-1 max-w-[260px] truncate" title={e.escalation_reason}>
                              {decision.reason}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-[11px] text-zinc-700 dark:text-zinc-300">{e.intent ? getAiIntentLabel(e.intent) : "—"}</TableCell>
                        <TableCell className="text-[11px] text-zinc-500 dark:text-gray-400">{e.confidence !== null ? `${Math.round(e.confidence * 100)}%` : "—"}</TableCell>
                        <TableCell className="text-[11px] text-zinc-500 dark:text-gray-400">{dollars(e.cost_estimate_usd)}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </Section>

          <details className="rounded-2xl border border-black/5 dark:border-white/5 bg-white/30 dark:bg-white/[0.02]">
            <summary className="cursor-pointer px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">
              Developer details
              <span className="ml-2 text-[11px] font-normal text-zinc-500 dark:text-gray-400">
                Scheduled jobs and edge function responses for technical review.
              </span>
            </summary>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 px-4 pb-4">
              <Section title="Scheduled jobs" count={data.cron.length} empty="No scheduled jobs visible.">
                {data.cron.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-black/5 dark:border-white/5">
                        <TableHead className="px-6 text-[10px] uppercase tracking-wider text-zinc-500">Job</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">Schedule</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">Last status</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">Last run</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.cron.map((c) => (
                        <TableRow key={c.jobid} className="border-black/5 dark:border-white/5">
                          <TableCell className="px-6 text-[11px] font-mono">{c.jobname}{!c.active && <span className="ml-2 text-rose-500 text-[10px]">paused</span>}</TableCell>
                          <TableCell className="text-[11px] font-mono text-zinc-500 dark:text-gray-400">{c.schedule}</TableCell>
                          <TableCell>
                            <Badge variant={c.last_status === "succeeded" ? "success" : "danger"} size="sm">
                              {c.last_status || "—"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-[11px] text-zinc-500 dark:text-gray-400">{fmtRelative(c.last_start)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Section>

              <Section title="Edge function calls (1h)" count={data.pg_net_recent.length} empty="No edge function calls in the last hour.">
                {data.pg_net_recent.length > 0 && (
                  <ul className="divide-y divide-black/5 dark:divide-white/5 max-h-[420px] overflow-y-auto">
                    {data.pg_net_recent.map((r) => (
                      <li key={r.id} className="px-6 py-2.5 flex items-start gap-3 text-[11px]">
                        <Badge variant={r.is_error ? "danger" : "success"} size="sm" className="font-mono">
                          {r.status_code ?? "—"}
                        </Badge>
                        <div className="flex-1 min-w-0">
                          <div className="text-zinc-500 dark:text-gray-400 truncate" title={r.content_preview}>{r.content_preview}</div>
                          <div className="text-[10px] text-zinc-400">{fmtRelative(r.created)}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </details>
        </>
      )}
    </div>
  )
}

// =====================================================================

function Tile({ label, value, sub, tone, icon: Icon }) {
  const toneClass = {
    amber:  "bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-300",
    blue:   "bg-blue-500/10 border-blue-500/20 text-blue-700 dark:text-blue-300",
    rose:   "bg-rose-500/10 border-rose-500/20 text-rose-700 dark:text-rose-300",
    violet: "bg-violet-500/10 border-violet-500/20 text-violet-700 dark:text-violet-300",
  }[tone]
  return (
    <Card className={`${toneClass} border rounded-2xl`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider opacity-80 font-semibold">{label}</span>
          {Icon && <Icon className="w-4 h-4 opacity-60" />}
        </div>
        <div className="text-3xl font-bold mt-1">{value}</div>
        {sub && <div className="text-[10px] opacity-70 mt-1">{sub}</div>}
      </CardContent>
    </Card>
  )
}

function AIStatusBanner({ s }) {
  if (!s) return null
  const issues = []
  if (!s.replies_enabled) issues.push("AI replies are turned off. Leads will not receive automatic AI replies.")
  if (!s.default_agent)   issues.push("No default AI agent is selected. Journeys without their own agent will not auto-reply.")
  if (s.default_agent && !s.default_agent.enabled) issues.push(`Default agent "${s.default_agent.name}" is disabled.`)
  if (s.default_agent && !s.provider_creds_ok)     issues.push(`Default agent needs active ${s.default_agent.provider} credentials before it can reply.`)
  const ok = issues.length === 0 && s.default_agent
  return (
    <Card className={ok
      ? "bg-emerald-500/5 border-emerald-500/30 border rounded-2xl"
      : "bg-amber-500/5 border-amber-500/30 border rounded-2xl"}>
      <CardContent className="p-4 flex items-start gap-3">
        {ok ? <Bot className="w-5 h-5 text-emerald-500" /> : <ShieldAlert className="w-5 h-5 text-amber-500" />}
        <div className="flex-1">
          <div className="text-sm font-semibold text-zinc-900 dark:text-white">
            AI replies — {ok ? "Healthy" : "Needs attention"}
          </div>
          {ok ? (
            <div className="text-[11px] text-zinc-500 dark:text-gray-400 mt-0.5">
              AI replies are enabled and healthy. Default agent: <span className="font-medium">{s.default_agent.name}</span>.
            </div>
          ) : (
            <ul className="text-[11px] text-zinc-600 dark:text-gray-400 mt-1 list-disc list-inside space-y-0.5">
              {issues.map((i) => <li key={i}>{i}</li>)}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function Section({ title, subtitle, count, empty, children }) {
  return (
    <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
      <CardHeader className="px-6 py-4">
        <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white flex items-center gap-2">
          {title}
          {count !== undefined && (
            <span className="text-[10px] font-normal text-zinc-500 dark:text-gray-400 normal-case bg-zinc-100 dark:bg-white/5 px-1.5 py-0.5 rounded">
              {count}
            </span>
          )}
        </CardTitle>
        {subtitle && <CardDescription className="text-[11px] text-zinc-500 dark:text-gray-400">{subtitle}</CardDescription>}
      </CardHeader>
      <CardContent className="p-0">
        {count === 0 ? (
          <div className="text-center py-8 text-xs text-zinc-400 dark:text-gray-500">{empty}</div>
        ) : children}
      </CardContent>
    </Card>
  )
}

function ActionTable({ rows, showLock, renderActions }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-black/5 dark:border-white/5">
          <TableHead className="px-6 text-[10px] uppercase tracking-wider text-zinc-500">Follow-up</TableHead>
          <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">Status</TableHead>
          <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">Reason / error</TableHead>
          <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">Lead</TableHead>
          {showLock && <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">Processing hold</TableHead>}
          <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500 text-right pr-6">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const action = getOperationActionDisplay(row.action_type)
          const status = getOperationStatusDisplay(row.status, row)
          return (
          <TableRow key={row.id} className="border-black/5 dark:border-white/5">
            <TableCell className="px-6 text-[11px] text-zinc-700 dark:text-zinc-300">
              {action.label}
              {action.rawValue && <div className="text-[10px] text-zinc-400 dark:text-gray-500 font-mono mt-0.5">Type: {action.rawValue}</div>}
            </TableCell>
            <TableCell>
              <span className={getStatusPillClass(status.variant, "uppercase")} title={status.title}>{status.label}</span>
              {row.retry_count > 0 && <span className="text-[10px] text-zinc-500 ml-1">×{row.retry_count}</span>}
            </TableCell>
            <TableCell className="text-[11px] text-zinc-500 dark:text-gray-400 max-w-[420px]">
              {(() => {
                if (!row.error_message) return "—"
                const explained = explainActionFailure(row.error_message)
                if (!explained) return <span className="block truncate" title={row.error_message}>{row.error_message}</span>
                return (
                  <span className="block truncate" title={`${explained.suggestion}\n\nRaw: ${row.error_message}`}>
                    {explained.cause}
                  </span>
                )
              })()}
            </TableCell>
            <TableCell className="text-[10px] text-zinc-500 dark:text-gray-400 font-mono">
              {row.lead_id ? <code className="text-[10px]">{row.lead_id.slice(0,8)}</code> : "—"}
            </TableCell>
            {showLock && (
              <TableCell className="text-[10px] text-zinc-500 dark:text-gray-400">
                {fmtRelative(row.locked_until)}
                {row.locked_by && <div className="text-zinc-400 font-mono" title="Worker handling this action">{row.locked_by}</div>}
              </TableCell>
            )}
            <TableCell className="text-right pr-6">
              {renderActions?.(row)}
            </TableCell>
          </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
