"use client"

import { useEffect, useState, Fragment } from "react"
import { motion } from "framer-motion"
import { AlertTriangle, AlertCircle, CheckCircle2, Loader2, RefreshCw, Filter } from "lucide-react"

import { Button } from "@/components/ui/button"
import { AppIcon } from "@/components/AppIcon"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import { getStatusPillClass } from "@/lib/statusDisplay"
import { apiFetch } from "@/utils/apiFetch"
import {
  getErrorAffectedLabel,
  getErrorIssueDisplay,
  getErrorStatusDisplay,
} from "@/lib/errorDisplay"

function fmtDate(ts) {
  if (!ts) return "---"
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

function ErrorRow({ err, onUpdateStatus, expanded, onToggle }) {
  const issue = getErrorIssueDisplay(err)
  const status = getErrorStatusDisplay(err.status)
  const affected = getErrorAffectedLabel(err)
  return (
    <>
      <TableRow
        onClick={onToggle}
        className="cursor-pointer hover:bg-zinc-100/50 dark:hover:bg-white/5"
      >
        <TableCell className="text-xs text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
          {fmtDate(err.created_at)}
        </TableCell>
        <TableCell>
          <span className={getStatusPillClass(issue.variant)} title={issue.title}>{issue.label}</span>
          {issue.rawValue && (
            <div className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-500 truncate max-w-[260px]" title={issue.rawValue}>
              Technical: {issue.rawValue}
            </div>
          )}
        </TableCell>
        <TableCell className="text-sm text-zinc-700 dark:text-zinc-300">
          {affected}
        </TableCell>
        <TableCell className="text-sm text-zinc-700 dark:text-zinc-300 max-w-md truncate">
          {err.error_message}
        </TableCell>
        <TableCell>
          <span className={getStatusPillClass(status.variant)}>{status.label}</span>
        </TableCell>
        <TableCell className="text-right">
          <div className="flex gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
            {err.status !== "resolved" && (
              <button
                onClick={() => onUpdateStatus(err.id, "resolved")}
                className="text-xs text-emerald-600 hover:text-emerald-500 px-2 py-1"
                title="Mark resolved"
              >
                Resolve
              </button>
            )}
            {err.status !== "ignored" && (
              <button
                onClick={() => onUpdateStatus(err.id, "ignored")}
                className="text-xs text-zinc-500 hover:text-zinc-400 px-2 py-1"
                title="Ignore"
              >
                Ignore
              </button>
            )}
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-zinc-100/30 dark:bg-white/5 border-b border-zinc-200 dark:border-white/10">
          <TableCell colSpan={7} className="p-4 align-top">
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <div className="font-semibold text-zinc-500 dark:text-zinc-400 mb-1">Developer details</div>
                <div className="font-semibold text-zinc-500 dark:text-zinc-400 mt-3 mb-1">Journey</div>
                <div className="font-mono text-zinc-700 dark:text-zinc-300 break-all">{err.workflow_name || "(none)"}</div>
                <div className="font-semibold text-zinc-500 dark:text-zinc-400 mt-3 mb-1">Node</div>
                <div className="font-mono text-zinc-700 dark:text-zinc-300 break-all">{err.node_name || "(none)"}</div>
                <div className="font-semibold text-zinc-500 dark:text-zinc-400 mt-3 mb-1">Tenant ID</div>
                <div className="font-mono text-zinc-700 dark:text-zinc-300 break-all">{err.tenant_id || "(none)"}</div>
                <div className="font-semibold text-zinc-500 dark:text-zinc-400 mt-3 mb-1">Execution ID</div>
                <div className="font-mono text-zinc-700 dark:text-zinc-300 break-all">{err.execution_id || "(none)"}</div>
                <div className="font-semibold text-zinc-500 dark:text-zinc-400 mt-3 mb-1">Error ID</div>
                <div className="font-mono text-zinc-700 dark:text-zinc-300 break-all">{err.id}</div>
              </div>
              <div>
                <div className="font-semibold text-zinc-500 dark:text-zinc-400 mb-1">Raw error</div>
                <pre className="bg-black/5 dark:bg-black/40 p-2 rounded text-xs overflow-auto max-h-60 text-zinc-700 dark:text-zinc-300 font-mono">
{JSON.stringify(err.raw_error, null, 2)}
                </pre>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

export default function ErrorsPage() {
  const [errors, setErrors] = useState([])
  const [groups, setGroups]   = useState([])
  const [view, setView]       = useState("grouped") // 'grouped' | 'raw'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [statusFilter, setStatusFilter] = useState("open")
  const [severityFilter, setSeverityFilter] = useState("all")
  const [expandedId, setExpandedId] = useState(null)
  const [expandedSig, setExpandedSig] = useState(null)

  const fetchErrors = async () => {
    setLoading(true)
    setError("")
    try {
      const qs = new URLSearchParams()
      if (view === "grouped") {
        qs.set("grouped", "1")
      } else {
        if (statusFilter !== "all") qs.set("status", statusFilter)
        if (severityFilter !== "all") qs.set("severity", severityFilter)
      }
      const json = await apiFetch(`/api/errors?${qs.toString()}`)
      if (view === "grouped") {
        setGroups(json.data || [])
      } else {
        setErrors(json.data || [])
      }
    } catch (err) {
      setError(err.message || "Failed to load errors")
      setErrors([]); setGroups([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchErrors()
  }, [statusFilter, severityFilter, view])

  const updateStatus = async (id, status) => {
    try {
      await apiFetch("/api/errors", { method: "PATCH", json: { id, status } })
      fetchErrors()
    } catch (err) {
      setError(err.message || "Update failed")
    }
  }

  const summaryRows = view === "grouped" ? groups : errors
  const totalShown = view === "grouped"
    ? groups.reduce((sum, g) => sum + (Number(g.count) || 0), 0)
    : errors.length
  const counts = summaryRows.reduce((acc, e) => {
    const weight = view === "grouped" ? (Number(e.count) || 0) : 1
    acc[e.severity] = (acc[e.severity] || 0) + weight
    return acc
  }, {})

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
              <AppIcon name="errors" size={32} className="text-zinc-700 dark:text-zinc-300" />
              Issues & alerts
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              Review journey, delivery, and system issues that may need attention.
            </p>
          </div>
          <Button onClick={fetchErrors} variant="outline" size="sm" disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Refresh
          </Button>
        </div>

        <div className="grid grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-zinc-500 dark:text-zinc-400" title={view === "grouped" ? "Raw occurrences represented by grouped issues shown for the last 90 days." : "Raw error rows shown with the current filters."}>
                {view === "grouped" ? "Grouped occurrences" : "Raw shown"}
              </div>
              <div className="text-2xl font-bold text-zinc-900 dark:text-white">{totalShown}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-zinc-500 dark:text-zinc-400" title={view === "grouped" ? "Critical raw occurrences represented by grouped issues shown." : "Critical raw rows shown."}>Critical</div>
              <div className="text-2xl font-bold text-red-600 dark:text-red-400">{counts.critical || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-zinc-500 dark:text-zinc-400" title={view === "grouped" ? "Error-level raw occurrences represented by grouped issues shown." : "Error-level raw rows shown."}>Errors</div>
              <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">{counts.error || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-zinc-500 dark:text-zinc-400" title={view === "grouped" ? "Warning raw occurrences represented by grouped issues shown." : "Warning raw rows shown."}>Warnings</div>
              <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{counts.warning || 0}</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                Issue log
              </CardTitle>
              <div className="flex gap-2 items-center text-sm">
                <div className="flex items-center bg-zinc-100 dark:bg-white/5 rounded-lg p-0.5 border border-zinc-200 dark:border-white/10">
                  {["grouped","raw"].map(v => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setView(v)}
                      className={`px-2.5 py-1 rounded-md text-xs capitalize ${view===v ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm" : "text-zinc-500 dark:text-zinc-400"}`}
                    >{v === "grouped" ? "Grouped" : "Raw"}</button>
                  ))}
                </div>
                {view === "raw" && (
                  <>
                    <Filter className="w-4 h-4 text-zinc-400" />
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="h-8 px-2.5 bg-zinc-100 dark:bg-surface-2 border border-zinc-200 dark:border-white/5 text-zinc-700 dark:text-zinc-300 text-xs rounded-xl outline-none focus:border-zinc-300 dark:focus:border-white/20"
                    >
                      <option value="all">All statuses</option>
                      <option value="open">Open</option>
                      <option value="investigating">Investigating</option>
                      <option value="resolved">Resolved</option>
                      <option value="ignored">Ignored</option>
                    </select>
                    <select
                      value={severityFilter}
                      onChange={(e) => setSeverityFilter(e.target.value)}
                      className="h-8 px-2.5 bg-zinc-100 dark:bg-surface-2 border border-zinc-200 dark:border-white/5 text-zinc-700 dark:text-zinc-300 text-xs rounded-xl outline-none focus:border-zinc-300 dark:focus:border-white/20"
                    >
                      <option value="all">All severities</option>
                      <option value="critical">Critical</option>
                      <option value="error">Error</option>
                      <option value="warning">Warning</option>
                    </select>
                  </>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {error && (
              <Alert variant="danger" className="m-4">{error}</Alert>
            )}
            {loading ? (
              <div className="p-8 flex items-center justify-center text-zinc-400">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : view === "grouped" ? (
              groups.length === 0 && !error ? (
                <div className="p-8 flex flex-col items-center justify-center text-center">
                  <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-2" />
                  <p className="text-zinc-500 dark:text-zinc-400 text-sm">No issues in the last 90 days.</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Issue</TableHead>
                      <TableHead className="w-20 text-center">Count</TableHead>
                      <TableHead>Affected journey/action</TableHead>
                      <TableHead>First seen</TableHead>
                      <TableHead>Last seen</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.map(g => {
                      const sigKey = `${g.workflow_name}::${g.signature}`
                      const open = expandedSig === sigKey
                      const issue = getErrorIssueDisplay(g)
                      return (
                        // Fragment needs an explicit key. Shorthand <> can't
                        // take one, so use the long form.
                        <Fragment key={sigKey}>
                          <TableRow
                            className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-white/[0.03]"
                            onClick={() => setExpandedSig(open ? null : sigKey)}
                          >
                            <TableCell>
                              <span className={getStatusPillClass(issue.variant)} title={issue.title}>{issue.label}</span>
                            </TableCell>
                            <TableCell className="text-center">
                              <Badge variant="danger" className="font-mono">{g.count}</Badge>
                            </TableCell>
                            <TableCell className="text-xs text-zinc-700 dark:text-zinc-300">{getErrorAffectedLabel(g)}</TableCell>
                            <TableCell className="text-xs text-zinc-500">{fmtDate(g.first_seen)}</TableCell>
                            <TableCell className="text-xs text-zinc-500">{fmtDate(g.last_seen)}</TableCell>
                            <TableCell>
                              <span className={getStatusPillClass(issue.variant)}>{issue.variant === "danger" ? "Needs review" : "Review"}</span>
                            </TableCell>
                          </TableRow>
                          {open && (
                            <TableRow className="bg-zinc-50 dark:bg-black/30">
                              <TableCell colSpan={6} className="p-4">
                                <div className="text-[11px] text-zinc-500 uppercase tracking-wider mb-1">Latest occurrence</div>
                                <div className="text-xs text-zinc-700 dark:text-zinc-200 mb-2 whitespace-pre-wrap break-words">
                                  {g.sample_message}
                                </div>
                                <details className="mt-2">
                                  <summary className="cursor-pointer text-[11px] text-blue-600 dark:text-blue-400">Developer details</summary>
                                  <div className="mt-2 grid gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                                    <div>Raw signature: <span className="font-mono text-zinc-700 dark:text-zinc-300">{g.signature || "(none)"}</span></div>
                                    <div>Raw journey: <span className="font-mono text-zinc-700 dark:text-zinc-300">{g.workflow_name || "(none)"}</span></div>
                                  </div>
                                </details>
                                {g.sample_raw && (
                                  <details className="mt-2">
                                    <summary className="cursor-pointer text-[11px] text-blue-600 dark:text-blue-400">Raw payload</summary>
                                    <pre className="mt-1 p-2 bg-black/30 text-zinc-200 rounded overflow-x-auto text-[10px]">{JSON.stringify(g.sample_raw, null, 2)}</pre>
                                  </details>
                                )}
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      )
                    })}
                  </TableBody>
                </Table>
              )
            ) : errors.length === 0 && !error ? (
              <div className="p-8 flex flex-col items-center justify-center text-center">
                <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-2" />
                <p className="text-zinc-500 dark:text-zinc-400 text-sm">No errors matching the current filters.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Issue</TableHead>
                    <TableHead>Affected area</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {errors.map((err) => (
                    <ErrorRow
                      key={err.id}
                      err={err}
                      expanded={expandedId === err.id}
                      onToggle={() => setExpandedId(expandedId === err.id ? null : err.id)}
                      onUpdateStatus={updateStatus}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  )
}
