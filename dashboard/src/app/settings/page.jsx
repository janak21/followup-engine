"use client"

import { useEffect, useState, useRef } from "react"
import { useRouter } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import {
  Clock, Mail, CheckCircle2, AlertTriangle,
  ToggleLeft, ToggleRight, Edit2, Check, X, Loader2,
  Eye, EyeOff, HelpCircle, Save, Info,
  Plus, Play, Trash2, RefreshCw, AlertCircle, Send,
  ChevronDown, Search, Folder, FolderPlus, ChevronRight
} from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { AppIcon } from "@/components/AppIcon"
import { getCachedData, setCachedData } from "@/utils/apiCache"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import CustomSelect from "@/components/ui/custom-select"
import { useToast } from "@/components/ui/toast"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import { UsagePanel, MembersPanel } from "./components/TeamAndUsagePanels"
import {
  getSenderHealthDisplay,
  getSenderStatusClass,
  getSenderUsageLabel,
  SENDER_HEALTH_OPTIONS,
  SENDER_POOL_OPTIONS,
} from "@/lib/senderHealth"
import {
  COMMON_MERGE_TAGS,
  getTemplateChannelClass,
  getTemplateChannelDisplay,
  getTemplateTitle,
  normalizeTemplateText,
  validateMergeTags,
} from "@/lib/templateDisplay"

const healthOptions = [
  { value: "green", label: "Healthy", color: "#10b981" },
  { value: "yellow", label: "Limited", color: "#f59e0b" },
  { value: "red", label: "Needs review", color: "#ef4444" }
]

const warmupOptions = [
  { value: "warming", label: "Warming", color: "#3b82f6" },
  { value: "active", label: "Ready", color: "#10b981" },
  { value: "paused", label: "Paused", color: "#71717a" },
  { value: "burnt", label: "Needs review", color: "#ef4444" }
]

const SETTINGS_TABS = [
  {
    id: "general",
    label: "Workspace",
    iconName: "settings",
    description: "Control business hours, timezone, and when channels are allowed to send.",
  },
  {
    id: "senders",
    label: "Channels",
    iconName: "channels",
    description: "Manage sending accounts, limits, and channel availability.",
  },
  {
    id: "telephony",
    label: "AI & voice",
    iconName: "aiAgents",
    description: "Configure AI reply agents, voice agents, and related connections.",
  },
  {
    id: "templates",
    label: "Templates",
    iconName: "templates",
    description: "Manage reusable messages for email, SMS, calls, and team alerts.",
  },
  {
    id: "data",
    label: "Data",
    iconName: "data",
    description: "Manage lead fields, suppressions, and data mapping.",
  },
  {
    id: "developer",
    label: "Developer",
    iconName: "developer",
    description: "Advanced integration and debugging tools.",
  },
  {
    id: "access",
    label: "Billing & access",
    iconName: "billing",
    description: "Review usage costs and manage workspace access.",
  },
]

const TEMPLATE_LIBRARY_PRESETS = [
  {
    category: "FIRST TOUCH",
    items: [
      {
        key: "share_resource",
        name: "Share Helpful Resource",
        channel: "email",
        subject: "Did it help?",
        notes: "Reach out to your lead by sharing a relevant article.",
        body: "Hi {{first_name}},\n\nI saw you recently downloaded our content. Did you find it helpful?\n\nIf you have any questions, feel free to reply directly to this email.\n\nBest,\n[Your name]"
      },
      {
        key: "inbound_lead",
        name: "Inbound Lead from Content",
        channel: "email",
        subject: "Welcome to Example Co!",
        notes: "When a prospect downloads content from your website.",
        body: "Hi {{first_name}},\n\nThanks for downloading our guide! I wanted to check in and see if you had any questions about how Example Co can help streamline your operations.\n\nLet me know if you have 5 minutes for a quick chat this week.\n\nBest,\n[Your name]"
      }
    ]
  },
  {
    category: "FOLLOW UP",
    items: [
      {
        key: "follow_up_call",
        name: "The Follow-Up Email that Follows Through",
        channel: "email",
        subject: "Sorry I missed you",
        notes: "You tried calling, but your prospect didn't pick up.",
        body: "Hi {{first_name}},\n\nSorry I missed you on the phone today. I was calling to introduce myself and see if we can schedule a quick 5-minute chat about your follow-up systems.\n\nLet me know if tomorrow morning or afternoon works better for you.\n\nCheers,\n[Your name]"
      },
      {
        key: "first_sms_touch",
        name: "Sms First Touch Follow-Up",
        channel: "sms",
        notes: "Sent after a lead fills out a contact form.",
        body: "Hi {{first_name}}, this is [Your name] from Example Co. Just following up on your request. Let me know when is a good time to connect!"
      }
    ]
  },
  {
    category: "ALERTS",
    items: [
      {
        key: "action_required",
        name: "Action Required for Lead",
        channel: "team_alert",
        notes: "Internal team alert when a lead hits a critical stage.",
        body: "Hi Team, the lead {{first_name}} {{last_name}} has reached a critical stage in the journey and requires manual review."
      }
    ]
  }
]

