"use client"

// AI Agents (Phase 1 — data + UI only; LLM wiring lands in Phase 2).
//
// Two views in one file:
//   * List view  — table of agents for this tenant + tenant kill switch
//                  + per-row enable toggle + "+ New Agent" → Edit view
//   * Edit view  — tabbed editor (Identity, Behavior, Knowledge, Escalation)
//                  Save mutates the agent; KB items have their own CRUD
//                  endpoint and are saved inline.
//
// State machine: editingAgentId === null  → list view
//                editingAgentId === 'new' → edit view, create mode
//                editingAgentId === <id>  → edit view, update mode
//
// Why tabs vs one big form: the surface is heavy (prompt textarea is
// large, KB list grows). Tabs keep each section focused and let the
// operator save without scrolling past everything.

import { useEffect, useState } from "react"
import { getCachedData, setCachedData } from "@/utils/apiCache"
import { useRouter } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import {
  Bot, Sparkles, Brain, BookOpen, ShieldAlert,
  Plus, Edit2, Trash2, X, Check, Loader2, ArrowLeft,
  ToggleLeft, ToggleRight, AlertCircle, CheckCircle2, Info, Save,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { AppIcon } from "@/components/AppIcon"
import { HugeiconsIcon } from "@hugeicons/react"
import { Robot01Icon } from "@hugeicons/core-free-icons"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useIsOperator } from "@/components/RoleProvider"
import { useToast } from "@/components/ui/toast"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { Alert } from "@/components/ui/alert"
import { apiFetch } from "@/utils/apiFetch"
import {
  AI_AGENT_ESCALATION_EXAMPLES,
  AI_AGENT_INTENT_OPTIONS,
  getAiAgentIntentDisplay,
} from "@/lib/aiAgentDisplay"

