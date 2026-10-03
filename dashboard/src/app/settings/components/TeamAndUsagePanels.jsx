"use client"

// Usage + Team panels for the Settings page. Extracted verbatim from
// settings/page.jsx — both are self-contained (own fetches + local state).

import { useEffect, useState } from "react"
import { Loader2, Plus, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import CustomSelect from "@/components/ui/custom-select"
import { useConfirm } from "@/components/ui/confirm-dialog"

// ---------------------------------------------------------------
// Usage + estimated cost panel.
// Pulls /api/usage which recomputes from events on every call.
// ---------------------------------------------------------------
function UsagePanel() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState(30)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/usage?days=${days}`)
      .then(r => r.json())
      .then(j => { if (!cancelled) setData(j.data || null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days])

  const fmtCents = (c) => `$${(Math.max(0, c) / 100).toFixed(2)}`
  const totals = data?.totals || { sms: {}, call: {}, email: {} }
  const grandCents = (totals.sms.est_cost_cents || 0)
                   + (totals.call.est_cost_cents || 0)
                   + (totals.email.est_cost_cents || 0)

  return (
    <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-lg text-zinc-900 dark:text-white">Estimated channel cost</CardTitle>
            <CardDescription className="text-zinc-500 dark:text-gray-400 mt-1">
              Outbound volume + estimated provider spend. Rates configurable per tenant in <span className="font-mono">config.rates</span>.
            </CardDescription>
          </div>
          <CustomSelect
            value={days}
            onChange={(val) => setDays(parseInt(val))}
            options={[
              { value: 7, label: "Last 7 days" },
              { value: 30, label: "Last 30 days" },
              { value: 90, label: "Last 90 days" }
            ]}
            triggerClassName="h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between"
          />
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="py-6 flex items-center justify-center text-zinc-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <UsageTile label="Total est." value={fmtCents(grandCents)} accent="emerald" />
              <UsageTile label="SMS"  count={totals.sms.msg_count}   units={`${Math.round(totals.sms.units)} seg`}  cost={fmtCents(totals.sms.est_cost_cents)}  accent="emerald" />
              <UsageTile label="Call" count={totals.call.msg_count}  units={`${totals.call.units?.toFixed(1) || 0} min`} cost={fmtCents(totals.call.est_cost_cents)} accent="blue" />
              <UsageTile label="Email" count={totals.email.msg_count} units={`${Math.round(totals.email.units)} msg`} cost={fmtCents(totals.email.est_cost_cents)} accent="purple" />
            </div>

            {data?.daily?.length > 0 && (
              <div className="border border-black/5 dark:border-white/5 rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-zinc-950/[0.03] dark:bg-white/[0.03]">
                    <tr className="text-zinc-500 dark:text-zinc-400 uppercase text-[10px]">
                      <th className="text-left px-3 py-2 font-semibold">Day</th>
                      <th className="text-right px-3 py-2 font-semibold">SMS</th>
                      <th className="text-right px-3 py-2 font-semibold">Call</th>
                      <th className="text-right px-3 py-2 font-semibold">Email</th>
                      <th className="text-right px-3 py-2 font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/5 dark:divide-white/5">
                    {data.daily.slice(-30).reverse().map(d => (
                      <tr key={d.day} className="hover:bg-zinc-950/[0.02] dark:hover:bg-white/[0.02]">
                        <td className="px-3 py-1.5 font-mono text-zinc-700 dark:text-zinc-300">{d.day}</td>
                        <td className="px-3 py-1.5 text-right text-emerald-700 dark:text-emerald-400">{fmtCents(d.sms || 0)}</td>
                        <td className="px-3 py-1.5 text-right text-blue-700 dark:text-blue-400">{fmtCents(d.call || 0)}</td>
                        <td className="px-3 py-1.5 text-right text-purple-700 dark:text-purple-400">{fmtCents(d.email || 0)}</td>
                        <td className="px-3 py-1.5 text-right font-semibold text-zinc-900 dark:text-white">{fmtCents(d.total_cents || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {(!data?.daily || data.daily.length === 0) && (
              <p className="text-xs text-zinc-400 italic">No outbound events in this window yet.</p>
            )}

            <p className="text-[10px] text-zinc-500">
              SMS cost is estimated at 1 segment per 160 chars. Call cost = Twilio voice + Retell per-minute combined. Edit per-tenant rates in <span className="font-mono">tenants.config.rates</span>.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function UsageTile({ label, value, count, units, cost, accent = "zinc" }) {
  const colors = {
    emerald: "text-emerald-600 dark:text-emerald-400",
    blue:    "text-blue-600 dark:text-blue-400",
    purple:  "text-purple-600 dark:text-purple-400",
    zinc:    "text-zinc-700 dark:text-zinc-200",
  }
  const c = colors[accent] || colors.zinc
  return (
    <div className="p-3 rounded-xl border border-black/5 dark:border-white/5 bg-zinc-950/[0.02] dark:bg-white/[0.03]">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      {value ? (
        <div className={`text-2xl font-bold mt-1 ${c}`}>{value}</div>
      ) : (
        <>
          <div className={`text-lg font-bold mt-1 ${c}`}>{cost}</div>
          <div className="text-[10px] text-zinc-500 mt-0.5">{count} msgs · {units}</div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------
// Members + pending invites panel. Lives in settings because that's where
// owners go to manage the workspace. Mutations are operator-only.
// ---------------------------------------------------------------
function MembersPanel() {
  const confirm = useConfirm()
  const [members, setMembers] = useState([])
  const [invites, setInvites] = useState([])
  const [loading, setLoading] = useState(true)
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("client_viewer")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const load = async () => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/members")
      const json = await res.json()
      if (!res.ok) { setError(json.error || "Failed to load"); return }
      setMembers(json.data?.members || [])
      setInvites(json.data?.invites || [])
    } catch (err) {
      setError(err.message || "Failed to load")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const sendInvite = async (e) => {
    e?.preventDefault?.()
    setError("")
    const clean = inviteEmail.trim().toLowerCase()
    if (!clean) { setError("Email required"); return }
    setSaving(true)
    try {
      const res = await fetch("/api/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: clean, role: inviteRole }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error || "Invite failed"); return }
      setInviteEmail("")
      setShowInvite(false)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const revokeInvite = async (id) => {
    if (!(await confirm({
      title: "Revoke this invite?",
      message: "The pending invitation will no longer be usable.",
      confirmLabel: "Revoke invite",
      destructive: true,
    }))) return
    await fetch(`/api/members?inviteId=${id}`, { method: "DELETE" })
    load()
  }
  const removeMember = async (id, email) => {
    if (!(await confirm({
      title: "Remove member?",
      message: `${email || "This member"} will lose access to the workspace.`,
      confirmLabel: "Remove member",
      destructive: true,
    }))) return
    await fetch(`/api/members?memberId=${id}`, { method: "DELETE" })
    load()
  }

  const roleLabel = (r) => ({
    owner: "Owner", admin: "Admin", member: "Member", client_viewer: "Client viewer",
  }[r] || r)
  const roleVariant = (r) => ({
    owner: "warning",
    admin: "success",
    member: "info",
    client_viewer: "ai",
  }[r] || "neutral")

  return (
    <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg text-zinc-900 dark:text-white">Members &amp; client access</CardTitle>
            <CardDescription className="text-zinc-500 dark:text-gray-400 mt-1">
              Operators run the workspace. Client viewers get read-only access to the dashboard and leads.
            </CardDescription>
          </div>
          <Button
            onClick={() => { setShowInvite(true); setError("") }}
            className="bg-zinc-950/10 dark:bg-white/10 hover:bg-zinc-950/15 dark:hover:bg-white/15 text-zinc-800 dark:text-white border border-black/10 dark:border-white/10 rounded-xl px-3 py-2 text-xs font-medium flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" /> Invite
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="py-6 flex items-center justify-center text-zinc-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : error ? (
          <Alert variant="danger" size="sm">{error}</Alert>
        ) : (
          <div className="space-y-3">
            {/* Members */}
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Active members ({members.length})</div>
              {members.length === 0 ? (
                <div className="text-xs text-zinc-400 italic">No members yet.</div>
              ) : (
                <ul className="divide-y divide-black/5 dark:divide-white/5 border border-black/5 dark:border-white/5 rounded-xl overflow-hidden">
                  {members.map(m => (
                    <li key={m.id} className="px-3 py-2 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-zinc-800 dark:text-white truncate">{m.email || <span className="text-zinc-400">unknown email</span>}</div>
                        <div className="text-[10px] text-zinc-400">Joined {m.created_at ? new Date(m.created_at).toLocaleDateString() : "?"}</div>
                      </div>
                      <Badge variant={roleVariant(m.role)} className="uppercase tracking-wider">{roleLabel(m.role)}</Badge>
                      {m.role !== "owner" && (
                        <button
                          onClick={() => removeMember(m.id, m.email)}
                          className="p-1.5 rounded-md hover:bg-rose-500/10 text-zinc-400 hover:text-rose-600"
                          title="Remove member"
                          aria-label="Remove member"
                        ><Trash2 className="w-3.5 h-3.5" /></button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Pending invites */}
            {invites.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Pending invites ({invites.length})</div>
                <ul className="divide-y divide-black/5 dark:divide-white/5 border border-amber-500/20 bg-amber-500/[0.04] rounded-xl overflow-hidden">
                  {invites.map(i => (
                    <li key={i.id} className="px-3 py-2 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-zinc-800 dark:text-white truncate">{i.email}</div>
                        <div className="text-[10px] text-zinc-400">Invited {i.created_at ? new Date(i.created_at).toLocaleDateString() : "?"} — claims on first magic-link sign-in</div>
                      </div>
                      <Badge variant={roleVariant(i.role)} className="uppercase tracking-wider">{roleLabel(i.role)}</Badge>
                      <button
                        onClick={() => revokeInvite(i.id)}
                        className="p-1.5 rounded-md hover:bg-rose-500/10 text-zinc-400 hover:text-rose-600"
                        title="Revoke invite"
                        aria-label="Revoke invite"
                      ><Trash2 className="w-3.5 h-3.5" /></button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Invite modal */}
        {showInvite && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
            <div className="absolute inset-0" onClick={() => !saving && setShowInvite(false)} />
            <div className="relative w-full max-w-md bg-white dark:bg-surface-1 border border-black/10 dark:border-white/10 rounded-2xl p-6 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-zinc-900 dark:text-white">Invite to workspace</h3>
                <button
                  type="button"
                  onClick={() => setShowInvite(false)}
                  disabled={saving}
                  className="rounded-lg p-1.5 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-65 dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-white focus-visible:ring-3 focus-visible:ring-ring/60"
                  aria-label="Close invite dialog"
                  title="Close invite dialog"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={sendInvite} className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-zinc-500">Email</Label>
                  <Input
                    type="email"
                    autoFocus
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="someone@example.com"
                    className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-zinc-500">Role</Label>
                  <CustomSelect
                    value={inviteRole}
                    onChange={(val) => setInviteRole(val)}
                    options={[
                      { value: "client_viewer", label: "Client viewer — read-only dashboard + leads" },
                      { value: "member", label: "Member — operate the workspace" },
                      { value: "admin", label: "Admin — manage everything" },
                      { value: "owner", label: "Owner — full control + destructive ops" }
                    ]}
                    triggerClassName="w-full h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between"
                  />
                </div>
                {error && (
                  <Alert variant="danger" size="sm">{error}</Alert>
                )}
                <div className="pt-2 flex justify-end gap-2">
                  <Button type="button" onClick={() => setShowInvite(false)} disabled={saving} className="bg-transparent border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-200 rounded-xl">Cancel</Button>
                  <Button type="submit" disabled={saving} variant="default">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                    Send invite
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export { UsagePanel, MembersPanel }
