"use client"

import { useEffect, useState, useRef, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import {
  Users, Search, Plus, Edit2, Trash2, X, Mail, MessageSquare, RefreshCw,
  PhoneCall, Play, Pause, ChevronRight, AlertCircle, Info, Calendar,
  Loader2, Sparkles, SlidersHorizontal, Settings, CheckCircle2,
  Volume2, Clock, Check, Trash, Upload, Folder, ChevronDown, Columns3,
  ArrowLeft, SkipForward, Download, Copy, Activity
} from "lucide-react"

import CustomSelect from "@/components/ui/custom-select"
import { AppIcon } from "@/components/AppIcon"
import { getCachedData, setCachedData } from "@/utils/apiCache"
import { useToast } from "@/components/ui/toast"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import {
  getComplianceStatusDisplay,
  getConversationStatusDisplay,
  getDeliveryStatusDisplay,
  getJourneyStatusDisplay,
  getLeadStatusDisplay,
  getStatusDotClass,
  getStatusPillClass,
} from "@/lib/statusDisplay"

import { StatusPill, getLeadCurrentStateSummary, getTimelineEventDisplay, getWarningDisplay, getJourneyStepLabel, humanizeInlineLabel } from "./components/leadDisplay"
import { STANDARD_COLUMNS, LS_KEY, defaultVisibleIds, groupCustomFieldsByFolder, CustomFieldInput, CustomFieldDisplay } from "./components/leadsTableColumns"
import { ConversationView } from "./components/ConversationView"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useTheme } from "@/components/ThemeProvider"
import { useIsOperator } from "@/components/RoleProvider"
import { validateAndCoerceCustomFields } from "@/utils/customFields"
import { createSupabaseBrowserClient } from "@/utils/supabase-browser"

