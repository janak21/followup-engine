"use client"

import { useEffect, useMemo, useState } from "react"
import { motion } from "framer-motion"
import { Plus, Trash2, Loader2, RefreshCw, Search, Upload, X, AlertCircle, Check, Info } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Alert } from "@/components/ui/alert"
import { AppIcon } from "@/components/AppIcon"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getCachedData, setCachedData } from "@/utils/apiCache"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { getStatusPillClass } from "@/lib/statusDisplay"
import { apiFetch } from "@/utils/apiFetch"
import {
  getSuppressionChannelClass,
  getSuppressionChannelDisplay,
  getSuppressionReasonDisplay,
  getSuppressionSourceDisplay,
  groupSuppressions,
} from "@/lib/suppressionDisplay"

function fmtDate(ts) {
  if (!ts) return "—"
  try { return new Date(ts).toLocaleString() } catch { return ts }
}

// Parse a pasted CSV (or one-per-line) string. Auto-detects email vs phone by
// regex so the operator doesn't have to set the channel per row.
function parseBulkInput(raw) {
  const out = []
  for (const line of String(raw || "").split(/[\r\n]+/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    // Accept either bare values OR "email,reason" / "phone,reason" CSV pairs.
    const [ident, reason] = trimmed.split(",").map(s => (s || "").trim())
    if (!ident) continue
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ident)
    const isPhone = /^\+?\d[\d\s\-().]{6,}$/.test(ident)
    if (!isEmail && !isPhone) {
      out.push({ identifier: ident, channel: null, reason: reason || "manual", _warn: "unrecognized format" })
    } else {
      out.push({
        identifier: ident,
        channel: isEmail ? "email" : "sms",
        reason: reason || "manual",
      })
    }
  }
  return out
}