export default function SettingsPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState("general")
  const [tenant, setTenant] = useState(() => getCachedData("settings_tenant"))
  const [senders, setSenders] = useState(() => getCachedData("settings_senders") || [])
  const [templates, setTemplates] = useState(() => getCachedData("settings_templates") || [])
  const [selectedTemplateFilter, setSelectedTemplateFilter] = useState("all")
  const [templateSearchQuery, setTemplateSearchQuery] = useState("")
  const [templateFolders, setTemplateFolders] = useState(() => getCachedData("settings_template_folders") || [])
  const [templateFolderFilter, setTemplateFolderFilter] = useState("all")
  const [showTemplateFolderModal, setShowTemplateFolderModal] = useState(false)
  const [templateFolderForm, setTemplateFolderForm] = useState({ name: "", originalName: null })
  const [templateFolderError, setTemplateFolderError] = useState("")
  const [savingTemplateFolder, setSavingTemplateFolder] = useState(false)
  const [templateDraggingId, setTemplateDraggingId] = useState(null)
  const [templateDragOverNodePath, setTemplateDragOverNodePath] = useState(null)
  const [templateToMove, setTemplateToMove] = useState(null)
  const [newFolderInlineName, setNewFolderInlineName] = useState("")
  const [creatingInlineFolder, setCreatingInlineFolder] = useState(false)
  const [inlineFolderError, setInlineFolderError] = useState("")
  const [showLibraryModal, setShowLibraryModal] = useState(false)
  const [librarySelectedKeys, setLibrarySelectedKeys] = useState([])
  const [selectedPresetForPreview, setSelectedPresetForPreview] = useState(null)
  const [showAddTemplateDropdown, setShowAddTemplateDropdown] = useState(false)
  const [showCustomVarsHelp, setShowCustomVarsHelp] = useState(false)
  const [credentials, setCredentials] = useState(() => getCachedData("settings_credentials") || [])
  const [retellAgents, setRetellAgents] = useState(() => getCachedData("settings_retellAgents") || [])
  const [retellPhoneNumbers, setRetellPhoneNumbers] = useState(() => getCachedData("settings_retellPhoneNumbers") || [])
  const [syncingRetell, setSyncingRetell] = useState(false)
  
  const [loading, setLoading] = useState(() => !getCachedData("settings_tenant"))
  const [savingTenant, setSavingTenant] = useState(false)
  const [successMsg, setSuccessMsg] = useState("")
  const [errorMsg, setErrorMsg] = useState("")

  // Non-blocking feedback + confirmation come from the shared app-root
  // providers (see components/ui/toast + confirm-dialog).
  const { pushToast } = useToast()
  const confirm = useConfirm()

  // Inline editing sender limit states
  const [editingSenderId, setEditingSenderId] = useState(null)
  // Sender Add/Edit modal state
  const [showSenderModal, setShowSenderModal] = useState(false)
  const [editingSender, setEditingSender] = useState(null) // null = add mode
  const [senderForm, setSenderForm] = useState({
    sender_slot: "",
    sender_email: "",
    sender_name: "",
    n8n_credential_name: "",
    domain: "",
    daily_limit: 30,
    min_seconds_between_sends: 1200,
    warmup_stage: "active",
    health_status: "green",
    active: true,
    // Per-sender OAuth client (Option C). NULL = use tenant default.
    google_client_id: "",
    google_client_secret: "",
  })
  const [senderFormError, setSenderFormError] = useState("")
  const [savingSender, setSavingSender] = useState(false)
  const [editingLimit, setEditingLimit] = useState(0)

  // Template CRUD modal states
  const [showTplModal, setShowTplModal] = useState(false)
  const [editingTpl, setEditingTpl] = useState(null)
  const [previewTpl, setPreviewTpl] = useState(null)
  const [tplForm, setTplForm] = useState({
    template_key: "",
    channel: "email",
    subject: "",
    body: "",
    notes: "",
    active: true
  })



  // Credentials CRUD modal states
  const [showCredModal, setShowCredModal] = useState(false)
  const [editingCred, setEditingCred] = useState(null)
  const [credForm, setCredForm] = useState({
    provider: "retell",
    n8n_credential_name: "",
    config: {},
    active: true
  })

  // Gmail test-send modal state. Test send hits /api/senders/[id]/test-send
  // which proves the OAuth chain end-to-end (refresh token → access token →
  // Gmail messages.send) without polluting actions/templates/leads.
  const [testSendSender, setTestSendSender] = useState(null)  // sender row or null = closed
  const [testSendBusy, setTestSendBusy] = useState(false)
  const [testSendForm, setTestSendForm] = useState({
    to: "",
    subject: "Example Co test send",
    body_html: "<p>Hello,</p><p>This is a Example Co test send. If you received this, the Gmail dispatch chain is working end-to-end.</p><p>— Example Co</p>",
    body_format: "both",  // 'both' | 'plain' | 'html'
  })




  useEffect(() => {
    const hasCache = !!getCachedData("settings_tenant")
    fetchSettings(hasCache)
  }, [])

  const [previewLeads, setPreviewLeads] = useState([])
  const [selectedPreviewLeadId, setSelectedPreviewLeadId] = useState("sample")

  useEffect(() => {
    if (activeTab === "templates") {
      fetch("/api/leads?limit=30")
        .then(r => r.json())
        .then(json => {
          if (json && json.data) setPreviewLeads(json.data)
        })
        .catch(err => console.error("Error loading preview leads", err))
    }
  }, [activeTab])

  // Handle the Google OAuth callback redirect. When the user is bounced back
  // to /settings after the consent flow, the URL carries ?gmail_status=...
  // Surface the result as a toast and clean the URL so a refresh doesn't
  // re-toast the same outcome.
  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const status = params.get("gmail_status")
    if (!status) return

    if (status === "connected") {
      const email = params.get("gmail_authorized_email")
      pushToast("success", email
        ? `Gmail connected: ${email}`
        : "Gmail connected.")
      // Targeted refresh so the sender row reflects the new google_refresh_token.
      fetch("/api/senders").then(r => r.json()).then(j => {
        if (Array.isArray(j?.data)) {
          setSenders(j.data)
          setCachedData("settings_senders", j.data)
        }
      }).catch(() => {})
    } else {
      const err = params.get("gmail_error") || "Gmail connection failed"
      pushToast("error", `Gmail: ${err}`, 7000)
    }

    // Remove the OAuth params from the URL so refresh doesn't re-toast.
    params.delete("gmail_status")
    params.delete("gmail_sender_id")
    params.delete("gmail_authorized_email")
    params.delete("gmail_error")
    const newUrl = window.location.pathname + (params.toString() ? `?${params}` : "")
    window.history.replaceState(null, "", newUrl)
  }, [])

  const fetchSettings = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [tenantRes, sendersRes, templatesRes, credsRes, agentsRes, phoneRes, foldersRes] = await Promise.all([
        fetch("/api/tenant"),
        fetch("/api/senders"),
        fetch("/api/templates"),
        fetch("/api/credentials"),
        fetch("/api/retell-agents?include_inactive=1"),
        fetch("/api/retell-phone-numbers"),
        fetch("/api/templates/folders")
      ])

      const tenantData = await tenantRes.json()
      const sendersData = await sendersRes.json()
      const templatesData = await templatesRes.json()
      const credsData = await credsRes.json()
      const agentsData = await agentsRes.json()
      const phoneData = phoneRes.ok ? await phoneRes.json() : { data: [] }
      const foldersData = foldersRes.ok ? await foldersRes.json() : { data: { folders: [] } }

      setTenant(tenantData.data)
      setSenders(sendersData.data || [])
      setTemplates(templatesData.data || [])
      setCredentials(credsData.data || [])
      setRetellAgents(agentsData.data || [])
      setRetellPhoneNumbers(phoneData.data || [])
      setTemplateFolders(foldersData.data?.folders || [])

      setCachedData("settings_tenant", tenantData.data)
      setCachedData("settings_senders", sendersData.data || [])
      setCachedData("settings_templates", templatesData.data || [])
      setCachedData("settings_credentials", credsData.data || [])
      setCachedData("settings_retellAgents", agentsData.data || [])
      setCachedData("settings_retellPhoneNumbers", phoneData.data || [])
      setCachedData("settings_template_folders", foldersData.data?.folders || [])
    } catch (err) {
      console.error("Failed to load settings:", err)
      setErrorMsg("Error loading settings. Check API endpoints.")
    } finally {
      setLoading(false)
    }
  }

  // Handle Business Hours Updates
  const handleDayToggle = (day) => {
    if (!tenant) return
    const currentDays = [...(tenant.business_hours?.days || [])]
    const index = currentDays.indexOf(day)
    
    if (index === -1) {
      currentDays.push(day)
    } else {
      currentDays.splice(index, 1)
    }

    setTenant({
      ...tenant,
      business_hours: {
        ...tenant.business_hours,
        days: currentDays
      }
    })
  }

  const handleTimeChange = (field, value) => {
    if (!tenant) return
    setTenant({
      ...tenant,
      business_hours: {
        ...tenant.business_hours,
        [field]: value
      }
    })
  }

  // Save Tenant Configuration
  const handleSaveTenant = async (e) => {
    e.preventDefault()
    setSavingTenant(true)
    setSuccessMsg("")
    setErrorMsg("")

    try {
      const res = await fetch("/api/tenant", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tenant)
      })

      if (res.ok) {
        setSuccessMsg("Tenant configuration updated successfully.")
        setTimeout(() => setSuccessMsg(""), 4000)
      } else {
        setErrorMsg("Failed to save tenant settings.")
      }
    } catch (err) {
      console.error(err)
      setErrorMsg("Failed to connect to tenant API.")
    } finally {
      setSavingTenant(false)
    }
  }

  // Handle Senders status toggles
  const handleToggleSenderActive = async (id, currentActive) => {
    try {
      const res = await fetch("/api/senders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, active: !currentActive })
      })

      if (res.ok) {
        setSenders(senders.map(s => s.id === id ? { ...s, active: !currentActive } : s))
      }
    } catch (err) {
      console.error(err)
    }
  }

  // Inline Sender Limit Edit Controls
  const handleStartEditLimit = (sender) => {
    setEditingSenderId(sender.id)
    setEditingLimit(sender.daily_limit)
  }

  const handleSaveSenderLimit = async (id) => {
    try {
      const res = await fetch("/api/senders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, daily_limit: Number(editingLimit) })
      })

      if (res.ok) {
        setSenders(senders.map(s => s.id === id ? { ...s, daily_limit: Number(editingLimit) } : s))
        setEditingSenderId(null)
      }
    } catch (err) {
      console.error(err)
    }
  }

  // ---------- Gmail Test Send ----------
  const handleOpenTestSend = (sender) => {
    setTestSendSender(sender)
    setTestSendForm((f) => ({
      ...f,
      // Default the recipient to the logged-in user's email so most clicks
      // need zero edits. Falls back to the sender's own email if we don't
      // know the user (useful — sends to self, no external surface).
      // Default to the sender's own email — sends to self, no external
      // surface area. User can change it to whatever they want.
      to: f.to || sender.sender_email || "",
    }))
  }

  const handleSubmitTestSend = async (e) => {
    e?.preventDefault?.()
    if (!testSendSender) return
    if (!testSendForm.to) {
      pushToast("error", "Enter a recipient email.")
      return
    }
    setTestSendBusy(true)
    try {
      const res = await fetch(`/api/senders/${testSendSender.id}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testSendForm),
      })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j?.ok) {
        pushToast(
          "success",
          `Sent to ${j.to} — Gmail id ${String(j.gmail_id).slice(0, 12)}…`
        )
        setTestSendSender(null)
        // Reflect the bumped sent_today counter in the table without a full reload.
        fetch("/api/senders").then((r) => r.json()).then((j) => {
          if (Array.isArray(j?.data)) setSenders(j.data)
        }).catch(() => {})
      } else {
        const stage = j?.stage || "send"
        const msg = j?.error || `HTTP ${res.status}`
        pushToast("error", `Test send failed at ${stage}: ${msg}`)
      }
    } catch (err) {
      pushToast("error", `Network error: ${err?.message || String(err)}`)
    } finally {
      setTestSendBusy(false)
    }
  }

  // ---------- Sender Modal (Add / Edit) ----------
  const handleOpenAddSender = () => {
    setEditingSender(null)
    setSenderForm({
      sender_slot: "",
      sender_email: "",
      sender_name: "",
      n8n_credential_name: "",
      domain: "",
      daily_limit: 30,
      min_seconds_between_sends: 1200,
      warmup_stage: "active",
      health_status: "green",
      active: true,
      google_client_id: "",
      google_client_secret: "",
    })
    setSenderFormError("")
    setShowSenderModal(true)
  }

  const handleOpenEditSender = (s) => {
    setEditingSender(s)
    setSenderForm({
      sender_slot: s.sender_slot || "",
      sender_email: s.sender_email || "",
      sender_name: s.sender_name || "",
      n8n_credential_name: s.n8n_credential_name || "",
      domain: s.domain || "",
      daily_limit: s.daily_limit ?? 30,
      min_seconds_between_sends: s.min_seconds_between_sends ?? 1200,
      warmup_stage: s.warmup_stage || "active",
      health_status: s.health_status || "green",
      active: s.active ?? true,
      google_client_id: s.google_client_id || "",
      google_client_secret: s.google_client_secret || "",
    })
    setSenderFormError("")
    setShowSenderModal(true)
  }

  const handleSaveSender = async (e) => {
    e?.preventDefault?.()
    setSenderFormError("")
    setSavingSender(true)
    try {
      const isEdit = !!editingSender
      const method = isEdit ? "PUT" : "POST"
      const body = isEdit ? { id: editingSender.id, ...senderForm } : senderForm
      const res = await fetch("/api/senders", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        setSenderFormError(json.error || `Save failed (HTTP ${res.status})`)
        return
      }
      // Refresh list
      const listRes = await fetch("/api/senders")
      const listJson = await listRes.json()
      if (listRes.ok) setSenders(listJson.data || [])
      setShowSenderModal(false)
    } catch (err) {
      setSenderFormError(err.message || "Failed to save sender")
    } finally {
      setSavingSender(false)
    }
  }

  const handleDeleteSender = async (s) => {
    if (!(await confirm({
      title: `Delete sender ${s.sender_slot}?`,
      message: `${s.sender_email} will be removed. This cannot be undone.`,
      confirmLabel: "Delete sender",
      destructive: true,
    }))) return
    try {
      const res = await fetch(`/api/senders?id=${s.id}`, { method: "DELETE" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        pushToast("error", json.error || "Failed to delete sender")
        return
      }
      setSenders(senders.filter(x => x.id !== s.id))
    } catch (err) {
      pushToast("error", err.message || "Failed to delete sender")
    }
  }

  const handleResetSenderToday = async (s) => {
    if (!(await confirm({
      title: `Reset today's sent count for ${s.sender_slot}?`,
      message: "The counter goes back to 0.",
      confirmLabel: "Reset count",
    }))) return
    try {
      const res = await fetch("/api/senders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: s.id, reset_today: true }),
      })
      const json = await res.json()
      if (!res.ok) {
        pushToast("error", json.error || "Failed to reset count")
        return
      }
      setSenders(senders.map(x => x.id === s.id ? json.data : x))
    } catch (err) {
      pushToast("error", err.message || "Failed to reset count")
    }
  }

  const handleQuickUpdateSender = async (id, patch) => {
    try {
      const res = await fetch("/api/senders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      })
      const json = await res.json()
      if (!res.ok) {
        pushToast("error", json.error || "Update failed")
        return
      }
      setSenders(senders.map(x => x.id === id ? json.data : x))
    } catch (err) {
      pushToast("error", err.message || "Update failed")
    }
  }

  // Template CRUD Actions
  const handleStartCreateTemplate = () => {
    setEditingTpl(null)
    setTplForm({
      template_key: "",
      channel: "email",
      subject: "",
      body: "",
      notes: "",
      active: true,
      folder: templateFolderFilter !== "all" && templateFolderFilter !== "__none__" ? templateFolderFilter : ""
    })
    setShowTplModal(true)
  }

  const handleStartEditTemplate = (tpl) => {
    setEditingTpl(tpl)
    setTplForm({
      template_key: tpl.template_key,
      channel: tpl.channel,
      subject: tpl.subject || "",
      body: tpl.body || "",
      notes: tpl.notes || "",
      active: tpl.active ?? true,
      folder: tpl.folder || ""
    })
    setShowTplModal(true)
  }

  const handleSaveTemplate = async (e) => {
    e.preventDefault()
    setSuccessMsg("")
    setErrorMsg("")

    try {
      const url = "/api/templates"
      const method = editingTpl ? "PUT" : "POST"
      const payload = editingTpl 
        ? { id: editingTpl.id, ...tplForm, folder: tplForm.folder ? tplForm.folder.trim() : null } 
        : { ...tplForm, folder: tplForm.folder ? tplForm.folder.trim() : null }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })

      if (res.ok) {
        setSuccessMsg(editingTpl ? "Template updated successfully." : "Template created successfully.")
        setShowTplModal(false)
        fetchSettings()
        setTimeout(() => setSuccessMsg(""), 4000)
      } else {
        const errorData = await res.json()
        setErrorMsg(errorData.error || "Failed to save template.")
      }
    } catch (err) {
      console.error(err)
      setErrorMsg("Failed to save template.")
    }
  }

  // Template Folder Actions
  const openCreateTemplateFolder = () => {
    setTemplateFolderForm({ name: "", originalName: null })
    setTemplateFolderError("")
    setShowTemplateFolderModal(true)
  }

  const openRenameTemplateFolder = (name) => {
    setTemplateFolderForm({ name, originalName: name })
    setTemplateFolderError("")
    setShowTemplateFolderModal(true)
  }

  const saveTemplateFolder = async (e) => {
    e?.preventDefault?.()
    const trimmed = templateFolderForm.name.trim()
    if (!trimmed) { setTemplateFolderError("Folder name is required"); return }
    setSavingTemplateFolder(true)
    setTemplateFolderError("")
    try {
      if (templateFolderForm.originalName) {
        const res = await fetch("/api/templates/folders", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: templateFolderForm.originalName, to: trimmed })
        })
        const json = await res.json()
        if (!res.ok) { setTemplateFolderError(json.error || "Rename failed"); return }
      } else {
        const res = await fetch("/api/templates/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed })
        })
        const json = await res.json()
        if (!res.ok) { setTemplateFolderError(json.error || "Create failed"); return }
      }
      setShowTemplateFolderModal(false)
      fetchSettings()
    } catch (err) {
      setTemplateFolderError(err.message || "Failed to save folder")
    } finally {
      setSavingTemplateFolder(false)
    }
  }

  const deleteTemplateFolder = async (name) => {
    const templatesInFolder = templates.filter(t => t.folder === name)
    const msg = templatesInFolder.length > 0
      ? `${templatesInFolder.length} template(s) in this folder will move to Uncategorized — they will NOT be deleted.`
      : "This cannot be undone."
    if (!(await confirm({
      title: `Delete folder "${name}"?`,
      message: msg,
      confirmLabel: "Delete folder",
      destructive: true,
    }))) return
    try {
      const res = await fetch(`/api/templates/folders?name=${encodeURIComponent(name)}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) { pushToast("error", json.error || "Delete failed"); return }
      if (templateFolderFilter === name) setTemplateFolderFilter("all")
      fetchSettings()
    } catch (err) {
      pushToast("error", err.message || "Delete failed")
    }
  }

  const handleMoveTemplateToFolder = async (tpl, newFolder) => {
    try {
      const res = await fetch("/api/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: tpl.id,
          template_key: tpl.template_key,
          channel: tpl.channel,
          subject: tpl.subject,
          body: tpl.body,
          notes: tpl.notes,
          active: tpl.active,
          folder: newFolder ? newFolder.trim() : null
        })
      })
      if (res.ok) {
        fetchSettings()
      } else {
        const err = await res.json()
        pushToast("error", err.error || "Failed to move template")
      }
    } catch (err) {
      pushToast("error", "Failed to move template")
    }
  }

  const handleCreateInlineFolder = async (e) => {
    e?.preventDefault()
    const trimmed = newFolderInlineName.trim()
    if (!trimmed) { setInlineFolderError("Name cannot be empty"); return }
    setCreatingInlineFolder(true)
    setInlineFolderError("")
    try {
      const res = await fetch("/api/templates/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed })
      })
      const json = await res.json()
      if (!res.ok) {
        setInlineFolderError(json.error || "Failed to create folder")
        return
      }
      setTemplateFolders(json.data.folders || [])
      setNewFolderInlineName("")
      // Auto assign template to newly created folder
      if (templateToMove) {
        await handleMoveTemplateToFolder(templateToMove, trimmed)
        setTemplateToMove(null)
      }
    } catch (err) {
      setInlineFolderError("Failed to create folder")
    } finally {
      setCreatingInlineFolder(false)
    }
  }

  const [importingPresets, setImportingPresets] = useState(false)
  const handleImportSelectedPresets = async () => {
    setImportingPresets(true)
    try {
      const selectedPresets = []
      TEMPLATE_LIBRARY_PRESETS.forEach(cat => {
        cat.items.forEach(item => {
          if (librarySelectedKeys.includes(item.key)) {
            selectedPresets.push(item)
          }
        })
      })

      for (const preset of selectedPresets) {
        const payload = {
          template_key: preset.key,
          channel: preset.channel,
          subject: preset.subject || "",
          body: preset.body,
          notes: preset.notes || "",
          active: true
        }
        await fetch("/api/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
      }

      pushToast("success", `Successfully imported ${selectedPresets.length} templates.`)
      setShowLibraryModal(false)
      fetchSettings()
    } catch (err) {
      console.error(err)
      pushToast("error", "Failed to import template presets.")
    } finally {
      setImportingPresets(false)
    }
  }

  const handleDeleteTemplate = async (id) => {
    if (!(await confirm({
      title: "Delete this template?",
      message: "This cannot be undone.",
      confirmLabel: "Delete template",
      destructive: true,
    }))) return
    setSuccessMsg("")
    setErrorMsg("")

    try {
      const res = await fetch(`/api/templates?id=${id}`, {
        method: "DELETE"
      })

      if (res.ok) {
        setSuccessMsg("Template deleted successfully.")
        fetchSettings()
        setTimeout(() => setSuccessMsg(""), 4000)
      } else {
        setErrorMsg("Failed to delete template.")
      }
    } catch (err) {
      console.error(err)
      setErrorMsg("Failed to delete template.")
    }
  }



  // Credentials CRUD Actions
  const handleStartCreateCredential = () => {
    setEditingCred(null)
    setCredForm({
      provider: "retell",
      n8n_credential_name: "",
      config: { from_number: "", agent_id: "" },
      active: true
    })
    setShowCredModal(true)
  }

  const handleStartEditCredential = (cred) => {
    setEditingCred(cred)
    setCredForm({
      provider: cred.provider,
      n8n_credential_name: cred.n8n_credential_name,
      config: cred.config || {},
      active: cred.active ?? true
    })
    setShowCredModal(true)
  }

  const handleSaveCredential = async (e) => {
    e.preventDefault()
    setSuccessMsg("")
    setErrorMsg("")

    try {
      const url = "/api/credentials"
      const method = editingCred ? "PUT" : "POST"
      const payload = editingCred
        ? { id: editingCred.id, ...credForm }
        : { tenant_id: tenant?.id, ...credForm }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })

      if (res.ok) {
        pushToast("success", editingCred ? "Credential updated." : "Credential created.")
        setShowCredModal(false)
        fetchSettings()
      } else {
        // Surface the actual server reason instead of a generic "Save failed"
        // toast. Most common: 23505 unique violation when adding a second
        // credential for a provider that already exists (one-per-provider-per-tenant).
        const errorData = await res.json().catch(() => ({}))
        const msg = errorData?.error || `Save failed (HTTP ${res.status})`
        pushToast("error", msg, 7000)
      }
    } catch (err) {
      console.error(err)
      pushToast("error", `Network error: ${err?.message || String(err)}`, 7000)
    }
  }

  const handleDeleteCredential = async (id) => {
    if (!(await confirm({
      title: "Delete this credential?",
      message: "This cannot be undone.",
      confirmLabel: "Delete credential",
      destructive: true,
    }))) return
    setSuccessMsg("")
    setErrorMsg("")

    try {
      const res = await fetch(`/api/credentials?id=${id}`, {
        method: "DELETE"
      })

      if (res.ok) {
        setSuccessMsg("Credential deleted successfully.")
        fetchSettings()
        setTimeout(() => setSuccessMsg(""), 4000)
      } else {
        setErrorMsg("Failed to delete credential.")
      }
    } catch (err) {
      console.error(err)
      setErrorMsg("Failed to delete credential.")
    }
  }


  
  // Targeted refresh — pulls just the two tables that the sync writes to,
  // without re-running the full settings load (which flashes the loading
  // shimmer over the entire page). Settings stays mounted; only the two
  // Retell tables update.
  const refreshRetellOnly = async () => {
    try {
      const [agentsRes, phoneRes] = await Promise.all([
        fetch("/api/retell-agents?include_inactive=1"),
        fetch("/api/retell-phone-numbers"),
      ])
      const agentsData = agentsRes.ok ? await agentsRes.json() : { data: [] }
      const phoneData  = phoneRes.ok  ? await phoneRes.json()  : { data: [] }
      setRetellAgents(agentsData.data || [])
      setRetellPhoneNumbers(phoneData.data || [])
    } catch (err) {
      console.warn("refreshRetellOnly:", err)
    }
  }

  const handleSyncRetell = async () => {
    setSyncingRetell(true)
    try {
      const res = await fetch("/api/retell-agents/sync", { method: "POST" })
      const json = await res.json()
      if (!res.ok) {
        pushToast("error", json.error || "Sync failed.")
        return
      }
      const a = json.agents_synced ?? 0
      const p = json.phone_numbers_synced ?? 0
      pushToast("success", `Synced ${a} agent${a === 1 ? "" : "s"} · ${p} phone number${p === 1 ? "" : "s"}`)
      if (json.phone_error) pushToast("error", `Phone numbers: ${json.phone_error}`, 6000)
      await refreshRetellOnly()
    } catch (err) {
      console.error("Failed to sync Retell:", err)
      pushToast("error", "Sync failed: " + (err?.message || "unknown error"))
    } finally {
      setSyncingRetell(false)
    }
  }

  const handleToggleAgentActive = async (id, currentActive) => {
    try {
      const res = await fetch("/api/retell-agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, active: !currentActive })
      })
      if (res.ok) {
        setRetellAgents(retellAgents.map(a => a.id === id ? { ...a, active: !currentActive } : a))
      } else {
        const errJson = await res.json()
        pushToast("error", errJson.error || "Failed to toggle agent status.")
      }
    } catch (err) {
      console.error(err)
    }
  }

  const handleDeleteAgent = async (id) => {
    if (!(await confirm({
      title: "Delete this agent registry?",
      message: "Any journey referencing it will fall back to the tenant default.",
      confirmLabel: "Delete agent",
      destructive: true,
    }))) return
    try {
      const res = await fetch(`/api/retell-agents?id=${id}`, {
        method: "DELETE"
      })
      if (res.ok) {
        setRetellAgents(retellAgents.filter(a => a.id !== id))
      } else {
        const errJson = await res.json()
        pushToast("error", errJson.error || "Failed to delete agent registry.")
      }
    } catch (err) {
      console.error(err)
    }
  }

  const daysOfWeek = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  const activeTabInfo = SETTINGS_TABS.find((tab) => tab.id === activeTab) || SETTINGS_TABS[0]

  if (loading && !tenant) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-4">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
        <span className="text-sm text-gray-500">Loading settings panel...</span>
      </div>
    )
  }

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
          <AppIcon name="settings" size={32} className="text-zinc-700 dark:text-gray-300" />
          Settings
        </h1>
        <p className="text-sm text-zinc-500 dark:text-gray-400 mt-1">
          Configure workspace rules, channels, AI, templates, data, integrations, and billing.
        </p>
      </div>

      {successMsg && <Alert variant="success">{successMsg}</Alert>}

      {errorMsg && <Alert variant="danger">{errorMsg}</Alert>}

      {/* Tabs Selector */}
      <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-1 p-1 bg-zinc-950/5 dark:bg-black/20 rounded-2xl mb-0">
        {SETTINGS_TABS.map((tab) => {
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all relative z-10 ${
                isActive
                  ? "bg-white dark:bg-surface-2 text-zinc-900 dark:text-white shadow-sm border border-black/5 dark:border-white/5"
                  : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              }`}
              title={tab.description}
            >
              {isActive && (
                <motion.div
                  layoutId="activeSettingsTab"
                  className="absolute inset-0 bg-white dark:bg-surface-2 rounded-xl shadow-sm border border-black/5 dark:border-white/5 -z-10"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <AppIcon name={tab.iconName} size={15} />
              {tab.label}
            </button>
          )
        })}
      </div>
      <div className="rounded-2xl border border-black/5 dark:border-white/5 bg-white/40 dark:bg-white/[0.02] px-4 py-3">
        <div className="text-sm font-semibold text-zinc-900 dark:text-white">{activeTabInfo.label}</div>
        <p className="text-xs text-zinc-500 dark:text-gray-400 mt-0.5">{activeTabInfo.description}</p>
      </div>
      </div>


      <div className="space-y-8">
        {activeTab === "general" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
            <CardHeader>
              <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                <AppIcon name="settings" size={20} className="text-zinc-500 dark:text-gray-400" /> Workspace settings
              </CardTitle>
              <CardDescription className="text-zinc-500 dark:text-gray-400">
                Control business hours, timezone, channel pauses, and alert routing.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSaveTenant} className="space-y-5">
                
                {/* Business Hours */}
                <div className="space-y-2.5">
                  <Label className="text-xs text-zinc-500 dark:text-gray-400 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-zinc-400 dark:text-gray-500" /> Active Business Hours
                  </Label>
                  
                  <div className="grid grid-cols-2 gap-3 bg-zinc-950/5 dark:bg-black/20 p-3 rounded-xl border border-black/5 dark:border-white/5">
                    <div className="space-y-1">
                      <span className="text-[10px] text-zinc-400 dark:text-gray-500 uppercase tracking-wider font-semibold">Start</span>
                      <input 
                        type="text" 
                        placeholder="00:00"
                        pattern="^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$"
                        value={tenant.business_hours?.start || "09:00"}
                        onChange={(e) => handleTimeChange("start", e.target.value)}
                        className="w-full bg-white dark:bg-surface-2 border border-black/10 dark:border-white/5 text-zinc-800 dark:text-gray-200 text-xs rounded-lg p-1.5 focus:border-black/20 dark:focus:border-white/20 outline-none font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <span className="text-[10px] text-zinc-400 dark:text-gray-500 uppercase tracking-wider font-semibold">End</span>
                      <input 
                        type="text" 
                        placeholder="23:59"
                        pattern="^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$"
                        value={tenant.business_hours?.end || "17:00"}
                        onChange={(e) => handleTimeChange("end", e.target.value)}
                        className="w-full bg-white dark:bg-surface-2 border border-black/10 dark:border-white/5 text-zinc-800 dark:text-gray-200 text-xs rounded-lg p-1.5 focus:border-black/20 dark:focus:border-white/20 outline-none font-mono"
                      />
                    </div>
                  </div>

                  {/* Days Multi-Select checkboxes */}
                  <span className="text-[10px] text-zinc-400 dark:text-gray-500 uppercase tracking-wider font-semibold block mt-1">Days of the Week</span>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {daysOfWeek.map((day) => {
                      const isSelected = tenant.business_hours?.days?.includes(day)
                      return (
                        <button
                          key={day}
                          type="button"
                          onClick={() => handleDayToggle(day)}
                          className={`text-[10px] font-semibold px-2 py-1 rounded-lg border transition-all ${
                            isSelected 
                              ? "bg-zinc-950/5 dark:bg-white/10 text-zinc-900 dark:text-white border-black/15 dark:border-white/25 shadow-inner" 
                              : "bg-transparent text-zinc-400 dark:text-gray-500 border-black/5 dark:border-white/5 hover:border-black/10 dark:hover:border-white/10"
                          }`}
                        >
                          {day}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Channel kill switches */}
                <div className="space-y-2.5">
                  <Label className="text-xs text-zinc-500 dark:text-gray-400 flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 text-rose-500" /> Channel pauses
                  </Label>
                  <p className="text-[10px] text-zinc-500">Toggle a channel ON to hold all outbound on that channel. Already-queued actions wait; nothing dispatches until the pause is lifted.</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: "sms",        label: "SMS" },
                      { id: "email",      label: "Email" },
                      { id: "call",       label: "Call" },
                      { id: "team_alert", label: "Team Alert" },
                    ].map(ch => {
                      const paused = !!(tenant.channel_pauses && tenant.channel_pauses[ch.id])
                      return (
                        <label
                          key={ch.id}
                          className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border cursor-pointer ${paused ? "border-rose-500/30 bg-rose-500/5" : "border-black/10 dark:border-white/10 bg-zinc-950/5 dark:bg-black/20"}`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={paused}
                              onChange={(e) => setTenant({ ...tenant, channel_pauses: { ...(tenant.channel_pauses || {}), [ch.id]: e.target.checked } })}
                              className="w-3.5 h-3.5"
                            />
                            <span className="text-xs text-zinc-700 dark:text-gray-300">{ch.label}</span>
                          </div>
                          <span className={`text-[10px] uppercase tracking-wider font-semibold ${paused ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                            {paused ? "Paused" : "Active"}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>

                {/* Timezone Select */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-zinc-500 dark:text-gray-400">Timezone</Label>
                  <CustomSelect 
                    value={tenant.timezone || "America/New_York"}
                    onChange={(val) => setTenant({ ...tenant, timezone: val })}
                    options={[
                      { value: "America/New_York", label: "Eastern Time (America/New_York)" },
                      { value: "America/Chicago", label: "Central Time (America/Chicago)" },
                      { value: "America/Denver", label: "Mountain Time (America/Denver)" },
                      { value: "America/Los_Angeles", label: "Pacific Time (America/Los_Angeles)" },
                      { value: "Europe/London", label: "Greenwich Mean Time (Europe/London)" },
                      { value: "Asia/Kolkata", label: "India Standard Time (Asia/Kolkata)" },
                      { value: "UTC", label: "Coordinated Universal Time (UTC)" }
                    ]}
                    triggerClassName="w-full h-9 bg-white dark:bg-surface-2 border border-black/10 dark:border-white/5 text-zinc-700 dark:text-gray-300 text-xs rounded-xl px-3 outline-none flex items-center justify-between"
                  />
                </div>

                {/* Team Alert Email */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-zinc-500 dark:text-gray-400 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-zinc-400 dark:text-gray-500" /> Alert Dispatch Email
                  </Label>
                  <Input 
                    type="email"
                    placeholder="alerts@yourdomain.com"
                    value={tenant.team_alert_email || ""}
                    onChange={(e) => setTenant({ ...tenant, team_alert_email: e.target.value })}
                    className="bg-white dark:bg-surface-2 border-black/10 dark:border-white/5 text-zinc-900 dark:text-white h-9 rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-600 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
                  />
                  <span className="text-[10px] text-zinc-400 dark:text-gray-500 block leading-relaxed">
                    Urgent events, failed call alerts, and manual human reviews will be routed here.
                  </span>
                </div>

                {/* Submit button */}
                <Button 
                  type="submit" 
                  disabled={savingTenant}
                  variant="default"
                >
                  {savingTenant ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving Changes
                    </>
                  ) : (
                    <>
                      <Save className="w-3.5 h-3.5" /> Save Configuration
                    </>
                  )}
                </Button>

              </form>
            </CardContent>
          </Card>

            {/* Lead Custom Fields Quick Link */}
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl flex flex-col justify-between">
              <CardHeader>
                <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                  <AppIcon name="customFields" size={20} className="text-zinc-500 dark:text-gray-400" /> Lead Custom Fields
                </CardTitle>
                <CardDescription className="text-zinc-500 dark:text-gray-400">
                  Manage custom field schemas, groups, and folders.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5 flex-1 flex flex-col justify-between">
                <div className="space-y-4">
                  <p className="text-xs text-zinc-600 dark:text-gray-400 leading-relaxed">
                    Custom fields allow you to track structured properties (e.g. key dates, dropdown selections, boolean flags, numbers) on lead records. 
                  </p>
                  <div className="bg-zinc-950/5 dark:bg-black/20 p-4 rounded-xl border border-black/5 dark:border-white/5 space-y-2 text-xs">
                    <span className="font-semibold text-zinc-700 dark:text-gray-300 block">Workspace Features:</span>
                    <ul className="list-disc list-inside space-y-1 text-zinc-600 dark:text-gray-400 text-[11px]">
                      <li>Organize fields into nested folders</li>
                      <li>Define field validation rules and placeholders</li>
                      <li>Drag and drop to reorder lead page displays</li>
                    </ul>
                  </div>
                </div>
                <Button
                  onClick={() => router.push("/settings/custom-fields")}
                  className="w-full bg-zinc-900 dark:bg-white hover:bg-zinc-800 dark:hover:bg-white/90 text-white dark:text-black font-semibold h-9 rounded-xl shadow-md transition-all text-xs mt-4"
                >
                  Open Custom Fields Workspace
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "senders" && (
          <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                    <AppIcon name="channels" size={20} className="text-zinc-500 dark:text-gray-400" /> Channels & sending limits
                  </CardTitle>
                  <CardDescription className="text-zinc-500 dark:text-gray-400 mt-1">
                    Manage sending accounts, channel health, sender pools, and daily volume caps.
                  </CardDescription>
                  <p className="text-[11px] text-zinc-500 dark:text-gray-400 mt-2">
                    Sending limits help prevent overuse and protect deliverability.
                  </p>
                </div>
                <Button
                  onClick={handleOpenAddSender}
                  variant="default"
                >
                  <Plus className="w-4 h-4" /> Add Sender
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="border-black/5 dark:border-white/5 bg-black/[0.01] dark:bg-white/[0.01]">
                  <TableRow className="border-black/5 dark:border-white/5 hover:bg-transparent">
                    <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-6">Sender</TableHead>
                    <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-4">Channel / pool</TableHead>
                    <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-4">Health</TableHead>
                    <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-4">Usage today</TableHead>
                    <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-4">Limit</TableHead>
                    <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-6 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {senders.length === 0 ? (
                    <TableRow className="border-black/5 dark:border-white/5">
                      <TableCell colSpan={6} className="text-center py-6 text-zinc-400 dark:text-gray-500 text-xs">
                        No senders registered in pool.
                      </TableCell>
                    </TableRow>
                  ) : (
                    senders.map((sender) => {
                      const isEditing = editingSenderId === sender.id
                      const health = getSenderHealthDisplay(sender)
                      const connected = Boolean(sender.google_connected_at || sender.google_refresh_token)
                      return (
                        <TableRow key={sender.id} className="border-black/5 dark:border-white/5 hover:bg-zinc-950/5 dark:hover:bg-white/[0.01] transition-colors group/row">
                          
                          {/* Sender Identity + Google OAuth status */}
                          <TableCell className="px-6 py-4">
                            <div className="font-semibold text-zinc-800 dark:text-gray-200">{sender.sender_name}</div>
                            <div className="text-xs text-zinc-500 dark:text-gray-400 mt-0.5">{sender.sender_email}</div>
                            <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                              {connected ? (
                                <>
                                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2 py-0.5 shadow-sm">
                                    <CheckCircle2 className="w-3 h-3" /> Connected
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenTestSend(sender)}
                                    className="inline-flex items-center gap-1 text-[10px] font-semibold text-zinc-700 dark:text-gray-300 bg-zinc-950/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-lg px-2 py-0.5 hover:bg-zinc-950/10 dark:hover:bg-white/10 transition-all shadow-sm"
                                    title="Send a one-off test email through this sender to prove the OAuth + Gmail chain is working"
                                  >
                                    <Send className="w-3 h-3" /> Test Send
                                  </button>
                                  <a
                                    href={`/api/oauth/google/start?sender_id=${sender.id}`}
                                    className="inline-flex items-center gap-1 text-[10px] font-semibold text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white bg-transparent hover:bg-zinc-950/5 dark:hover:bg-white/5 border border-transparent hover:border-black/5 dark:hover:border-white/5 rounded-lg px-2 py-0.5 transition-all"
                                    title="Re-run the OAuth flow (e.g. if the refresh token was revoked)"
                                  >
                                    Reconnect Google
                                  </a>
                                </>
                              ) : (
                                <a
                                  href={`/api/oauth/google/start?sender_id=${sender.id}`}
                                  className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500/90 dark:hover:bg-blue-500 border border-blue-700/20 rounded-lg px-2.5 py-1 transition-all shadow-sm"
                                  title="Connect this sender's Gmail account via Google OAuth"
                                >
                                  <Mail className="w-3 h-3" /> Connect Google
                                </a>
                              )}
                            </div>
                          </TableCell>

                          {/* Channel / pool */}
                          <TableCell className="px-4 py-4">
                            <div className="space-y-1.5">
                              <div>
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20">
                                  Email
                                </span>
                                <div className="text-[10px] text-zinc-500 dark:text-gray-500 mt-1">
                                  Pool: <span className="font-mono">{sender.sender_slot}</span>
                                </div>
                              </div>
                              <CustomSelect
                                value={sender.warmup_stage}
                                options={warmupOptions}
                                onChange={(val) => handleQuickUpdateSender(sender.id, { warmup_stage: val })}
                                triggerClassName={`flex items-center justify-between gap-1 w-[116px] px-2 py-1 rounded-lg text-[10px] font-semibold border outline-none cursor-pointer shadow-sm transition-colors ${
                                  sender.warmup_stage === 'active' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20' :
                                  sender.warmup_stage === 'warming' ? 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20 hover:bg-blue-500/20' :
                                  sender.warmup_stage === 'paused' ? 'bg-zinc-500/10 text-zinc-700 dark:text-gray-400 border-zinc-500/20 hover:bg-zinc-500/20' :
                                  'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20 hover:bg-rose-500/20'
                                }`}
                                direction="up"
                              />
                            </div>
                          </TableCell>

                          {/* Derived sender health */}
                          <TableCell className="px-4 py-4">
                            <div className="space-y-1.5">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${getSenderStatusClass(health.variant)}`}>
                                {health.label}
                              </span>
                              <div className="text-[10px] text-zinc-500 dark:text-gray-400 max-w-[180px] leading-snug">{health.reason}</div>
                              <CustomSelect
                                value={sender.health_status}
                                options={healthOptions}
                                onChange={(val) => handleQuickUpdateSender(sender.id, { health_status: val })}
                                triggerClassName={`flex items-center justify-between gap-1 w-[116px] px-2 py-1 rounded-lg text-[10px] font-semibold border outline-none cursor-pointer shadow-sm transition-colors ${
                                  sender.health_status === 'green' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20' :
                                  sender.health_status === 'yellow' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20 hover:bg-amber-500/20' :
                                  'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20 hover:bg-rose-500/20'
                                }`}
                              />
                            </div>
                          </TableCell>

                          {/* Usage today */}
                          <TableCell className="px-4 py-4">
                            <div className="text-xs">
                              <div className="font-semibold text-zinc-800 dark:text-gray-200">{getSenderUsageLabel(sender)}</div>
                              <div className="text-[10px] text-zinc-400 dark:text-gray-500 mt-0.5">
                                Total sent: <span className="font-mono">{sender.total_sent || 0}</span>
                              </div>
                            </div>
                          </TableCell>

                          {/* Daily Limit Input */}
                          <TableCell className="px-4 py-4">
                            {isEditing ? (
                              <div className="flex items-center gap-1">
                                <Input
                                  type="number"
                                  value={editingLimit}
                                  onChange={(e) => setEditingLimit(e.target.value)}
                                  className="h-8 w-16 bg-white dark:bg-surface-2 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white px-2 rounded-lg text-xs"
                                />
                                <Button
                                  size="icon-xs"
                                  onClick={() => handleSaveSenderLimit(sender.id)}
                                  className="bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 rounded-md p-1 h-7 w-7"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                </Button>
                                <Button
                                  size="icon-xs"
                                  onClick={() => setEditingSenderId(null)}
                                  className="bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-500 dark:text-gray-400 rounded-md p-1 h-7 w-7"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </Button>
                              </div>
                            ) : (
                              <div className="group/limit flex items-center gap-1.5">
                                <div>
                                  <span className="font-mono font-semibold text-zinc-900 dark:text-gray-200 text-xs">{sender.daily_limit}</span>
                                  <span className="text-[10px] text-zinc-500 dark:text-gray-500 block font-normal">per day</span>
                                </div>
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  onClick={() => handleStartEditLimit(sender)}
                                  className="opacity-0 group-hover/row:opacity-100 hover:bg-zinc-950/5 dark:hover:bg-white/5 text-zinc-400 dark:text-gray-500 hover:text-zinc-900 dark:hover:text-white rounded-md transition-all p-1"
                                >
                                  <Edit2 className="w-3 h-3" />
                                </Button>
                              </div>
                            )}
                          </TableCell>

                          {/* Actions */}
                          <TableCell className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-1 flex-wrap">
                              <button
                                type="button"
                                onClick={() => handleToggleSenderActive(sender.id, sender.active)}
                                title={sender.active ? "Pause sender" : "Resume sender"}
                                className="text-[10px] font-semibold px-2 py-1 rounded-lg border border-black/10 dark:border-white/10 text-zinc-600 dark:text-gray-300 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-950/5 dark:hover:bg-white/5 transition-colors"
                              >
                                {sender.active ? "Pause" : "Resume"}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleResetSenderToday(sender)}
                                title="Reset today's sent count to 0"
                                aria-label="Reset today's sent count"
                                className="text-zinc-400 hover:text-blue-600 dark:text-gray-500 dark:hover:text-blue-400 transition-colors p-1.5 hover:bg-zinc-950/5 dark:hover:bg-white/5 rounded-lg"
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleOpenEditSender(sender)}
                                title="Edit all fields"
                                aria-label="Edit sender"
                                className="text-zinc-400 hover:text-zinc-900 dark:text-gray-500 dark:hover:text-white transition-colors p-1.5 hover:bg-zinc-950/5 dark:hover:bg-white/5 rounded-lg"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteSender(sender)}
                                title="Delete sender"
                                aria-label="Delete sender"
                                className="text-zinc-400 hover:text-rose-600 dark:text-gray-500 dark:hover:text-rose-400 transition-colors p-1.5 hover:bg-zinc-950/5 dark:hover:bg-white/5 rounded-lg"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </TableCell>

                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {activeTab === "templates" && (
          <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                  <AppIcon name="templates" size={20} className="text-zinc-500 dark:text-gray-400" /> Message templates
                </CardTitle>
                <CardDescription className="text-zinc-500 dark:text-gray-400">
                  Manage reusable messages for email, SMS, and team alerts.
                </CardDescription>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-zinc-500 dark:text-gray-400 font-medium">
                  {templates.filter(t => t.channel !== "call" && t.channel !== "whatsapp").length} of 50 created
                </span>
                
                {/* HubSpot Dropdown button */}
                <div className="relative">
                  <Button 
                    onClick={() => setShowAddTemplateDropdown(!showAddTemplateDropdown)}
                    className="bg-zinc-900 dark:bg-white hover:bg-zinc-800 dark:hover:bg-white/90 text-white dark:text-black font-semibold h-8 px-3 rounded-lg text-xs flex items-center gap-1.5 shadow-sm"
                  >
                    <Plus className="w-3.5 h-3.5" /> New template <ChevronDown className="w-3 h-3 ml-0.5" />
                  </Button>
                  {showAddTemplateDropdown && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowAddTemplateDropdown(false)} />
                      <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-[#181818] border border-black/10 dark:border-white/10 rounded-xl shadow-xl z-50 p-1 py-1.5 animate-fade-in">
                        <button
                          onClick={() => {
                            setShowAddTemplateDropdown(false);
                            handleStartCreateTemplate();
                          }}
                          className="w-full text-left px-3 py-2 text-xs text-zinc-700 dark:text-gray-200 hover:bg-zinc-50 dark:hover:bg-white/5 rounded-lg font-medium transition-colors"
                        >
                          From scratch
                        </button>
                        <button
                          onClick={() => {
                            setShowAddTemplateDropdown(false);
                            setLibrarySelectedKeys([]);
                            setSelectedPresetForPreview(TEMPLATE_LIBRARY_PRESETS[0]?.items[0]);
                            setShowLibraryModal(true);
                          }}
                          className="w-full text-left px-3 py-2 text-xs text-zinc-700 dark:text-gray-200 hover:bg-zinc-50 dark:hover:bg-white/5 rounded-lg font-medium transition-colors border-t border-black/5 dark:border-white/5 mt-1 pt-2"
                        >
                          From template library
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Folder Breadcrumb Navigation */}
              <div 
                onDragOver={(e) => {
                  e.preventDefault()
                  if (templateDraggingId) setTemplateDragOverNodePath("")
                }}
                onDragLeave={() => setTemplateDragOverNodePath(null)}
                onDrop={(e) => {
                  e.preventDefault()
                  const dragged = templates.find(t => t.id === templateDraggingId)
                  if (dragged) {
                    handleMoveTemplateToFolder(dragged, "")
                  }
                  setTemplateDraggingId(null)
                  setTemplateDragOverNodePath(null)
                }}
                className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-3.5 border rounded-xl shadow-sm transition-all duration-200 ${
                  templateDragOverNodePath === ""
                    ? "bg-teal-500/10 border-teal-500/30 scale-[1.01]"
                    : "bg-zinc-50/50 dark:bg-black/10 border-black/5 dark:border-white/5"
                }`}
              >
                <div className="flex items-center gap-2 text-xs">
                  <span 
                    onClick={() => setTemplateFolderFilter("all")}
                    className={`cursor-pointer transition-colors px-2 py-0.5 rounded-lg font-medium ${
                      templateFolderFilter === "all"
                        ? "text-zinc-900 dark:text-white bg-black/5 dark:bg-white/5"
                        : "text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white"
                    }`}
                  >
                    All Message Templates
                  </span>
                  {templateFolderFilter !== "all" && (
                    <>
                      <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                      <span className="font-semibold text-zinc-900 dark:text-white bg-black/5 dark:bg-white/5 px-2 py-0.5 rounded-lg">
                        {templateFolderFilter === "__none__" ? "Uncategorized" : templateFolderFilter}
                      </span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={openCreateTemplateFolder}
                    variant="outline"
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                    <span>New Folder</span>
                  </Button>
                </div>
              </div>

              {/* Folders Grid View */}
              {templateFolderFilter === "all" && !templateSearchQuery.trim() && templateFolders.length > 0 && (
                <div className="space-y-3">
                  <div className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">Folders</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {templateFolders.map(folder => {
                      const count = templates.filter(t => t.folder === folder).length
                      const isDragOver = templateDragOverNodePath === folder
                      return (
                        <div
                          key={folder}
                          onClick={() => setTemplateFolderFilter(folder)}
                          onDragOver={(e) => {
                            e.preventDefault()
                            if (templateDraggingId) setTemplateDragOverNodePath(folder)
                          }}
                          onDragLeave={() => {
                            if (templateDragOverNodePath === folder) setTemplateDragOverNodePath(null)
                          }}
                          onDrop={(e) => {
                            e.preventDefault()
                            const dragged = templates.find(t => t.id === templateDraggingId)
                            if (dragged) {
                              handleMoveTemplateToFolder(dragged, folder)
                            }
                            setTemplateDraggingId(null)
                            setTemplateDragOverNodePath(null)
                          }}
                          className={`group relative flex items-center justify-between p-4 rounded-xl border hover:bg-white/60 dark:hover:bg-black/35 hover:border-black/10 dark:hover:border-white/10 shadow-sm transition-all duration-200 cursor-pointer select-none ${
                            isDragOver
                              ? "ring-2 ring-teal-500 border-teal-500/50 bg-teal-500/5 dark:bg-teal-500/10 scale-[1.02]"
                              : "border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20"
                          }`}
                        >
                          <div className="flex items-center gap-3.5 min-w-0">
                            <div className="p-2.5 rounded-lg bg-teal-500/10 dark:bg-teal-500/20 text-teal-500 dark:text-teal-400 shrink-0">
                              <Folder className="w-4 h-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-zinc-900 dark:text-white truncate">{folder}</div>
                              <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-medium">{count} {count === 1 ? "template" : "templates"}</div>
                            </div>
                          </div>
                          
                          {/* Folder Actions */}
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => {
                                  e.stopPropagation()
                                  openRenameTemplateFolder(folder)
                              }}
                              className="p-1 hover:bg-zinc-100 dark:hover:bg-white/5 rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
                              title="Rename folder"
                            >
                              <Edit2 className="w-3 w-3" />
                            </button>
                            <button
                              onClick={(e) => {
                                  e.stopPropagation()
                                  deleteTemplateFolder(folder)
                              }}
                              className="p-1 hover:bg-rose-500/10 rounded text-zinc-500 hover:text-rose-600"
                              title="Delete folder"
                            >
                              <Trash2 className="w-3 w-3" />
                            </button>
                          </div>
                        </div>
                      )
                    })}

                    {(() => {
                      const uncategorizedCount = templates.filter(t => t.channel !== "call" && t.channel !== "whatsapp" && !t.folder).length;
                      if (uncategorizedCount === 0) return null;
                      const isDragOver = templateDragOverNodePath === "__none__"
                      return (
                        <div
                          onClick={() => setTemplateFolderFilter("__none__")}
                          onDragOver={(e) => {
                            e.preventDefault()
                            if (templateDraggingId) setTemplateDragOverNodePath("__none__")
                          }}
                          onDragLeave={() => {
                            if (templateDragOverNodePath === "__none__") setTemplateDragOverNodePath(null)
                          }}
                          onDrop={(e) => {
                            e.preventDefault()
                            const dragged = templates.find(t => t.id === templateDraggingId)
                            if (dragged) {
                              handleMoveTemplateToFolder(dragged, "")
                            }
                            setTemplateDraggingId(null)
                            setTemplateDragOverNodePath(null)
                          }}
                          className={`flex items-center justify-between p-4 rounded-xl border hover:bg-white/60 dark:hover:bg-black/35 hover:border-black/10 dark:hover:border-white/10 shadow-sm transition-all duration-200 cursor-pointer select-none ${
                            isDragOver
                              ? "ring-2 ring-teal-500 border-teal-500/50 bg-teal-500/5 dark:bg-teal-500/10 scale-[1.02]"
                              : "border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20"
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="p-2 rounded-lg bg-zinc-500/10 dark:bg-zinc-500/20 text-zinc-500 shrink-0">
                              <Folder className="w-4 h-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-zinc-900 dark:text-white truncate">Uncategorized</div>
                              <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-medium">{uncategorizedCount} {uncategorizedCount === 1 ? "template" : "templates"}</div>
                            </div>
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                </div>
              )}

              {/* Filters bar */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-zinc-950/[0.02] dark:bg-white/[0.01] border border-black/5 dark:border-white/5 p-3 rounded-xl">
                <div className="flex flex-1 max-w-sm relative items-center">
                  <Search className="absolute left-3 w-4 h-4 text-zinc-400 dark:text-zinc-500 pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search templates"
                    value={templateSearchQuery}
                    onChange={(e) => setTemplateSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-4 py-1.5 bg-white dark:bg-black/30 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white text-xs rounded-xl outline-none focus:border-black/20 dark:focus:border-white/20 transition-all shadow-sm placeholder:text-zinc-400"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500 dark:text-gray-400">Channel:</span>
                  <CustomSelect
                    value={selectedTemplateFilter}
                    onChange={(val) => setSelectedTemplateFilter(val)}
                    options={[
                      { value: "all", label: "All Channels" },
                      { value: "email", label: "Email" },
                      { value: "sms", label: "SMS" },
                      { value: "team_alert", label: "Team Alert" }
                    ]}
                    triggerClassName="h-8 bg-white dark:bg-black/30 border border-black/10 dark:border-white/10 text-zinc-700 dark:text-gray-300 text-xs rounded-xl px-3 outline-none flex items-center gap-4 justify-between"
                  />
                </div>
              </div>

              {(() => {
                const filtered = templates
                  .filter(t => t.channel !== "call" && t.channel !== "whatsapp")
                  .filter(t => {
                    // Folder filter matching
                    if (templateFolderFilter === "all") {
                      // Hide templates that belong to a folder in the root view
                      if (t.folder) return false
                    } else if (templateFolderFilter === "__none__") {
                      if (t.folder) return false
                    } else {
                      if (t.folder !== templateFolderFilter) return false
                    }

                    if (selectedTemplateFilter !== "all" && t.channel !== selectedTemplateFilter) return false
                    if (!templateSearchQuery.trim()) return true
                    const q = templateSearchQuery.toLowerCase()
                    return (
                      (t.template_key || "").toLowerCase().includes(q) ||
                      (t.subject || "").toLowerCase().includes(q) ||
                      (t.body || "").toLowerCase().includes(q) ||
                      (t.notes || "").toLowerCase().includes(q)
                    )
                  })

                if (filtered.length === 0) {
                  return (
                    <div className="text-center py-12 text-xs text-zinc-400 dark:text-gray-500 italic">
                      No templates found matching filters.
                    </div>
                  )
                }

                return (
                  <div className="border border-black/5 dark:border-white/5 rounded-xl overflow-hidden">
                    <Table>
                      <TableHeader className="bg-black/[0.01] dark:bg-white/[0.01] border-b border-black/5 dark:border-white/5">
                        <TableRow className="hover:bg-transparent border-black/5 dark:border-white/5">
                          <TableHead className="w-12 text-center py-3">
                            <input type="checkbox" className="rounded border-zinc-300 dark:border-zinc-700" disabled />
                          </TableHead>
                          <TableHead className="text-xs text-zinc-500 dark:text-gray-400 font-semibold py-3">Name</TableHead>
                          <TableHead className="text-xs text-zinc-500 dark:text-gray-400 font-semibold py-3">Key</TableHead>
                          <TableHead className="text-xs text-zinc-500 dark:text-gray-400 font-semibold py-3">Channel</TableHead>
                          <TableHead className="text-xs text-zinc-500 dark:text-gray-400 font-semibold py-3">Purpose / Notes</TableHead>
                          <TableHead className="text-xs text-zinc-500 dark:text-gray-400 font-semibold py-3 text-right pr-6">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filtered.map((tpl) => {
                          const channel = getTemplateChannelDisplay(tpl.channel)
                          const title = getTemplateTitle(tpl)
                          return (
                            <TableRow 
                              key={tpl.id} 
                              draggable
                              onDragStart={() => setTemplateDraggingId(tpl.id)}
                              onDragEnd={() => setTemplateDraggingId(null)}
                              className={`border-black/5 dark:border-white/5 hover:bg-zinc-950/5 dark:hover:bg-white/[0.01] transition-colors cursor-grab active:cursor-grabbing select-none ${
                                templateDraggingId === tpl.id ? "opacity-45 scale-[0.99] border-dashed border-teal-500/50" : ""
                              }`}
                            >
                              <TableCell className="text-center py-4">
                                <input type="checkbox" className="rounded border-zinc-300 dark:border-zinc-700" disabled />
                              </TableCell>
                              <TableCell className="py-4">
                                <button
                                  onClick={() => handleStartEditTemplate(tpl)}
                                  className="font-semibold text-xs text-teal-600 dark:text-teal-400 hover:underline text-left block"
                                >
                                  {title}
                                </button>
                                {tpl.subject && (
                                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 block mt-0.5 truncate max-w-xs">
                                    Subject: {tpl.subject}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="py-4">
                                <span className="font-mono text-[10px] bg-zinc-100 dark:bg-white/5 px-2 py-0.5 rounded border border-black/5 dark:border-white/5 text-zinc-600 dark:text-zinc-400">
                                  {tpl.template_key}
                                </span>
                              </TableCell>
                              <TableCell className="py-4">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${getTemplateChannelClass(tpl.channel)}`}>
                                  {channel.label}
                                </span>
                                {tpl.folder && (
                                  <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 flex items-center gap-0.5 mt-1">
                                    <Folder className="w-3 h-3 text-zinc-400" /> {tpl.folder}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="py-4 text-xs text-zinc-500 dark:text-gray-400 max-w-xs truncate">
                                {tpl.notes || <span className="italic opacity-60">no notes</span>}
                              </TableCell>
                              <TableCell className="py-4 text-right pr-6">
                                <div className="inline-flex gap-1 justify-end">
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => setPreviewTpl(tpl)}
                                    title="Preview template"
                                    className="h-6 w-6 rounded-md bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-500 dark:text-gray-300"
                                  >
                                    <Eye className="w-3 h-3" />
                                  </Button>
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => handleStartEditTemplate(tpl)}
                                    title="Edit template"
                                    className="h-6 w-6 rounded-md bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-500 dark:text-gray-300"
                                  >
                                    <Edit2 className="w-3 h-3" />
                                  </Button>
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => {
                                      setTemplateToMove(tpl)
                                      setNewFolderInlineName("")
                                      setInlineFolderError("")
                                    }}
                                    title="Move to folder"
                                    className="h-6 w-6 rounded-md bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-500 dark:text-gray-300"
                                  >
                                    <Folder className="w-3 h-3" />
                                  </Button>
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => handleDeleteTemplate(tpl.id)}
                                    title="Delete template"
                                    className="h-6 w-6 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )
              })()}
            </CardContent>
          </Card>
        )}

        {activeTab === "telephony" && (
          <div className="space-y-8">
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                    <AppIcon name="aiAgents" size={20} className="text-zinc-500 dark:text-gray-400" /> AI reply agents
                  </CardTitle>
                  <CardDescription className="text-zinc-500 dark:text-gray-400">
                    Configure AI reply behavior, knowledge, escalation rules, and playground tests.
                  </CardDescription>
                </div>
                <Button
                  onClick={() => router.push("/settings/ai-agents")}
                  className="bg-zinc-950/10 dark:bg-white/10 hover:bg-zinc-950/15 dark:hover:bg-white/15 text-zinc-800 dark:text-white border border-black/10 dark:border-white/10 rounded-xl px-3 py-2 text-xs font-medium"
                >
                  Open AI agents
                </Button>
              </CardHeader>
            </Card>

            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                  <AppIcon name="aiAgents" size={20} className="text-zinc-500 dark:text-gray-400" /> AI & voice connections
                </CardTitle>
                <CardDescription className="text-zinc-500 dark:text-gray-400">
                  Manage active AI, voice, calling, email, and SMS provider credentials.
                </CardDescription>
              </div>
              <Button
                size="sm"
                onClick={handleStartCreateCredential}
                variant="default"
              >
                <Plus className="w-3.5 h-3.5" /> Add Credential
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="border-black/5 dark:border-white/5 bg-black/[0.01] dark:bg-white/[0.01]">
                  <TableRow className="border-black/5 dark:border-white/5 hover:bg-transparent">
                    <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-6">Provider</TableHead>
                    <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-4">Internal Key</TableHead>
                    <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-4 text-center">Status</TableHead>
                    <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-6 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {credentials.length === 0 ? (
                    <TableRow className="border-black/5 dark:border-white/5">
                      <TableCell colSpan={4} className="text-center py-6 text-zinc-400 dark:text-gray-500 text-xs">
                        No credentials added yet. Add one to enable outbound integrations.
                      </TableCell>
                    </TableRow>
                  ) : (
                    credentials.map((cred) => (
                      <TableRow key={cred.id} className="border-black/5 dark:border-white/5 hover:bg-zinc-950/5 dark:hover:bg-white/[0.01] transition-colors">
                        <TableCell className="px-6 py-4">
                          <span className="font-semibold text-zinc-800 dark:text-gray-200 capitalize">{cred.provider}</span>
                        </TableCell>
                        <TableCell className="px-4 py-4">
                          <code className="text-[10px] bg-zinc-950/5 dark:bg-white/5 px-1.5 py-0.5 rounded font-mono text-zinc-700 dark:text-gray-300">
                            {cred.n8n_credential_name}
                          </code>
                        </TableCell>
                        <TableCell className="px-4 py-4 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                            cred.active ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20'
                          }`}>
                            {cred.active ? 'ACTIVE' : 'INACTIVE'}
                          </span>
                        </TableCell>
                        <TableCell className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              onClick={() => handleStartEditCredential(cred)}
                              className="h-7 w-7 rounded-md bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-500 dark:text-gray-300"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              onClick={() => handleDeleteCredential(cred.id)}
                              className="h-7 w-7 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

            {/* Retell Voice Agents Card */}
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                    <Play className="w-5 h-5 text-zinc-500 dark:text-gray-400" /> Voice agents
                  </CardTitle>
                  <CardDescription className="text-zinc-500 dark:text-gray-400">
                    Manage synchronized voice agents and their active mappings.
                  </CardDescription>
                </div>
                <Button
                  onClick={handleSyncRetell}
                  disabled={syncingRetell}
                  variant="default"
                >
                  {syncingRetell ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Syncing...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3.5 h-3.5" /> Sync from Retell
                    </>
                  )}
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader className="border-black/5 dark:border-white/5 bg-black/[0.01] dark:bg-white/[0.01]">
                    <TableRow className="border-black/5 dark:border-white/5 hover:bg-transparent">
                      <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-6">Agent Name</TableHead>
                      <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-4">Agent ID</TableHead>
                      <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-4">Language / Voice</TableHead>
                      <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-4 text-center">Status</TableHead>
                      <TableHead className="text-zinc-500 dark:text-gray-400 font-medium py-3 px-6 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {retellAgents.length === 0 ? (
                      <TableRow className="border-black/5 dark:border-white/5">
                        <TableCell colSpan={5} className="text-center py-6 text-zinc-400 dark:text-gray-500 text-xs">
                          No Retell agents synced yet. Click "Sync from Retell".
                        </TableCell>
                      </TableRow>
                    ) : (
                      retellAgents.map((agent) => (
                        <TableRow key={agent.id} className="border-black/5 dark:border-white/5 hover:bg-zinc-950/5 dark:hover:bg-white/[0.01] transition-colors">
                          <TableCell className="px-6 py-4">
                            <div className="font-semibold text-zinc-800 dark:text-gray-200">{agent.name}</div>
                            {agent.description && (
                              <div className="text-xs text-zinc-500 dark:text-gray-400 mt-0.5">{agent.description}</div>
                            )}
                          </TableCell>
                          <TableCell className="px-4 py-4 font-mono text-xs text-zinc-600 dark:text-gray-300">
                            {agent.agent_id}
                          </TableCell>
                          <TableCell className="px-4 py-4 text-xs text-zinc-600 dark:text-gray-300">
                            <div>{agent.language || "—"}</div>
                            <div className="text-[10px] text-zinc-400 dark:text-gray-500 mt-0.5">{agent.voice_id || "—"}</div>
                          </TableCell>
                          <TableCell className="px-4 py-4 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                              agent.active ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20'
                            }`}>
                              {agent.active ? 'ACTIVE' : 'INACTIVE'}
                            </span>
                          </TableCell>
                          <TableCell className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => handleToggleAgentActive(agent.id, agent.active)}
                                title={agent.active ? "Click to deactivate" : "Click to activate"}
                                className="text-zinc-600 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
                              >
                                {agent.active ? (
                                  <ToggleRight className="w-8 h-8 text-emerald-600 dark:text-emerald-400" />
                                ) : (
                                  <ToggleLeft className="w-8 h-8 text-zinc-400 dark:text-gray-600" />
                                )}
                              </button>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => handleDeleteAgent(agent.id)}
                                className="h-7 w-7 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Retell Phone Numbers Card */}
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
              <CardHeader>
                <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                  <AppIcon name="channels" size={20} className="text-zinc-500 dark:text-gray-400" /> Calling numbers
                </CardTitle>
                <CardDescription className="text-zinc-500 dark:text-gray-400">
                  Synchronized outbound and inbound phone numbers for voice follow-up.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader className="border-black/5 dark:border-white/5 bg-black/[0.01] dark:bg-white/[0.01]">
                    <TableRow className="border-black/5 dark:border-white/5 hover:bg-transparent">
                      <TableHead className="text-zinc-600 dark:text-gray-400 font-medium py-3 px-6">Phone Number</TableHead>
                      <TableHead className="text-zinc-600 dark:text-gray-400 font-medium py-3 px-4">Nickname</TableHead>
                      <TableHead className="text-zinc-600 dark:text-gray-400 font-medium py-3 px-4">Assigned Agent</TableHead>
                      <TableHead className="text-zinc-600 dark:text-gray-400 font-medium py-3 px-4">Last Synced</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {retellPhoneNumbers.length === 0 ? (
                      <TableRow className="border-black/5 dark:border-white/5">
                        <TableCell colSpan={4} className="text-center py-6 text-zinc-400 dark:text-gray-500 text-xs">
                          No phone numbers synced yet. Click "Sync from Retell" above.
                        </TableCell>
                      </TableRow>
                    ) : (
                      retellPhoneNumbers.map((phone) => (
                        <TableRow key={phone.id} className="border-black/5 dark:border-white/5 hover:bg-zinc-950/5 dark:hover:bg-white/[0.01] transition-colors">
                          <TableCell className="px-6 py-4 font-mono text-sm text-zinc-800 dark:text-gray-200">
                            {phone.phone_number_pretty || phone.phone_number}
                          </TableCell>
                          <TableCell className="px-4 py-4 text-xs text-zinc-600 dark:text-gray-300">
                            {phone.nickname || "—"}
                          </TableCell>
                          <TableCell className="px-4 py-4 text-xs text-zinc-600 dark:text-gray-300">
                            {phone.outbound_agent_id ? (
                              <div>Outbound: <code className="text-[10px] bg-zinc-950/5 dark:bg-white/5 px-1 rounded font-mono">{phone.outbound_agent_id}</code></div>
                            ) : phone.inbound_agent_id ? (
                              <div>Inbound: <code className="text-[10px] bg-zinc-950/5 dark:bg-white/5 px-1 rounded font-mono">{phone.inbound_agent_id}</code></div>
                            ) : (
                              <span className="text-zinc-400 dark:text-gray-500">Unassigned</span>
                            )}
                          </TableCell>
                          <TableCell className="px-4 py-4 text-[10px] text-zinc-500 dark:text-gray-500">
                            {phone.last_synced_at ? new Date(phone.last_synced_at).toLocaleString() : "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "data" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
              <CardHeader>
                <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                  <AppIcon name="customFields" size={20} className="text-zinc-500 dark:text-gray-400" /> Lead fields
                </CardTitle>
                <CardDescription className="text-zinc-500 dark:text-gray-400">
                  Manage custom lead fields, folders, display order, and validation rules.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => router.push("/settings/custom-fields")}
                  className="bg-zinc-900 dark:bg-white hover:bg-zinc-800 dark:hover:bg-white/90 text-white dark:text-black font-semibold h-9 rounded-xl text-xs"
                >
                  Open custom fields
                </Button>
              </CardContent>
            </Card>

            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
              <CardHeader>
                <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                  <AppIcon name="suppressions" size={20} className="text-zinc-500 dark:text-gray-400" /> Suppressions
                </CardTitle>
                <CardDescription className="text-zinc-500 dark:text-gray-400">
                  Review leads who should not be contacted because of opt-outs, bounces, or manual suppression.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => router.push("/suppressions")}
                  className="bg-zinc-900 dark:bg-white hover:bg-zinc-800 dark:hover:bg-white/90 text-white dark:text-black font-semibold h-9 rounded-xl text-xs"
                >
                  Open suppressions
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "developer" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
              <CardHeader>
                <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                  <AppIcon name="developer" size={20} className="text-zinc-500 dark:text-gray-400" /> Provider credentials
                </CardTitle>
                <CardDescription className="text-zinc-500 dark:text-gray-400">
                  Advanced credentials and raw provider configuration remain in AI &amp; voice connections.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => setActiveTab("telephony")}
                  className="bg-zinc-900 dark:bg-white hover:bg-zinc-800 dark:hover:bg-white/90 text-white dark:text-black font-semibold h-9 rounded-xl text-xs"
                >
                  Open credentials
                </Button>
              </CardContent>
            </Card>

            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl">
              <CardHeader>
                <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                  <AppIcon name="data" size={20} className="text-zinc-500 dark:text-gray-400" /> Data mapping
                </CardTitle>
                <CardDescription className="text-zinc-500 dark:text-gray-400">
                  Configure custom fields used by templates, journey conditions, and webhook payload mapping.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => router.push("/settings/custom-fields")}
                  className="bg-zinc-900 dark:bg-white hover:bg-zinc-800 dark:hover:bg-white/90 text-white dark:text-black font-semibold h-9 rounded-xl text-xs"
                >
                  Open data mapping
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "access" && (
          <div className="space-y-8">
            <UsagePanel />
            <MembersPanel />
          </div>
        )}
      </div>

      {showCredModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl relative">
            <button 
              onClick={() => setShowCredModal(false)}
              className="absolute top-4 right-4 text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-lg font-bold text-zinc-900 dark:text-white">
              {editingCred ? "Edit Credential" : "Add Credential"}
            </h3>
            <form onSubmit={handleSaveCredential} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-zinc-500 dark:text-gray-400">Provider</Label>
                  <CustomSelect 
                    value={credForm.provider}
                    onChange={(val) => setCredForm({ ...credForm, provider: val, config: {} })}
                    options={[
                      { value: "retell", label: "Retell AI" },
                      { value: "twilio", label: "Twilio" },
                      { value: "gmail", label: "Gmail" },
                      { value: "anthropic", label: "Anthropic (Claude)" },
                      { value: "openai", label: "OpenAI" },
                      { value: "openrouter", label: "OpenRouter (100+ models)" },
                      { value: "custom", label: "Custom Provider" }
                    ]}
                    triggerClassName="w-full h-9 bg-white dark:bg-surface-2 border border-black/10 dark:border-white/5 text-zinc-700 dark:text-gray-300 text-xs rounded-xl px-3 outline-none flex items-center justify-between capitalize"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-zinc-500 dark:text-gray-400">Internal Credential Key</Label>
                  <Input 
                    placeholder="e.g. followup_retell_key"
                    value={credForm.n8n_credential_name}
                    onChange={(e) => setCredForm({ ...credForm, n8n_credential_name: e.target.value })}
                    className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-600 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20 font-mono text-xs"
                    required
                  />
                </div>
              </div>

              {/* Dynamic Config UI based on provider */}
              <div className="space-y-3 bg-zinc-950/5 dark:bg-black/20 p-4 rounded-xl border border-black/5 dark:border-white/5">
                <span className="text-[10px] text-zinc-400 dark:text-gray-500 uppercase tracking-wider font-semibold block">
                  Configuration Map
                </span>
                
                {credForm.provider === 'retell' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-500 dark:text-gray-400">From Number</Label>
                      <Input 
                        placeholder="+15551234567"
                        value={credForm.config.from_number || ""}
                        onChange={(e) => setCredForm({ ...credForm, config: { ...credForm.config, from_number: e.target.value }})}
                        className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-500 dark:text-gray-400">Agent ID</Label>
                      <Input 
                        placeholder="agent_xxxxx"
                        value={credForm.config.agent_id || ""}
                        onChange={(e) => setCredForm({ ...credForm, config: { ...credForm.config, agent_id: e.target.value }})}
                        className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs"
                      />
                    </div>
                  </div>
                )}
                
                {credForm.provider === 'twilio' && (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-500 dark:text-gray-400">From Number</Label>
                      <Input
                        placeholder="+15551234567"
                        value={credForm.config.from_number || ""}
                        onChange={(e) => setCredForm({ ...credForm, config: { ...credForm.config, from_number: e.target.value }})}
                        className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-500 dark:text-gray-400">Messaging Service SID <span className="text-zinc-400">(recommended for production)</span></Label>
                      <Input
                        placeholder="MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                        value={credForm.config.messaging_service_sid || ""}
                        onChange={(e) => setCredForm({ ...credForm, config: { ...credForm.config, messaging_service_sid: e.target.value.trim() }})}
                        className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs font-mono"
                      />
                      <p className="text-[10px] text-zinc-500 leading-relaxed">
                        Twilio Console → Messaging → Services → your service → "Service SID". When set, the engine uses it instead of From Number — unlocks sender pools, geo permissions, opt-out automation, scheduled messages.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-500 dark:text-gray-400">Account SID</Label>
                      <Input
                        placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                        value={credForm.config.account_sid || ""}
                        onChange={(e) => setCredForm({ ...credForm, config: { ...credForm.config, account_sid: e.target.value.trim() }})}
                        className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-500 dark:text-gray-400">Auth Token</Label>
                      <Input
                        type="password"
                        placeholder="••••••••••••••••••••••••••••••••"
                        value={credForm.config.auth_token || ""}
                        onChange={(e) => setCredForm({ ...credForm, config: { ...credForm.config, auth_token: e.target.value.trim() }})}
                        className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs font-mono"
                      />
                      <p className="text-[10px] text-zinc-500 leading-relaxed">
                        Account SID + Auth Token: Twilio Console → Account → API keys & tokens → LIVE Auth Token. Required so the engine can dispatch SMS directly + verify delivery status. Stored encrypted; only the engine reads it.
                      </p>
                    </div>
                  </div>
                )}

                {credForm.provider === 'gmail' && (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-500 dark:text-gray-400">Google Client ID</Label>
                      <Input
                        placeholder="xxxxxx.apps.googleusercontent.com"
                        value={credForm.config.google_client_id || ""}
                        onChange={(e) => setCredForm({ ...credForm, config: { ...credForm.config, google_client_id: e.target.value.trim() }})}
                        className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-500 dark:text-gray-400">Google Client Secret</Label>
                      <Input
                        type="password"
                        placeholder="••••••••••••••••••••"
                        value={credForm.config.google_client_secret || ""}
                        onChange={(e) => setCredForm({ ...credForm, config: { ...credForm.config, google_client_secret: e.target.value.trim() }})}
                        className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs font-mono"
                      />
                      <p className="text-[10px] text-zinc-500 leading-relaxed">
                        Get both from Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs. Use a Web Application client. Set the Authorized Redirect URI to <code className="font-mono bg-zinc-200/40 dark:bg-white/5 px-1 rounded text-[10px]">{typeof window !== 'undefined' ? window.location.origin : '<your-app-url>'}/api/oauth/google/callback</code>. Internal-user OAuth apps (scoped to your Google Workspace) don't need Google verification.
                      </p>
                    </div>
                  </div>
                )}

                {credForm.provider === 'anthropic' && (
                  <div className="space-y-1">
                    <Label className="text-xs text-zinc-500 dark:text-gray-400">Anthropic API Key</Label>
                    <Input
                      type="password"
                      placeholder="sk-ant-api03-…"
                      value={credForm.config.api_key || ""}
                      onChange={(e) => setCredForm({ ...credForm, config: { ...credForm.config, api_key: e.target.value.trim() }})}
                      className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs font-mono"
                    />
                    <p className="text-[10px] text-zinc-500 leading-relaxed">
                      Get from <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="underline">console.anthropic.com → API Keys</a>. Used by your AI Agents (Settings → AI Agents) when configured with provider=anthropic.
                    </p>
                  </div>
                )}

                {credForm.provider === 'openai' && (
                  <div className="space-y-1">
                    <Label className="text-xs text-zinc-500 dark:text-gray-400">OpenAI API Key</Label>
                    <Input
                      type="password"
                      placeholder="sk-…"
                      value={credForm.config.api_key || ""}
                      onChange={(e) => setCredForm({ ...credForm, config: { ...credForm.config, api_key: e.target.value.trim() }})}
                      className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs font-mono"
                    />
                    <p className="text-[10px] text-zinc-500 leading-relaxed">
                      Get from <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="underline">platform.openai.com → API Keys</a>. Used by your AI Agents (Settings → AI Agents) when configured with provider=openai.
                    </p>
                  </div>
                )}

                {credForm.provider === 'openrouter' && (
                  <div className="space-y-1">
                    <Label className="text-xs text-zinc-500 dark:text-gray-400">OpenRouter API Key</Label>
                    <Input
                      type="password"
                      placeholder="sk-or-v1-…"
                      value={credForm.config.api_key || ""}
                      onChange={(e) => setCredForm({ ...credForm, config: { ...credForm.config, api_key: e.target.value.trim() }})}
                      className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs font-mono"
                    />
                    <p className="text-[10px] text-zinc-500 leading-relaxed">
                      Get from <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" className="underline">openrouter.ai → Settings → Keys</a>. Gives access to 100+ models (OpenAI, Anthropic, Llama, DeepSeek, Gemini, Mistral, Qwen) through one API. Used by your AI Agents when configured with provider=openrouter. <span className="text-amber-600 dark:text-amber-400">Free-tier models are rate-limited (~20 req/min) and may skip strict JSON — good for testing, not production traffic.</span>
                    </p>
                  </div>
                )}

                {(credForm.provider !== 'retell' && credForm.provider !== 'twilio' && credForm.provider !== 'gmail' && credForm.provider !== 'anthropic' && credForm.provider !== 'openai' && credForm.provider !== 'openrouter') && (
                  <div className="space-y-1">
                    <Label className="text-xs text-zinc-500 dark:text-gray-400">Raw JSON Config</Label>
                    <textarea
                      rows="4"
                      value={JSON.stringify(credForm.config, null, 2)}
                      onChange={(e) => {
                        try {
                          const parsed = JSON.parse(e.target.value);
                          setCredForm({ ...credForm, config: parsed });
                        } catch (err) {
                        }
                      }}
                      placeholder="{}"
                      className="w-full bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-700 dark:text-gray-300 text-xs rounded-xl p-3 outline-none focus:border-black/20 dark:focus:border-white/20 font-mono"
                    ></textarea>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input 
                  type="checkbox"
                  id="credActive"
                  checked={credForm.active}
                  onChange={(e) => setCredForm({ ...credForm, active: e.target.checked })}
                  className="w-4 h-4 rounded border-black/15 dark:border-white/10 bg-white dark:bg-black/40 text-zinc-900 dark:text-white focus:ring-0"
                />
                <Label htmlFor="credActive" className="text-xs text-zinc-700 dark:text-gray-300 cursor-pointer">
                  Credential is Active
                </Label>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <Button 
                  type="button" 
                  onClick={() => setShowCredModal(false)}
                  className="bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-800 dark:text-white border border-black/5 dark:border-white/5 rounded-xl text-xs h-9 px-4"
                >
                  Cancel
                </Button>
                <Button 
                  type="submit"
                  variant="default"
                >
                  Save Credential
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Gmail test-send modal — proves the OAuth + Gmail chain works without
          touching actions / templates / leads. Sends a one-off email through
          the picked sender. Counts against daily cap to stay honest. */}
      {testSendSender && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl relative">
            <button
              onClick={() => setTestSendSender(null)}
              className="absolute top-4 right-4 text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white"
              type="button"
            >
              <X className="w-5 h-5" />
            </button>
            <div>
              <h3 className="text-lg font-bold text-zinc-900 dark:text-white">Send Test Email</h3>
              <p className="text-xs text-zinc-500 dark:text-gray-400 mt-1">
                From <span className="font-mono">{testSendSender.sender_email}</span> via Gmail API. This counts against the sender's daily cap.
              </p>
            </div>
            <form onSubmit={handleSubmitTestSend} className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-500 dark:text-gray-400">To</Label>
                <Input
                  type="email"
                  required
                  value={testSendForm.to}
                  onChange={(e) => setTestSendForm({ ...testSendForm, to: e.target.value })}
                  placeholder="recipient@example.com"
                  className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-500 dark:text-gray-400">Subject</Label>
                <Input
                  required
                  value={testSendForm.subject}
                  onChange={(e) => setTestSendForm({ ...testSendForm, subject: e.target.value })}
                  className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-500 dark:text-gray-400">Body (HTML)</Label>
                <textarea
                  rows={6}
                  value={testSendForm.body_html}
                  onChange={(e) => setTestSendForm({ ...testSendForm, body_html: e.target.value })}
                  className="w-full bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white rounded-xl px-3 py-2 text-sm font-mono outline-none focus:border-black/20 dark:focus:border-white/20"
                />
                <p className="text-[10px] text-zinc-500 dark:text-gray-500">
                  Plain text is auto-derived from the HTML for multipart sends.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-500 dark:text-gray-400">Format</Label>
                <div className="flex gap-2">
                  {[
                    { v: "both",  label: "Both (recommended)", hint: "multipart/alternative — best deliverability" },
                    { v: "plain", label: "Plain text only",     hint: "highest reply-rate for cold outreach" },
                    { v: "html",  label: "HTML only",           hint: "less reliable across spam filters" },
                  ].map((opt) => (
                    <button
                      key={opt.v}
                      type="button"
                      onClick={() => setTestSendForm({ ...testSendForm, body_format: opt.v })}
                      title={opt.hint}
                      className={`text-[11px] px-2.5 py-1.5 rounded-lg border transition-colors ${
                        testSendForm.body_format === opt.v
                          ? "bg-blue-500/15 border-blue-500/40 text-blue-700 dark:text-blue-300"
                          : "bg-zinc-950/5 dark:bg-white/5 border-black/5 dark:border-white/5 text-zinc-600 dark:text-gray-400 hover:bg-zinc-950/10 dark:hover:bg-white/10"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  onClick={() => setTestSendSender(null)}
                  className="bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-800 dark:text-white border border-black/5 dark:border-white/5 rounded-xl text-xs h-9 px-4"
                  disabled={testSendBusy}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="default"
                  disabled={testSendBusy}
                >
                  {testSendBusy ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending…
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" /> Send test
                    </>
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {previewTpl && (() => {
        const channel = getTemplateChannelDisplay(previewTpl.channel)
        const cleanBody = normalizeTemplateText(previewTpl.body)
        const warnings = validateMergeTags(`${previewTpl.subject || ""}\n${cleanBody}`)
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-2xl relative">
              <button
                onClick={() => setPreviewTpl(null)}
                className="absolute top-4 right-4 text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white"
                type="button"
              >
                <X className="w-5 h-5" />
              </button>
              <div className="space-y-1 pr-8">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-lg font-bold text-zinc-900 dark:text-white">{getTemplateTitle(previewTpl)}</h3>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${getTemplateChannelClass(previewTpl.channel)}`}>
                    {channel.label}
                  </span>
                </div>
                <p className="text-[10px] text-zinc-400 dark:text-gray-500">
                  Key: <span className="font-mono">{previewTpl.template_key}</span>
                </p>
              </div>

              {previewTpl.subject && (
                <div className="rounded-xl border border-black/5 dark:border-white/10 bg-zinc-950/5 dark:bg-black/20 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Subject</div>
                  <div className="text-sm text-zinc-900 dark:text-white mt-1">{previewTpl.subject}</div>
                </div>
              )}

              <div className="rounded-xl border border-black/5 dark:border-white/10 bg-zinc-950/5 dark:bg-black/20 px-3 py-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Message</div>
                <div className="text-sm text-zinc-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed mt-2 max-h-[45vh] overflow-y-auto">
                  {cleanBody}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 text-[10px] text-zinc-500 dark:text-gray-400">
                <span>Usage not available</span>
                {warnings.length > 0 ? (
                  <span className="text-amber-700 dark:text-amber-300">Review merge tag warnings before using.</span>
                ) : (
                  <span>No malformed merge tags detected.</span>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {showTemplateFolderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-2xl max-w-md w-full shadow-2xl p-6 relative">
            <button 
              onClick={() => setShowTemplateFolderModal(false)}
              className="absolute top-4 right-4 text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-base font-bold text-zinc-900 dark:text-white mb-4">
              {templateFolderForm.originalName ? "Rename Folder" : "New Folder"}
            </h3>
            {templateFolderError && (
              <Alert variant="danger" size="sm" className="mb-4">{templateFolderError}</Alert>
            )}
            <form onSubmit={saveTemplateFolder} className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold text-zinc-400 dark:text-gray-500">Folder Name</Label>
                <Input
                  placeholder="e.g. Welcome Series"
                  value={templateFolderForm.name}
                  onChange={(e) => setTemplateFolderForm({ ...templateFolderForm, name: e.target.value })}
                  className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
                  required
                  autoFocus
                />
              </div>
              <div className="flex justify-end gap-2.5 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowTemplateFolderModal(false)}
                  className="rounded-xl px-4 py-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={savingTemplateFolder}
                  variant="default"
                >
                  {savingTemplateFolder ? "Saving..." : "Save"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {templateToMove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-2xl max-w-md w-full shadow-2xl p-6 relative">
            <button 
              onClick={() => {
                setTemplateToMove(null)
                setInlineFolderError("")
                setNewFolderInlineName("")
              }}
              className="absolute top-4 right-4 text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-base font-bold text-zinc-900 dark:text-white mb-1.5 flex items-center gap-2">
              <Folder className="w-4 h-4 text-teal-500" /> Move Template to Folder
            </h3>
            <p className="text-xs text-zinc-500 dark:text-gray-400 mb-4 truncate">
              Moving <span className="font-semibold text-zinc-800 dark:text-zinc-200">"{templateToMove.notes || templateToMove.template_key}"</span>
            </p>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold text-zinc-400 dark:text-gray-500">Choose Existing Folder</Label>
                <CustomSelect 
                  value={templateToMove.folder || ""}
                  onChange={(val) => {
                    setTemplateToMove({ ...templateToMove, folder: val })
                  }}
                  options={[
                    { value: "", label: "— No folder (Uncategorized) —" },
                    ...templateFolders.map(f => ({ value: f, label: f }))
                  ]}
                  triggerClassName="w-full h-9 bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-700 dark:text-gray-300 text-xs rounded-xl px-3 outline-none flex items-center justify-between"
                />
              </div>

              <div className="border-t border-black/5 dark:border-white/5 my-2 pt-3 space-y-2">
                <Label className="text-[10px] uppercase font-bold text-zinc-400 dark:text-gray-500">Or Create New Folder</Label>
                {inlineFolderError && (
                  <Alert variant="danger" size="sm">{inlineFolderError}</Alert>
                )}
                <div className="flex gap-2">
                  <Input
                    placeholder="New folder name..."
                    value={newFolderInlineName}
                    onChange={(e) => setNewFolderInlineName(e.target.value)}
                    className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 text-xs rounded-lg flex-1"
                  />
                  <Button
                    onClick={handleCreateInlineFolder}
                    disabled={creatingInlineFolder || !newFolderInlineName.trim()}
                    variant="default"
                  >
                    {creatingInlineFolder ? "Creating..." : "Create"}
                  </Button>
                </div>
              </div>

              <div className="flex justify-end gap-2.5 pt-3 border-t border-black/5 dark:border-white/5 mt-4">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setTemplateToMove(null)
                    setInlineFolderError("")
                    setNewFolderInlineName("")
                  }}
                  className="rounded-xl px-4 py-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    await handleMoveTemplateToFolder(templateToMove, templateToMove.folder)
                    setTemplateToMove(null)
                  }}
                  className="bg-teal-600 hover:bg-teal-500 dark:bg-teal-500 dark:hover:bg-teal-400 text-white font-semibold rounded-xl px-4 py-2 text-xs shadow-sm"
                >
                  Move Template
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showLibraryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-2xl max-w-4xl w-full flex flex-col h-[600px] overflow-hidden shadow-2xl relative">
            <button 
              onClick={() => setShowLibraryModal(false)}
              className="absolute top-4 right-4 text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white z-50"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="px-6 py-4 border-b border-black/5 dark:border-white/5 bg-zinc-50 dark:bg-black/10">
              <h3 className="text-lg font-bold text-zinc-900 dark:text-white">
                Template Library
              </h3>
              <p className="text-xs text-zinc-500 dark:text-gray-400 mt-0.5">
                Select template presets to import them into your workspace.
              </p>
            </div>
            
            <div className="flex flex-1 overflow-hidden">
              {/* Left pane: presets list */}
              <div className="w-1/2 border-r border-black/5 dark:border-white/10 overflow-y-auto p-4 space-y-5">
                {TEMPLATE_LIBRARY_PRESETS.map((cat) => (
                  <div key={cat.category} className="space-y-2">
                    <h4 className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 tracking-wider uppercase">
                      {cat.category}
                    </h4>
                    <div className="space-y-2">
                      {cat.items.map((item) => {
                        const isSelected = librarySelectedKeys.includes(item.key)
                        const isCurrentPreview = selectedPresetForPreview?.key === item.key
                        const channelDisplay = getTemplateChannelDisplay(item.channel)
                        return (
                          <div
                            key={item.key}
                            onClick={() => {
                              setSelectedPresetForPreview(item)
                              if (isSelected) {
                                setLibrarySelectedKeys(librarySelectedKeys.filter(k => k !== item.key))
                              } else {
                                setLibrarySelectedKeys([...librarySelectedKeys, item.key])
                              }
                            }}
                            className={`border rounded-xl p-3.5 flex items-start gap-3 cursor-pointer transition-all duration-200 ${
                              isCurrentPreview
                                ? "border-zinc-900 dark:border-white bg-zinc-50 dark:bg-white/5"
                                : "border-black/5 dark:border-white/5 hover:border-black/10 dark:hover:border-white/10"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              readOnly
                              className="w-4 h-4 rounded border-zinc-300 dark:border-zinc-700 mt-0.5 cursor-pointer pointer-events-none"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-bold text-zinc-800 dark:text-white truncate">
                                  {item.name}
                                </span>
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${getTemplateChannelClass(item.channel)}`}>
                                  {channelDisplay.label}
                                </span>
                              </div>
                              <p className="text-[10px] text-zinc-500 dark:text-gray-400 mt-1 line-clamp-1">
                                {item.notes}
                              </p>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* Right pane: preview */}
              <div className="w-1/2 bg-zinc-50/50 dark:bg-black/10 overflow-y-auto p-6 space-y-4">
                {selectedPresetForPreview ? (
                  <div className="space-y-4">
                    <div>
                      <div className="text-[10px] uppercase font-bold text-zinc-400 tracking-wider">
                        Template Preview
                      </div>
                      <h4 className="text-base font-bold text-zinc-900 dark:text-white mt-1">
                        {selectedPresetForPreview.name}
                      </h4>
                      <div className="text-[10px] font-mono text-zinc-400 mt-0.5">
                        Key: {selectedPresetForPreview.key}
                      </div>
                    </div>

                    <div className="bg-white dark:bg-black/30 border border-black/5 dark:border-white/5 rounded-2xl p-4.5 space-y-3.5 shadow-sm">
                      {selectedPresetForPreview.subject && (
                        <div className="border-b border-black/5 dark:border-white/5 pb-2.5">
                          <span className="text-[10px] font-semibold text-zinc-400 dark:text-gray-500 uppercase tracking-wider block">
                            Subject
                          </span>
                          <span className="text-xs text-zinc-800 dark:text-gray-200 font-medium block mt-0.5">
                            {selectedPresetForPreview.subject}
                          </span>
                        </div>
                      )}
                      <div>
                        <span className="text-[10px] font-semibold text-zinc-400 dark:text-gray-500 uppercase tracking-wider block">
                          Message Body
                        </span>
                        <div className="text-xs text-zinc-700 dark:text-gray-300 whitespace-pre-wrap font-sans mt-1.5 leading-relaxed bg-zinc-50 dark:bg-black/20 p-3 rounded-xl border border-black/5 dark:border-white/5">
                          {selectedPresetForPreview.body}
                        </div>
                      </div>
                    </div>

                    <div className="text-[10px] text-zinc-400 dark:text-zinc-500 flex items-start gap-1 bg-zinc-50 dark:bg-white/5 p-3 rounded-xl border border-black/5 dark:border-white/5">
                      <Info className="w-3.5 h-3.5 mt-0.5 text-zinc-500" />
                      <span>This template uses dynamic variables like first_name. Values are replaced dynamically during journey runs.</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center text-zinc-400">
                    <Info className="w-8 h-8 mb-2 opacity-50" />
                    <span className="text-xs italic">Select a template preset on the left to preview it.</span>
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-3 border-t border-black/5 dark:border-white/5 flex items-center justify-between bg-zinc-50 dark:bg-black/10">
              <span className="text-xs text-zinc-500 dark:text-gray-400 font-medium">
                {librarySelectedKeys.length} template(s) selected
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowLibraryModal(false)}
                  className="rounded-lg text-xs"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleImportSelectedPresets}
                  disabled={librarySelectedKeys.length === 0 || importingPresets}
                  variant="default"
                >
                  {importingPresets && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Save my selections
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showTplModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-2xl max-w-4xl w-full flex flex-col h-[650px] overflow-hidden shadow-2xl relative">
            <button 
              onClick={() => setShowTplModal(false)}
              className="absolute top-4 right-4 text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white z-50"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-black/5 dark:border-white/5 bg-zinc-50 dark:bg-black/10 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-zinc-900 dark:text-white">
                  {editingTpl ? "Edit Template" : "Compose Message Template"}
                </h3>
                <p className="text-[11px] text-zinc-500 dark:text-gray-400 mt-0.5">
                  Compose templates and preview them live against test contacts.
                </p>
              </div>
            </div>

            {(() => {
              const mergeWarnings = validateMergeTags(`${tplForm.subject || ""}\n${normalizeTemplateText(tplForm.body)}`)
              
              const activeLead = previewLeads.find(l => String(l.id) === String(selectedPreviewLeadId))

              // Live sample contact, merging selected real lead if available.
              // Phone tags: the leads table has phone_e164 + phone_raw (no `phone`).
              // We derive a single `phone` value from those and expose all three keys
              // so any template shape resolves correctly against the preview.
              const previewPhone =
                activeLead?.phone_e164 || activeLead?.phone_raw || "+1 (555) 019-2834"
              const sampleContact = {
                first_name: activeLead?.first_name || "Brian",
                last_name: activeLead?.last_name || "Halligan",
                email: activeLead?.email || "brian@hubspot.com",
                phone:      previewPhone,
                phone_e164: previewPhone,
                phone_raw:  activeLead?.phone_raw || previewPhone,
                company: activeLead?.company || "HubSpot, Inc.",
                source: activeLead?.source || "Inbound Content",
                zip_code: activeLead?.zip_code || "02141",
                address: activeLead?.address_line1 || activeLead?.address || "25 First Street, Cambridge, MA",
                timezone: activeLead?.timezone || "America/New_York",
              }

              // Unpack custom fields
              if (activeLead && activeLead.custom_fields && typeof activeLead.custom_fields === 'object') {
                Object.keys(activeLead.custom_fields).forEach(key => {
                  sampleContact[key] = activeLead.custom_fields[key] || ""
                })
              }

              // Unpack raw payload walking parameters (e.g. raw_payload.recording_url)
              const flattenPayload = (obj, prefix = "raw_payload.") => {
                const res = {}
                const recurse = (val, path) => {
                  if (val && typeof val === "object" && !Array.isArray(val)) {
                    Object.keys(val).forEach(k => {
                      recurse(val[k], path ? `${path}.${k}` : k)
                    })
                  } else {
                    res[prefix + path] = val !== null && val !== undefined ? String(val) : ""
                  }
                }
                recurse(obj, "")
                return res
              }

              if (activeLead && activeLead.raw_payload && typeof activeLead.raw_payload === 'object') {
                const flattened = flattenPayload(activeLead.raw_payload)
                Object.keys(flattened).forEach(key => {
                  sampleContact[key] = flattened[key]
                })
              }

              const previewSubject = tplForm.channel === 'email' ? getLivePreviewText(tplForm.subject, sampleContact) : ""
              const previewBody = getLivePreviewText(tplForm.body, sampleContact)

              function getLivePreviewText(text = "", vars = {}) {
                let preview = normalizeTemplateText(text)
                Object.keys(vars).forEach(key => {
                  const regex = new RegExp(`{{\\s*${key}\\s*}}`, "g")
                  preview = preview.replace(regex, vars[key])
                })
                return preview
              }

              return (
                <form onSubmit={handleSaveTemplate} className="flex flex-col flex-1 overflow-hidden">
                  <div className="flex flex-1 overflow-hidden">
                    {/* Left Pane: Compose form */}
                    <div className="w-1/2 border-r border-black/5 dark:border-white/10 overflow-y-auto p-6 space-y-4">
                      <div className="text-[11px] font-bold text-zinc-400 dark:text-zinc-500 tracking-wider uppercase">
                        Compose Template
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase font-bold text-zinc-400 dark:text-gray-500">Template Name / Notes</Label>
                        <Input
                          placeholder="e.g. Inbound Lead from Content"
                          value={tplForm.notes}
                          onChange={(e) => setTplForm({ ...tplForm, notes: e.target.value })}
                          className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-600 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label className="text-[10px] uppercase font-bold text-zinc-400 dark:text-gray-500">Key</Label>
                          <Input 
                            placeholder="e.g. email_welcome"
                            value={tplForm.template_key}
                            onChange={(e) => setTplForm({ ...tplForm, template_key: e.target.value })}
                            className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-600 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
                            required
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-[10px] uppercase font-bold text-zinc-400 dark:text-gray-500">Channel</Label>
                          <CustomSelect 
                            value={tplForm.channel}
                            onChange={(val) => setTplForm({ ...tplForm, channel: val })}
                            options={[
                              { value: "email", label: "Email" },
                              { value: "sms", label: "SMS" },
                              { value: "team_alert", label: "Team alert" }
                            ]}
                            triggerClassName="w-full h-9 bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-700 dark:text-gray-300 text-xs rounded-xl px-3 outline-none flex items-center justify-between"
                          />
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase font-bold text-zinc-400 dark:text-gray-500">Folder</Label>
                        <CustomSelect 
                          value={tplForm.folder || ""}
                          onChange={(val) => setTplForm({ ...tplForm, folder: val })}
                          options={[
                            { value: "", label: "— No folder (Uncategorized) —" },
                            ...templateFolders.map(f => ({ value: f, label: f }))
                          ]}
                          triggerClassName="w-full h-9 bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-700 dark:text-gray-300 text-xs rounded-xl px-3 outline-none flex items-center justify-between"
                        />
                      </div>

                      {tplForm.channel === 'email' && (
                        <div className="space-y-1.5">
                          <Label className="text-[10px] uppercase font-bold text-zinc-400 dark:text-gray-500">Email Subject</Label>
                          <Input 
                            placeholder="e.g. Welcome to Example Co!"
                            value={tplForm.subject}
                            onChange={(e) => setTplForm({ ...tplForm, subject: e.target.value })}
                            className="bg-white dark:bg-black/40 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-600 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
                            required
                          />
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase font-bold text-zinc-400 dark:text-gray-500">Message Body</Label>
                        <textarea 
                          rows="6"
                          placeholder="Type message content here. Use {{first_name}} format for variables."
                          value={tplForm.body}
                          onChange={(e) => setTplForm({ ...tplForm, body: e.target.value })}
                          className="w-full bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-700 dark:text-gray-300 text-xs rounded-xl p-3 outline-none focus:border-black/20 dark:focus:border-white/20 placeholder:text-zinc-400 dark:placeholder:text-gray-600 font-sans leading-relaxed"
                          required
                        ></textarea>
                      </div>

                      <div className="rounded-xl border border-black/5 dark:border-white/10 bg-zinc-950/5 dark:bg-black/20 p-3.5 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-[10px] uppercase tracking-wider font-bold text-zinc-400">Available merge tags</div>
                          <button
                            type="button"
                            onClick={() => setShowCustomVarsHelp(!showCustomVarsHelp)}
                            className="text-zinc-500 hover:text-zinc-700 dark:text-gray-400 dark:hover:text-white flex items-center gap-1 text-[10px] font-semibold transition-colors duration-150"
                          >
                            <Info className="w-3.5 h-3.5" />
                            <span>Custom Fields Guide</span>
                          </button>
                        </div>

                        {showCustomVarsHelp && (
                          <div className="text-[10px] text-zinc-600 dark:text-gray-300 bg-white dark:bg-black/30 border border-black/5 dark:border-white/5 rounded-xl p-3 space-y-2 leading-relaxed">
                            <p className="font-semibold text-zinc-800 dark:text-white">Using Custom Fields & Webhooks:</p>
                            <ul className="list-disc pl-3.5 space-y-1">
                              <li>
                                <strong>Custom fields:</strong> Use the exact key of your custom fields, e.g. <span className="font-mono text-[10px] bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">{`{{industry}}`}</span> or <span className="font-mono text-[10px] bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">{`{{budget}}`}</span>.
                              </li>
                              <li>
                                <strong>Recording URL / Transcripts:</strong> Extract nested parameters from incoming webhook payloads by prefixing them with <span className="font-mono text-[10px] bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">raw_payload.</span>, e.g. <span className="font-mono text-[10px] bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">{`{{raw_payload.transcript}}`}</span> or <span className="font-mono text-[10px] bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">{`{{raw_payload.recording_url}}`}</span>.
                              </li>
                            </ul>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-1.5">
                          {COMMON_MERGE_TAGS.map((tag) => (
                            <span key={tag} className="font-mono text-[10px] text-zinc-600 dark:text-gray-300 bg-white dark:bg-black/30 border border-black/5 dark:border-white/5 rounded-md px-1.5 py-0.5">
                              {`{{${tag}}}`}
                            </span>
                          ))}
                        </div>
                        {mergeWarnings.length > 0 && (
                          <div className="space-y-1 pt-1">
                            {mergeWarnings.map((warning) => (
                              <div key={warning} className="text-[10px] text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1">
                                {warning}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <input 
                          type="checkbox"
                          id="tplActive"
                          checked={tplForm.active}
                          onChange={(e) => setTplForm({ ...tplForm, active: e.target.checked })}
                          className="w-4 h-4 rounded border-black/15 dark:border-white/10 bg-white dark:bg-black/40 text-zinc-900 dark:text-white focus:ring-0 cursor-pointer"
                        />
                        <Label htmlFor="tplActive" className="text-xs text-zinc-700 dark:text-gray-300 cursor-pointer select-none">
                          Active for follow-ups
                        </Label>
                      </div>
                    </div>

                    {/* Right Pane: Live preview */}
                    <div className="w-1/2 bg-zinc-50/50 dark:bg-black/10 overflow-y-auto p-6 space-y-4">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-zinc-400 dark:text-zinc-500 tracking-wider uppercase">
                          Live Preview
                        </span>
                        
                        <select
                          value={selectedPreviewLeadId}
                          onChange={(e) => setSelectedPreviewLeadId(e.target.value)}
                          className="bg-white dark:bg-zinc-900 border border-black/10 dark:border-white/10 px-2 py-1 rounded-lg shadow-sm text-[10px] font-semibold text-zinc-700 dark:text-gray-300 outline-none max-w-[200px] cursor-pointer"
                        >
                          <option value="sample">Brian Halligan (Sample Contact)</option>
                          {previewLeads.map((lead) => (
                            <option key={lead.id} value={lead.id}>
                              {`${lead.first_name || ""} ${lead.last_name || ""}`.trim() || "Unnamed Lead"} ({lead.email || "no email"})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="bg-white dark:bg-black/30 border border-black/5 dark:border-white/5 rounded-2xl p-5 space-y-4 shadow-sm h-[400px] overflow-y-auto flex flex-col">
                        {tplForm.channel === "email" ? (
                          <>
                            <div className="border-b border-black/5 dark:border-white/5 pb-3">
                              <span className="text-[10px] font-bold text-zinc-400 dark:text-gray-500 uppercase tracking-wider block">
                                Subject
                              </span>
                              <span className="text-xs text-zinc-800 dark:text-gray-200 font-bold block mt-0.5">
                                {previewSubject || <span className="italic opacity-60">no subject composed yet</span>}
                              </span>
                            </div>
                            <div className="flex-1">
                              <span className="text-[10px] font-bold text-zinc-400 dark:text-gray-500 uppercase tracking-wider block">
                                Message Body
                              </span>
                              <div 
                                className="text-xs text-zinc-700 dark:text-gray-300 font-sans mt-2.5 leading-relaxed bg-white dark:bg-black/20 p-3 rounded-xl border border-black/5 dark:border-white/5 min-h-[150px]"
                                dangerouslySetInnerHTML={{ 
                                  __html: previewBody 
                                    ? (/<[a-z][\s\S]*>/i.test(previewBody) ? previewBody : previewBody.replace(/\n/g, "<br />"))
                                    : '<span class="italic opacity-50">no body composed yet</span>' 
                                }}
                              />
                            </div>
                          </>
                        ) : (
                          <div className="flex-1 flex flex-col justify-start">
                            <span className="text-[10px] font-bold text-zinc-400 dark:text-gray-500 uppercase tracking-wider block">
                              {tplForm.channel === "sms" ? "SMS Content" : "Team Alert Content"}
                            </span>
                            <div className="bg-zinc-100 dark:bg-black/40 border border-black/5 dark:border-white/5 rounded-xl p-3.5 mt-2.5 max-w-sm self-start relative">
                              <div 
                                className="text-xs text-zinc-800 dark:text-gray-200 font-sans leading-relaxed"
                                dangerouslySetInnerHTML={{
                                  __html: previewBody
                                    ? (/<[a-z][\s\S]*>/i.test(previewBody) ? previewBody : previewBody.replace(/\n/g, "<br />"))
                                    : '<span class="italic opacity-50">no content composed yet</span>'
                                }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Modal Footer */}
                  <div className="px-6 py-3 border-t border-black/5 dark:border-white/5 flex justify-end gap-3 bg-zinc-50 dark:bg-black/10">
                    <Button 
                      type="button" 
                      onClick={() => setShowTplModal(false)}
                      className="bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-800 dark:text-white border border-black/5 dark:border-white/5 rounded-xl text-xs h-9 px-4"
                    >
                      Cancel
                    </Button>
                    <Button 
                      type="submit"
                      variant="default"
                    >
                      Save Template
                    </Button>
                  </div>
                </form>
              )
            })()}
          </div>
        </div>
      )}
      {showSenderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div
            className="absolute inset-0"
            onClick={() => !savingSender && setShowSenderModal(false)}
          />
          <div className="relative w-full max-w-2xl bg-white dark:bg-surface-1 border border-black/10 dark:border-white/10 rounded-2xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold text-zinc-900 dark:text-white mb-4">
              {editingSender ? `Edit Sender: ${editingSender.sender_slot}` : "Add a new sender"}
            </h2>

            {senderFormError && (
              <Alert variant="danger" className="mb-4">{senderFormError}</Alert>
            )}

            <form onSubmit={handleSaveSender} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-zinc-500 dark:text-gray-400 text-xs">Sender slot *</Label>
                  <Input
                    required
                    placeholder="sender_01"
                    value={senderForm.sender_slot}
                    onChange={(e) => setSenderForm({ ...senderForm, sender_slot: e.target.value })}
                    disabled={!!editingSender}
                    className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm"
                  />
                  <p className="text-[10px] text-zinc-400">Unique slot id per tenant (e.g. sender_01–sender_10). Locked after creation.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-zinc-500 dark:text-gray-400 text-xs">Sender name *</Label>
                  <Input
                    required
                    placeholder="Jane at Example Co"
                    value={senderForm.sender_name}
                    onChange={(e) => setSenderForm({ ...senderForm, sender_name: e.target.value })}
                    className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-zinc-500 dark:text-gray-400 text-xs">Sender email *</Label>
                  <Input
                    required
                    type="email"
                    placeholder="jane@example.com"
                    value={senderForm.sender_email}
                    onChange={(e) => setSenderForm({ ...senderForm, sender_email: e.target.value })}
                    className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-zinc-500 dark:text-gray-400 text-xs">Domain *</Label>
                  <Input
                    required
                    placeholder="example.com"
                    value={senderForm.domain}
                    onChange={(e) => setSenderForm({ ...senderForm, domain: e.target.value })}
                    className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-zinc-500 dark:text-gray-400 text-xs">Internal sender key *</Label>
                <Input
                  required
                  placeholder="jane@example.com"
                  value={senderForm.n8n_credential_name}
                  onChange={(e) => setSenderForm({ ...senderForm, n8n_credential_name: e.target.value })}
                  className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm font-mono"
                />
                <p className="text-[10px] text-zinc-400">
                  Stable internal key for this sender. Gmail dispatch uses the connected sender account and OAuth settings.
                </p>
              </div>

              {/* Per-sender Google OAuth client. Leave blank to use the
                  tenant default (Settings → AI & voice → Gmail credential). Override
                  here when this sender lives in a different Google
                  Workspace than other senders on this tenant. */}
              <div className="space-y-3 bg-zinc-950/5 dark:bg-black/20 p-4 rounded-xl border border-black/5 dark:border-white/5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400 dark:text-gray-500 uppercase tracking-wider font-semibold">
                    Google OAuth Client <span className="opacity-60 normal-case tracking-normal font-normal">(optional override)</span>
                  </span>
                </div>
                <p className="text-[10px] text-zinc-500 dark:text-gray-400 -mt-1">
                  Leave blank to use the tenant default. Override only when this sender's mailbox is in a different Google Workspace than other senders (e.g. agencies managing multiple client domains).
                </p>
                <div className="grid grid-cols-1 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-zinc-500 dark:text-gray-400">Google Client ID</Label>
                    <Input
                      placeholder="xxxxxx.apps.googleusercontent.com"
                      value={senderForm.google_client_id}
                      onChange={(e) => setSenderForm({ ...senderForm, google_client_id: e.target.value })}
                      className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-zinc-500 dark:text-gray-400">Google Client Secret</Label>
                    <Input
                      type="password"
                      placeholder="GOCSPX-xxxxxxxxxxxx"
                      value={senderForm.google_client_secret}
                      onChange={(e) => setSenderForm({ ...senderForm, google_client_secret: e.target.value })}
                      className="bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-8 rounded-lg text-xs font-mono"
                    />
                    <p className="text-[10px] text-zinc-500 dark:text-gray-500">
                      Both fields are snapshotted onto this sender at OAuth connect time. Changing them later won't break existing connections; only new "Connect Google" runs use the latest values.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-zinc-500 dark:text-gray-400 text-xs">Daily limit</Label>
                  <Input
                    type="number"
                    min="0"
                    value={senderForm.daily_limit}
                    onChange={(e) => setSenderForm({ ...senderForm, daily_limit: Number(e.target.value) })}
                    className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-zinc-500 dark:text-gray-400 text-xs">Seconds between sends</Label>
                  <Input
                    type="number"
                    min="0"
                    value={senderForm.min_seconds_between_sends}
                    onChange={(e) => setSenderForm({ ...senderForm, min_seconds_between_sends: Number(e.target.value) })}
                    className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white h-9 rounded-xl text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-zinc-500 dark:text-gray-400 text-xs">Active</Label>
                  <CustomSelect
                    value={senderForm.active ? "true" : "false"}
                    onChange={(val) => setSenderForm({ ...senderForm, active: val === "true" })}
                    options={[
                      { value: "true", label: "Active" },
                      { value: "false", label: "Disabled" }
                    ]}
                    triggerClassName="w-full h-9 bg-white dark:bg-surface-3 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white text-xs rounded-xl px-3 outline-none flex items-center justify-between"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-zinc-500 dark:text-gray-400 text-xs">Warmup stage</Label>
                  <CustomSelect
                    value={senderForm.warmup_stage}
                    onChange={(val) => setSenderForm({ ...senderForm, warmup_stage: val })}
                    options={SENDER_POOL_OPTIONS}
                    triggerClassName="w-full h-9 bg-white dark:bg-surface-3 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white text-xs rounded-xl px-3 outline-none flex items-center justify-between"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-zinc-500 dark:text-gray-400 text-xs">Health status</Label>
                  <CustomSelect
                    value={senderForm.health_status}
                    onChange={(val) => setSenderForm({ ...senderForm, health_status: val })}
                    options={SENDER_HEALTH_OPTIONS}
                    triggerClassName="w-full h-9 bg-white dark:bg-surface-3 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white text-xs rounded-xl px-3 outline-none flex items-center justify-between"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-black/5 dark:border-white/5">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowSenderModal(false)}
                  disabled={savingSender}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={savingSender}
                  variant="default"
                >
                  {savingSender ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</>
                  ) : editingSender ? "Save changes" : "Add sender"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>

  )
}