function LeadsPageContent() {
  const { theme } = useTheme()
  const isOperator = useIsOperator()
  const { pushToast } = useToast()
  const confirm = useConfirm()
  const searchParams = useSearchParams()
  const router = useRouter()
  const importBatchId = searchParams.get("import")
  const supabase = createSupabaseBrowserClient()
  const [leads, setLeads] = useState(() => getCachedData("leads_list") || [])
  const [journeys, setJourneys] = useState(() => getCachedData("leads_journeys") || [])
  const [loading, setLoading] = useState(() => !getCachedData("leads_list"))
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  // Saved segments — persist filter state for re-use across sessions.
  const [segments, setSegments] = useState([])
  const [segmentName, setSegmentName] = useState("")
  const [showSaveSegment, setShowSaveSegment] = useState(false)
  useEffect(() => {
    fetch("/api/segments").then(r => r.json()).then(j => setSegments(j.data || [])).catch(() => {})
  }, [])
  const applySegment = (seg) => {
    if (!seg) return
    const f = seg.filters || {}
    if (f.search !== undefined) setSearchQuery(f.search)
    if (f.status !== undefined) setStatusFilter(f.status)
    if (Array.isArray(f.columns)) setVisibleColumnIds(new Set(f.columns))
  }
  const saveSegment = async () => {
    const name = segmentName.trim()
    if (!name) return
    const filters = {
      search: searchQuery,
      status: statusFilter,
      columns: Array.from(visibleColumnIds || []),
    }
    const res = await fetch("/api/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, filters }),
    })
    if (res.ok) {
      const j = await res.json()
      setSegments(prev => {
        const without = prev.filter(s => s.name !== name)
        return [...without, j.data].sort((a, b) => a.name.localeCompare(b.name))
      })
      setSegmentName("")
      setShowSaveSegment(false)
    }
  }
  const deleteSegment = async (id) => {
    if (!(await confirm({
      title: "Delete this segment?",
      confirmLabel: "Delete segment",
      destructive: true,
    }))) return
    await fetch(`/api/segments?id=${id}`, { method: "DELETE" })
    setSegments(prev => prev.filter(s => s.id !== id))
  }
  // Column visibility — always init to null so SSR and first client render match.
  // Real value is hydrated from localStorage in a useEffect below.
  const [visibleColumnIds, setVisibleColumnIds] = useState(null)
  // Bulk selection for mass operations. Empty Set = no selection toolbar.
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkOp, setBulkOp] = useState(null) // null | 'exit' | 'enroll' | 'set_field'
  const [bulkValue, setBulkValue] = useState("")
  const [bulkField, setBulkField] = useState("")
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkError, setBulkError] = useState("")
  const [bulkEnrollPreview, setBulkEnrollPreview] = useState(null)
  const [bulkEnrollResult, setBulkEnrollResult] = useState(null)
  const [bulkEnrollScope, setBulkEnrollScope] = useState("selected") // selected | import
  const [showColumnsMenu, setShowColumnsMenu] = useState(false)
  
  // Drawer / Slide-over state
  const [selectedLead, setSelectedLead] = useState(null)
  const [activeTabFilter, setActiveTabFilter] = useState("all")
  const [timeline, setTimeline] = useState([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  // PHASE6: per-run visibility + controls.
  const [runs, setRuns] = useState([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [runOpLoading, setRunOpLoading] = useState(null)
  // Subtle "refreshing" indicator used during the silent 15s background
  // refetch — does NOT trigger the full loading spinner (which would
  // unmount the composer and lose the operator's typed reply).
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [leadWarnings, setLeadWarnings] = useState([])
  const [leadJourney, setLeadJourney] = useState(null)
  const [timelineError, setTimelineError] = useState("")
  // Default 'current' = only actions/events tied to this lead's current journey
  // enrollment. Flip to 'all' to see historical noise across prior journeys.
  const [timelineScope, setTimelineScope] = useState("current")
  const [timelineMeta, setTimelineMeta] = useState(null)
  const [copiedId, setCopiedId] = useState(null)
  const [expandedTranscriptId, setExpandedTranscriptId] = useState(null)
  const handleCopyTranscript = (text, id) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }
  // 'timeline' = system-trace card list. 'conversation' = chat-bubble view of
  // inbound + outbound messages grouped by channel. Conversation is what
  // operators want when they're answering "what did we say to this lead?".
  const [viewMode, setViewMode] = useState("timeline")
  // Conversation-mode channel filter: 'all' shows every channel, otherwise
  // restrict to email / sms / call to focus the read.
  const [convChannel, setConvChannel] = useState("all")
  const [formError, setFormError] = useState("")
  const [listError, setListError] = useState("")

  // Modals state
  const [isAddEditOpen, setIsAddEditOpen] = useState(false)
  const [editingLead, setEditingLead] = useState(null) // null if adding
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [leadToDelete, setLeadToDelete] = useState(null)

  // Form state
  const [formFirstName, setFormFirstName] = useState("")
  const [formLastName, setFormLastName] = useState("")
  const [formEmail, setFormEmail] = useState("")
  const [formPhone, setFormPhone] = useState("")
  const [formJourney, setFormJourney] = useState("")
  const [formStatus, setFormStatus] = useState("new")
  const [formSource, setFormSource] = useState("Manual Add")
  const [formCustomFields, setFormCustomFields] = useState({})
  const [formAdvancedOpen, setFormAdvancedOpen] = useState(false)
  const [customFieldErrors, setCustomFieldErrors] = useState({}) // { [field.key]: "message" }
  const [customFieldsSchema, setCustomFieldsSchema] = useState(() => getCachedData("leads_custom_fields_schema") || [])

  // Listen to cross-tab cache sync events
  useEffect(() => {
    const handleCacheUpdated = (e) => {
      const { key, data } = e.detail || {}
      if (key === "leads_list") {
        setLeads(data)
        setLoading(false)
      } else if (key === "leads_journeys") {
        setJourneys(data)
      } else if (key === "leads_custom_fields_schema") {
        setCustomFieldsSchema(data)
      }
    }

    const handleCacheCleared = () => {
      setLeads([])
      setJourneys([])
      setCustomFieldsSchema([])
    }

    window.addEventListener("api-cache-updated", handleCacheUpdated)
    window.addEventListener("api-cache-cleared", handleCacheCleared)

    return () => {
      window.removeEventListener("api-cache-updated", handleCacheUpdated)
      window.removeEventListener("api-cache-cleared", handleCacheCleared)
    }
  }, [])

  // Load leads, journeys and tenant on mount
  useEffect(() => {
    const hasCache = !!getCachedData("leads_list")
    fetchLeads(hasCache)
    fetchJourneys()
    fetchTenant()
  }, [])

  // Handle deep-linking from search params
  useEffect(() => {
    const paramLeadId = searchParams.get("leadId")
    if (paramLeadId) {
      const matched = leads.find(l => l.id === paramLeadId)
      if (matched) {
        setSelectedLead(matched)
      } else {
        const fetchInitialLead = async () => {
          setTimelineLoading(true)
          setTimelineError("")
          try {
            const res = await fetch(`/api/leads?timeline=true&leadId=${paramLeadId}&journey_filter=${timelineScope}`)
            const data = await res.json()
            if (res.ok && data.lead) {
              setSelectedLead(data.lead)
              setTimeline(data.data || [])
              setLeadWarnings(data.warnings || [])
              setLeadJourney(data.journey || null)
              setTimelineMeta(data.scope || null)
            } else {
              setTimelineError(data.error || "Lead not found")
            }
          } catch (err) {
            console.error("Failed to load initial lead:", err)
            setTimelineError(err.message || "Failed to load initial lead")
          } finally {
            setTimelineLoading(false)
          }
        }
        fetchInitialLead()
      }
    }
  }, [searchParams, leads])

  const [openTabs, setOpenTabs] = useState([])
  const [editingField, setEditingField] = useState(null)
  const [editValue, setEditValue] = useState("")
  const [savingField, setSavingField] = useState(false)
  const [saveError, setSaveError] = useState("")
  const [successField, setSuccessField] = useState(null)

  // Sync selectedLead into openTabs
  useEffect(() => {
    if (selectedLead) {
      setOpenTabs(prev => {
        const exists = prev.some(t => t.id === selectedLead.id)
        if (exists) return prev
        return [...prev, selectedLead]
      })
    }
  }, [selectedLead])

  const handleSelectTab = (lead) => {
    if (lead === null) {
      setSelectedLead(null)
      router.push("/leads")
    } else {
      setSelectedLead(lead)
      router.push(`/leads?leadId=${lead.id}`)
    }
  }

  const handleCloseTab = (leadId, e) => {
    e.stopPropagation()
    const next = openTabs.filter(t => t.id !== leadId)
    setOpenTabs(next)
    
    if (selectedLead && selectedLead.id === leadId) {
      if (next.length > 0) {
        const nextActive = next[next.length - 1]
        setSelectedLead(nextActive)
        router.push(`/leads?leadId=${nextActive.id}`)
      } else {
        setSelectedLead(null)
        router.push("/leads")
      }
    }
  }

  const handleInlineSave = async (fieldKey, value, isCustomField = false) => {
    setSavingField(true)
    setSaveError("")
    try {
      const payload = { id: selectedLead.id }
      if (isCustomField) {
        payload.custom_fields = {
          ...(selectedLead.custom_fields || {}),
          [fieldKey]: value
        }
      } else {
        if (fieldKey === "phone") {
          payload.phone_raw = value
          payload.phone_e164 = value
        } else {
          payload[fieldKey] = value
        }
      }

      const res = await fetch("/api/leads", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
      const resJson = await res.json()
      if (!res.ok) {
        setSaveError(resJson.error || "Failed to update lead")
        return
      }

      const updatedLead = resJson.data
      setSelectedLead(updatedLead)
      setLeads(prev => prev.map(l => l.id === updatedLead.id ? updatedLead : l))
      setOpenTabs(prev => prev.map(t => t.id === updatedLead.id ? updatedLead : t))

      setSuccessField(fieldKey)
      setTimeout(() => setSuccessField(null), 1500)
      setEditingField(null)
    } catch (err) {
      console.error("Inline save failed:", err)
      setSaveError(err.message || "Failed to update lead")
    } finally {
      setSavingField(false)
    }
  }

  const handleRunNow = async (actionId) => {
    if (!(await confirm({
      title: "Run this step immediately?",
      confirmLabel: "Run now",
    }))) return
    try {
      const res = await fetch(`/api/actions/${actionId}/run-now`, {
        method: "POST"
      })
      const j = await res.json()
      if (!res.ok) {
        pushToast("error", j.error || "Failed to trigger action")
        return
      }
      pushToast("success", "Step set to run immediately. The dispatcher will execute it within 1 minute.")
      if (selectedLead?.id) fetchTimeline(selectedLead.id, timelineScope)
    } catch (err) {
      console.error("Failed to run action now:", err)
      pushToast("error", "Error triggering action: " + err.message)
    }
  }

  const handleSkipStep = async (actionId) => {
    if (!(await confirm({
      title: "Skip this step?",
      message: "The journey will advance to the next step.",
      confirmLabel: "Skip step",
    }))) return
    try {
      const res = await fetch(`/api/actions/${actionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "skipped",
          last_skip_reason: "Skipped manually by operator",
          advance: true
        })
      })
      const j = await res.json()
      if (!res.ok) {
        pushToast("error", j.error || "Failed to skip step")
        return
      }
      pushToast("success", "Step skipped. Journey has advanced.")
      if (selectedLead?.id) {
        fetchTimeline(selectedLead.id, timelineScope)
        fetchLeads()
      }
    } catch (err) {
      console.error("Failed to skip step:", err)
      pushToast("error", "Error skipping step: " + err.message)
    }
  }

  const renderCustomFieldInlineInput = (field) => {
    const inputClass = "w-full text-xs font-mono p-1 px-2 bg-zinc-950/5 dark:bg-black/45 border border-black/10 dark:border-white/5 rounded-lg text-zinc-900 dark:text-white outline-none focus:border-blue-500"
    
    switch (field.type) {
      case "boolean":
        return (
          <CustomSelect
            value={editValue === true || editValue === "true" ? "true" : "false"}
            onChange={(val) => setEditValue(val === "true")}
            options={[
              { value: "true", label: "YES" },
              { value: "false", label: "NO" }
            ]}
            triggerClassName="w-full text-xs font-mono p-1 px-2 bg-zinc-950/5 dark:bg-black/45 border border-black/10 dark:border-white/5 rounded-lg text-zinc-900 dark:text-white outline-none focus:border-blue-500 flex items-center justify-between"
          />
        )
      case "number":
        return (
          <input
            type="number"
            value={editValue ?? ""}
            onChange={(e) => setEditValue(e.target.value === "" ? "" : Number(e.target.value))}
            className={inputClass}
            autoFocus
          />
        )
      case "date":
        return (
          <input
            type="date"
            value={editValue ?? ""}
            onChange={(e) => setEditValue(e.target.value)}
            className={inputClass}
            autoFocus
          />
        )
      default:
        return (
          <input
            type="text"
            value={editValue ?? ""}
            onChange={(e) => setEditValue(e.target.value)}
            className={inputClass}
            autoFocus
          />
        )
    }
  }

  const renderProfileFieldInlineInput = (fieldKey) => {
    const inputClass = "w-full text-xs font-mono p-1 px-2 bg-zinc-950/5 dark:bg-black/45 border border-black/10 dark:border-white/5 rounded-lg text-zinc-900 dark:text-white outline-none focus:border-blue-500"
    
    if (fieldKey === "journey_template") {
      return (
        <CustomSelect
          value={editValue}
          onChange={(val) => handleInlineSave("journey_template", val)}
          options={[
            { value: "", label: "-- No Journey --" },
            ...journeys.map(j => ({ value: j.journey_key, label: j.name }))
          ]}
          disabled={savingField}
          triggerClassName="w-full text-xs font-mono p-1 px-2 bg-zinc-950/5 dark:bg-black/45 border border-black/10 dark:border-white/5 rounded-lg text-zinc-900 dark:text-white outline-none focus:border-blue-500 flex items-center justify-between"
        />
      )
    }
    
    if (fieldKey === "journey_status") {
      return (
        <CustomSelect
          value={editValue}
          onChange={(val) => handleInlineSave("journey_status", val)}
          options={["new", "active", "paused", "completed", "failed"].map((value) => ({
            value,
            label: getJourneyStatusDisplay(value).label,
          }))}
          disabled={savingField}
          triggerClassName="w-full text-xs font-mono p-1 px-2 bg-zinc-950/5 dark:bg-black/45 border border-black/10 dark:border-white/5 rounded-lg text-zinc-900 dark:text-white outline-none focus:border-blue-500 flex items-center justify-between"
        />
      )
    }
    
    return (
      <input
        type={fieldKey === "email" ? "email" : "text"}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleInlineSave(fieldKey, editValue)
          if (e.key === "Escape") setEditingField(null)
        }}
        className={inputClass}
        disabled={savingField}
        autoFocus
      />
    )
  }


  // Hydrate visible columns from localStorage (or defaults) AFTER mount — client only.
  // Runs once when state is still null. Safe for SSR because effects don't run on the server.
  useEffect(() => {
    if (visibleColumnIds !== null) return
    let initial = null
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) initial = new Set(JSON.parse(raw))
    } catch {}
    if (!initial) initial = new Set(defaultVisibleIds(customFieldsSchema))
    setVisibleColumnIds(initial)
  }, [customFieldsSchema])

  // Persist on every change (client only because localStorage is gated)
  useEffect(() => {
    if (visibleColumnIds && typeof window !== "undefined") {
      try { localStorage.setItem(LS_KEY, JSON.stringify(Array.from(visibleColumnIds))) } catch {}
    }
  }, [visibleColumnIds])

  // All available columns = standard + dynamic from schema
  const allColumns = (() => {
    const customCols = (customFieldsSchema || [])
      .filter(f => f.active !== false)
      .map(f => ({
        id: `custom.${f.key}`,
        label: f.label,
        group: f.folder || "Custom Fields",
        defaultVisible: false,
        render: (lead) => <CustomFieldDisplay field={f} value={lead.custom_fields?.[f.key]} />,
      }))
    return [...STANDARD_COLUMNS, ...customCols]
  })()
  const visibleColumns = allColumns.filter(c => (visibleColumnIds || new Set()).has(c.id))
  const toggleColumn = (id) => {
    setVisibleColumnIds(prev => {
      const next = new Set(prev || [])
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const fetchTenant = async () => {
    try {
      const res = await fetch("/api/tenant")
      const data = await res.json()
      if (data.data?.config?.custom_fields) {
        setCustomFieldsSchema(data.data.config.custom_fields)
        setCachedData("leads_custom_fields_schema", data.data.config.custom_fields)
      }
    } catch (err) {
      console.error("Failed to load tenant config:", err)
    }
  }

  // Load timeline when selectedLead changes
  useEffect(() => {
    if (selectedLead) {
      fetchTimeline(selectedLead.id)
      fetchRuns(selectedLead.id)
    }
  }, [selectedLead])

  const fetchLeads = async (silent = false) => {
    if (!silent) setLoading(true)
    setListError("")
    try {
            const importBatchId = searchParams.get("import")
            const url = importBatchId ? `/api/leads?import=${encodeURIComponent(importBatchId)}` : "/api/leads"
            const res = await fetch(url)
      const data = await res.json()
      if (!res.ok) {
        setListError(data.error || "Failed to load leads")
        setLeads([])
        return
      }
      setLeads(data.data || [])
      setCachedData("leads_list", data.data || [])
    } catch (err) {
      console.error("Failed to load leads:", err)
      setListError(err.message || "Failed to load leads")
    } finally {
      setLoading(false)
    }
  }

  const fetchJourneys = async () => {
    try {
      const res = await fetch("/api/journeys?include_inactive=1")
      const data = await res.json()
      setJourneys(data.data || [])
      setCachedData("leads_journeys", data.data || [])
    } catch (err) {
      console.error("Failed to load journeys:", err)
    }
  }

  // silent=true is used by the 15s background refresh. Critical: when silent
  // we do NOT toggle timelineLoading — toggling unmounts the conversation
  // view (which returns a loading spinner early), which discards composer
  // state. The operator's half-typed reply would vanish every 15s.
  // PHASE6: fetch the lead's runs (newest first) and expose pause/resume/cancel.
  const fetchRuns = async (leadId) => {
    if (!leadId) return
    setRunsLoading(true)
    try {
      const res = await fetch(`/api/leads/${leadId}/runs`)
      const data = await res.json()
      setRuns(res.ok ? (data.data || []) : [])
    } catch (err) {
      console.error("Failed to load runs:", err)
      setRuns([])
    } finally {
      setRunsLoading(false)
    }
  }

  const handleRunOp = async (runId, op) => {
    if (op === "cancel" && !(await confirm({
      title: "Cancel this run?",
      message: "Its pending actions will be cancelled permanently.",
      confirmLabel: "Cancel run",
      destructive: true,
    }))) return
    setRunOpLoading(runId)
    try {
      const res = await fetch(`/api/runs/${runId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op }),
      })
      if (res.ok && selectedLead?.id) {
        await fetchRuns(selectedLead.id)
      }
    } catch (err) {
      console.error("Run op failed:", err)
    } finally {
      setRunOpLoading(null)
    }
  }

  const fetchTimeline = async (leadId, scope = timelineScope, { silent = false } = {}) => {
    if (!silent) {
      setTimelineLoading(true)
      setTimelineError("")
      setLeadWarnings([])
      setLeadJourney(null)
    } else {
      setIsRefreshing(true)
    }
    try {
      const res = await fetch(`/api/leads?timeline=true&leadId=${leadId}&journey_filter=${scope}`)
      const data = await res.json()
      if (!res.ok) {
        setTimelineError(data.error || "Failed to load timeline")
        if (!silent) {
          setTimeline([])
          setTimelineMeta(null)
        }
        return
      }
      setTimeline(data.data || [])
      setLeadWarnings(data.warnings || [])
      setLeadJourney(data.journey || null)
      setTimelineMeta(data.scope || null)
    } catch (err) {
      console.error("Failed to load timeline:", err)
      if (!silent) setTimelineError(err.message || "Failed to load timeline")
    } finally {
      if (!silent) setTimelineLoading(false)
      setIsRefreshing(false)
    }
  }

  // Re-fetch when the user flips the scope toggle (only if a lead is open).
  useEffect(() => {
    if (selectedLead?.id) fetchTimeline(selectedLead.id, timelineScope)
  }, [timelineScope])

  // ---------- Real-time auto-refresh ----------
  //
  // Subscribe to real-time changes on actions and events tables for the selected lead,
  // and on the leads table for the selected lead. Refetch timeline and/or leads list.
  useEffect(() => {
    if (!selectedLead?.id) return

    const channel = supabase
      .channel(`lead-realtime-${selectedLead.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "actions",
          filter: `lead_id=eq.${selectedLead.id}`,
        },
        () => {
          fetchTimeline(selectedLead.id, timelineScope, { silent: true })
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "events",
          filter: `lead_id=eq.${selectedLead.id}`,
        },
        () => {
          fetchTimeline(selectedLead.id, timelineScope, { silent: true })
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "leads",
          filter: `id=eq.${selectedLead.id}`,
        },
        () => {
          fetchLeads()
          fetchTimeline(selectedLead.id, timelineScope, { silent: true })
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [selectedLead?.id, timelineScope])

  const resetBulkEnrollState = () => {
    setBulkEnrollPreview(null)
    setBulkEnrollResult(null)
    setBulkEnrollScope("selected")
  }

  const closeBulkModal = ({ clearSelection = false } = {}) => {
    setBulkOp(null)
    setBulkValue("")
    setBulkField("")
    setBulkError("")
    resetBulkEnrollState()
    if (clearSelection) setSelectedIds(new Set())
  }

  const fetchBulkEnrollPreview = async (journeyKey) => {
    const key = String(journeyKey || "").trim()
    setBulkEnrollResult(null)
    setBulkEnrollPreview(null)
    setBulkError("")
    if (!key) return

    try {
      const body = {
        journey_key: key,
        start_behavior: "now",
        dry_run: true,
      }
      if (bulkEnrollScope === "import" && importBatchId) body.import_id = importBatchId
      else body.lead_ids = Array.from(selectedIds)

      const res = await fetch("/api/leads/bulk-enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        setBulkError(json.error || "Could not preview enrollment")
        return
      }
      setBulkEnrollPreview(json.data)
    } catch (err) {
      setBulkError(err.message || "Could not preview enrollment")
    }
  }

  const commitBulkEnroll = async () => {
    setBulkSaving(true)
    setBulkError("")
    try {
      const body = {
        journey_key: bulkValue,
        start_behavior: "now",
      }
      if (bulkEnrollScope === "import" && importBatchId) body.import_id = importBatchId
      else body.lead_ids = Array.from(selectedIds)

      const res = await fetch("/api/leads/bulk-enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        setBulkError(json.error || "Bulk enrollment failed")
        return
      }
      setBulkEnrollResult(json.data)
      setBulkEnrollPreview(null)
      fetchLeads()
    } catch (err) {
      setBulkError(err.message || "Bulk enrollment failed")
    } finally {
      setBulkSaving(false)
    }
  }

  // Open modal for Adding Lead
  const handleOpenAdd = () => {
    setEditingLead(null)
    setFormFirstName("")
    setFormLastName("")
    setFormEmail("")
    setFormPhone("")
    setFormJourney(journeys[0]?.journey_key || "demo_journey_1")
    setFormStatus("new")
    setFormSource("Manual Add")
    setFormCustomFields({})
    setFormAdvancedOpen(false)
    setCustomFieldErrors({})
    setFormError("")
    setIsAddEditOpen(true)
  }

  // Open modal for Editing Lead
  const handleOpenEdit = (lead, e) => {
    e.stopPropagation() // Prevent opening timeline drawer
    setEditingLead(lead)
    setFormFirstName(lead.first_name || "")
    setFormLastName(lead.last_name || "")
    setFormEmail(lead.email || "")
    setFormPhone(lead.phone_raw || lead.phone_e164 || "")
    setFormJourney(lead.journey_template || "")
    setFormStatus(lead.journey_status || "new")
    setFormSource(lead.source || "Manual Add")
    setFormCustomFields(lead.custom_fields || {})
    setFormAdvancedOpen(false)
    
    setCustomFieldErrors({})
    setFormError("")
    setIsAddEditOpen(true)
  }

  // Save Lead (handles both Add and Edit)
  const handleSaveLead = async (e) => {
    e.preventDefault()

    const raw_payload = editingLead ? (editingLead.raw_payload || {}) : {}

    // Run the same validator the server runs, so users see errors instantly
    // and the server gets a clean payload.
    const cfResult = validateAndCoerceCustomFields(formCustomFields, customFieldsSchema)
    if (!cfResult.ok) {
      setCustomFieldErrors(cfResult.errors)
      setFormAdvancedOpen(true)
      setFormError("Please fix the highlighted custom field errors before saving.")
      return
    }
    setCustomFieldErrors({})

    const payload = {
      first_name: formFirstName,
      last_name: formLastName,
      email: formEmail,
      phone_raw: formPhone,
      phone_e164: formPhone.replace(/[^+\d]/g, ""), // simple numbers cleanup
      journey_template: formJourney,
      journey_status: formStatus,
      source: formSource,
      raw_payload,
      custom_fields: cfResult.value
    }

    try {
      let res
      if (editingLead) {
        // Edit mode
        res = await fetch("/api/leads", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editingLead.id, ...payload })
        })
      } else {
        // Add mode
        res = await fetch("/api/leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
      }

      const responseBody = await res.json().catch(() => ({}))
      if (res.ok) {
        setFormError("")
        if (responseBody.warning) {
          pushToast("info", `Saved with warning: ${responseBody.warning}`, 7000)
        }
        setIsAddEditOpen(false)
        fetchLeads() // reload list
        if (selectedLead && editingLead && selectedLead.id === editingLead.id) {
          setSelectedLead(responseBody.data)
        }
      } else {
        if (responseBody.field_errors && typeof responseBody.field_errors === "object") {
          setCustomFieldErrors(responseBody.field_errors)
        }
        setFormError(responseBody.error || `Save failed (HTTP ${res.status})`)
      }
    } catch (err) {
      console.error("Failed to save lead:", err)
      setFormError(err.message || "Failed to save lead")
    }
  }

  // Open Delete Dialog
  const handleOpenDelete = (lead, e) => {
    e.stopPropagation()
    setLeadToDelete(lead)
    setIsDeleteOpen(true)
  }

  // Confirm Delete
  const handleConfirmDelete = async () => {
    if (!leadToDelete) return
    try {
      const res = await fetch(`/api/leads?id=${leadToDelete.id}`, {
        method: "DELETE"
      })
      if (res.ok) {
        setIsDeleteOpen(false)
        setLeadToDelete(null)
        // Close timeline drawer if deleted lead is currently open
        if (selectedLead && selectedLead.id === leadToDelete.id) {
          setSelectedLead(null)
          router.push("/leads")
        }
        fetchLeads()
      }
    } catch (err) {
      console.error("Failed to delete lead:", err)
    }
  }



  // Filtering logic
  const filteredLeads = leads.filter(lead => {
    const name = `${lead.first_name || ""} ${lead.last_name || ""}`.toLowerCase()
    const email = (lead.email || "").toLowerCase()
    const phone = (lead.phone_raw || lead.phone_e164 || "").toLowerCase()
    const matchQuery = name.includes(searchQuery.toLowerCase()) || 
                       email.includes(searchQuery.toLowerCase()) ||
                       phone.includes(searchQuery.toLowerCase())

    if (!matchQuery) return false

    // Tab segregation filtering
    if (activeTabFilter === "active" && lead.journey_status !== "active") return false
    if (activeTabFilter === "completed" && lead.journey_status !== "completed") return false
    if (activeTabFilter === "opt_out" && !(lead.opt_out || lead.journey_status === "opted_out")) return false
    if (activeTabFilter === "flagged" && !["failed", "error"].includes(lead.journey_status)) return false

    // Dropdown status filter
    if (statusFilter !== "all" && lead.journey_status !== statusFilter) return false

    return true
  })

  // Format date utility
  const formatDate = (isoString) => {
    if (!isoString) return "---"
    const date = new Date(isoString)
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    })
  }

  // ---------- Conversation view helpers ----------
  //
  // Trim the quoted-reply tail from an email body so the bubble shows only
  // the new content the person wrote. Gmail's API returns the FULL body
  // (new text + quoted prior thread); the UI shows only the top in a normal
  // mail client. Mirroring that here.
  //
  // Strategy: search the ENTIRE body (not per-line) for the first quoted
  // marker — markers can appear mid-line when Gmail flattens a plain-text
  // reply into HTML and we extract it back. Truncate at the earliest match.
  //
  // Markers:
  //   * "On <date>, <person> wrote:"          — Gmail / most clients
  //   * "On <day, date> at <time>, <person> wrote:" — Gmail w/ timestamp
  //   * "-----Original Message-----"          — Outlook
  //   * "Begin forwarded message:"            — Apple Mail forward
  //   * "From: <addr> ... Sent: ..."          — Outlook header block
  //   * First line beginning with ">"         — old-school quote prefix
  const stripQuotedTail = (s) => {
    if (!s) return ""
    const text = String(s)
    // Patterns that match anywhere in the body.
    const patterns = [
      /On\s+.{1,200}?\bwrote:\s*/i,                 // "On X, Y wrote:" (greedy upper-bound on length)
      /-----\s*Original Message\s*-----/i,
      /Begin\s+forwarded\s+message:/i,
      /(^|\n)From:\s+\S.{0,200}?\n\s*(Sent|Date):\s/i,  // Outlook header block
    ]
    let earliest = text.length
    for (const re of patterns) {
      const m = text.match(re)
      if (m && m.index !== undefined && m.index < earliest) earliest = m.index
    }
    // First "> " quoted line at a line start.
    const gt = text.match(/(?:^|\n)\s*>/)
    if (gt && gt.index !== undefined) {
      // The match index for "(^|\n)\s*>" points at the newline char (or 0 at
      // start). Add 1 if we matched the newline, so we cut at the line break,
      // not the char before.
      const cut = gt.index === 0 ? 0 : gt.index + 1
      if (cut < earliest) earliest = cut
    }
    return text.slice(0, earliest).replace(/\s+$/g, "")
  }

  // Bodies on inbound emails arrive as HTML (with entities + tags). We render
  // them as plain text in the bubble — safer than dangerouslySetInnerHTML and
  // matches what an operator wants to skim. Outbound bodies are usually plain
  // text from the template editor anyway.
  const stripHtmlAndEntities = (s) => {
    if (!s) return ""
    let t = String(s)
    t = t.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
                  (_m, h, inner) => `${inner.replace(/<[^>]+>/g, "")} (${h})`)
    t = t.replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|tr|table|li)>/gi, "\n\n")
    t = t.replace(/<br\s*\/?>/gi, "\n")
    t = t.replace(/<style[\s\S]*?<\/style>/gi, "")
         .replace(/<script[\s\S]*?<\/script>/gi, "")
         .replace(/<[^>]+>/g, "")
    t = t.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
         .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
         .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
         .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  }

  // "Today" / "Yesterday" / "Monday, Jun 20" / "Jun 20, 2024".
  const dateBucketLabel = (iso) => {
    if (!iso) return "Earlier"
    const d = new Date(iso)
    const today = new Date()
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
    const diffDays = Math.round((start(today) - start(d)) / 86400000)
    if (diffDays === 0) return "Today"
    if (diffDays === 1) return "Yesterday"
    if (diffDays < 7)   return d.toLocaleDateString("en-US", { weekday: "long" })
    if (d.getFullYear() === today.getFullYear()) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    }
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
  }

  const formatTimeOnly = (iso) => {
    if (!iso) return ""
    return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  }

  const allCount = leads.length
  const activeCount = leads.filter(l => l.journey_status === "active").length
  const completedCount = leads.filter(l => l.journey_status === "completed").length
  const optOutCount = leads.filter(l => l.opt_out === true || l.journey_status === "opted_out").length
  const flaggedCount = leads.filter(l => ["failed", "error"].includes(l.journey_status)).length

  return (
    <div className="pb-10 space-y-6">
      {/* Horizontal Tabs Bar */}
      <div className="flex items-center gap-1.5 border-b border-black/5 dark:border-white/5 pb-3 overflow-x-auto select-none no-scrollbar">
        {/* Tab 1: All Leads List */}
        <button
          onClick={() => handleSelectTab(null)}
          className={`flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl border transition-all ${
            !selectedLead
              ? "bg-zinc-200 dark:bg-white/20 text-zinc-950 dark:text-white border-black/20 dark:border-white/20 shadow-sm"
              : "bg-transparent border-transparent text-zinc-500 dark:text-gray-400 hover:text-zinc-800 dark:hover:text-white"
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          <span>All Leads List</span>
        </button>

        {/* Lead Tabs */}
        {openTabs.map((tabLead) => {
          const isActive = selectedLead && selectedLead.id === tabLead.id
          return (
            <div
              key={tabLead.id}
              onClick={() => handleSelectTab(tabLead)}
              className={`group flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl border transition-all cursor-pointer ${
                isActive
                  ? "bg-white/60 dark:bg-white/[0.04] border-black/5 dark:border-white/5 text-zinc-900 dark:text-white shadow-sm"
                  : "bg-transparent border-transparent text-zinc-500 dark:text-gray-400 hover:text-zinc-800 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5"
              }`}
            >
              <span>{tabLead.first_name || tabLead.last_name ? `${tabLead.first_name || ""} ${tabLead.last_name || ""}`.trim() : "Unknown Lead"}</span>
              <button
                type="button"
                onClick={(e) => handleCloseTab(tabLead.id, e)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-white rounded-full p-0.5 transition-colors"
                title="Close Tab"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )
        })}
      </div>

      {selectedLead ? (
        /* ==================== 3-COLUMN LEAD DETAILS WORKSPACE ==================== */
        <div className="space-y-6">
          {/* Workspace Header */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-6">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                onClick={() => {
                  setSelectedLead(null)
                  router.push("/leads")
                }}
                className="rounded-xl hover:bg-zinc-950/5 dark:hover:bg-white/5 text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white flex items-center gap-2"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Back to Leads</span>
              </Button>
              <div className="h-6 w-[1px] bg-black/10 dark:bg-white/10 hidden md:block" />
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">
                    {selectedLead.first_name} {selectedLead.last_name}
                  </h1>
	                  <StatusPill display={getLeadStatusDisplay(selectedLead.journey_status, selectedLead)} />
	                  <StatusPill display={getJourneyStatusDisplay(selectedLead.journey_status, selectedLead)} />
	                  <StatusPill display={getConversationStatusDisplay(selectedLead)} />
	                  <StatusPill display={getComplianceStatusDisplay(selectedLead)} />
                </div>
                <p className="text-xs text-zinc-500 dark:text-gray-400 mt-0.5 font-mono">ID: {selectedLead.id}</p>
              </div>
            </div>

            {isOperator && (
              <div className="flex items-center gap-3">
                <Button
                  onClick={() => setViewMode("conversation")}
                  className="bg-zinc-900 dark:bg-white hover:bg-zinc-800 dark:hover:bg-white/90 text-white dark:text-black rounded-xl px-4 py-2 font-semibold transition-all flex items-center gap-2"
                >
                  <MessageSquare className="w-4 h-4" /> View conversation
                </Button>
                <Button
                  onClick={(e) => handleOpenEdit(selectedLead, e)}
                  className="bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-800 dark:text-white border border-black/5 dark:border-white/5 rounded-xl px-4 py-2 font-medium transition-all flex items-center gap-2"
                >
                  <Edit2 className="w-4 h-4" /> Edit lead
                </Button>
              </div>
            )}
          </div>

          {(() => {
            const summary = getLeadCurrentStateSummary(selectedLead, timeline)
            const toneClass = summary.tone === "danger"
              ? "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300"
              : summary.tone === "warning"
              ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : summary.tone === "success"
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : summary.tone === "info"
              ? "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300"
              : "border-zinc-500/20 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300"
            const hasHumanReply = timeline.some((item) => item.isAIEscalation) || getConversationStatusDisplay(selectedLead).label === "Replied"
            return (
              <div className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-5 space-y-4">
                <div className={`rounded-xl border p-4 ${toneClass}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider font-bold opacity-70 mb-1">Current state</div>
                      <div className="text-sm font-semibold">{summary.title}</div>
                      <div className="text-xs opacity-80 mt-1">{summary.detail}</div>
                    </div>
                    {hasHumanReply && (
                      <Badge variant="warning" className="shrink-0">
                        <AlertCircle className="w-3 h-3" /> Review reply
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <StatusPill display={getLeadStatusDisplay(selectedLead.journey_status, selectedLead)} className="justify-center w-full" />
                  <StatusPill display={getJourneyStatusDisplay(selectedLead.journey_status, selectedLead)} className="justify-center w-full" />
                  <StatusPill display={getConversationStatusDisplay(selectedLead)} className="justify-center w-full" />
                  <StatusPill display={getComplianceStatusDisplay(selectedLead)} className="justify-center w-full" />
                </div>
              </div>
            )
          })()}

          {/* 3-Column Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            
            {/* LEFT COLUMN: Profile & Details Folders (cols: 3) */}
            <div className="lg:col-span-3 space-y-6">
              <div className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-5 space-y-4">
                <h3 className="text-xs font-semibold text-zinc-500 dark:text-gray-400 uppercase tracking-wider">Lead Profile</h3>
                
                <div className="space-y-3.5 text-xs">
                  {/* First Name */}
                  <div className="group relative">
                    <span className="text-zinc-400 dark:text-gray-500 block text-[10px] uppercase tracking-wide font-medium">First Name</span>
                    {editingField === "first_name" ? (
                      <div className="flex items-center gap-1.5 mt-1">
                        {renderProfileFieldInlineInput("first_name")}
                        {savingField ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
                        ) : (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => handleInlineSave("first_name", editValue)} className="text-emerald-500 hover:text-emerald-600 font-bold">✓</button>
                            <button onClick={() => setEditingField(null)} className="text-zinc-400 hover:text-zinc-600 font-bold">✕</button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div 
                        onClick={() => { setEditingField("first_name"); setEditValue(selectedLead.first_name || "") }}
                        className="flex items-center justify-between cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-lg p-1 -mx-1"
                      >
                        <span className="text-zinc-700 dark:text-gray-300 font-medium">{selectedLead.first_name || "---"}</span>
                        {successField === "first_name" ? (
                          <span className="text-emerald-500 font-bold font-sans">Saved!</span>
                        ) : (
                          <Edit2 className="w-3 h-3 text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    )}
                    {editingField === "first_name" && saveError && <span className="text-[10px] text-red-500 block mt-0.5">{saveError}</span>}
                  </div>

                  {/* Last Name */}
                  <div className="group relative">
                    <span className="text-zinc-400 dark:text-gray-500 block text-[10px] uppercase tracking-wide font-medium">Last Name</span>
                    {editingField === "last_name" ? (
                      <div className="flex items-center gap-1.5 mt-1">
                        {renderProfileFieldInlineInput("last_name")}
                        {savingField ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
                        ) : (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => handleInlineSave("last_name", editValue)} className="text-emerald-500 hover:text-emerald-600 font-bold">✓</button>
                            <button onClick={() => setEditingField(null)} className="text-zinc-400 hover:text-zinc-600 font-bold">✕</button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div 
                        onClick={() => { setEditingField("last_name"); setEditValue(selectedLead.last_name || "") }}
                        className="flex items-center justify-between cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-lg p-1 -mx-1"
                      >
                        <span className="text-zinc-700 dark:text-gray-300 font-medium">{selectedLead.last_name || "---"}</span>
                        {successField === "last_name" ? (
                          <span className="text-emerald-500 font-bold font-sans">Saved!</span>
                        ) : (
                          <Edit2 className="w-3 h-3 text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    )}
                    {editingField === "last_name" && saveError && <span className="text-[10px] text-red-500 block mt-0.5">{saveError}</span>}
                  </div>

                  {/* Email */}
                  <div className="group relative">
                    <span className="text-zinc-400 dark:text-gray-500 block text-[10px] uppercase tracking-wide font-medium">Email</span>
                    {editingField === "email" ? (
                      <div className="flex items-center gap-1.5 mt-1">
                        {renderProfileFieldInlineInput("email")}
                        {savingField ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
                        ) : (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => handleInlineSave("email", editValue)} className="text-emerald-500 hover:text-emerald-600 font-bold">✓</button>
                            <button onClick={() => setEditingField(null)} className="text-zinc-400 hover:text-zinc-600 font-bold">✕</button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div 
                        onClick={() => { setEditingField("email"); setEditValue(selectedLead.email || "") }}
                        className="flex items-center justify-between cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-lg p-1 -mx-1"
                      >
                        <span className="text-zinc-700 dark:text-gray-300 font-medium break-all font-mono">{selectedLead.email || "---"}</span>
                        {successField === "email" ? (
                          <span className="text-emerald-500 font-bold font-sans">Saved!</span>
                        ) : (
                          <Edit2 className="w-3 h-3 text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    )}
                    {editingField === "email" && saveError && <span className="text-[10px] text-red-500 block mt-0.5">{saveError}</span>}
                  </div>

                  {/* Phone */}
                  <div className="group relative">
                    <span className="text-zinc-400 dark:text-gray-500 block text-[10px] uppercase tracking-wide font-medium">Phone</span>
                    {editingField === "phone" ? (
                      <div className="flex items-center gap-1.5 mt-1">
                        {renderProfileFieldInlineInput("phone")}
                        {savingField ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
                        ) : (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => handleInlineSave("phone", editValue)} className="text-emerald-500 hover:text-emerald-600 font-bold">✓</button>
                            <button onClick={() => setEditingField(null)} className="text-zinc-400 hover:text-zinc-600 font-bold">✕</button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div 
                        onClick={() => { setEditingField("phone"); setEditValue(selectedLead.phone_raw || selectedLead.phone_e164 || "") }}
                        className="flex items-center justify-between cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-lg p-1 -mx-1"
                      >
                        <span className="text-zinc-700 dark:text-gray-300 font-medium font-mono">{selectedLead.phone_raw || selectedLead.phone_e164 || "---"}</span>
                        {successField === "phone" ? (
                          <span className="text-emerald-500 font-bold font-sans">Saved!</span>
                        ) : (
                          <Edit2 className="w-3 h-3 text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    )}
                    {editingField === "phone" && saveError && <span className="text-[10px] text-red-500 block mt-0.5">{saveError}</span>}
                  </div>

                  {/* Journey Selection */}
                  <div className="group relative">
                    <span className="text-zinc-400 dark:text-gray-500 block text-[10px] uppercase tracking-wide font-medium">Journey</span>
                    {editingField === "journey_template" ? (
                      <div className="flex items-center gap-1.5 mt-1">
                        {renderProfileFieldInlineInput("journey_template")}
                        {savingField ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
                        ) : (
                          <button onClick={() => setEditingField(null)} className="text-zinc-400 hover:text-zinc-600 font-bold shrink-0">✕</button>
                        )}
                      </div>
                    ) : (
                      <div 
                        onClick={() => { setEditingField("journey_template"); setEditValue(selectedLead.journey_template || "") }}
                        className="flex items-center justify-between cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-lg p-1 -mx-1"
                      >
                        <span className="text-emerald-600 dark:text-emerald-400 font-semibold break-all">
                          {(() => {
                            const j = journeys.find(x => x.journey_key?.toLowerCase() === selectedLead.journey_template?.toLowerCase())
                            return j ? j.name : (selectedLead.journey_template || "---")
                          })()}
                        </span>
                        {successField === "journey_template" ? (
                          <span className="text-emerald-500 font-bold font-sans">Saved!</span>
                        ) : (
                          <Edit2 className="w-3 h-3 text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    )}
                    {editingField === "journey_template" && saveError && <span className="text-[10px] text-red-500 block mt-0.5">{saveError}</span>}
                  </div>

	                  {/* Journey Status */}
	                  <div className="group relative">
	                    <span className="text-zinc-400 dark:text-gray-500 block text-[10px] uppercase tracking-wide font-medium">Journey Status</span>
                    {editingField === "journey_status" ? (
                      <div className="flex items-center gap-1.5 mt-1">
                        {renderProfileFieldInlineInput("journey_status")}
                        {savingField ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
                        ) : (
                          <button onClick={() => setEditingField(null)} className="text-zinc-400 hover:text-zinc-600 font-bold shrink-0">✕</button>
                        )}
                      </div>
                    ) : (
                      <div 
                        onClick={() => { setEditingField("journey_status"); setEditValue(selectedLead.journey_status || "new") }}
                        className="flex items-center justify-between cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-lg p-1 -mx-1"
                      >
	                        <StatusPill display={getJourneyStatusDisplay(selectedLead.journey_status, selectedLead)} />
                        {successField === "journey_status" ? (
                          <span className="text-emerald-500 font-bold font-sans">Saved!</span>
                        ) : (
                          <Edit2 className="w-3 h-3 text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    )}
                    {editingField === "journey_status" && saveError && <span className="text-[10px] text-red-500 block mt-0.5">{saveError}</span>}
                  </div>
                </div>

                {/* Custom fields — grouped by folder, collapsible */}
                {customFieldsSchema.length > 0 && (
                  <div className="pt-3 border-t border-black/5 dark:border-white/5 space-y-2">
                    {Object.entries(groupCustomFieldsByFolder(customFieldsSchema)).map(([folder, fields]) => (
                      <details key={folder} open className="bg-zinc-950/[0.02] dark:bg-white/[0.02] border border-black/5 dark:border-white/5 rounded-xl">
                        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] rounded-xl select-none flex items-center justify-between">
                          <span className="flex items-center gap-1.5">
                            <Folder className="w-3.5 h-3.5 text-zinc-400" /> {folder}
                            <span className="text-zinc-400 dark:text-zinc-500 font-normal">({fields.length})</span>
                          </span>
                          <ChevronDown className="w-3.5 h-3.5 text-zinc-400 transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="px-3 pb-3 grid grid-cols-2 gap-3 text-xs">
                          {fields.map((field) => {
                            const val = selectedLead.custom_fields?.[field.key]
                            const isEditing = editingField === `custom.${field.key}`
                            const isSuccess = successField === `custom.${field.key}`
                            return (
                              <div key={field.key} className="space-y-0.5 col-span-2 group relative">
                                <span className="text-zinc-400 dark:text-gray-500 block text-[10px] uppercase tracking-wide flex items-center gap-1 font-medium">
                                  {field.label}
                                  {/* Info tooltip — always shown for every custom field so the
                                      operator can copy the merge tag (needed for templates,
                                      HTTP request bodies, AI agent knowledge, etc.). Click
                                      copies {{key}} to clipboard; hover shows the description
                                      + the tag. */}
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      const tag = `{{${field.key}}}`
                                      try {
                                        navigator.clipboard?.writeText(tag)
                                        // Reuse the field-save success flash pattern so the
                                        // operator sees confirmation without a new toast queue.
                                        setSuccessField(`copy_${field.key}`)
                                        setTimeout(() => setSuccessField(null), 1200)
                                      } catch { /* clipboard blocked — tooltip still works */ }
                                    }}
                                    className="cursor-pointer inline-flex items-center hover:opacity-100 opacity-60 transition-opacity"
                                    title={
                                      `Merge tag: {{${field.key}}}\nClick to copy` +
                                      (field.description ? `\n\n${field.description}` : "")
                                    }
                                    aria-label={`Copy merge tag {{${field.key}}}`}
                                  >
                                    <Info className="w-3 h-3" />
                                  </button>
                                  {successField === `copy_${field.key}` && (
                                    <span className="text-[10px] text-emerald-500 font-mono normal-case tracking-normal">copied</span>
                                  )}
                                </span>
                                {isEditing ? (
                                  <div className="flex flex-col gap-1.5 mt-1">
                                    {renderCustomFieldInlineInput(field)}
                                    <div className="flex justify-end gap-1.5 text-[10px]">
                                      {savingField ? (
                                        <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
                                      ) : (
                                        <>
                                          <button
                                            onClick={() => handleInlineSave(field.key, editValue, true)}
                                            className="px-2 py-0.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 rounded-md border border-emerald-500/20 font-semibold"
                                          >
                                            Save
                                          </button>
                                          <button
                                            onClick={() => setEditingField(null)}
                                            className="px-2 py-0.5 bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-500 dark:text-gray-400 rounded-md border border-black/5 dark:border-white/5 font-semibold"
                                          >
                                            Cancel
                                          </button>
                                        </>
                                      )}
                                    </div>
                                    {saveError && <span className="text-[10px] text-red-500 block">{saveError}</span>}
                                  </div>
                                ) : (
                                  <div 
                                    onClick={() => {
                                      setEditingField(`custom.${field.key}`)
                                      setEditValue(val ?? "")
                                    }}
                                    className="flex items-center justify-between cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-lg p-1 -mx-1"
                                  >
                                    <span className="text-zinc-700 dark:text-gray-300 font-mono text-left break-all font-medium">
                                      <CustomFieldDisplay field={field} value={val} />
                                    </span>
                                    {isSuccess ? (
                                      <span className="text-emerald-500 font-bold font-sans">Saved!</span>
                                    ) : (
                                      <Edit2 className="w-3 h-3 text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </details>
                    ))}
                  </div>
                )}
              </div>

              {isOperator && (
                <div className="bg-white/40 dark:bg-white/[0.02] border border-rose-500/15 backdrop-blur-xl rounded-2xl p-5 space-y-3">
                  <h3 className="text-xs font-semibold text-rose-600 dark:text-rose-400 uppercase tracking-wider">Danger zone</h3>
                  <p className="text-xs text-zinc-500 dark:text-gray-400">
                    Deleting a lead removes its profile and related history. Use this only when the record should no longer exist.
                  </p>
                  <Button
                    onClick={(e) => handleOpenDelete(selectedLead, e)}
                    className="bg-transparent hover:bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 dark:border-rose-500/30 rounded-xl px-4 py-2 font-medium transition-all flex items-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" /> Delete lead
                  </Button>
                </div>
              )}
            </div>

            <div className="lg:col-span-6 space-y-6">
              <div className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-6 space-y-6">

                {/* PHASE6: Enrollments panel — per-run visibility + controls */}
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold text-zinc-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-2">
                    <Activity className="w-4 h-4 text-zinc-400 dark:text-gray-500" />
                    Enrollments
                    {runs.length > 0 && (
                      <span className="text-[10px] font-normal text-zinc-400 dark:text-gray-500 normal-case tracking-normal">
                        · {runs.length} run{runs.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </h3>
                  {runsLoading ? (
                    <p className="text-xs text-zinc-400">Loading…</p>
                  ) : runs.length === 0 ? (
                    <p className="text-xs text-zinc-400">No enrollments.</p>
                  ) : (
                    <div className="space-y-2">
                      {runs.map((run) => {
                        const isRunning = run.status === "running"
                        const isPaused = run.status === "paused"
                        const isTerminal = ["completed", "failed", "cancelled", "responded", "opted_out"].includes(run.status)
                        const runVariant = run.status === "running" ? "success"
                          : run.status === "paused" ? "warning"
                          : run.status === "responded" ? "info"
                          : ["failed", "cancelled"].includes(run.status) ? "danger"
                          : "neutral"
                        return (
                          <div key={run.id} className="flex items-center justify-between gap-3 rounded-xl border border-black/5 dark:border-white/5 bg-zinc-50/50 dark:bg-black/20 px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge variant={runVariant} size="sm" className="uppercase">{run.status}</Badge>
                                <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200 truncate">{run.journey_name || run.journey_key}</span>
                                {run.journey_paused ? (
                                  <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">journey paused</span>
                                ) : null}
                              </div>
                              <div className="text-[10px] text-zinc-400 dark:text-gray-500 mt-0.5">
                                started {new Date(run.created_at).toLocaleString()} · step {run.current_step ?? "—"}
                                {run.trigger_type && run.trigger_type !== "manual" ? ` · ${run.trigger_type}` : ""}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {!isTerminal && (
                                <>
                                  {isPaused ? (
                                    <Button size="sm" variant="outline" disabled={runOpLoading === run.id} onClick={() => handleRunOp(run.id, "resume")} className="h-7 px-2 text-[11px]">Resume</Button>
                                  ) : isRunning ? (
                                    <Button size="sm" variant="outline" disabled={runOpLoading === run.id} onClick={() => handleRunOp(run.id, "pause")} className="h-7 px-2 text-[11px]">Pause</Button>
                                  ) : null}
                                  <Button size="sm" variant="outline" disabled={runOpLoading === run.id} onClick={() => handleRunOp(run.id, "cancel")} className="h-7 px-2 text-[11px] text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-500/30 hover:bg-rose-50 dark:hover:bg-rose-500/10">Cancel</Button>
                                </>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* Timeline Header with toggles */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <h3 className="text-xs font-semibold text-zinc-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-2">
                    <Clock className="w-4 h-4 text-zinc-400 dark:text-gray-500" />
                    {viewMode === "conversation" ? "Conversation" : viewMode === "unified" ? "Unified Feed" : "Interaction Timeline"}
                    {timelineMeta?.applied && (timelineMeta.actions_hidden + timelineMeta.events_hidden) > 0 && (
                      <span className="text-[10px] font-normal text-zinc-400 dark:text-gray-500 normal-case tracking-normal">
                        · {timelineMeta.actions_hidden + timelineMeta.events_hidden} hidden from prior journeys
                      </span>
                    )}
                  </h3>
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* viewMode toggle */}
                    <div className="inline-flex items-center bg-zinc-100 dark:bg-white/5 rounded-lg p-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setViewMode("unified")}
                        className={`px-2.5 py-1 rounded-md transition-colors ${
                          viewMode === "unified"
                            ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm"
                            : "text-zinc-500 dark:text-gray-400 hover:text-zinc-700 dark:hover:text-gray-200"
                        }`}
                        title="Unified view: chat bubbles and system/automation logs interleaved chronologically"
                      >
                        Unified Feed
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode("conversation")}
                        className={`px-2.5 py-1 rounded-md transition-colors ${
                          viewMode === "conversation"
                            ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm"
                            : "text-zinc-500 dark:text-gray-400 hover:text-zinc-700 dark:hover:text-gray-200"
                        }`}
                        title="Chat-style view of messages exchanged with this lead"
                      >
                        Conversation
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode("timeline")}
                        className={`px-2.5 py-1 rounded-md transition-colors ${
                          viewMode === "timeline"
                            ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm"
                            : "text-zinc-500 dark:text-gray-400 hover:text-zinc-700 dark:hover:text-gray-200"
                        }`}
                        title="System trace: every action and event with status, retry reasons, etc."
                      >
                        Timeline
                      </button>
                    </div>
                    
                    {/* Scope toggle */}
                    {selectedLead?.journey_template && (
                      <div className="inline-flex items-center bg-zinc-100 dark:bg-white/5 rounded-lg p-0.5 text-[11px]">
                        <button
                          type="button"
                          onClick={() => setTimelineScope("current")}
                          className={`px-2.5 py-1 rounded-md transition-colors ${
                            timelineScope === "current"
                              ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm"
                              : "text-zinc-500 dark:text-gray-400 hover:text-zinc-700 dark:hover:text-gray-200"
                          }`}
                          title="Show only actions and events from this lead's current journey enrollment"
                        >
                          Current journey
                        </button>
                        <button
                          type="button"
                          onClick={() => setTimelineScope("all")}
                          className={`px-2.5 py-1 rounded-md transition-colors ${
                            timelineScope === "all"
                              ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm"
                              : "text-zinc-500 dark:text-gray-400 hover:text-zinc-700 dark:hover:text-gray-200"
                          }`}
                          title="Show every action and event ever recorded for this lead, across all enrollments"
                        >
                          All time
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {timelineError && (
                  <Alert variant="danger" size="sm">{timelineError}</Alert>
                )}

                {viewMode === "conversation" || viewMode === "unified" ? (
                  <ConversationView
                    timeline={timeline}
                    loading={timelineLoading}
                    lead={selectedLead}
                    channelFilter={convChannel}
                    setChannelFilter={setConvChannel}
                    stripHtmlAndEntities={stripHtmlAndEntities}
                    dateBucketLabel={dateBucketLabel}
                    formatTimeOnly={formatTimeOnly}
                    stripQuotedTail={stripQuotedTail}
                    onReplySent={() => {
                      if (selectedLead?.id) fetchTimeline(selectedLead.id, timelineScope, { silent: true })
                      setTimelineError("")
                    }}
                    onComposerError={(msg) => setTimelineError(msg)}
                    showSystemLogs={viewMode === "unified"}
                  />
                ) : timelineLoading ? (
                  <div className="flex flex-col items-center justify-center py-12 space-y-3">
                    <Loader2 className="w-6 h-6 animate-spin text-zinc-400 dark:text-gray-500" />
                    <span className="text-sm text-zinc-500 dark:text-gray-500">Loading timeline...</span>
                  </div>
                ) : timeline.length === 0 ? (
                  <div className="text-center py-10 text-xs text-zinc-400 dark:text-gray-500 bg-zinc-950/[0.01] dark:bg-white/[0.01] border border-dashed border-black/10 dark:border-white/5 rounded-2xl">
                    No outreach action or event recorded for this lead yet.
                  </div>
                ) : (
                  <div className="relative border-l border-black/10 dark:border-white/10 pl-6 ml-3 space-y-8">
                    {timeline.map((item) => {
                      const isOutbound = item.type === "outbound"
                      const isCall = item.channel === "call"
                      const isSMS = item.channel === "sms"
                      const isEmail = item.channel === "email"
                      const eventDisplay = getTimelineEventDisplay(item)

                      let IconComponent = Settings
                      let iconBg = "bg-zinc-950/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-zinc-500 dark:text-gray-400"

                      if (isCall) {
                        IconComponent = PhoneCall
                        iconBg = isOutbound 
                          ? "bg-blue-500/10 border-blue-500/20 text-blue-500 dark:text-blue-400"
                          : "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                      } else if (isSMS) {
                        IconComponent = MessageSquare
                        iconBg = isOutbound
                          ? "bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400"
                          : "bg-orange-500/10 border-orange-500/20 text-orange-600 dark:text-orange-400"
                      } else if (isEmail) {
                        IconComponent = Mail
                        iconBg = isOutbound
                          ? "bg-zinc-950/5 dark:bg-white/10 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white"
                          : "bg-slate-500/10 border-slate-500/20 text-slate-600 dark:text-slate-300"
                      }

                      return (
                        <div key={item.id} className="relative">
                          <div className={`absolute -left-[37px] top-1 w-6 h-6 rounded-full border flex items-center justify-center z-10 ${iconBg} shadow-md`}>
                            <IconComponent className="w-3.5 h-3.5" />
                          </div>

                          <div className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 hover:border-black/10 dark:hover:border-white/10 rounded-2xl p-4 transition-all space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-zinc-900 dark:text-white/90">{eventDisplay.title}</span>
                              <span className={getStatusPillClass(eventDisplay.status.variant, "text-[10px]")} title={eventDisplay.status.title}>
                                {eventDisplay.status.label}
                              </span>
                            </div>

                            {item.subtitle && (
                              <div className={`text-[11px] flex items-center gap-1 ${
                                item.wasRescheduled ? 'text-blue-600 dark:text-blue-400' :
                                item.status === 'skipped' || item.status === 'cancelled' ? 'text-zinc-500 dark:text-zinc-400' :
                                item.status === 'failed' ? 'text-rose-600 dark:text-rose-400' :
                                'text-amber-600 dark:text-amber-400'
                              }`}>
                                <Clock className="w-3 h-3" /> {item.subtitle}
                              </div>
                            )}

                            <span className="text-[10px] text-zinc-400 dark:text-gray-500 block">
                              {formatDate(item.timestamp)}
                            </span>

                            {item.body && (
                              <p className="text-xs text-zinc-700 dark:text-gray-300 bg-zinc-950/5 dark:bg-black/20 p-2.5 border border-black/5 dark:border-white/5 rounded-xl whitespace-pre-wrap leading-relaxed">
                                {item.body}
                              </p>
                            )}

                            {item.details && item.details.body && (
                              <div className="space-y-1.5 bg-zinc-950/5 dark:bg-black/20 p-2.5 border border-black/5 dark:border-white/5 rounded-xl">
                                {item.details.subject && (
                                  <div className="text-[10px] text-zinc-500 dark:text-gray-400 font-medium">Subject: {item.details.subject}</div>
                                )}
                                <p className="text-xs text-zinc-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
                                  {item.details.body}
                                </p>
                              </div>
                            )}

                            {isCall && (item.callSummary || item.callTranscript || item.callRecordingUrl) && (
                              <div className="space-y-3 pt-2 border-t border-white/5">
                                {item.callRecordingUrl && (
                                  <div className="space-y-1">
                                    <span className="text-[10px] text-zinc-500 dark:text-gray-500 flex items-center gap-1">
                                      <Volume2 className="w-3.5 h-3.5" /> Call Recording
                                    </span>
                                    <div className="bg-zinc-950/5 dark:bg-black/30 rounded-xl p-2 border border-black/5 dark:border-white/5">
                                      <audio 
                                        src={item.callRecordingUrl} 
                                        controls 
                                        className="w-full h-7 text-xs select-none outline-none" 
                                        style={{ filter: theme === "dark" ? "invert(90%) hue-rotate(180deg)" : "none" }}
                                      />
                                    </div>
                                  </div>
                                )}

                                {item.callSummary && (
                                  <div className="text-xs">
                                    <span className="text-zinc-500 dark:text-gray-500 font-medium">Summary:</span>
                                    <p className="text-zinc-700 dark:text-gray-300 mt-1 italic">{item.callSummary}</p>
                                  </div>
                                )}

                                {item.callTranscript && (
                                  <details className="group border border-black/5 dark:border-white/5 rounded-xl overflow-hidden bg-zinc-950/5 dark:bg-black/10">
                                    <summary className="text-[10px] text-zinc-500 dark:text-gray-400 font-semibold cursor-pointer py-2 px-3 hover:bg-zinc-950/5 dark:hover:bg-white/5 select-none list-none flex items-center justify-between">
                                      View Transcript 
                                      <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90 text-zinc-400 dark:text-gray-500" />
                                    </summary>
                                    <div className="p-3 border-t border-black/5 dark:border-white/5 text-[11px] font-mono leading-relaxed bg-zinc-950/10 dark:bg-black/25 text-zinc-700 dark:text-gray-300 max-h-40 overflow-y-auto whitespace-pre-wrap">
                                      {item.callTranscript}
                                    </div>
                                  </details>
                                )}
                              </div>
                            )}

                            {item.error && (
                              <div className="flex items-center gap-1.5 text-rose-400 bg-rose-500/10 border border-rose-500/20 p-2 rounded-xl text-xs">
                                <AlertCircle className="w-3.5 h-3.5" />
                                <span>{item.error}</span>
                              </div>
                            )}

                            {item.canRunNow && (
                              <button
                                onClick={async (e) => {
                                  e.preventDefault()
                                  if (!(await confirm({
                                    title: "Force this action to run immediately?",
                                    message: "This bypasses any rescheduled run_at.",
                                    confirmLabel: "Run now",
                                  }))) return
                                  try {
                                    const res = await fetch(`/api/actions/${item.id}/run-now`, { method: "POST" })
                                    const json = await res.json()
                                    if (!res.ok) {
                                      pushToast("error", json.error || "Failed to run now")
                                      return
                                    }
                                    if (selectedLead) fetchTimeline(selectedLead.id)
                                  } catch (err) {
                                    pushToast("error", err.message || "Failed to run now")
                                  }
                                }}
                                className="text-[11px] flex items-center gap-1.5 text-blue-700 dark:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 px-3 py-1.5 rounded-lg transition-colors"
                                title="Sets run_at = now() so the dispatcher fires it within ~1 minute"
                              >
                                <Play className="w-3 h-3" /> Run now
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT COLUMN: Journey steps, Opportunity/Deals & Warnings (cols: 3) */}
            <div className="lg:col-span-3 space-y-6">
              
              {/* Warnings Panel */}
              {leadWarnings.length > 0 && (
                <div className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-5 space-y-3">
                  <h3 className="text-xs font-semibold text-zinc-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-500" /> Warnings ({leadWarnings.length})
                  </h3>
                  <div className="space-y-2">
                    {leadWarnings.map((w, i) => {
                      const warningDisplay = getWarningDisplay(w)
                      return (
                        <div
                          key={i}
                          className={`p-3 rounded-xl border text-xs ${
                            w.severity === "error"
                              ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                              : w.severity === "warning"
                              ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                              : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                          }`}
                        >
                          <div className="text-[10px] uppercase tracking-wider mb-1 opacity-70 font-semibold">
                            {warningDisplay.label}
                          </div>
                          {warningDisplay.message}
                          {warningDisplay.details && warningDisplay.details !== warningDisplay.message && (
                            <details className="mt-2 text-[10px] opacity-80">
                              <summary className="cursor-pointer">Technical details</summary>
                              <div className="mt-1 font-mono break-words">{warningDisplay.details}</div>
                            </details>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Outreach Overview / Next Action Card */}
              {leadJourney && (
                <div className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-5 space-y-4 shadow-sm">
                  <h3 className="text-xs font-semibold text-zinc-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-indigo-500" />
                    Outreach Status & Next Action
                  </h3>
                  
                  <div className="space-y-4">
                    {/* Current Status Row */}
                    <div className="flex items-center justify-between p-3 bg-zinc-950/5 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 rounded-xl">
	                      <div className="space-y-0.5">
	                        <span className="text-[10px] text-zinc-400 dark:text-gray-500 uppercase tracking-wider font-semibold">Lead Status</span>
	                        <div className="flex items-center gap-1.5 mt-0.5">
	                          {(() => {
	                            const leadStatus = getLeadStatusDisplay(selectedLead.journey_status, selectedLead)
	                            return (
	                              <>
	                                <span className={`w-2 h-2 rounded-full ${getStatusDotClass(leadStatus.variant)} ${leadStatus.variant === "success" ? "animate-pulse" : ""}`} />
	                                <span className="text-xs font-bold text-zinc-900 dark:text-white" title={leadStatus.title}>
	                                  {leadStatus.label}
	                                </span>
	                              </>
	                            )
	                          })()}
	                        </div>
	                      </div>
                      
                      {/* Current Step Tracker */}
                      <div className="text-right space-y-0.5">
                        <span className="text-[10px] text-zinc-400 dark:text-gray-500 uppercase tracking-wider font-semibold">Current Step</span>
                        <div className="text-xs font-mono font-bold text-zinc-700 dark:text-zinc-300">
                          {selectedLead.current_step !== undefined ? `Step ${selectedLead.current_step + 1} of ${(leadJourney.spec?.steps || []).length}` : 'Not Enrolled'}
                        </div>
                      </div>
                    </div>

                    {/* Current Showcase / Step Info */}
                    {(() => {
                      const steps = leadJourney.spec?.steps || []
                      const currentStep = steps[selectedLead.current_step]
                      if (!currentStep) return null
                      return (
                        <div className="p-3 bg-zinc-950/5 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 rounded-xl space-y-2">
                          <span className="text-[10px] text-zinc-400 dark:text-gray-500 uppercase tracking-wider font-semibold">Current Journey Location</span>
                          <div className="space-y-1">
                            <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
                              <span className="uppercase text-[10px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded font-mono">
                                {getJourneyStepLabel(currentStep.type)}
                              </span>
                              {currentStep.channel && (
                                <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                                  via {currentStep.channel}
                                </span>
                              )}
                            </div>
                            {currentStep.template_key && (
                              <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-mono">
                                Template: <span className="text-indigo-600 dark:text-indigo-400 font-semibold">{currentStep.template_key}</span>
                              </div>
                            )}
                            {currentStep.delay && (
                              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                                Delay: <span className="font-medium text-zinc-700 dark:text-zinc-300">Wait {currentStep.delay.amount} {currentStep.delay.unit}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })()}

                    {/* Next Action Info */}
                    {(() => {
                      const pendingAction = timeline.find(it => it.status === 'pending')
                      if (pendingAction) {
                        const pendingDisplay = getTimelineEventDisplay(pendingAction)
                        return (
                          <div className="p-3 bg-indigo-500/5 border border-indigo-500/20 rounded-xl space-y-2.5">
                            <span className="text-[10px] text-indigo-600 dark:text-indigo-400 uppercase tracking-wider font-bold">Next Scheduled Action</span>
                            <div className="space-y-1">
                              <div className="text-xs font-semibold text-zinc-900 dark:text-white">
                                {pendingDisplay.title}
                              </div>
                              {pendingAction.subtitle && (
                                <div className="text-[11px] text-zinc-500 dark:text-gray-400 flex items-center gap-1">
                                  <Clock className="w-3.5 h-3.5 text-zinc-400 dark:text-gray-500" />
                                  {pendingAction.subtitle}
                                </div>
                              )}
                              {pendingAction.timestamp && (
                                <div className="text-[10px] text-zinc-400 dark:text-zinc-500">
                                  Target Date: {formatDate(pendingAction.timestamp)}
                                </div>
                              )}
                            </div>

                            {/* Operator Actions directly in the card */}
                            <div className="pt-2 border-t border-black/5 dark:border-white/5 flex items-center gap-2">
                              <Button
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleRunNow(pendingAction.id)
                                }}
                                className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg text-xs py-1.5 h-auto shadow-sm flex items-center justify-center gap-1.5 transition-colors border border-transparent"
                                title="Force this step to execute immediately"
                              >
                                <Play className="w-3 h-3 fill-current" /> Run Now
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleSkipStep(pendingAction.id)
                                }}
                                className="flex-1 bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs py-1.5 h-auto font-semibold flex items-center justify-center gap-1.5 transition-colors"
                                title="Skip this step and proceed to the next step"
                              >
                                <SkipForward className="w-3 h-3" /> Skip Step
                              </Button>
                            </div>
                          </div>
                        )
                      } else {
                        return (
                          <div className="p-3 bg-zinc-950/5 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 rounded-xl text-center">
                            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                              {selectedLead.journey_status === 'completed' ? 'This journey is complete. No further steps are scheduled.' :
                               selectedLead.journey_status === 'failed' ? 'This journey stopped after a failure. Review the timeline before continuing.' :
                               selectedLead.opt_out ? 'This lead opted out and cannot be contacted.' :
                               'No active scheduled action is currently shown.'}
                            </span>
                          </div>
                        )
                      }
                    })()}
                  </div>
                </div>
              )}

              {/* Journey Steps Progress Tracker */}
              {leadJourney && (
                <div className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-5 space-y-4">
                  <h3 className="text-xs font-semibold text-zinc-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-2">
                    <Settings className="w-4 h-4 text-zinc-400 dark:text-gray-500" /> 
                    Journey Progress
                  </h3>
                  <div className="space-y-2">
                    <div className="text-xs text-zinc-500 dark:text-gray-400 flex flex-col gap-0.5 border-b border-black/5 dark:border-white/5 pb-2">
                      <div className="font-semibold text-zinc-700 dark:text-gray-300">{leadJourney.name}</div>
                      <div className="font-mono text-[10px]">key: {leadJourney.journey_key} (v{leadJourney.version})</div>
                    </div>
                    <div className="space-y-2 pt-2">
                      {(leadJourney.spec?.steps || []).map((step, i) => {
                        const isTerminal = !["active", "new", "paused"].includes(selectedLead.journey_status)
                        const isCurrent = !isTerminal && i === selectedLead.current_step
                        const isPast = isTerminal ? i <= selectedLead.current_step : i < selectedLead.current_step
                        const pendingAction = isCurrent && timeline.find(it => it.status === 'pending' && (it.stepIndex === i || it.stepIndex === undefined || it.stepIndex === null))
                        return (
                          <div
                            key={i}
                            className={`flex items-start gap-2.5 text-xs p-2.5 rounded-xl border transition-all ${
                              isCurrent
                                ? "bg-blue-500/10 border-blue-500/30 text-blue-700 dark:text-blue-300 shadow-sm"
                                : isPast
                                ? "bg-emerald-500/5 border-emerald-500/10 text-emerald-700 dark:text-emerald-300 opacity-80"
                                : "bg-zinc-950/5 dark:bg-white/[0.01] border-transparent text-zinc-500 dark:text-gray-500 opacity-60"
                            }`}
                          >
                            <span className="font-mono text-sm leading-none mt-0.5">
                              {isPast ? "✓" : isCurrent ? "▶" : "○"}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-1.5">
                                <span className="font-semibold uppercase text-[10px] tracking-wide">{getJourneyStepLabel(step.type)}</span>
                                {step.delay && (
                                  <span className="text-[10px] font-mono opacity-80">
                                    wait {step.delay.amount}{step.delay.unit?.[0]}
                                  </span>
                                )}
                              </div>
                              <div className="font-mono text-[10px] truncate mt-0.5 opacity-80">{step.template_key || "No template"}</div>
                              {pendingAction && (
                                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleRunNow(pendingAction.id)
                                    }}
                                    className="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded text-[10px] shadow-sm flex items-center gap-1 transition-colors border border-transparent"
                                    title="Force this step to execute immediately"
                                  >
                                    <Play className="w-2.5 h-2.5 fill-current" /> Run Now
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleSkipStep(pendingAction.id)
                                    }}
                                    className="px-2 py-0.5 bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-800 dark:text-zinc-200 font-semibold rounded text-[10px] shadow-sm flex items-center gap-1 transition-colors border border-black/5 dark:border-white/5"
                                    title="Skip this step and proceed to the next step"
                                  >
                                    <SkipForward className="w-2.5 h-2.5" /> Skip Step
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Call Recordings & Transcripts Panel */}
              {(() => {
                const callRecordings = []
                const customFields = selectedLead.custom_fields || {}
                const customRecordingUrl = customFields.last_call_recording_url || customFields.recording_url
                const customTranscript = customFields.last_call_transcript || customFields.transcript || customFields.call_transcript
                const customSummary = customFields.last_call_summary || customFields.summary || customFields.call_summary

                if (customRecordingUrl) {
                  callRecordings.push({
                    id: "custom-field",
                    title: "Latest Call (Custom Field)",
                    url: customRecordingUrl,
                    transcript: customTranscript,
                    summary: customSummary,
                    timestamp: selectedLead.updated_at || selectedLead.created_at
                  })
                }

                if (Array.isArray(timeline)) {
                  timeline.forEach(item => {
                    if (item.channel === "call" && item.callRecordingUrl) {
                      if (!callRecordings.some(r => r.url === item.callRecordingUrl)) {
                        callRecordings.push({
                          id: item.id || `timeline-${item.timestamp}`,
                          title: `Call on ${new Date(item.timestamp).toLocaleDateString()}`,
                          url: item.callRecordingUrl,
                          transcript: item.callTranscript || item.body,
                          summary: item.callSummary,
                          timestamp: item.timestamp
                        })
                      }
                    }
                  })
                }

                if (callRecordings.length === 0) return null

                return (
                  <div className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-5 space-y-4">
                    <h3 className="text-xs font-semibold text-zinc-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-2">
                      <Volume2 className="w-4 h-4 text-emerald-500" /> Call Recordings ({callRecordings.length})
                    </h3>
                    <div className="space-y-4">
                      {callRecordings.map((rec) => {
                        const isExpanded = expandedTranscriptId === rec.id
                        const isCopied = copiedId === rec.id
                        return (
                          <div key={rec.id} className="p-3 bg-zinc-950/5 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 rounded-xl space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                                {rec.title}
                              </span>
                              <a
                                href={rec.url}
                                download
                                target="_blank"
                                rel="noreferrer"
                                className="text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
                                title="Download Recording"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </a>
                            </div>

                            <audio src={rec.url} controls className="w-full h-8 bg-zinc-100 dark:bg-zinc-800 rounded-lg outline-none" />

                            {rec.summary && (
                              <div className="text-[11px] text-zinc-500 dark:text-gray-400">
                                <span className="font-semibold text-zinc-700 dark:text-zinc-300">Summary: </span>
                                {rec.summary}
                              </div>
                            )}

                            {rec.transcript && (
                              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <button
                                    type="button"
                                    onClick={() => setExpandedTranscriptId(isExpanded ? null : rec.id)}
                                    className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-0.5"
                                  >
                                    {isExpanded ? "Hide Transcript" : "Show Transcript"}
                                  </button>
                                  {isExpanded && (
                                    <button
                                      type="button"
                                      onClick={() => handleCopyTranscript(rec.transcript, rec.id)}
                                      className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 flex items-center gap-0.5 text-[10px] font-medium"
                                      title="Copy Transcript"
                                    >
                                      {isCopied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                                      <span>{isCopied ? "Copied!" : "Copy"}</span>
                                    </button>
                                  )}
                                </div>

                                {isExpanded && (
                                  <div className="text-[11px] text-zinc-600 dark:text-gray-300 bg-zinc-50 dark:bg-black/20 border border-black/5 dark:border-white/5 rounded-lg p-2.5 max-h-40 overflow-y-auto whitespace-pre-wrap font-sans leading-relaxed">
                                    {rec.transcript}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

            </div>

          </div>
        </div>
      ) : (
        /* ==================== LEADS LIST VIEW ==================== */
        <div className="space-y-4">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
                <AppIcon name="leads" size={32} className="text-zinc-700 dark:text-gray-300" />
                Leads Management
              </h1>
              <p className="text-sm text-zinc-500 dark:text-gray-400 mt-0.5">
                Track and configure leads in their follow-up journeys.
              </p>
            </div>
            {isOperator && (
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    router.push("/leads/import")
                  }}
                  variant="default"
                >
                  <Upload className="w-4 h-4" /> Import CSV
                </Button>
                <Button
                  onClick={handleOpenAdd}
                  variant="default"
                >
                  <Plus className="w-4 h-4" /> Add Lead
                </Button>
              </div>
            )}
          </div>

          {listError && (
            <Alert variant="danger" title="Could not load leads">
              <div className="opacity-90 break-words">{listError}</div>
            </Alert>
          )}

          {importBatchId && (
            <div className="flex flex-col gap-3 rounded-xl border border-sky-500/20 bg-sky-500/10 p-3 text-sm text-sky-800 dark:text-sky-200 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-semibold">Showing leads from this import</div>
                <div className="text-xs text-sky-700/80 dark:text-sky-300/80">Only imported leads from this import are shown. Select rows to enroll specific leads, or enroll eligible leads from this import.</div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {isOperator && selectedIds.size === 0 && (
                  <Button
                    type="button"
                    onClick={() => {
                      setBulkValue("")
                      resetBulkEnrollState()
                      setBulkEnrollScope("import")
                      setBulkOp("enroll")
                    }}
                    className="h-8 rounded-lg bg-zinc-950 px-3 text-xs text-white dark:bg-white dark:text-black"
                  >
                    Enroll this import in a journey
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={() => router.push("/leads")}
                  className="h-8 rounded-lg border border-sky-500/20 bg-white/70 px-3 text-xs text-sky-800 dark:bg-white/10 dark:text-sky-100"
                >
                  Clear filter
                </Button>
              </div>
            </div>
          )}

          {/* Segregation Tab selector */}
          <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5 border-b border-black/5 dark:border-white/5 pb-2">
            {[
	              { id: "all", label: "All Leads", count: allCount },
	              { id: "active", label: "Running", count: activeCount, title: "Loaded leads where journey_status is active." },
	              { id: "completed", label: "Journey Completed", count: completedCount, title: "Loaded leads where journey_status is completed." },
              { id: "opt_out", label: "Not Contactable", count: optOutCount, title: "Loaded leads where opt_out is true or journey_status is opted_out." },
              { id: "flagged", label: "Journey Failed", count: flaggedCount, title: "Loaded leads where journey_status is failed or error." },
            ].map((tab) => {
              const isActive = activeTabFilter === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTabFilter(tab.id)}
                  title={tab.title || "Count is based on currently loaded leads."}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-xl border transition-all flex items-center gap-2 shadow-sm ${
                    isActive
                      ? "bg-zinc-200 dark:bg-white/20 text-zinc-950 dark:text-white border-black/20 dark:border-white/20 shadow-sm"
                      : "bg-transparent text-zinc-600 dark:text-zinc-400 border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                >
                  <span>{tab.label}</span>
                  <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono ${
                    isActive
                      ? "bg-white dark:bg-black/40 text-zinc-900 dark:text-white border border-black/5 dark:border-white/5 shadow-sm"
                      : "bg-black/5 text-zinc-500 dark:bg-white/5 dark:text-zinc-500"
                  }`}>
                    {tab.count}
                  </span>
                </button>
	              )
	            })}
	          </div>
	          <p className="text-[10px] text-zinc-600 dark:text-zinc-400">
	            Lead tab counts reflect currently loaded rows, not full tenant totals.
	          </p>
          </div>

	          {/* Filters Bar */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-3 relative z-10">
            {/* Left: Search and Status Filter */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 flex-1">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
                <Input 
                  placeholder="Search leads by name, email, or phone..." 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 h-9 border-black/10 dark:border-white/5 bg-white dark:bg-white/[0.02] text-zinc-900 dark:text-white rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-500 focus-visible:ring-1 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
                />
              </div>
              
              <div className="w-full sm:w-48">
                <CustomSelect 
                  value={statusFilter}
                  onChange={(val) => setStatusFilter(val)}
                  options={[
                    { value: "all", label: "All Journey Statuses" },
                    { value: "new", label: "New" },
                    { value: "active", label: "Active" },
                    { value: "paused", label: "Paused" },
                    { value: "completed", label: "Completed" },
                    { value: "failed", label: "Failed" }
                  ]}
                  triggerClassName="w-full h-9 bg-white dark:bg-surface-2 border border-black/10 dark:border-white/5 text-zinc-700 dark:text-gray-300 text-xs rounded-xl px-3 outline-none flex items-center justify-between"
                />
              </div>
            </div>

            {/* Right: Segment & Column pickers */}
            <div className="flex items-center gap-3 self-stretch lg:self-auto justify-end">
              {/* Segments Dropdown */}
              {segments.length > 0 && (
                <div className="relative min-w-[140px]">
                  <CustomSelect
                    value=""
                    onChange={(val) => {
                      const seg = segments.find(s => s.id === val)
                      applySegment(seg)
                    }}
                    options={[
                      { value: "", label: "— Load Segment —" },
                      ...segments.map(s => ({ value: s.id, label: s.name }))
                    ]}
                    triggerClassName="h-9 w-full bg-white dark:bg-surface-2 border border-black/10 dark:border-white/5 text-zinc-700 dark:text-gray-300 text-xs rounded-xl px-3 outline-none flex items-center justify-between"
                  />
                </div>
              )}

              {/* Save Segment button */}
              <Button
                onClick={() => setShowSaveSegment(true)}
                variant="default"
              >
                Save Segment
              </Button>

              {/* Column picker toggle */}
              <div className="relative">
                <Button
                  onClick={() => setShowColumnsMenu(!showColumnsMenu)}
                  variant="outline"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" /> Columns
                </Button>

                {showColumnsMenu && (
                  <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-surface-1 border border-black/10 dark:border-white/10 rounded-2xl shadow-xl p-3 z-50 max-h-72 overflow-y-auto space-y-2">
                    <div className="text-[10px] font-semibold text-zinc-400 dark:text-gray-500 uppercase tracking-wider pb-1 border-b border-black/5 dark:border-white/5">
                      Toggle Columns
                    </div>
                    {allColumns.map(col => (
                      <label key={col.id} className="flex items-center gap-2 text-xs font-medium cursor-pointer p-1 rounded-lg hover:bg-zinc-950/5 dark:hover:bg-white/5 text-zinc-700 dark:text-gray-300 select-none">
                        <input
                          type="checkbox"
                          checked={(visibleColumnIds || new Set()).has(col.id)}
                          onChange={() => toggleColumn(col.id)}
                          className="rounded border-black/10 dark:border-white/10"
                        />
                        <span>{col.label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Leads table card */}
          <Card className="border border-black/5 dark:border-white/5 bg-white/40 dark:bg-white/[0.01] backdrop-blur-xl rounded-2xl overflow-hidden shadow-xl">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-zinc-100/95 dark:bg-zinc-950/95 backdrop-blur border-b border-black/5 dark:border-white/5">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-12 text-center">
                        <input
                          type="checkbox"
                          checked={filteredLeads.length > 0 && filteredLeads.every(l => selectedIds.has(l.id))}
                          onChange={(e) => {
                            const next = new Set(selectedIds)
                            if (e.target.checked) filteredLeads.forEach(l => next.add(l.id))
                            else filteredLeads.forEach(l => next.delete(l.id))
                            setSelectedIds(next)
                          }}
                          className="rounded border-zinc-300 dark:border-zinc-700 text-zinc-900 focus:ring-zinc-900"
                        />
                      </TableHead>
                      {visibleColumns.map((col) => (
                        <TableHead 
                          key={col.id} 
                          className={`text-xs font-bold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider py-2.5 ${
                            col.align === "center" ? "text-center" : col.align === "right" ? "text-right" : ""
                          }`}
                        >
                          {col.label}
                        </TableHead>
                      ))}
                      <TableHead className="w-24 text-right text-xs font-bold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider py-2.5">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="divide-y divide-black/5 dark:divide-white/5">
                    {loading && leads.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={visibleColumns.length + 2} className="text-center py-16">
                          <div className="flex flex-col items-center justify-center space-y-3">
                            <Loader2 className="w-8 h-8 animate-spin text-zinc-400 dark:text-gray-500" />
                            <span className="text-sm text-zinc-500 dark:text-gray-400 font-medium">Fetching leads from engine...</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : filteredLeads.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={visibleColumns.length + 2} className="text-center py-16">
                          <div className="flex flex-col items-center justify-center space-y-2 text-zinc-400 dark:text-gray-500">
                            <Users className="w-10 h-10 stroke-1" />
                            <span className="text-sm font-semibold mt-1">No Leads Found</span>
                            <span className="text-xs text-zinc-500 dark:text-gray-400">
                              {leads.length === 0 
                                ? "Import a CSV or add leads manually."
                                : "No leads found matching your search and filter criteria."}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredLeads.map((lead) => (
                        <TableRow 
                          key={lead.id}
                          className="hover:bg-blue-500/[0.04] dark:hover:bg-blue-400/[0.06] transition-colors border-b border-black/5 dark:border-white/5 group cursor-pointer"
                          onClick={() => setSelectedLead(lead)}
                        >
                          <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(lead.id)}
                              onChange={(e) => {
                                const next = new Set(selectedIds)
                                if (e.target.checked) next.add(lead.id); else next.delete(lead.id)
                                setSelectedIds(next)
                              }}
                              className="rounded border-zinc-300 dark:border-zinc-700 text-zinc-900 focus:ring-zinc-900"
                            />
                          </TableCell>
                          
                          {visibleColumns.map((col) => (
                            <TableCell 
                              key={col.id} 
                              className={`py-2.5 text-sm text-zinc-700 dark:text-gray-300 font-medium ${
                                col.align === "center" ? "text-center" : col.align === "right" ? "text-right" : ""
                              } ${col.cellClass || ""}`}
                            >
                              {col.render(lead, journeys)}
                            </TableCell>
                          ))}

                          <TableCell className="text-right py-2.5" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              {isOperator ? (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={(e) => handleOpenEdit(lead, e)}
                                    className="hover:bg-zinc-950/5 dark:hover:bg-white/5 text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white rounded-md transition-colors"
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={(e) => handleOpenDelete(lead, e)}
                                    className="hover:bg-rose-500/10 text-zinc-500 dark:text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 rounded-md transition-colors"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </>
                              ) : (
                                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 uppercase tracking-wider font-semibold">View</span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ==================== ADD / EDIT LEAD MODAL ==================== */}
      <AnimatePresence>
        {isAddEditOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsAddEditOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            />

            {/* Modal Dialog */}
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white dark:bg-surface-1 border border-black/10 dark:border-white/10 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden relative z-10 flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-black/5 dark:border-white/5 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold text-zinc-900 dark:text-white">
                    {editingLead ? "Edit Lead" : "Add Lead"}
                  </h2>
                  <p className="text-xs text-zinc-500 dark:text-gray-400 mt-1">
                    Create a lead and choose whether to start a follow-up journey.
                  </p>
                </div>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={() => setIsAddEditOpen(false)}
                  className="rounded-full hover:bg-zinc-950/5 dark:hover:bg-white/5 text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>

              {/* Form Content */}
              <form onSubmit={handleSaveLead} className="flex-1 overflow-y-auto p-6 space-y-4">
                <div className="space-y-4">
                  {formError && (
                    <Alert variant="danger">{formError}</Alert>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-zinc-900 dark:text-white font-medium text-xs">First name <span className="text-rose-500">*</span></Label>
                      <Input
                        required
                        placeholder="Jane"
                        value={formFirstName}
                        onChange={(e) => setFormFirstName(e.target.value)}
                        className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/5 text-zinc-900 dark:text-white h-9 rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-600 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-zinc-900 dark:text-white font-medium text-xs">Last name <span className="text-rose-500">*</span></Label>
                      <Input
                        required
                        placeholder="Doe"
                        value={formLastName}
                        onChange={(e) => setFormLastName(e.target.value)}
                        className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/5 text-zinc-900 dark:text-white h-9 rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-600 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-zinc-900 dark:text-white font-medium text-xs">Email <span className="text-rose-500">*</span></Label>
                    <Input
                      type="email"
                      required
                      placeholder="jane.doe@company.com"
                      value={formEmail}
                      onChange={(e) => setFormEmail(e.target.value)}
                      className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/5 text-zinc-900 dark:text-white h-9 rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-600 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-zinc-900 dark:text-white font-medium text-xs">Phone <span className="text-rose-500">*</span></Label>
                    <Input
                      type="tel"
                      required
                      placeholder="+1 555 012 3456"
                      value={formPhone}
                      onChange={(e) => setFormPhone(e.target.value)}
                      className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/5 text-zinc-900 dark:text-white h-9 rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-600 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
                    />
                    <p className="text-[11px] text-zinc-400 dark:text-gray-500">Example: +1 555 012 3456</p>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-zinc-900 dark:text-white font-medium text-xs">Journey <span className="text-rose-500">*</span></Label>
                    <CustomSelect
                      value={formJourney}
                      onChange={(val) => setFormJourney(val)}
                      options={[
                        { value: "", label: "— Select a journey —" },
                        ...journeys.map(j => ({ value: j.journey_key, label: j.name || j.journey_key }))
                      ]}
                      triggerClassName="w-full h-9 bg-white dark:bg-surface-3 border border-black/10 dark:border-white/5 text-zinc-700 dark:text-gray-300 text-xs rounded-xl px-3 outline-none flex items-center justify-between"
                    />
                    {journeys.length === 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                        No journeys loaded. Check the Journeys page or your Supabase config.
                      </p>
                    )}
                    {!editingLead && (
                      <p className="text-[11px] text-zinc-500 dark:text-gray-400 mt-1">
                        This lead will be added and the selected journey will start immediately.
                      </p>
                    )}
                  </div>

                  <div className="rounded-xl border border-black/5 dark:border-white/5 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setFormAdvancedOpen((open) => !open)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left text-xs font-semibold text-zinc-600 dark:text-gray-300 bg-zinc-950/[0.02] dark:bg-white/[0.02] hover:bg-zinc-950/[0.04] dark:hover:bg-white/[0.04]"
                    >
                      <span>Advanced</span>
                      <ChevronDown className={`w-3.5 h-3.5 text-zinc-400 transition-transform ${formAdvancedOpen ? "rotate-180" : ""}`} />
                    </button>

                    {formAdvancedOpen && (
                      <div className="p-4 space-y-4 border-t border-black/5 dark:border-white/5">
                        <div className="space-y-1.5">
                          <Label className="text-zinc-900 dark:text-white font-medium text-xs">Source</Label>
                          <Input
                            placeholder="Manual Add"
                            value={formSource}
                            onChange={(e) => setFormSource(e.target.value)}
                            className="bg-white dark:bg-surface-3 border-black/10 dark:border-white/5 text-zinc-900 dark:text-white h-9 rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-600 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
                          />
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-zinc-900 dark:text-white font-medium text-xs">Journey status</Label>
                          <CustomSelect
                            value={formStatus}
                            onChange={(val) => setFormStatus(val)}
                            options={["new", "active", "paused", "completed", "failed"].map((value) => ({
                              value,
                              label: getJourneyStatusDisplay(value).label,
                            }))}
                            triggerClassName="w-full h-9 bg-white dark:bg-surface-3 border border-black/10 dark:border-white/5 text-zinc-700 dark:text-gray-300 text-xs rounded-xl px-3 outline-none flex items-center justify-between"
                          />
                        </div>

                {/* Custom Fields — grouped by folder, type-aware inputs */}
                {customFieldsSchema.length > 0 && Object.entries(groupCustomFieldsByFolder(customFieldsSchema)).map(([folder, fields]) => (
                  <div key={folder} className="space-y-3 pt-3 border-t border-black/5 dark:border-white/5">
                    <Label className="text-zinc-500 dark:text-gray-400 text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5">
                      <Folder className="w-3.5 h-3.5 text-zinc-400" /> {folder}
                    </Label>
                    <div className="grid grid-cols-2 gap-4">
                      {fields.map((field) => {
                        const val = formCustomFields[field.key]
                        const setVal = (next) => {
                          setFormCustomFields({ ...formCustomFields, [field.key]: next })
                          // Clear this field's error as soon as the user edits it.
                          if (customFieldErrors[field.key]) {
                            const { [field.key]: _, ...rest } = customFieldErrors
                            setCustomFieldErrors(rest)
                          }
                        }
                        const fieldError = customFieldErrors[field.key]
                        // Boolean, multi_line, radio, multi_select span full width for readability
                        const fullWidth = ["multi_line", "radio", "multi_select"].includes(field.type)
                        return (
                          <div key={field.key} className={`space-y-1.5 ${fullWidth ? "col-span-2" : "col-span-2 sm:col-span-1"}`}>
                            <Label className="text-zinc-500 dark:text-gray-400 text-xs flex items-center gap-1">
                              {field.label}
                              {field.required && <span className="text-rose-500 font-bold">*</span>}
                              {field.description && (
                                <span className="cursor-help text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300" title={field.description}>
                                  <Info className="w-3 h-3" />
                                </span>
                              )}
                            </Label>
                            <div className={fieldError ? "ring-1 ring-rose-500/60 rounded-xl" : ""}>
                              <CustomFieldInput field={field} value={val} onChange={setVal} />
                            </div>
                            {fieldError && (
                              <div className="text-[11px] text-rose-600 dark:text-rose-400 flex items-center gap-1">
                                <AlertCircle className="w-3 h-3" /> {fieldError}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer Buttons */}
                <div className="sticky -bottom-6 -mx-6 mt-2 px-6 py-4 bg-white/95 dark:bg-zinc-950/95 backdrop-blur border-t border-black/5 dark:border-white/5 flex items-center justify-end gap-3">
                  <Button 
                    type="button"
                    onClick={() => setIsAddEditOpen(false)}
                    className="h-9 px-4 rounded-xl bg-transparent hover:bg-zinc-950/5 dark:hover:bg-white/5 text-zinc-500 dark:text-gray-400 border border-black/10 dark:border-white/5 font-medium text-xs transition-colors"
                  >
                    Cancel
                  </Button>
                  <Button 
                    type="submit"
                    variant="default"
                  >
                    {editingLead ? "Save Changes" : "Create Lead"}
                  </Button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ==================== SAVE SEGMENT MODAL ==================== */}
      {showSaveSegment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="absolute inset-0" onClick={() => setShowSaveSegment(false)} />
          <div className="relative w-full max-w-sm bg-white dark:bg-surface-1 border border-black/10 dark:border-white/10 rounded-2xl shadow-2xl p-6">
            <h3 className="text-lg font-bold text-zinc-900 dark:text-white mb-3">Save current view</h3>
            <p className="text-xs text-zinc-500 mb-3">Stores the search, journey-status filter, and visible columns. Re-applies from the Segments dropdown.</p>
            <Input
              autoFocus
              value={segmentName}
              onChange={(e) => setSegmentName(e.target.value)}
              placeholder="e.g. Hot leads — replied last 7d"
              className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
              onKeyDown={(e) => e.key === "Enter" && saveSegment()}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => setShowSaveSegment(false)} className="bg-transparent border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-200 rounded-xl">Cancel</Button>
              <Button onClick={saveSegment} disabled={!segmentName.trim()} variant="default">Save</Button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== FLOATING BULK ACTION TOOLBAR ==================== */}
      {selectedIds.size > 0 && !bulkOp && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 fade-in duration-200">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-zinc-900 dark:bg-zinc-800 border border-white/10 rounded-2xl shadow-2xl backdrop-blur-xl text-white">
            {/* Count badge */}
            <div className="flex items-center gap-1.5 pr-3 border-r border-white/20">
              <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center text-[10px] font-bold">
                {selectedIds.size}
              </div>
              <span className="text-xs font-medium text-white/80">
                {selectedIds.size === 1 ? "lead" : "leads"} selected
              </span>
            </div>

            {/* Bulk action buttons */}
            <button
              onClick={() => { setBulkValue(""); resetBulkEnrollState(); setBulkOp("enroll") }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl bg-white/10 hover:bg-white/20 transition-colors"
            >
              Enroll in journey
            </button>
            <button
              onClick={() => { setBulkField(""); setBulkValue(""); setBulkOp("set_field") }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl bg-white/10 hover:bg-white/20 transition-colors"
            >
              Set Field
            </button>
            <button
              onClick={() => setBulkOp("exit")}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 transition-colors"
            >
              Exit Journey
            </button>

            {/* Clear selection */}
            <button
              onClick={() => setSelectedIds(new Set())}
              className="ml-1 p-1 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
              title="Clear selection"
              aria-label="Clear selection"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* ==================== BULK OPERATION MODAL ==================== */}
      {bulkOp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="absolute inset-0" onClick={() => !bulkSaving && closeBulkModal({ clearSelection: !!bulkEnrollResult && bulkEnrollScope === "selected" })} />
          <div className="relative w-full max-w-md bg-white dark:bg-surface-1 border border-black/10 dark:border-white/10 rounded-2xl shadow-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900 dark:text-white">
                {bulkOp === "exit" && "Exit journey"}
                {bulkOp === "enroll" && (bulkEnrollScope === "import" ? "Enroll leads from this import" : "Enroll in journey")}
                {bulkOp === "set_field" && "Set field"}
                {" "}— {bulkEnrollScope === "import" ? "this import" : `${selectedIds.size} leads`}
              </h3>
              <button onClick={() => closeBulkModal({ clearSelection: !!bulkEnrollResult && bulkEnrollScope === "selected" })} disabled={bulkSaving} className="p-1 text-zinc-400 hover:text-zinc-900 dark:hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {bulkOp === "exit" && (
              <p className="text-sm text-zinc-600 dark:text-zinc-300">
                This sets <span className="font-mono">journey_status='completed'</span> on every selected lead.
                The journey-exit trigger cancels their pending actions automatically.
                <br /><br />
                <span className="text-rose-600 dark:text-rose-400 font-medium">This is irreversible from the UI.</span>
              </p>
            )}
            {bulkOp === "enroll" && (
              <div className="space-y-3">
                {bulkEnrollResult ? (
                  <div className="space-y-3">
                    <Alert variant="success" size="sm">
                      {bulkEnrollResult.summary?.enrolled || 0} enrolled, {(bulkEnrollResult.summary?.skipped_already_active || 0) + (bulkEnrollResult.summary?.skipped_opted_out || 0) + (bulkEnrollResult.summary?.skipped_suppressed || 0) + (bulkEnrollResult.summary?.skipped_missing_contact || 0)} skipped, {bulkEnrollResult.summary?.failed || 0} failed.
                    </Alert>
                    {(bulkEnrollResult.results || []).filter((row) => row.status !== "enrolled").slice(0, 4).map((row) => (
                      <div key={row.lead_id} className="text-[11px] text-zinc-500 dark:text-gray-400">
                        <span className="font-mono">{row.lead_id.slice(0, 8)}</span>: {row.reason}
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-zinc-500">
                      {bulkEnrollScope === "import"
                        ? "Only leads from this import will be considered. Eligible leads queue step 0 through the native action queue."
                        : "Queues step 0 through the native action queue. No providers are called from this action."}
                    </p>
                    <div>
                      <Label className="text-xs">Journey</Label>
                      <CustomSelect
                        value={bulkValue}
                        onChange={(val) => {
                          setBulkValue(val)
                          fetchBulkEnrollPreview(val)
                        }}
                        options={[
                          { value: "", label: "— pick a journey —" },
                          ...journeys.filter(j => j.active).map(j => ({ value: j.journey_key, label: j.name || j.journey_key }))
                        ]}
                        triggerClassName="w-full mt-1 h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between"
                      />
                    </div>
                    <div className="rounded-xl border border-black/10 dark:border-white/10 p-3 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-zinc-500 dark:text-gray-400">Start behavior</span>
                        <span className="font-medium text-zinc-800 dark:text-gray-200">Start now</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-center">
                        {[
                          ["Ready", bulkEnrollPreview?.summary?.ready || 0],
                          ["Active", bulkEnrollPreview?.summary?.skipped_already_active || 0],
                          ["Opted out", bulkEnrollPreview?.summary?.skipped_opted_out || 0],
                          ["Suppressed", bulkEnrollPreview?.summary?.skipped_suppressed || 0],
                        ].map(([label, value]) => (
                          <div key={label} className="rounded-lg bg-zinc-950/5 dark:bg-white/[0.03] p-2">
                            <div className="text-sm font-semibold text-zinc-900 dark:text-white">{value}</div>
                            <div className="text-[10px] text-zinc-500">{label}</div>
                          </div>
                        ))}
                      </div>
                      {(bulkEnrollPreview?.summary?.skipped_missing_contact || 0) > 0 && (
                        <div className="text-[11px] text-amber-700 dark:text-amber-300">
                          {bulkEnrollPreview.summary.skipped_missing_contact} lead(s) missing the contact method required by step 0.
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            {bulkOp === "set_field" && (
              <div className="space-y-3">
                <p className="text-xs text-zinc-500">
                  Writes one custom field on every selected lead. Existing custom_fields are preserved.
                </p>
                <div>
                  <Label className="text-xs">Custom field key</Label>
                  <Input value={bulkField} onChange={(e) => setBulkField(e.target.value)}
                         placeholder="e.g. priority"
                         className="mt-1 bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl" />
                </div>
                <div>
                  <Label className="text-xs">Value</Label>
                  <Input value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
                         placeholder="e.g. hot"
                         className="mt-1 bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl" />
                </div>
              </div>
            )}

            {bulkError && (
              <Alert variant="danger" size="sm" className="mt-3">{bulkError}</Alert>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" onClick={() => closeBulkModal({ clearSelection: !!bulkEnrollResult && bulkEnrollScope === "selected" })} disabled={bulkSaving}
                      className="bg-transparent border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-200 rounded-xl">
                {bulkEnrollResult ? "Done" : "Cancel"}
              </Button>
              {!bulkEnrollResult && (
                <Button
                  type="button"
                  disabled={bulkSaving || (bulkOp === "enroll" && (!bulkValue || (bulkEnrollPreview?.summary?.ready || 0) === 0)) || (bulkOp === "set_field" && !bulkField)}
                onClick={async () => {
                  if (bulkOp === "enroll") {
                    await commitBulkEnroll()
                    return
                  }
                  setBulkSaving(true); setBulkError("")
                  try {
                    const body = { lead_ids: Array.from(selectedIds), op: bulkOp }
                    if (bulkOp === "set_field") { body.field = bulkField; body.value = bulkValue }
                    const res = await fetch("/api/leads/bulk", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(body),
                    })
                    const json = await res.json()
                    if (!res.ok) { setBulkError(json.error || "Bulk operation failed"); return }
                    setBulkOp(null)
                    setSelectedIds(new Set())
                    fetchLeads()
                  } finally {
                    setBulkSaving(false)
                  }
                }}
                className={`rounded-xl ${bulkOp === "exit" ? "bg-rose-600 hover:bg-rose-700" : "bg-zinc-950 dark:bg-white"} text-white dark:text-zinc-900`}
              >
                {bulkSaving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
                  {bulkOp === "enroll" ? (bulkEnrollScope === "import" ? "Enroll eligible leads" : "Enroll leads") : `Apply to ${selectedIds.size} leads`}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================== DELETE CONFIRMATION MODAL ==================== */}
      <AnimatePresence>
        {isDeleteOpen && leadToDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsDeleteOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            />

            {/* Confirmation Box */}
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-2xl w-full max-w-sm shadow-2xl p-6 relative z-10 space-y-4"
            >
              <div className="flex items-center gap-3 text-rose-500 dark:text-rose-400">
                <div className="w-9 h-9 rounded-full bg-rose-500/10 flex items-center justify-center border border-rose-500/20">
                  <AlertCircle className="w-5 h-5" />
                </div>
                <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Delete Lead?</h3>
              </div>

              <p className="text-xs text-zinc-500 dark:text-gray-400 leading-relaxed">
                Are you sure you want to delete <span className="text-zinc-800 dark:text-gray-200 font-medium">{leadToDelete.first_name} {leadToDelete.last_name}</span>? 
                This action is permanent and will delete all associated logs, timeline actions, and event history.
              </p>

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button 
                  onClick={() => setIsDeleteOpen(false)}
                  className="h-8 px-3.5 rounded-xl bg-transparent hover:bg-zinc-950/5 dark:hover:bg-white/5 text-zinc-500 dark:text-gray-400 border border-black/10 dark:border-white/5 font-medium text-xs transition-colors"
                >
                  Cancel
                </Button>
                <Button 
                  onClick={handleConfirmDelete}
                  variant="destructive"
                >
                  Confirm Delete
                </Button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  )
}

export default function LeadsPage() {
  return (
    <Suspense fallback={
      <div className="p-16 flex flex-col items-center justify-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
        <p className="text-zinc-500 dark:text-gray-400 text-sm font-medium">Loading workspace...</p>
      </div>
    }>
      <LeadsPageContent />
    </Suspense>
  )
}
