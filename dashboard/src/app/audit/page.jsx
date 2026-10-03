"use client"

import { useEffect, useState, useMemo, Fragment } from "react"
import { motion } from "framer-motion"
import { History, Loader2, Search, ChevronRight, RefreshCw } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Alert } from "@/components/ui/alert"
import { AppIcon } from "@/components/AppIcon"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { apiFetch } from "@/utils/apiFetch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const OP_STYLES = {
  INSERT: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  UPDATE: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  DELETE: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
}

function fmt(ts) {
  if (!ts) return "—"
  try { return new Date(ts).toLocaleString() } catch { return ts }
}

function DiffPanel({ before, after, changedKeys }) {
  // Show only changed keys for UPDATE; full payload otherwise.
  if (before && after && Array.isArray(changedKeys) && changedKeys.length > 0) {
    return (
      <div className="space-y-1.5">
        {changedKeys.map(k => (
          <div key={k} className="grid grid-cols-[140px_1fr_1fr] gap-2 items-start text-[11px]">
            <div className="font-mono text-zinc-500 truncate">{k}</div>
            <div className="bg-rose-500/10 text-rose-700 dark:text-rose-300 px-2 py-1 rounded font-mono whitespace-pre-wrap break-words">
              {before[k] === undefined ? "—" : JSON.stringify(before[k])}
            </div>
            <div className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-2 py-1 rounded font-mono whitespace-pre-wrap break-words">
              {after[k] === undefined ? "—" : JSON.stringify(after[k])}
            </div>
          </div>
        ))}
      </div>
    )
  }
  const payload = after || before
  return (
    <pre className="p-2 bg-black/40 text-zinc-200 rounded-lg overflow-x-auto text-[10px] font-mono">
      {JSON.stringify(payload, null, 2)}
    </pre>
  )
}

export default function AuditPage() {
  const [rows, setRows] = useState([])
  const [tables, setTables] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [actor, setActor] = useState("")
  const [table, setTable] = useState("")
  const [op, setOp] = useState("")
  const [days, setDays] = useState(30)
  const [expanded, setExpanded] = useState(null)

  const fetchRows = async () => {
    setLoading(true)
    setError("")
    try {
      const qs = new URLSearchParams()
      if (actor) qs.set("actor", actor)
      if (table) qs.set("table", table)
      if (op)    qs.set("op", op)
      qs.set("days", days)
      const json = await apiFetch(`/api/audit?${qs.toString()}`)
      setRows(json.data?.rows || [])
      setTables(json.data?.tables || [])
    } catch (err) {
      setError(err.message || "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchRows() }, [actor, table, op, days])

  const totalsByOp = useMemo(() => rows.reduce((acc, r) => {
    acc[r.op] = (acc[r.op] || 0) + 1
    return acc
  }, {}), [rows])

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
              <AppIcon name="audit" size={28} /> Audit log
            </h1>
            <p className="text-sm text-zinc-500 dark:text-gray-400 mt-1">
              Every mutation on critical tables, scoped to your tenant.
            </p>
          </div>
          <Button onClick={fetchRows} variant="outline" size="sm" disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Refresh
          </Button>
        </div>

        {/* Filter bar */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-4 mb-4">
          <div className="md:col-span-2 relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-400" />
            <Input
              placeholder="Actor email contains…"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              className="pl-9 h-9 rounded-xl bg-white dark:bg-white/[0.02] border-black/10 dark:border-white/5"
            />
          </div>
          <select
            value={table}
            onChange={(e) => setTable(e.target.value)}
            className="h-9 px-3 bg-white dark:bg-white/[0.02] border border-black/10 dark:border-white/5 rounded-xl text-sm text-zinc-900 dark:text-white"
          >
            <option value="">All tables</option>
            {tables.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select
            value={op}
            onChange={(e) => setOp(e.target.value)}
            className="h-9 px-3 bg-white dark:bg-white/[0.02] border border-black/10 dark:border-white/5 rounded-xl text-sm text-zinc-900 dark:text-white"
          >
            <option value="">All operations</option>
            <option value="INSERT">Insert</option>
            <option value="UPDATE">Update</option>
            <option value="DELETE">Delete</option>
          </select>
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value))}
            className="h-9 px-3 bg-white dark:bg-white/[0.02] border border-black/10 dark:border-white/5 rounded-xl text-sm text-zinc-900 dark:text-white"
          >
            <option value={1}>Last 24h</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
          </select>
        </div>

        {/* Totals */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <Card><CardContent className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Showing</div>
            <div className="text-2xl font-bold mt-1 text-zinc-900 dark:text-white">{rows.length}</div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Inserts</div>
            <div className="text-2xl font-bold mt-1 text-emerald-600 dark:text-emerald-400">{totalsByOp.INSERT || 0}</div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Updates</div>
            <div className="text-2xl font-bold mt-1 text-blue-600 dark:text-blue-400">{totalsByOp.UPDATE || 0}</div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Deletes</div>
            <div className="text-2xl font-bold mt-1 text-rose-600 dark:text-rose-400">{totalsByOp.DELETE || 0}</div>
          </CardContent></Card>
        </div>

        <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl overflow-hidden">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <History className="w-4 h-4 text-zinc-400" /> Recent mutations
            </CardTitle>
            <CardDescription className="text-xs">Click a row to see the field-level diff.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {error && (
              <Alert variant="danger" className="m-4">{error}</Alert>
            )}
            {loading ? (
              <div className="p-12 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-zinc-400" /></div>
            ) : rows.length === 0 ? (
              <div className="p-12 text-center text-sm text-zinc-400">No audit entries match your filters.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-44">When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Table</TableHead>
                    <TableHead className="w-28">Op</TableHead>
                    <TableHead>Row</TableHead>
                    <TableHead>Changed keys</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(r => {
                    const open = expanded === r.id
                    return (
                      <Fragment key={r.id}>
                        <TableRow
                          className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-white/[0.03]"
                          onClick={() => setExpanded(open ? null : r.id)}
                        >
                          <TableCell className="text-xs text-zinc-700 dark:text-zinc-300 font-mono">{fmt(r.at)}</TableCell>
                          <TableCell className="text-xs">{r.actor_email || <span className="text-zinc-400 italic">system</span>}</TableCell>
                          <TableCell className="text-xs font-mono">{r.table_name}</TableCell>
                          <TableCell>
                            <span className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${OP_STYLES[r.op] || "bg-zinc-500/10"}`}>{r.op}</span>
                          </TableCell>
                          <TableCell className="text-[10px] font-mono text-zinc-500 truncate max-w-[180px]">{r.row_id}</TableCell>
                          <TableCell className="text-[11px] text-zinc-600 dark:text-zinc-300">
                            {(r.changed_keys || []).slice(0, 5).join(", ") || (r.op === "INSERT" ? "—" : "")}
                            {(r.changed_keys || []).length > 5 && (
                              <span className="text-zinc-400 ml-1">+{r.changed_keys.length - 5}</span>
                            )}
                          </TableCell>
                        </TableRow>
                        {open && (
                          <TableRow className="bg-zinc-50 dark:bg-black/30">
                            <TableCell colSpan={6} className="p-4">
                              <DiffPanel before={r.before} after={r.after} changedKeys={r.changed_keys} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  )
}