// Model presets — quick picks for the dropdown. Operator can also paste
// any model ID (e.g. a newer release) in the freeform field below.
// Final model validity is enforced by the provider at call time.
const MODEL_PRESETS = {
  anthropic: [
    { v: "claude-haiku-4-5",         label: "Claude Haiku 4.5 (fast, cheap — best for replies)" },
    { v: "claude-sonnet-4-6",        label: "Claude Sonnet 4.6 (balanced)" },
    { v: "claude-opus-4-8",          label: "Claude Opus 4.8 (highest quality, slowest, $$)" },
    { v: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (stable, well-tested fallback)" },
    { v: "claude-3-5-haiku-20241022",  label: "Claude 3.5 Haiku (stable, cheapest fallback)" },
  ],
  openai: [
    { v: "gpt-4o-mini",        label: "GPT-4o mini (fast, cheap — best for replies)" },
    { v: "gpt-4o",             label: "GPT-4o (balanced)" },
    { v: "gpt-4.1",            label: "GPT-4.1 (highest quality)" },
    { v: "gpt-4.1-mini",       label: "GPT-4.1 mini (small, fast)" },
    { v: "o1-mini",            label: "o1-mini (reasoning, slow)" },
    { v: "o1",                 label: "o1 (reasoning, slow, $$)" },
    { v: "gpt-3.5-turbo",      label: "GPT-3.5 Turbo (legacy, very cheap fallback)" },
  ],
  openrouter: [
    // Model IDs verified against openrouter.ai/models in July 2026. Paste any
    // slug in the freeform box below to use models not listed here.
    //
    // ── FREE (rate-limited, testing only) ──
    { v: "stepfun/step-3.5-flash:free",                        label: "StepFun Step 3.5 Flash — FREE (256K ctx, MoE)" },
    { v: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", label: "Nvidia Nemotron 3 Nano Omni — FREE (reasoning)" },
    { v: "nvidia/nemotron-3-nano-30b-a3b:free",                label: "Nvidia Nemotron 3 Nano 30B — FREE" },
    { v: "meta-llama/llama-3.3-70b-instruct:free",             label: "Llama 3.3 70B — FREE (fallback)" },
    // ── Cheap paid (production-viable) ──
    { v: "nvidia/nemotron-3-super-120b-a12b",                  label: "Nvidia Nemotron 3 Super — $0.09/$0.40 per 1M" },
    { v: "deepseek/deepseek-v4-flash",                         label: "DeepSeek V4 Flash — $0.10/$0.20 per 1M (cheapest DeepSeek)" },
    { v: "minimax/minimax-m2.5",                               label: "MiniMax M2.5 — $0.12/$0.48 per 1M (205K ctx)" },
    { v: "stepfun/step-3.7-flash",                             label: "StepFun Step 3.7 Flash — $0.20/$1.15 (reasoning, 256K)" },
    { v: "moonshotai/kimi-k2.5",                               label: "Kimi K2.5 — $0.38/$2.03 (262K ctx, multimodal)" },
    { v: "moonshotai/kimi-k2.6",                               label: "Kimi K2.6 — $0.55/$3.20 (long-horizon coding)" },
    { v: "z-ai/glm-4.6",                                       label: "Z.ai GLM 4.6 — 200K ctx (Claude Code-tier)" },
    { v: "minimax/minimax-m3",                                 label: "MiniMax M3 — $0.30/$1.20 (1M ctx, multimodal)" },
    // ── Premium (routing through OpenRouter) ──
    { v: "deepseek/deepseek-v4-pro",                           label: "DeepSeek V4 Pro — $0.44/$0.87 per 1M" },
    { v: "anthropic/claude-3.5-sonnet",                        label: "Claude 3.5 Sonnet — via OpenRouter" },
    { v: "openai/gpt-4o-mini",                                 label: "GPT-4o mini — via OpenRouter" },
  ],
}

const DEFAULT_SYSTEM_PROMPT = `You are a polite, concise sales reply agent. Your goal is to keep the conversation moving toward a meeting while staying truthful.

Hard rules:
- Never invent pricing, dates, product capabilities, or personal details about the recipient.
- If you cannot answer truthfully from the knowledge below, escalate to a human (set intent="complex").
- Keep replies under 80 words. Plain text. No emojis.
- Match the tone of the previous outbound email.
- Always end with a single forward-looking next step (a question, a meeting suggestion, or a clarification request).`

// Tiny toast
export default function AIAgentsPage() {
  const router = useRouter()
  const isOperator = useIsOperator()
  const { pushToast } = useToast()
  const confirm = useConfirm()

  const [agents, setAgents] = useState(() => getCachedData("ai_agents_list") || [])
  const [tenant, setTenant] = useState(() => getCachedData("settings_tenant"))
  const [loading, setLoading] = useState(() => !getCachedData("ai_agents_list"))
  const [error, setError] = useState("")

  const [editingAgentId, setEditingAgentId] = useState(null) // null | 'new' | uuid

  // Templates modal — the "Use a template" flow. Preview cards → pick →
  // POST /api/ai-agents/from-template → transitions into the newly-created
  // agent's edit view so the operator can immediately tune name, prompt, KB.
  const [showTemplatesModal, setShowTemplatesModal] = useState(false)
  const [templates, setTemplates] = useState([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [expandedTemplateId, setExpandedTemplateId] = useState(null)
  const [creatingFromTemplateId, setCreatingFromTemplateId] = useState(null)

  const openTemplatesModal = async () => {
    setShowTemplatesModal(true)
    setExpandedTemplateId(null)
    if (templates.length === 0) {
      setTemplatesLoading(true)
      try {
        const j = await apiFetch("/api/ai-agents/from-template")
        setTemplates(Array.isArray(j?.data) ? j.data : [])
      } catch (err) {
        pushToast("error", `Failed to load templates: ${err.message}`)
      } finally {
        setTemplatesLoading(false)
      }
    }
  }
  const handleCreateFromTemplate = async (templateId) => {
    setCreatingFromTemplateId(templateId)
    try {
      const j = await apiFetch("/api/ai-agents/from-template", {
        json: { template_id: templateId },
      })
      pushToast(
        "success",
        `Created "${j.data.agent.name}" · ${j.data.knowledge_created} knowledge item(s) seeded`
      )
      setShowTemplatesModal(false)
      // Land the operator on the new agent's edit view so they can tune it.
      await refetch()
      setEditingAgentId(j.data.agent.id)
    } catch (err) {
      pushToast("error", err.message || "Create failed")
    } finally {
      setCreatingFromTemplateId(null)
    }
  }

  const refetch = async (silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    try {
      const [agentsRes, tenantRes] = await Promise.all([
        fetch("/api/ai-agents"),
        fetch("/api/tenant"),
      ])
      const agentsJson = await agentsRes.json()
      const tenantJson = await tenantRes.json()
      if (!agentsRes.ok) throw new Error(agentsJson.error || "Failed to load agents")
      if (!tenantRes.ok) throw new Error(tenantJson.error || "Failed to load tenant")
      setAgents(agentsJson.data || [])
      setTenant(tenantJson.data || null)
      setCachedData("ai_agents_list", agentsJson.data || [])
      setCachedData("settings_tenant", tenantJson.data || null)
    } catch (err) {
      setError(err.message || "Load failed")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    const hasCache = !!getCachedData("ai_agents_list")
    refetch(hasCache)
  }, [])

  const toggleAIReplies = async (next) => {
    if (!tenant?.id) return
    try {
      const j = await apiFetch("/api/tenant", {
        method: "PUT", json: { id: tenant.id, ai_replies_enabled: next },
      })
      setTenant(j.data)
      pushToast("success", next ? "AI Replies enabled tenant-wide" : "AI Replies disabled tenant-wide")
    } catch (err) {
      pushToast("error", err.message || "Update failed")
    }
  }

  const toggleAgentEnabled = async (agent, next) => {
    try {
      const j = await apiFetch("/api/ai-agents", {
        method: "PUT", json: { id: agent.id, enabled: next },
      })
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? j.data : a)))
    } catch (err) {
      pushToast("error", err.message || "Update failed")
    }
  }

  const deleteAgent = async (agent) => {
    if (!(await confirm({
      title: `Delete agent "${agent.name}"?`,
      message: "This cannot be undone. Any journey referencing it will fall back to the tenant default.",
      confirmLabel: "Delete agent",
      destructive: true,
    }))) return
    try {
      await apiFetch(`/api/ai-agents?id=${agent.id}`, { method: "DELETE" })
      setAgents((prev) => prev.filter((a) => a.id !== agent.id))
      pushToast("success", "Agent deleted")
    } catch (err) {
      pushToast("error", err.message || "Delete failed")
    }
  }

  // ----- Edit view -----
  if (editingAgentId !== null) {
    return (
      <AgentEditor
        agentId={editingAgentId}
        initialAgent={editingAgentId === "new" ? null : agents.find((a) => a.id === editingAgentId)}
        onBack={() => { setEditingAgentId(null); refetch() }}
        // After successful create, stay in the editor but transition to
        // edit mode for the newly created agent. This unlocks Knowledge +
        // Playground without forcing the operator to close and re-open.
        onCreated={async (newAgent) => {
          await refetch()
          setEditingAgentId(newAgent.id)
        }}
        pushToast={pushToast}
      />
    )
  }

  // ----- List view -----
  return (
    <div className="space-y-8 pb-10">

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
            <AppIcon name="aiAgents" size={32} className="text-violet-500" />
            AI Agents
          </h1>
          <p className="text-sm text-zinc-500 dark:text-gray-400 mt-1">
            Configure the agents that auto-reply to inbound emails. Create one per use case; assign to a journey or set as tenant default.
          </p>
        </div>
        {isOperator && (
          <div className="flex items-center gap-2 flex-wrap">
            {/* Ready-to-use templates. Speed-to-Lead / Cold Follow-up /
                Reactivation. Opens a modal → preview → creates agent + KB
                in one click via POST /api/ai-agents/from-template. */}
            <Button
              onClick={openTemplatesModal}
              className="bg-violet-500/15 hover:bg-violet-500/25 text-violet-700 dark:text-violet-300 border border-violet-500/30 rounded-xl text-sm h-10 px-4 inline-flex items-center gap-2"
              title="Start from a ready-to-use template — Speed-to-Lead, Cold Follow-up, or Reactivation"
            >
              <Sparkles className="w-4 h-4" /> Use a template
            </Button>
            <Button
              onClick={() => setEditingAgentId("new")}
              className="bg-zinc-900 dark:bg-white hover:bg-zinc-800 dark:hover:bg-white/90 text-white dark:text-black rounded-xl text-sm h-10 px-4 inline-flex items-center gap-2"
            >
              <Plus className="w-4 h-4" /> New Agent
            </Button>
          </div>
        )}
      </div>

      {/* Tenant kill switch */}
      <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
        <CardContent className="p-5 flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <ShieldAlert className={`w-5 h-5 mt-0.5 ${tenant?.ai_replies_enabled ? "text-emerald-500" : "text-zinc-400"}`} />
            <div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-white">
                AI Replies — Tenant Master Switch
              </div>
              <div className="text-xs text-zinc-500 dark:text-gray-400 mt-0.5">
                When off, NO agent fires regardless of per-agent settings. Per-client kill switch.
              </div>
            </div>
          </div>
          {isOperator && tenant && (
            <button
              type="button"
              onClick={() => toggleAIReplies(!tenant.ai_replies_enabled)}
              className="flex items-center gap-2"
              title={tenant.ai_replies_enabled ? "Click to disable" : "Click to enable"}
            >
              {tenant.ai_replies_enabled
                ? <ToggleRight className="w-9 h-9 text-emerald-500" />
                : <ToggleLeft  className="w-9 h-9 text-zinc-400" />}
              <span className={`text-xs font-medium ${tenant.ai_replies_enabled ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500"}`}>
                {tenant.ai_replies_enabled ? "Enabled" : "Disabled"}
              </span>
            </button>
          )}
        </CardContent>
      </Card>

      {/* Agents list */}
      <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
        <CardHeader className="px-6 py-4">
          <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white flex items-center gap-2">
            <HugeiconsIcon icon={Robot01Icon} size={16} className="text-violet-500" /> Your Agents
          </CardTitle>
          <CardDescription className="text-xs text-zinc-500 dark:text-gray-400">
            Each agent has its own reply behavior, knowledge base, and escalation rules.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <Alert variant="danger" className="m-6">{error}</Alert>
          )}
          {loading && agents.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
            </div>
          ) : agents.length === 0 ? (
            <div className="text-center py-12 text-sm text-zinc-500 dark:text-gray-400">
              <HugeiconsIcon icon={Robot01Icon} size={40} className="mx-auto text-zinc-300 dark:text-zinc-600 mb-2" />
              No agents yet. Create one to start auto-replying to inbound mail.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-black/5 dark:border-white/5">
                  <TableHead className="text-xs text-zinc-500 dark:text-gray-400 uppercase tracking-wider px-6">Agent</TableHead>
                  <TableHead className="text-xs text-zinc-500 dark:text-gray-400 uppercase tracking-wider">Behavior</TableHead>
                  <TableHead className="text-xs text-zinc-500 dark:text-gray-400 uppercase tracking-wider">Default?</TableHead>
                  <TableHead className="text-xs text-zinc-500 dark:text-gray-400 uppercase tracking-wider">Enabled</TableHead>
                  <TableHead className="text-xs text-zinc-500 dark:text-gray-400 uppercase tracking-wider text-right pr-6">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((a) => (
                  <TableRow key={a.id} className="border-black/5 dark:border-white/5 hover:bg-zinc-950/5 dark:hover:bg-white/[0.01] transition-colors">
                    <TableCell className="px-6 py-4">
                      <div className="font-semibold text-zinc-800 dark:text-gray-200">{a.name}</div>
                      <div 
                        className="text-xs text-zinc-500 dark:text-gray-400 mt-0.5 max-w-[320px] whitespace-normal break-words line-clamp-2" 
                        title={a.description}
                      >
                        {a.description || <span className="italic opacity-60">no description</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-xs text-zinc-700 dark:text-zinc-300">Auto-reply agent</div>
                      <div className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5">
                        Advanced: {a.provider}/{a.model}
                      </div>
                    </TableCell>
                    <TableCell>
                      {tenant?.default_ai_agent_id === a.id ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-1.5 py-0.5">
                          <CheckCircle2 className="w-2.5 h-2.5" /> Default
                        </span>
                      ) : (
                        <span className="text-[10px] text-zinc-400">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => isOperator && toggleAgentEnabled(a, !a.enabled)}
                        disabled={!isOperator}
                        title={a.enabled ? "Click to disable" : "Click to enable"}
                      >
                        {a.enabled
                          ? <ToggleRight className="w-7 h-7 text-emerald-500" />
                          : <ToggleLeft  className="w-7 h-7 text-zinc-400" />}
                      </button>
                    </TableCell>
                    <TableCell className="text-right pr-6">
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          onClick={() => setEditingAgentId(a.id)}
                          className="bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-700 dark:text-gray-300 rounded-lg text-xs h-7 px-2.5 inline-flex items-center gap-1"
                        >
                          <Edit2 className="w-3 h-3" /> Edit
                        </Button>
                        {isOperator && (
                          <Button
                            size="sm"
                            onClick={() => deleteAgent(a)}
                            className="bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 rounded-lg text-xs h-7 px-2.5 inline-flex items-center gap-1"
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Tenant default picker */}
      {tenant && agents.length > 0 && (
        <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-white">Tenant Default Agent</div>
              <div className="text-xs text-zinc-500 dark:text-gray-400 mt-0.5">
                Used when a journey has no agent override. Pick "None" to require explicit per-journey selection.
              </div>
            </div>
            <select
              value={tenant.default_ai_agent_id || ""}
              onChange={async (e) => {
                const next = e.target.value || null
                try {
                  const j = await apiFetch("/api/tenant", {
                    method: "PUT", json: { id: tenant.id, default_ai_agent_id: next },
                  })
                  setTenant(j.data)
                  pushToast("success", "Default agent updated")
                } catch (err) {
                  pushToast("error", err.message || "Update failed")
                }
              }}
              disabled={!isOperator}
              className="bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white text-sm rounded-xl h-9 px-3 outline-none"
            >
              <option value="">None</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </CardContent>
        </Card>
      )}

      {/* Templates modal — preview + one-click create */}
      {showTemplatesModal && (
        <TemplatesModal
          templates={templates}
          loading={templatesLoading}
          expandedId={expandedTemplateId}
          setExpandedId={setExpandedTemplateId}
          creatingId={creatingFromTemplateId}
          onClose={() => setShowTemplatesModal(false)}
          onCreate={handleCreateFromTemplate}
        />
      )}
    </div>
  )
}

// =========================================================================
// TemplatesModal — pick a ready-to-use agent
// =========================================================================
function TemplatesModal({ templates, loading, expandedId, setExpandedId, creatingId, onClose, onCreate }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-black/5 dark:border-white/5 shrink-0">
          <div>
            <h3 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-violet-500" /> Ready-to-use agents
            </h3>
            <p className="text-xs text-zinc-500 dark:text-gray-400 mt-1">
              Each template is crafted to sound human — no AI tells. Pick one, tune it, ship it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
            </div>
          )}
          {!loading && templates.length === 0 && (
            <div className="text-center py-10 text-sm text-zinc-500 dark:text-gray-400">
              No templates available.
            </div>
          )}
          {templates.map((t) => {
            const expanded = expandedId === t.id
            const busy = creatingId === t.id
            const toneClass = {
              emerald: "border-emerald-500/30 bg-emerald-500/5",
              blue:    "border-blue-500/30 bg-blue-500/5",
              amber:   "border-amber-500/30 bg-amber-500/5",
            }[t.icon_color] || "border-black/5 dark:border-white/5 bg-white/40 dark:bg-white/[0.02]"
            return (
              <Card key={t.id} className={`${toneClass} border rounded-2xl backdrop-blur-xl`}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-zinc-900 dark:text-white flex items-center gap-2">
                        <Bot className="w-4 h-4" />
                        {t.name}
                      </div>
                      <div className="text-[11px] text-zinc-600 dark:text-gray-400 mt-1 italic">"{t.tagline}"</div>
                      <div className="text-[11px] text-zinc-500 dark:text-gray-400 mt-1.5">{t.description}</div>
                      <div className="flex items-center gap-2 flex-wrap mt-2 text-[10px] text-zinc-500">
                        <span className="font-mono bg-zinc-100 dark:bg-white/5 px-1.5 py-0.5 rounded">{t.agent.provider}/{t.agent.model}</span>
                        <span>temp {t.agent.temperature}</span>
                        <span>·</span>
                        <span>max {t.agent.max_replies_per_lead} replies/lead</span>
                        <span>·</span>
                        <span>escalate on {t.agent.escalate_on_intents.join(", ")}</span>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <Button
                        onClick={() => onCreate(t.id)}
                        disabled={busy}
                        className="bg-zinc-900 dark:bg-white text-white dark:text-black rounded-lg text-[11px] h-8 px-3 inline-flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        Use
                      </Button>
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : t.id)}
                        className="text-[10px] text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white underline"
                      >
                        {expanded ? "Hide" : "Preview"}
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="mt-3 space-y-3 border-t border-black/5 dark:border-white/10 pt-3">
                      <div>
                        <div className="text-[10px] font-semibold text-zinc-500 dark:text-gray-400 uppercase tracking-wider mb-1">System prompt</div>
                        <pre className="text-[10px] text-zinc-700 dark:text-gray-300 bg-white dark:bg-black/40 border border-black/5 dark:border-white/10 rounded-lg p-2.5 whitespace-pre-wrap font-mono max-h-[240px] overflow-y-auto">
                          {t.agent.system_prompt}
                        </pre>
                      </div>
                      <div>
                        <div className="text-[10px] font-semibold text-zinc-500 dark:text-gray-400 uppercase tracking-wider mb-1">Seed knowledge ({t.knowledge?.length || 0} items)</div>
                        <ul className="space-y-1.5">
                          {t.knowledge?.map((kb, idx) => (
                            <li key={idx} className="bg-white dark:bg-black/40 border border-black/5 dark:border-white/10 rounded-lg p-2">
                              <div className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">{kb.title}</div>
                              <div className="text-[10px] text-zinc-600 dark:text-gray-400 mt-0.5 whitespace-pre-wrap">{kb.content}</div>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <p className="text-[10px] text-zinc-500 dark:text-gray-400 italic">
                        Items marked <code className="font-mono bg-zinc-100 dark:bg-white/5 px-1 rounded">[EDIT ME]</code> are placeholders — replace with your actual data after creating the agent.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>

        <div className="border-t border-black/5 dark:border-white/5 p-4 flex justify-end shrink-0">
          <Button
            onClick={onClose}
            variant="default"
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}

// =========================================================================
// AgentEditor — tabbed edit view
// =========================================================================
function AgentEditor({ agentId, initialAgent, onBack, onCreated, pushToast }) {
  const isOperator = useIsOperator()
  const isNew = agentId === "new"
  const [activeTab, setActiveTab] = useState("identity")
  const [busy, setBusy] = useState(false)

  // Form state. Defaults match the DB defaults.
  const [form, setForm] = useState(() => initialAgent || {
    name: "",
    description: "",
    enabled: true,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    system_prompt: DEFAULT_SYSTEM_PROMPT,
    temperature: 0.7,
    max_tokens: 1024,
    escalate_on_intents: ["objection", "negative", "complex", "out_of_office"],
    confidence_threshold: 0.7,
    max_replies_per_lead: 5,
  })

  // KB items (only relevant after we've saved at least once)
  const [kbItems, setKbItems] = useState([])
  const [kbLoading, setKbLoading] = useState(false)

  const loadKb = async () => {
    if (isNew) return
    setKbLoading(true)
    try {
      const j = await apiFetch(`/api/ai-agents/${agentId}/knowledge`).catch(() => null)
      if (j) setKbItems(j.data || [])
    } finally {
      setKbLoading(false)
    }
  }
  useEffect(() => { loadKb() }, [agentId])

  const handleSave = async () => {
    setBusy(true)
    try {
      const method = isNew ? "POST" : "PUT"
      const body = isNew ? form : { id: agentId, ...form }
      const j = await apiFetch("/api/ai-agents", { method, json: body })
      if (isNew) {
        // On create: stay in the editor for the new agent so Knowledge +
        // Playground tabs are immediately available (they need an agent_id).
        pushToast("success", `Agent created — Knowledge & Playground unlocked`)
        onCreated?.(j.data)
      } else {
        pushToast("success", "Agent updated")
        onBack()
      }
    } catch (err) {
      pushToast("error", err.message || "Save failed")
    } finally {
      setBusy(false)
    }
  }

  const tabs = [
    { v: "identity",    label: "Identity",    Icon: (props) => <HugeiconsIcon icon={Robot01Icon} {...props} /> },
    { v: "brain",       label: "Behavior",    Icon: Brain },
    { v: "knowledge",   label: "Knowledge",   Icon: BookOpen, disabled: isNew },
    { v: "escalation",  label: "Escalation",  Icon: ShieldAlert },
    // Playground requires the agent to exist (KB + creds are pulled from DB).
    // For unsaved tweaks the operator can override prompt/model/temperature/etc.
    // via the in-flight form state.
    { v: "playground",  label: "Playground",  Icon: Sparkles,    disabled: isNew },
  ]

  return (
    <div className="space-y-6 pb-10">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button onClick={onBack} className="bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-700 dark:text-gray-300 rounded-lg h-9 px-3 inline-flex items-center gap-1.5 text-xs">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Button>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
            <AppIcon name="aiAgents" size={28} className="text-violet-500" />
            {isNew ? "New AI Agent" : (form.name || "Untitled Agent")}
          </h1>
        </div>
        {isOperator && (
          <Button onClick={handleSave} disabled={busy} variant="default">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isNew ? "Create Agent" : "Save Changes"}
          </Button>
        )}
      </div>

      {/* Tab strip */}
      <div className="inline-flex items-center bg-zinc-100 dark:bg-white/5 rounded-xl p-1 text-xs flex-wrap gap-0.5">
        {tabs.map((t) => {
          const active = activeTab === t.v
          const Icon = t.Icon
          return (
            <button
              key={t.v}
              type="button"
              disabled={t.disabled}
              onClick={() => !t.disabled && setActiveTab(t.v)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                active
                  ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm"
                  : "text-zinc-500 dark:text-gray-400 hover:text-zinc-700 dark:hover:text-gray-200"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
              {t.v === "knowledge" && !isNew && (
                <span className="ml-1 text-[10px] opacity-60">({kbItems.length})</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      {activeTab === "identity" && (
        <IdentityTab form={form} setForm={setForm} isOperator={isOperator} />
      )}
      {activeTab === "brain" && (
        <BrainTab form={form} setForm={setForm} isOperator={isOperator} />
      )}
      {activeTab === "knowledge" && !isNew && (
        <KnowledgeTab agentId={agentId} kbItems={kbItems} setKbItems={setKbItems} loading={kbLoading} reload={loadKb} isOperator={isOperator} pushToast={pushToast} />
      )}
      {activeTab === "escalation" && (
        <EscalationTab form={form} setForm={setForm} isOperator={isOperator} />
      )}
      {activeTab === "playground" && !isNew && (
        <PlaygroundTab agentId={agentId} form={form} kbCount={kbItems.length} pushToast={pushToast} />
      )}
    </div>
  )
}

// ----- Tabs -----

function IdentityTab({ form, setForm, isOperator }) {
  return (
    <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
      <CardContent className="p-6 space-y-5 max-w-2xl">
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-500 dark:text-gray-400">Name</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!isOperator}
            placeholder="e.g. Inbound Sales Replies" className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-500 dark:text-gray-400">Description / internal notes</Label>
          <textarea rows={2} value={form.description || ""} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!isOperator}
            placeholder="What this agent is for, what use case it handles…"
            className="w-full bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white rounded-xl px-3 py-2 text-sm outline-none" />
        </div>
        <div className="flex items-center gap-3">
          <input type="checkbox" id="enabled" checked={!!form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} disabled={!isOperator}
            className="w-4 h-4" />
          <label htmlFor="enabled" className="text-sm text-zinc-700 dark:text-gray-300">
            Enabled — when off, this specific agent is skipped even if the tenant switch is on.
          </label>
        </div>
      </CardContent>
    </Card>
  )
}

function BrainTab({ form, setForm, isOperator }) {
  const models = MODEL_PRESETS[form.provider] || []
  return (
    <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
      <CardContent className="p-6 space-y-6">
        <div className="max-w-3xl space-y-1">
          <div className="text-sm font-semibold text-zinc-900 dark:text-white">Behavior and instructions</div>
          <p className="text-xs text-zinc-500 dark:text-gray-400">
            Describe how this agent should reply, what it should avoid, and when it should send the conversation to a human.
          </p>
        </div>

        <div className="space-y-1.5 max-w-4xl">
          <Label className="text-xs text-zinc-500 dark:text-gray-400">Agent instructions</Label>
          <textarea
            rows={12}
            value={form.system_prompt}
            onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
            disabled={!isOperator}
            placeholder={`Example:
Reply in a concise, helpful tone.
Never invent pricing, product details, or availability.
Send complex objections, unsubscribe requests, and unclear questions to a human.`}
            className="w-full bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white rounded-xl px-3 py-2 text-sm leading-relaxed outline-none"
          />
          <p className="text-[10px] text-zinc-500">
            Conversation history and knowledge items are added automatically. Write durable behavior rules here, not lead-specific context.
          </p>
        </div>

        <details className="rounded-2xl border border-black/5 dark:border-white/10 bg-zinc-50/80 dark:bg-black/20 max-w-4xl">
          <summary className="cursor-pointer list-none px-4 py-3 flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-white">Advanced AI settings</div>
              <p className="text-[11px] text-zinc-500 dark:text-gray-400 mt-0.5">
                Only change these if you know how model settings affect reply behavior.
              </p>
            </div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400 dark:text-zinc-500 mt-1">
              Optional
            </span>
          </summary>
          <div className="px-4 pb-4 pt-1 space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-500 dark:text-gray-400">Provider</Label>
                <select value={form.provider} onChange={(e) => {
                  const next = e.target.value
                  const presets = MODEL_PRESETS[next] || []
                  setForm({ ...form, provider: next, model: presets[0]?.v || form.model })
                }} disabled={!isOperator}
                  className="w-full h-9 bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white text-sm rounded-xl px-3 outline-none">
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="openai">OpenAI</option>
                  <option value="openrouter">OpenRouter (100+ models, free tier available)</option>
                </select>
                {form.provider === "openrouter" && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-relaxed mt-1">
                    Free models are rate-limited (~20 req/min, ~200/day) and may ignore strict JSON — fine for Playground, not production. Paid models on OpenRouter work like OpenAI.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-500 dark:text-gray-400">
                  Model {form.provider === "openrouter" && <span className="text-zinc-400">(pick a preset OR paste any OpenRouter slug below)</span>}
                </Label>
                <select value={models.some(m => m.v === form.model) ? form.model : ""} onChange={(e) => setForm({ ...form, model: e.target.value })} disabled={!isOperator}
                  className="w-full h-9 bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white text-sm rounded-xl px-3 outline-none">
                  {form.provider === "openrouter" && <option value="">— pick a preset —</option>}
                  {models.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
                </select>
                <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} disabled={!isOperator}
                  placeholder={form.provider === "openrouter"
                    ? "or paste any OpenRouter model slug (e.g. deepseek/deepseek-v4-flash)"
                    : "or paste a custom model id"}
                  className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs font-mono" />
                {form.provider === "openrouter" ? (
                  <p className="text-[10px] text-zinc-500 leading-relaxed">
                    Any model from{" "}
                    <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer" className="underline text-violet-600 dark:text-violet-400">
                      openrouter.ai/models
                    </a>
                    {" "}works — copy the full slug (provider/model-name) into the field above. New models appear on OpenRouter within hours of release; you don't have to wait for us to add them.
                    {" "}API key set in Settings → Credentials → OpenRouter.
                  </p>
                ) : (
                  <p className="text-[10px] text-zinc-500">API key for this provider must be set in Settings → Credentials.</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-500 dark:text-gray-400">Temperature ({form.temperature})</Label>
                <input type="range" min="0" max="1" step="0.05" value={form.temperature}
                  onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} disabled={!isOperator}
                  className="w-full" />
                <p className="text-[10px] text-zinc-500">
                  Higher values make replies more varied. Lower values make replies more consistent.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-500 dark:text-gray-400">Max tokens</Label>
                <Input type="number" min="64" max="8192" value={form.max_tokens}
                  onChange={(e) => setForm({ ...form, max_tokens: Number(e.target.value) })} disabled={!isOperator}
                  className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm" />
                <p className="text-[10px] text-zinc-500">Maximum reply length budget used by the AI model.</p>
              </div>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}

function KnowledgeTab({ agentId, kbItems, setKbItems, loading, reload, isOperator, pushToast }) {
  const confirm = useConfirm()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ title: "", content: "" })

  const handleAdd = async () => {
    if (!form.title.trim() || !form.content.trim()) {
      pushToast("error", "Title and content required")
      return
    }
    setAdding(true)
    try {
      const j = await apiFetch(`/api/ai-agents/${agentId}/knowledge`, {
        json: form,
      })
      setKbItems([j.data, ...kbItems])
      setForm({ title: "", content: "" })
      pushToast("success", "Knowledge item added")
    } catch (err) {
      pushToast("error", err.message || "Add failed")
    } finally {
      setAdding(false)
    }
  }

  const handleDelete = async (id) => {
    if (!(await confirm({
      title: "Delete this knowledge item?",
      confirmLabel: "Delete item",
      destructive: true,
    }))) return
    try {
      await apiFetch(`/api/ai-agents/${agentId}/knowledge?item_id=${id}`, { method: "DELETE" })
      setKbItems(kbItems.filter((k) => k.id !== id))
    } catch (err) {
      pushToast("error", err.message || "Delete failed")
    }
  }

  const toggleActive = async (item) => {
    try {
      const j = await apiFetch(`/api/ai-agents/${agentId}/knowledge`, {
        method: "PUT", json: { id: item.id, active: !item.active },
      })
      setKbItems(kbItems.map((k) => (k.id === item.id ? j.data : k)))
    } catch (err) {
      pushToast("error", err.message || "Update failed")
    }
  }

  return (
    <div className="space-y-4">
      <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
        <CardContent className="p-6 space-y-3">
          <div className="text-sm font-semibold text-zinc-900 dark:text-white">Add knowledge item</div>
          <p className="text-[11px] text-zinc-500">
            Text snippets the agent grounds replies in. Pricing tiers, product positioning, common questions + answers, do/don't lists. Each item gets prepended to the prompt at reply time.
          </p>
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Title (e.g. 'Pricing tiers' or 'Out-of-office handling')"
            disabled={!isOperator}
            className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm" />
          <textarea rows={5} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })}
            placeholder="Free-form text the AI can quote or reference. Be specific."
            disabled={!isOperator}
            className="w-full bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white rounded-xl px-3 py-2 text-sm leading-relaxed outline-none" />
          <div className="flex justify-end">
            <Button onClick={handleAdd} disabled={!isOperator || adding}
              variant="default">
              {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Add Item
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-zinc-400" /></div>
          ) : kbItems.length === 0 ? (
            <div className="text-center py-10 text-xs text-zinc-500 dark:text-gray-400">No knowledge items yet.</div>
          ) : (
            <ul className="divide-y divide-black/5 dark:divide-white/5">
              {kbItems.map((k) => (
                <li key={k.id} className="p-5 flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-semibold ${k.active ? "text-zinc-900 dark:text-white" : "text-zinc-400 line-through"}`}>{k.title}</span>
                      {!k.active && <span className="text-[10px] text-zinc-400 uppercase tracking-wider">inactive</span>}
                    </div>
                    <p className="text-xs text-zinc-600 dark:text-gray-400 mt-1 whitespace-pre-wrap line-clamp-4">{k.content}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" onClick={() => toggleActive(k)} disabled={!isOperator}
                      className="bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-600 dark:text-gray-300 rounded-lg text-[10px] h-7 px-2">
                      {k.active ? "Disable" : "Enable"}
                    </Button>
                    <Button size="sm" onClick={() => handleDelete(k.id)} disabled={!isOperator}
                      className="bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 rounded-lg text-[10px] h-7 px-2">
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function EscalationTab({ form, setForm, isOperator }) {
  const toggleIntent = (intent) => {
    const set = new Set(form.escalate_on_intents || [])
    if (set.has(intent)) set.delete(intent)
    else set.add(intent)
    setForm({ ...form, escalate_on_intents: Array.from(set) })
  }
  return (
    <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
      <CardContent className="p-6 space-y-6 max-w-4xl">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-zinc-900 dark:text-white">Human handoff rules</div>
          <p className="text-xs text-zinc-500 dark:text-gray-400">
            Choose when the AI should stop auto-replying and ask a person to review the conversation.
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-semibold text-zinc-900 dark:text-white">Send to a human when the lead says...</div>
          <p className="text-[11px] text-zinc-500">Select the reply types that should be reviewed by a person instead of answered automatically.</p>
          <div className="grid grid-cols-2 gap-2 mt-2">
            {AI_AGENT_INTENT_OPTIONS.map((i) => {
              const selected = (form.escalate_on_intents || []).includes(i.value)
              return (
                <button
                  key={i.value}
                  type="button"
                  onClick={() => isOperator && toggleIntent(i.value)}
                  disabled={!isOperator}
                  className={`text-left text-xs px-3 py-2 rounded-lg border transition-colors ${
                    selected
                      ? "bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-300"
                      : "bg-zinc-100 dark:bg-white/5 border-black/5 dark:border-white/10 text-zinc-600 dark:text-gray-400 hover:bg-zinc-200 dark:hover:bg-white/10"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {selected ? <Check className="w-3 h-3" /> : <span className="w-3 h-3 inline-block" />}
                    <span className="font-medium">{i.label}</span>
                  </div>
                  <span className="text-[10px] opacity-70 ml-4">{i.description}</span>
                </button>
              )
            })}
          </div>
          {(form.escalate_on_intents || []).includes("negative") && (
            <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2">
              Some teams prefer AI to close these politely instead of escalating. Adjust this based on your process.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-zinc-500 dark:text-gray-400">Only auto-reply when AI is confident ({form.confidence_threshold})</Label>
            <input type="range" min="0" max="1" step="0.05" value={form.confidence_threshold}
              onChange={(e) => setForm({ ...form, confidence_threshold: Number(e.target.value) })} disabled={!isOperator}
              className="w-full" />
            <p className="text-[10px] text-zinc-500">If confidence is below this level, the conversation is sent to a human.</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-zinc-500 dark:text-gray-400">Maximum AI replies before human review</Label>
            <Input type="number" min="0" max="50" value={form.max_replies_per_lead}
              onChange={(e) => setForm({ ...form, max_replies_per_lead: Number(e.target.value) })} disabled={!isOperator}
              className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm" />
            <p className="text-[10px] text-zinc-500">After this many AI replies in one conversation, the next response is sent to a human. 0 disables AI replies for this agent.</p>
          </div>
        </div>

        <div className="rounded-xl border border-black/5 dark:border-white/10 bg-zinc-50 dark:bg-black/20 p-3 space-y-2">
          <div className="text-xs font-semibold text-zinc-900 dark:text-white">Examples</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {AI_AGENT_ESCALATION_EXAMPLES.map((example) => (
              <div key={example.quote} className="text-[11px] text-zinc-600 dark:text-gray-400 bg-white dark:bg-black/30 border border-black/5 dark:border-white/5 rounded-lg px-3 py-2">
                <span className="text-zinc-900 dark:text-white">"{example.quote}"</span>
                <span className="mx-1.5 text-zinc-400">→</span>
                <span className="font-medium text-zinc-700 dark:text-gray-200">{example.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-3 text-[11px] text-blue-700 dark:text-blue-300 flex items-start gap-2">
          <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div>
            Human review items appear alongside other operational alerts. The team can review the lead before another follow-up is sent.
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// =========================================================================
// PlaygroundTab
// =========================================================================
//
// Test the agent on a pasted sample inbound — no DB writes, no real send.
// Uses the in-flight form state for overrides (system_prompt, model,
// temperature, escalation rules) so the operator can test unsaved tweaks.
// KB is read from saved state (KB items have their own save flow).
//
// Shows: classified intent + confidence bar, reasoning, decision (replied
// vs escalated + why), generated reply, token usage + cost estimate.
function PlaygroundTab({ agentId, form, kbCount, pushToast }) {
  const [inboundSubject, setInboundSubject] = useState("Re: quick question")
  const [inboundBody, setInboundBody] = useState("Hey Jane,\n\nWhat's the pricing for the team plan? Also, do you have a free trial?\n\nThanks,\nLead")
  const [priorOutbound, setPriorOutbound] = useState("Hey Lead,\n\nWe just launched a new team plan. Let me know if you'd like to chat about it.\n\nThanks,\nExample Co Team")
  const [leadFirstName, setLeadFirstName] = useState("Lead")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState("")

  const runTest = async () => {
    if (!inboundBody.trim()) {
      pushToast("error", "Inbound body required")
      return
    }
    setBusy(true); setError(""); setResult(null)
    try {
      const history = priorOutbound.trim()
        ? [{ direction: "outbound", body: priorOutbound.trim() }]
        : []
      const j = await apiFetch(`/api/ai-agents/${agentId}/playground`, {
        json: {
          // Send the operator's in-flight form so unsaved tweaks are tested.
          overrides: {
            system_prompt:        form.system_prompt,
            provider:             form.provider,
            model:                form.model,
            temperature:          form.temperature,
            max_tokens:           form.max_tokens,
            escalate_on_intents:  form.escalate_on_intents,
            confidence_threshold: form.confidence_threshold,
          },
          inbound: { subject: inboundSubject, body: inboundBody },
          history,
          lead: { first_name: leadFirstName, email: "test@example.com", email_conversation_count: 0 },
        },
      })
      setResult(j.data)
    } catch (err) {
      setError(err.message || "Test failed")
      pushToast("error", err.message || "Test failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-violet-500/5 border border-violet-500/20 rounded-xl p-3 text-[11px] text-violet-700 dark:text-violet-300 flex items-start gap-2">
        <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div>
          Tests the agent using your current instructions and escalation rules <strong>before</strong> you save. Knowledge items are loaded from saved state ({kbCount} active). Nothing is saved and no real messages are sent.
        </div>
      </div>

      <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
        <CardContent className="p-6 space-y-4">
          <div className="text-sm font-semibold text-zinc-900 dark:text-white">Sample input</div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-500">Lead first name</Label>
              <Input value={leadFirstName} onChange={(e) => setLeadFirstName(e.target.value)}
                className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-500">Inbound subject (optional)</Label>
              <Input value={inboundSubject} onChange={(e) => setInboundSubject(e.target.value)}
                className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-zinc-500">Prior outbound (your last email to them — optional, sets thread context)</Label>
            <textarea rows={3} value={priorOutbound} onChange={(e) => setPriorOutbound(e.target.value)}
              className="w-full bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white rounded-xl px-3 py-2 text-sm leading-relaxed outline-none" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-zinc-500">Inbound reply from the lead (required)</Label>
            <textarea rows={6} value={inboundBody} onChange={(e) => setInboundBody(e.target.value)}
              placeholder="Paste the lead's reply here…"
              className="w-full bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white rounded-xl px-3 py-2 text-sm leading-relaxed outline-none" />
          </div>

          <div className="flex justify-end">
            <Button onClick={runTest} disabled={busy}
              variant="default">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {busy ? "Testing agent..." : "Test agent"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="danger">{error}</Alert>
      )}

      {result && (() => {
        const intentDisplay = getAiAgentIntentDisplay(result.intent)
        return (
        <Card className={result.decision === "escalated"
          ? "bg-amber-500/5 border border-amber-500/30 rounded-2xl"
          : "bg-emerald-500/5 border border-emerald-500/30 rounded-2xl"}>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                {result.decision === "escalated"
                  ? <ShieldAlert className="w-5 h-5 text-amber-500" />
                  : <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
                <span className="text-sm font-semibold text-zinc-900 dark:text-white">
                  Decision: {result.decision === "escalated" ? "Escalate to human" : "Auto-reply"}
                </span>
                {result.escalation_reason && (
                  <span className="text-[10px] text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">
                    {result.escalation_reason}
                  </span>
                )}
              </div>
              <div className="text-[10px] text-zinc-500 dark:text-gray-400">
                {result.prompt_tokens}+{result.completion_tokens} tokens · ${Number(result.cost_estimate_usd || 0).toFixed(6)} · {result.effective_agent?.model}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-[10px] text-zinc-500 uppercase tracking-wider">Intent</Label>
                <div className="text-xs text-zinc-900 dark:text-white">{intentDisplay.label}</div>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-zinc-500 uppercase tracking-wider">Confidence</Label>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-zinc-200 dark:bg-white/10 rounded-full overflow-hidden">
                    <div className={`h-full ${result.confidence >= (form.confidence_threshold ?? 0.7) ? "bg-emerald-500" : "bg-amber-500"}`}
                      style={{ width: `${Math.round((result.confidence || 0) * 100)}%` }} />
                  </div>
                  <span className="text-xs font-mono text-zinc-700 dark:text-gray-300">{Math.round((result.confidence || 0) * 100)}%</span>
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[10px] text-zinc-500 uppercase tracking-wider">AI reasoning</Label>
              <p className="text-[12px] text-zinc-700 dark:text-gray-300 italic bg-white dark:bg-black/30 border border-black/5 dark:border-white/5 rounded-lg p-2.5">
                "{result.reasoning}"
              </p>
            </div>

            <div className="space-y-1">
              <Label className="text-[10px] text-zinc-500 uppercase tracking-wider">
                {result.decision === "escalated" ? "AI's suggested reply (would NOT be sent — operator handles)" : "Reply that would be sent"}
              </Label>
              <p className="text-[12px] text-zinc-700 dark:text-gray-300 whitespace-pre-wrap bg-white dark:bg-black/30 border border-black/5 dark:border-white/5 rounded-lg p-3 leading-relaxed">
                {result.reply}
              </p>
            </div>

            <details className="text-[10px] text-zinc-500 dark:text-gray-400">
              <summary className="cursor-pointer hover:text-zinc-900 dark:hover:text-white">Effective agent config used for this test</summary>
              <pre className="mt-1 bg-zinc-950/5 dark:bg-black/40 p-2 rounded text-[10px] overflow-x-auto">
                {JSON.stringify(result.effective_agent, null, 2)}
              </pre>
            </details>
          </CardContent>
        </Card>
        )
      })()}
    </div>
  )
}