export default function SuppressionsPage() {
  const confirm = useConfirm()
  const [rows, setRows] = useState(() => getCachedData("suppressions_rows") || [])
  const [channels, setChannels] = useState(() => getCachedData("suppressions_channels") || [])
  const [reasons, setReasons] = useState(() => getCachedData("suppressions_reasons") || [])
  const [channelFilter, setChannelFilter] = useState("")
  const [reasonFilter, setReasonFilter] = useState("")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(() => !getCachedData("suppressions_rows"))
  const [error, setError] = useState("")

  const [showAdd, setShowAdd] = useState(false)
  const [bulkText, setBulkText] = useState("")
  const [bulkReason, setBulkReason] = useState("manual")
  const [bulkChannel, setBulkChannel] = useState("auto")
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkResult, setBulkResult] = useState(null)

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    try {
      const qs = new URLSearchParams()
      if (channelFilter) qs.set("channel", channelFilter)
      if (reasonFilter)  qs.set("reason",  reasonFilter)
      if (search)        qs.set("q",       search)
      const json = await apiFetch(`/api/suppressions?${qs.toString()}`)
      setRows(json.data?.rows || [])
      setChannels(json.data?.channels || [])
      setReasons(json.data?.reasons || [])
      setCachedData("suppressions_rows", json.data?.rows || [])
      setCachedData("suppressions_channels", json.data?.channels || [])
      setCachedData("suppressions_reasons", json.data?.reasons || [])
    } catch (err) {
      setError(err.message || "Failed to load")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    const hasCache = !!getCachedData("suppressions_rows")
    load(hasCache)
  }, [channelFilter, reasonFilter])

  const handleSearch = (e) => {
    e?.preventDefault?.()
    load()
  }

  const removeOne = async (id) => {
    if (!(await confirm({
      title: "Remove this suppression?",
      message: "Removing it may allow future outbound messages to this contact.",
      confirmLabel: "Remove suppression",
      destructive: true,
    }))) return
    try {
      await apiFetch(`/api/suppressions?id=${id}`, { method: "DELETE" })
    } catch (err) {
      setError(err.message || "Failed to remove suppression")
      return
    }
    load()
  }

  const parsed = parseBulkInput(bulkText)
  const groupedRows = useMemo(() => groupSuppressions(rows), [rows])
  const summary = useMemo(() => {
    const email = rows.filter((row) => row.channel === "email" || row.email).length
    const phone = rows.filter((row) => ["sms", "call", "phone"].includes(row.channel) || row.phone_e164).length
    const hardBounced = rows.filter((row) => ["bounce_hard", "hard_bounce"].includes(row.reason)).length
    const optedOut = rows.filter((row) => ["unsubscribe", "opt_out", "opted_out"].includes(row.reason)).length
    return { total: rows.length, grouped: groupedRows.length, email, phone, hardBounced, optedOut }
  }, [rows, groupedRows])
  const submitBulk = async () => {
    setBulkSaving(true)
    setBulkResult(null)
    try {
      const entries = parsed.map(p => ({
        identifier: p.identifier,
        channel: bulkChannel === "auto" ? p.channel : bulkChannel,
        reason: bulkReason,
      }))
      let json
      try {
        json = await apiFetch("/api/suppressions", { json: { entries } })
      } catch (err) {
        setBulkResult({ error: err.message })
        return
      }
      setBulkResult(json?.data || {})
      await load()
    } finally {
      setBulkSaving(false)
    }
  }

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
              <AppIcon name="suppressions" size={28} /> Suppressions
            </h1>
            <p className="text-sm text-zinc-500 dark:text-gray-400 mt-1">
              Contacts on this list will not receive outbound emails, SMS, or calls.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={load} variant="outline" size="sm" disabled={loading} className="rounded-xl">
              {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              Refresh
            </Button>
            <Button onClick={() => { setShowAdd(true); setBulkResult(null); setBulkText("") }}
                    className="bg-zinc-950 dark:bg-white text-white dark:text-zinc-900 rounded-xl">
              <Plus className="w-4 h-4 mr-1.5" /> Add suppressions
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          {[
            { label: "Total suppressed", value: summary.total, hint: `${summary.grouped} unique contact/channel rows shown` },
            { label: "Email", value: summary.email, hint: "Loaded rows with email suppression" },
            { label: "Phone / SMS / call", value: summary.phone, hint: "Loaded rows with phone suppression" },
            { label: "Hard bounced", value: summary.hardBounced, hint: "Loaded rows marked as hard bounce" },
            { label: "Unsubscribed / opted out", value: summary.optedOut, hint: "Loaded rows marked as unsubscribe or opt-out" },
          ].map((card) => (
            <div key={card.label} className="rounded-2xl border border-black/5 dark:border-white/5 bg-white/40 dark:bg-white/[0.02] p-4">
              <div className="text-2xl font-bold text-zinc-900 dark:text-white">{card.value}</div>
              <div className="text-xs font-semibold text-zinc-700 dark:text-gray-300 mt-1">{card.label}</div>
              <div className="text-[10px] text-zinc-500 dark:text-gray-500 mt-0.5">{card.hint}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-4 mb-4">
          <form onSubmit={handleSearch} className="md:col-span-2 relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-400" />
            <Input
              placeholder="Search email / phone / notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9 rounded-xl bg-white dark:bg-white/[0.02] border-black/10 dark:border-white/5"
            />
          </form>
          <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}
                  className="h-9 px-3 bg-white dark:bg-white/[0.02] border border-black/10 dark:border-white/5 rounded-xl text-sm text-zinc-900 dark:text-white">
            <option value="">All channels</option>
            {channels.map(c => <option key={c} value={c}>{getSuppressionChannelDisplay(c).label}</option>)}
          </select>
          <select value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)}
                  className="h-9 px-3 bg-white dark:bg-white/[0.02] border border-black/10 dark:border-white/5 rounded-xl text-sm text-zinc-900 dark:text-white">
            <option value="">All reasons</option>
	            {reasons.map(r => <option key={r} value={r}>{getSuppressionReasonDisplay(r).label}</option>)}
          </select>
        </div>

        {/* Table */}
        <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl overflow-hidden">
          <CardContent className="p-0">
            {error && (
              <Alert variant="danger" className="m-4">{error}</Alert>
            )}
            {loading && rows.length === 0 ? (
              <div className="p-12 flex items-center justify-center text-zinc-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : rows.length === 0 ? (
              <div className="p-12 text-center text-sm text-zinc-400">No suppressed contacts. Outbound messages are not currently blocked by suppressions.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contact</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Why suppressed</TableHead>
                    <TableHead>Added by</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead className="text-right">Remove</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groupedRows.map(group => {
                    const r = group.latest
                    const reason = getSuppressionReasonDisplay(r.reason || "unknown")
                    const source = getSuppressionSourceDisplay(r.source || "unknown")
                    const channel = getSuppressionChannelDisplay(group.channel)
                    return (
                      <TableRow key={group.key} className="hover:bg-zinc-50 dark:hover:bg-white/[0.03] align-top">
                        <TableCell className="font-mono text-xs">
                          <div>{group.identifier}</div>
                          {group.count > 1 && (
                            <div className="text-[10px] text-zinc-500 dark:text-gray-500 mt-1">{group.count} events</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${getSuppressionChannelClass(group.channel)}`}>{channel.label}</span>
                        </TableCell>
                        <TableCell className="text-xs">
                          <span className={getStatusPillClass(reason.variant)} title={reason.title}>
                            {reason.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-[11px] text-zinc-500">
                          <span title={source.title}>{source.label}</span>
                        </TableCell>
                        <TableCell className="text-[11px] text-zinc-500 font-mono">{fmtDate(r.created_at)}</TableCell>
                        <TableCell className="text-[11px] text-zinc-500 max-w-[340px]">
                          <div className="truncate">{r.notes || "—"}</div>
                          {group.count > 1 && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-900 dark:hover:text-white">View all events</summary>
                              <div className="mt-2 space-y-1">
                                {group.events.map((event) => {
                                  const eventReason = getSuppressionReasonDisplay(event.reason || "unknown")
                                  const eventSource = getSuppressionSourceDisplay(event.source || "unknown")
                                  return (
                                    <div key={event.id} className="rounded-lg border border-black/5 dark:border-white/5 bg-zinc-950/5 dark:bg-black/20 px-2 py-1.5 flex items-start justify-between gap-2">
                                      <div>
                                        <div className="text-[10px] text-zinc-700 dark:text-gray-300">{eventReason.label} · {eventSource.label}</div>
                                        <div className="text-[10px] text-zinc-400">{fmtDate(event.created_at)}{event.notes ? ` · ${event.notes}` : ""}</div>
                                      </div>
                                      <button onClick={() => removeOne(event.id)} className="p-1 rounded-md hover:bg-rose-500/10 text-zinc-400 hover:text-rose-600" title="Remove this suppression event"
 aria-label="Remove this suppression event">
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    </div>
                                  )
                                })}
                              </div>
                            </details>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <button onClick={() => removeOne(r.id)} className="p-1.5 rounded-md hover:bg-rose-500/10 text-zinc-400 hover:text-rose-600" title={group.count > 1 ? "Remove latest suppression event" : "Remove suppression"}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Bulk add modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="absolute inset-0" onClick={() => !bulkSaving && setShowAdd(false)} />
          <div className="relative w-full max-w-2xl bg-white dark:bg-surface-1 border border-black/10 dark:border-white/10 rounded-2xl shadow-2xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
                <Upload className="w-5 h-5" /> Bulk add suppressions
              </h2>
              <button onClick={() => setShowAdd(false)} disabled={bulkSaving} className="p-1 text-zinc-400 hover:text-zinc-900 dark:hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="text-xs text-zinc-500 flex items-start gap-2 bg-blue-500/[0.04] border border-blue-500/20 rounded-xl p-2.5">
                <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-blue-500" />
                <span>Paste one email or phone per line. Optional <span className="font-mono">{`identifier,reason`}</span> per line still works for existing reason keys. Channel is auto-detected from the format.</span>
              </div>

              <div>
                <Label className="text-xs">Entries</Label>
                <textarea
                  rows={8}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={"someone@example.com\n+15551234567,unsubscribe\n+447700900000,bounce"}
                  className="w-full mt-1 p-3 text-xs font-mono bg-white dark:bg-surface-3 border border-black/10 dark:border-white/5 rounded-xl outline-none text-zinc-900 dark:text-white"
                />
                {parsed.length > 0 && (
                  <div className="text-[10px] text-zinc-500 mt-1">{parsed.length} entries — {parsed.filter(p => p._warn).length} flagged as unrecognized</div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Default reason</Label>
                  <select value={bulkReason} onChange={(e) => setBulkReason(e.target.value)}
                          className="w-full mt-1 h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white">
                    {["manual", "unsubscribe", "opt_out", "bounce_hard", "complaint", "invalid_phone", "do_not_contact"].map(reason => (
                      <option key={reason} value={reason}>{getSuppressionReasonDisplay(reason).label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs">Force channel</Label>
                  <select value={bulkChannel} onChange={(e) => setBulkChannel(e.target.value)}
                          className="w-full mt-1 h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white">
                    <option value="auto">Auto (detect per row)</option>
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="call">Call</option>
                  </select>
                </div>
              </div>

              {bulkResult && (
                <Alert variant={bulkResult.error ? "danger" : "success"} size="sm">
                  {bulkResult.error
                    ? bulkResult.error
                    : `${bulkResult.added} added, ${bulkResult.skipped} skipped${bulkResult.errors?.length ? `, ${bulkResult.errors.length} errors` : ""}.`}
                </Alert>
              )}

              <div className="pt-2 flex justify-end gap-2">
                <Button type="button" onClick={() => setShowAdd(false)} disabled={bulkSaving}
                        className="bg-transparent border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-200 rounded-xl">
                  Cancel
                </Button>
                <Button type="button" onClick={submitBulk} disabled={bulkSaving || parsed.length === 0}
                        variant="default">
                  {bulkSaving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Upload className="w-3.5 h-3.5 mr-1.5" />}
                  Add {parsed.length || ""} suppressions
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
