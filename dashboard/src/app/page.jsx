"use client"

import { useEffect, useState, useMemo } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import {
  Users, MessageSquare, PhoneCall, Mail, Inbox, Loader2,
  CheckCircle2, XCircle, Clock, AlertTriangle, ArrowRight,
  Sparkles, Zap, Calendar, CheckSquare, RefreshCw,
  TrendingUp, Info, BarChart2, X, Search
} from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import { AppIcon } from "@/components/AppIcon"
import { useIsClientViewer } from "@/components/RoleProvider"
import { getCachedData, setCachedData } from "@/utils/apiCache"
import { apiFetch } from "@/utils/apiFetch"
import { getJourneyStatusDisplay, getStatusClass } from "@/lib/statusDisplay"

// Resolve a flat avatar tone from a name. A cohesive, desaturated cool-family
// palette — enough variation to distinguish people in a list without the loud
// multi-hue gradients that read as generic.
const getAvatarTone = (str) => {
  const char = String(str || "U").trim().toUpperCase();
  const charCode = char.charCodeAt(0) || 0;
  const tones = [
    "bg-slate-500",
    "bg-indigo-500",
    "bg-violet-500",
    "bg-sky-600",
    "bg-teal-600",
    "bg-zinc-500",
  ];
  return tones[charCode % tones.length];
};

// SVG Circular Progress Ring component for conversion/delivery rates
function RadialProgress({ percentage, colorClass }) {
  const radius = 24
  const stroke = 3.5
  const normalizedRadius = radius - stroke * 2
  const circumference = normalizedRadius * 2 * Math.PI
  const strokeDashoffset = circumference - (percentage / 100) * circumference

  return (
    <div className="relative flex items-center justify-center w-12 h-12 flex-shrink-0">
      <svg height={radius * 2} width={radius * 2} className="transform -rotate-90">
        <circle
          className="stroke-black/5 dark:stroke-white/10"
          fill="transparent"
          strokeWidth={stroke}
          r={normalizedRadius}
          cx={radius}
          cy={radius}
        />
        <circle
          stroke="currentColor"
          fill="transparent"
          strokeWidth={stroke}
          strokeDasharray={`${circumference} ${circumference}`}
          style={{ strokeDashoffset }}
          r={normalizedRadius}
          cx={radius}
          cy={radius}
          className={`${colorClass} transition-all duration-500`}
        />
      </svg>
      <span className="absolute text-[10px] font-bold text-zinc-900 dark:text-white font-mono">{percentage}%</span>
    </div>
  )
}

// Single source of truth for journey-status presentation. `hex` mirrors the
// tailwind -500 tone in `color`/`barColor` and is consumed by the SVG donut
// chart (which can't take a tailwind class), so status colors live in one map.
const JOURNEY_STATUS_META = {
  new: { sourceLabel: "New", label: "Not enrolled", icon: Sparkles, color: "text-blue-500", bg: "bg-blue-500/10", barColor: "bg-blue-500", hex: "#3b82f6" },
  active: { sourceLabel: "Active", label: "Running", icon: Zap, color: "text-emerald-500", bg: "bg-emerald-500/10", barColor: "bg-emerald-500", hex: "#10b981" },
  responded: { sourceLabel: "Responded", label: "Exited: replied", icon: MessageSquare, color: "text-cyan-500", bg: "bg-cyan-500/10", barColor: "bg-cyan-500", hex: "#06b6d4" },
  callback_booked: { sourceLabel: "Callback", label: "Callback requested", icon: Calendar, color: "text-violet-500", bg: "bg-violet-500/10", barColor: "bg-violet-500", hex: "#8b5cf6" },
  completed: { sourceLabel: "Completed", label: "Completed", icon: CheckSquare, color: "text-zinc-500 dark:text-zinc-400", bg: "bg-zinc-500/10", barColor: "bg-zinc-500 dark:bg-zinc-400", hex: "#71717a" },
  opted_out: { sourceLabel: "Opted out", label: "Exited: opted out", icon: XCircle, color: "text-rose-500", bg: "bg-rose-500/10", barColor: "bg-rose-500", hex: "#f43f5e" },
}

// Fixed display order for the journey-status donut + legend.
const JOURNEY_STATUS_ORDER = ["new", "active", "responded", "callback_booked", "completed", "opted_out"]

// Journey status donut chart.
function JourneyStatusDonutChart({ counts, total, onSelectStage }) {
  const segments = JOURNEY_STATUS_ORDER.map((key) => {
    const display = getJourneyStatusDisplay(key)
    const meta = JOURNEY_STATUS_META[key]
    return {
      key,
      label: meta?.label || display.label,
      sourceLabel: meta?.sourceLabel || display.label,
      title: display.title,
      value: counts[key] || 0,
      color: meta?.hex,
    }
  }).filter(s => s.value > 0)

  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-6 text-zinc-400 text-xs">
        No active journey logs.
      </div>
    )
  }

  const size = 100
  const strokeWidth = 10
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  let accumulatedPercentage = 0

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6 justify-center w-full">
      <div className="relative w-24 h-24 flex-shrink-0 flex items-center justify-center">
        <svg viewBox={`0 0 ${size} ${size}`} width="100%" height="100%" className="transform -rotate-90">
          {segments.map((seg) => {
            const pct = (seg.value / total) * 100
            const strokeDashoffset = circumference - (pct / 100) * circumference
            const rotation = (accumulatedPercentage / 100) * 360
            accumulatedPercentage += pct

            return (
              <circle
                key={seg.label}
                stroke={seg.color}
                fill="transparent"
                strokeWidth={strokeWidth}
                strokeDasharray={`${circumference} ${circumference}`}
                style={{ 
                  strokeDashoffset,
                  transform: `rotate(${rotation}deg)`,
                  transformOrigin: 'center'
                }}
                r={radius}
                cx={size / 2}
                cy={size / 2}
                onClick={() => onSelectStage(seg.sourceLabel)}
                className="transition-all duration-500 hover:stroke-[12px] cursor-pointer"
              />
            )
          })}
        </svg>
        <div className="absolute flex flex-col items-center justify-center">
          <span className="text-xl font-bold text-zinc-900 dark:text-white leading-none">{total}</span>
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-medium mt-1">Leads</span>
        </div>
      </div>
      
      {/* Legend list */}
      <div className="grid grid-cols-2 sm:grid-cols-1 gap-2 flex-1 w-full">
        {segments.map(seg => (
          <div 
            key={seg.label} 
            onClick={() => onSelectStage(seg.sourceLabel)}
            className="flex items-center justify-between text-xs min-w-0 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 p-1 rounded-md transition-colors group"
          >
            <span className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400 group-hover:text-zinc-900 dark:group-hover:text-white truncate">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: seg.color }} />
              <span className="truncate" title={seg.title}>{seg.label}</span>
            </span>
            <span className="font-semibold text-zinc-900 dark:text-white font-mono ml-2">
              {seg.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function NeedsAttentionSection({ data, error }) {
  const items = data?.items || []
  const [isCollapsed, setIsCollapsed] = useState(() => {
    if (typeof window === "undefined") return false
    return window.localStorage.getItem("dashboard_needs_attention_collapsed") === "1"
  })
  const [showAll, setShowAll] = useState(false)
  const hasOverflow = items.length > 3
  const visibleItems = showAll || !hasOverflow ? items : items.slice(0, 3)

  const setCollapsed = (next) => {
    setIsCollapsed(next)
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dashboard_needs_attention_collapsed", next ? "1" : "0")
    }
  }

  // Map a known attention category to a Badge variant, or null to fall back to
  // the item's own badgeClassName (for categories without a mapped variant).
  const getAttentionVariant = (item) => {
    if (item.category === "human_reply" || item.category === "callback" || item.category === "system_issue") {
      return "warning"
    }
    if (item.category === "failed_action" || item.category === "suppressed") {
      return "danger"
    }
    return null
  }

  return (
    <Card className="bg-white/50 dark:bg-white/[0.025] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl shadow-md overflow-hidden">
      <CardHeader className="px-4 py-3 border-b border-black/5 dark:border-white/5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm text-zinc-900 dark:text-white flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Needs Attention
            </CardTitle>
            <CardDescription className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Follow-ups and system issues that may need review now.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-mono text-zinc-600 dark:text-zinc-300">
              {items.length} {items.length === 1 ? "item" : "items"}
            </span>
            <button
              type="button"
              onClick={() => setCollapsed(!isCollapsed)}
              className="px-2 py-1 rounded-lg border border-black/10 dark:border-white/10 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5"
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className={isCollapsed ? "hidden" : "p-0"}>
        {error ? (
          <div className="px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
            Needs Attention could not load. Dashboard metrics are still available.
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-4 flex items-center gap-3 text-sm text-zinc-600 dark:text-zinc-300">
            <CheckCircle2 className="w-5 h-5 text-emerald-500" />
            <span>No urgent follow-ups. Your queue is clear.</span>
          </div>
        ) : (
          <div className="divide-y divide-black/5 dark:divide-white/5">
            {visibleItems.map((item) => (
              <div key={item.id} className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {getAttentionVariant(item) ? (
                      <Badge variant={getAttentionVariant(item)} title={item.category?.replace(/_/g, " ")}>
                        {item.type}
                      </Badge>
                    ) : (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold ${item.badgeClassName || ""}`} title={item.category?.replace(/_/g, " ")}>
                        {item.type}
                      </span>
                    )}
                    {item.time && (
                      <span className="text-[10px] text-zinc-600 dark:text-zinc-400 font-mono">
                        {formatAttentionTime(item.time)}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-sm font-semibold text-zinc-900 dark:text-white truncate">
                    {item.title}
                  </div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-300 line-clamp-1">
                    {item.reason}
                  </div>
                </div>
                {item.href && !item.disabled ? (
                  <Link
                    href={item.href}
                    className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-black/10 dark:border-white/10 text-xs font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  >
                    {item.actionLabel || "Review"}
                    <ArrowRight className="w-3 h-3" />
                  </Link>
                ) : (
                  <span className="shrink-0 px-3 py-1.5 rounded-lg border border-black/5 dark:border-white/5 text-xs text-zinc-400">
                    No direct link
                  </span>
                )}
              </div>
            ))}
            {hasOverflow && (
              <div className="px-4 py-2 flex items-center justify-between bg-zinc-950/[0.015] dark:bg-white/[0.015]">
                <span className="text-[11px] text-zinc-600 dark:text-zinc-400">
                  Showing {visibleItems.length} of {items.length}
                </span>
                <button
                  type="button"
                  onClick={() => setShowAll((value) => !value)}
                  className="text-[11px] font-semibold text-blue-700 dark:text-blue-300 hover:underline"
                >
                  {showAll ? "Show less" : "Show all"}
                </button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function formatAttentionTime(value) {
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return ""
  const diffMs = Date.now() - time
  const abs = Math.abs(diffMs)
  const suffix = diffMs >= 0 ? "ago" : "from now"
  const minutes = Math.round(abs / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ${suffix}`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ${suffix}`
  const days = Math.round(hours / 24)
  return `${days}d ${suffix}`
}

export default function Dashboard() {
  const router = useRouter()
  const [data, setData] = useState(() => getCachedData("dashboard_summary"))
  const [analyticsData, setAnalyticsData] = useState(() => getCachedData("analytics"))
  const [attentionData, setAttentionData] = useState(() => getCachedData("dashboard_attention"))
  const [attentionError, setAttentionError] = useState("")
  const [loading, setLoading] = useState(() => !getCachedData("dashboard_summary") || !getCachedData("analytics"))
  const [error, setError] = useState("")
  const [hoveredPoint, setHoveredPoint] = useState(null)
  const isClientViewer = useIsClientViewer()

  // Interactive drawer states for leads drill-down
  const [selectedStage, setSelectedStage] = useState(null)
  const [stageLeads, setStageLeads] = useState([])
  const [loadingStageLeads, setLoadingStageLeads] = useState(false)
  const [stageSearchQuery, setStageSearchQuery] = useState("")

  const loadData = async (silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    setAttentionError("")
    try {
      // Attention is non-critical: its failure shows a banner instead of
      // blanking the whole dashboard, so it resolves separately.
      const [sumJson, analJson, attentionResult] = await Promise.all([
        apiFetch("/api/dashboard/summary"),
        apiFetch("/api/analytics"),
        apiFetch("/api/dashboard/attention").catch((err) => ({ __error: err.message })),
      ])

      setData(sumJson.data)
      setAnalyticsData(analJson.data)
      setCachedData("dashboard_summary", sumJson.data)
      setCachedData("analytics", analJson.data)
      if (attentionResult.__error) {
        setAttentionError(attentionResult.__error || "Failed to load attention queue")
      } else {
        setAttentionData(attentionResult.data)
        setCachedData("dashboard_attention", attentionResult.data)
      }
    } catch (err) {
      setError(err.message || "Failed to load dashboard data")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const hasCache = getCachedData("dashboard_summary") && getCachedData("analytics")
    loadData(!!hasCache)
  }, [])

  // Lazy-load leads in background when stage is clicked
  useEffect(() => {
    if (!selectedStage) {
      setStageLeads([])
      setStageSearchQuery("")
      return
    }

    const fetchLeadsForStage = async () => {
      setLoadingStageLeads(true)
      try {
        const dbStatusMap = {
          'New': 'new',
          'Active': 'active',
          'Responded': 'responded',
          'Callback': 'callback_booked',
          'Completed': 'completed',
          'Opted out': 'opted_out'
        }
        const targetStatus = dbStatusMap[selectedStage] || selectedStage.toLowerCase()

        const json = await apiFetch(`/api/leads?limit=250`)
        if (json.data) {
          const filtered = json.data.filter(lead => lead.journey_status === targetStatus)
          setStageLeads(filtered)
        }
      } catch (err) {
        console.error("Failed to fetch leads for stage:", err)
      } finally {
        setLoadingStageLeads(false)
      }
    }

    fetchLeadsForStage()
  }, [selectedStage])

  // In-memory filtered leads for drawer search bar
  const filteredLeads = useMemo(() => {
    if (!stageSearchQuery) return stageLeads
    const q = stageSearchQuery.toLowerCase()
    return stageLeads.filter(lead => {
      const name = `${lead.first_name || ""} ${lead.last_name || ""}`.toLowerCase()
      const email = (lead.email || "").toLowerCase()
      const phone = (lead.phone_raw || lead.phone_e164 || "").toLowerCase()
      return name.includes(q) || email.includes(q) || phone.includes(q)
    })
  }, [stageLeads, stageSearchQuery])

  // Line Chart Calculations for weekly trend
  const responseRatesOverTime = analyticsData?.responseRatesOverTime || []
  const lineChartHeight = 220
  const lineChartWidth = 500
  const linePaddingX = 50
  const linePaddingY = 30

  const getLineCoordinates = (dataset) => {
    if (!dataset || dataset.length === 0) return []
    const maxVal = 100
    const stepX = (lineChartWidth - linePaddingX * 2) / (dataset.length - 1)
    
    return dataset.map((d, i) => {
      const x = linePaddingX + i * stepX
      const y = lineChartHeight - linePaddingY - (d.rate / maxVal) * (lineChartHeight - linePaddingY * 2)
      return { x, y, label: d.label, val: d.rate }
    })
  }

  const linePoints = useMemo(() => getLineCoordinates(responseRatesOverTime), [responseRatesOverTime])
  
  const linePathString = useMemo(() => {
    return linePoints.reduce((acc, p, i) => {
      return i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`
    }, "")
  }, [linePoints])

  const lineAreaPathString = useMemo(() => {
    return linePoints.length > 0 
      ? `${linePathString} L ${linePoints[linePoints.length - 1].x} ${lineChartHeight - linePaddingY} L ${linePoints[0].x} ${lineChartHeight - linePaddingY} Z`
      : ""
  }, [linePoints, linePathString])

  if (loading && !data) {
    return (
      <div className="space-y-10 pb-10 animate-pulse">
        <div className="h-8 w-72 rounded-xl bg-zinc-200 dark:bg-white/10" />
        <div className="h-4 w-96 rounded-lg bg-zinc-200 dark:bg-white/10" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-32 rounded-2xl bg-zinc-200 dark:bg-white/[0.05] border border-black/5 dark:border-white/5" />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-64 rounded-2xl bg-zinc-200 dark:bg-white/[0.05] border border-black/5 dark:border-white/5" />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="danger" title="Failed to load dashboard" className="p-6 rounded-2xl max-w-2xl mx-auto mt-10">
        <p>{error}</p>
      </Alert>
    )
  }

  const journeyStatusCounts = data?.pipeline || {}
  const channels = data?.channels_30d || {}
  const callOutcomes = data?.call_outcomes || {}
  const recentReplies = data?.recent_replies || []
  const totalLeads = Object.values(journeyStatusCounts).reduce((a, b) => a + b, 0)

  const getPct = (val) => totalLeads > 0 ? Math.round((val / totalLeads) * 100) : 0

  const journeyStatusTiles = JOURNEY_STATUS_ORDER.map((key) => {
    const display = getJourneyStatusDisplay(key)
    const meta = JOURNEY_STATUS_META[key]
    return {
      sourceLabel: meta?.sourceLabel || display.label,
      label: meta?.label || display.label,
      value: journeyStatusCounts[key] || 0,
      title: display.title,
      ...meta,
    }
  })

  // KPI card statistics
  const stats = [
    {
      title: "Leads tracked",
      value: totalLeads,
      icon: Users,
      desc: "Leads currently tracked across Journeys",
      trend: "All journey statuses",
      colorClass: "text-blue-500",
      bgClass: "bg-blue-500/10"
    },
    {
      title: "Response Rate",
      value: analyticsData?.kpis?.responseRate || "---",
      icon: TrendingUp,
      desc: "Email/SMS reply leads / contacted leads",
      trend: "Last 30 days",
      colorClass: "text-emerald-500",
      bgClass: "bg-emerald-500/10"
    },
    {
      title: "Running journeys",
      value: analyticsData?.kpis?.activeJourneys || "---",
      icon: Zap,
      desc: "Journeys currently active",
      trend: "Currently live",
      colorClass: "text-cyan-500",
      bgClass: "bg-cyan-500/10"
    },
    {
      title: "Follow-ups attempted",
      value: analyticsData?.kpis?.dailySentCounts || "---",
      icon: CheckSquare,
      desc: "Follow-up actions attempted in last 24h",
      trend: "Last 24 hours",
      colorClass: "text-violet-500",
      bgClass: "bg-violet-500/10"
    }
  ]

  // Call outcomes percentage distribution
  const callOther = Object.entries(callOutcomes).reduce((sum, [key, value]) => {
    return ["answered", "voicemail", "no_answer", "failed"].includes(key) ? sum : sum + (Number(value) || 0)
  }, 0)
  const callTotal = (callOutcomes.answered || 0) + (callOutcomes.voicemail || 0) + (callOutcomes.no_answer || 0) + (callOutcomes.failed || 0) + callOther
  const getCallOutcomePct = (val) => callTotal > 0 ? (val / callTotal) * 100 : 0
  const answeredPct = getCallOutcomePct(callOutcomes.answered || 0)
  const voicemailPct = getCallOutcomePct(callOutcomes.voicemail || 0)
  const noAnswerPct = getCallOutcomePct(callOutcomes.no_answer || 0)
  const failedPct = getCallOutcomePct(callOutcomes.failed || 0)
  const otherPct = getCallOutcomePct(callOther)

  const getAcceptedRate = (sent, failed) => {
    if (!sent) return 0
    return Math.max(0, Math.round(((sent - (failed || 0)) / sent) * 100))
  }

  return (
    <div className="space-y-10 pb-10">
      {/* Header section */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
            <AppIcon name="dashboard" size={32} className="text-zinc-700 dark:text-gray-300" />
            Follow-up dashboard
          </h1>
          <p className="text-sm text-zinc-500 dark:text-gray-400 mt-1 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            {isClientViewer
              ? "Monitor active follow-ups, replies, channel health, and issues that need action."
              : "Monitor active follow-ups, replies, channel health, and issues that need action."}
          </p>
        </div>
        <Button 
          onClick={loadData}
          variant="default"
        >
          <RefreshCw className="w-4 h-4" /> Refresh Data
        </Button>
      </div>

      <NeedsAttentionSection data={attentionData} error={attentionError} />

      {/* Current operating summary */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Operating overview</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat, i) => (
          <motion.div
            key={stat.title}
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.05 }}
          >
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl hover:bg-white/60 dark:hover:bg-white/[0.04] hover:-translate-y-0.5 hover:shadow-lg transition-all duration-300 rounded-2xl relative overflow-hidden shadow-md">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold text-zinc-500 dark:text-gray-500">
                  {stat.title}
                </CardTitle>
                <div className={`w-8 h-8 rounded-full ${stat.bgClass} flex items-center justify-center shadow-inner`}>
                  <stat.icon className={`w-4 h-4 ${stat.colorClass}`} />
                </div>
              </CardHeader>
              <CardContent className="p-5 pt-0">
                <div className="text-3xl font-bold text-zinc-900 dark:text-white tracking-tight mb-1">
                  {stat.value}
                </div>
                <div className="text-xs text-zinc-500 dark:text-gray-400 mb-2">{stat.desc}</div>
                <div className="flex items-center text-[10px] text-zinc-400 dark:text-zinc-500 font-mono">
                  <span>{stat.trend}</span>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>
      </div>

      {/* Channel health cards */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Channel health</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          
          {/* CALL CARD */}
          <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-6 shadow-lg h-full flex flex-col justify-between hover:bg-white/60 dark:hover:bg-white/[0.04] hover:-translate-y-0.5 hover:shadow-xl transition-all duration-300">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-black/5 dark:border-white/5">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-xl bg-blue-500/10"><PhoneCall className="w-4 h-4 text-blue-500" /></div>
                    <span className="text-sm font-bold text-zinc-900 dark:text-white">Voice Calls</span>
                  </div>
                  {/* Call Answer Rate */}
                  <RadialProgress 
                    percentage={channels.call?.sent > 0 ? Math.round(((callOutcomes.answered || 0) / channels.call.sent) * 100) : 0} 
                    colorClass="text-blue-500" 
                  />
                </div>

                <div className="grid grid-cols-3 gap-4 py-5">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold" title="Outbound call attempts in the last 30 days.">Attempts</div>
                    <div className="text-lg font-bold text-zinc-900 dark:text-white font-mono mt-1">{channels.call?.sent || 0}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold" title="Calls answered divided by call attempts.">Answered</div>
                    <div className="text-lg font-bold text-zinc-900 dark:text-white font-mono mt-1">{callOutcomes.answered || 0}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold" title="Outbound call attempts with failed, no-answer, busy, or invalid-number outcomes.">Failed</div>
                    <div className="text-lg font-bold text-rose-500 font-mono mt-1">{channels.call?.failed || 0}</div>
                  </div>
                </div>

                {/* Call Outcomes segmented bar */}
                <div className="pt-3 border-t border-black/5 dark:border-white/5">
                  <div className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-1 font-bold uppercase tracking-wider">Outcomes Split</div>
                  
                  <div className="w-full h-2 rounded-full overflow-hidden flex bg-zinc-200 dark:bg-zinc-800 my-2">
                    {answeredPct > 0 && <div style={{ width: `${answeredPct}%` }} className="bg-emerald-500 h-full" title={`Answered: ${callOutcomes.answered}`} />}
                    {voicemailPct > 0 && <div style={{ width: `${voicemailPct}%` }} className="bg-amber-400 h-full" title={`Voicemail: ${callOutcomes.voicemail}`} />}
                    {noAnswerPct > 0 && <div style={{ width: `${noAnswerPct}%` }} className="bg-rose-400 h-full" title={`No Answer: ${callOutcomes.no_answer}`} />}
                    {failedPct > 0 && <div style={{ width: `${failedPct}%` }} className="bg-zinc-400 dark:bg-zinc-600 h-full" title={`Failed: ${callOutcomes.failed}`} />}
                    {otherPct > 0 && <div style={{ width: `${otherPct}%` }} className="bg-slate-300 dark:bg-slate-700 h-full" title={`Other: ${callOther}`} />}
                  </div>

                  <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-[10px] text-zinc-500 dark:text-zinc-400 mt-2 font-mono">
                    <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Answered ({callOutcomes.answered || 0})</div>
                    <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Voicemail ({callOutcomes.voicemail || 0})</div>
                    <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-rose-400" /> No Answer ({callOutcomes.no_answer || 0})</div>
                    <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-600" /> Failed ({callOutcomes.failed || 0})</div>
                    {callOther > 0 && <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-700" /> Other ({callOther})</div>}
                  </div>
                </div>
              </div>
            </Card>
          </motion.div>

          {/* SMS CARD */}
          <motion.div initial={{ opacity: 0, x: 15 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }}>
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-6 shadow-lg h-full flex flex-col justify-between hover:bg-white/60 dark:hover:bg-white/[0.04] hover:-translate-y-0.5 hover:shadow-xl transition-all duration-300">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-black/5 dark:border-white/5">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-emerald-500/10"><MessageSquare className="w-4 h-4 text-emerald-500" /></div>
                    <span className="text-sm font-bold text-zinc-900 dark:text-white">SMS Messaging</span>
                  </div>
                  {/* SMS accepted rate */}
                  <RadialProgress 
                    percentage={getAcceptedRate(channels.sms?.sent, channels.sms?.failed)} 
                    colorClass="text-emerald-500" 
                  />
                </div>

                <div className="grid grid-cols-3 gap-4 py-5">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold" title="Outbound SMS events accepted or attempted in the last 30 days.">Sent</div>
                    <div className="text-lg font-bold text-zinc-900 dark:text-white font-mono mt-1">{channels.sms?.sent || 0}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold" title="Inbound SMS replies matched to leads in the last 30 days.">Replies</div>
                    <div className="text-lg font-bold text-zinc-900 dark:text-white font-mono mt-1">{channels.sms?.replied || 0}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold" title="Outbound SMS events marked failed in the last 30 days.">Failed</div>
                    <div className="text-lg font-bold text-rose-500 font-mono mt-1">{channels.sms?.failed || 0}</div>
                  </div>
                </div>

                <div className="pt-3 border-t border-black/5 dark:border-white/5 text-[10px] text-zinc-400 dark:text-zinc-500 italic leading-relaxed">
                  Sent is outbound SMS volume; replies are inbound lead responses; failed is provider failure volume.
                </div>
              </div>
            </Card>
          </motion.div>

          {/* EMAIL CARD */}
          <motion.div initial={{ opacity: 0, x: -15 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 }}>
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-6 shadow-lg h-full flex flex-col justify-between hover:bg-white/60 dark:hover:bg-white/[0.04] hover:-translate-y-0.5 hover:shadow-xl transition-all duration-300">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-black/5 dark:border-white/5">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-purple-500/10"><Mail className="w-4 h-4 text-purple-500" /></div>
                    <span className="text-sm font-bold text-zinc-900 dark:text-white">Email Outreach</span>
                  </div>
                  {/* Email accepted rate */}
                  <RadialProgress 
                    percentage={getAcceptedRate(channels.email?.sent, channels.email?.failed)} 
                    colorClass="text-purple-500" 
                  />
                </div>

                <div className="grid grid-cols-3 gap-4 py-5">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold" title="Outbound email events sent in the last 30 days.">Sent</div>
                    <div className="text-lg font-bold text-zinc-900 dark:text-white font-mono mt-1">{channels.email?.sent || 0}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold" title="Inbound email events matched to leads in the last 30 days. Bounce filtering depends on the dashboard summary RPC.">Replies</div>
                    <div className="text-lg font-bold text-zinc-900 dark:text-white font-mono mt-1">{channels.email?.replied || 0}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold" title="Outbound email failures surfaced by the dashboard summary RPC.">Failed</div>
                    <div className="text-lg font-bold text-rose-500 font-mono mt-1">{channels.email?.failed || 0}</div>
                  </div>
                </div>

                <div className="pt-3 border-t border-black/5 dark:border-white/5 text-[10px] text-zinc-400 dark:text-zinc-500 italic leading-relaxed">
                  Sent is outbound email volume; replies are inbound lead responses; failed is bounce/failure volume when available.
                </div>
              </div>
            </Card>
          </motion.div>

        </div>
      </div>

      {/* Journey status overview */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Lead &amp; journey status</h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
          <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-6 shadow-md flex flex-col justify-between h-full hover:bg-white/60 dark:hover:bg-white/[0.04] hover:-translate-y-0.5 transition-all duration-300">
              <div className="space-y-6 w-full">
                <div className="flex items-center justify-between pb-3 border-b border-black/5 dark:border-white/5">
                  <span className="text-xs font-semibold text-zinc-500 dark:text-gray-400">Journey status mix</span>
                  <Users className="w-4 h-4 text-zinc-400" />
                </div>
                <JourneyStatusDonutChart counts={journeyStatusCounts} total={totalLeads} onSelectStage={setSelectedStage} />
              </div>
            </Card>
          </motion.div>

          <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {journeyStatusTiles.map((tile, idx) => {
              const share = getPct(tile.value)
              return (
                <motion.div
                  key={tile.label}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: (idx + 1) * 0.04 }}
                >
                  <Card
                    onClick={() => setSelectedStage(tile.sourceLabel)}
                    className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl hover:bg-white/60 dark:hover:bg-white/[0.04] transition-all duration-300 rounded-2xl relative overflow-hidden h-full shadow-md cursor-pointer hover:scale-[1.02] active:scale-[0.98] group"
                  >
                    <CardContent className="p-5 flex flex-col justify-between h-full space-y-4">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-zinc-500 dark:text-gray-500 group-hover:text-zinc-900 dark:group-hover:text-white transition-colors" title={tile.title}>{tile.label}</span>
                        <div className={`w-7 h-7 rounded-lg ${tile.bg} flex items-center justify-center transition-transform group-hover:scale-110`}>
                          <tile.icon className={`w-3.5 h-3.5 ${tile.color}`} />
                        </div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-zinc-900 dark:text-white tracking-tight">{tile.value}</div>
                        <div className="flex items-center justify-between text-[10px] text-zinc-400 dark:text-zinc-500 mt-2">
                          <span>Share</span>
                          <span>{share}%</span>
                        </div>
                        <div className="w-full h-1 bg-zinc-200 dark:bg-white/10 rounded-full overflow-hidden mt-1">
                          <div style={{ width: `${share}%` }} className={`h-full ${tile.barColor}`} />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Recent replies and activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
        
        {/* Left Column (2/3 width): Interactive Line Chart */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">What changed recently</h2>
          <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-6 shadow-lg flex flex-col justify-between hover:bg-white/60 dark:hover:bg-white/[0.04] hover:-translate-y-0.5 hover:shadow-xl transition-all duration-300">
            <div>
              <CardHeader className="p-0 mb-4">
                <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-zinc-500 dark:text-gray-400" /> Reply trend
                </CardTitle>
                <CardDescription className="text-zinc-500 dark:text-gray-400">
                  Unique leads who replied by email or SMS divided by contacted leads for each day.
                </CardDescription>
              </CardHeader>

              {/* Responsive SVG Line Chart using viewBox */}
              <div className="relative w-full py-2">
                {linePoints.length === 0 ? (
                  <div className="py-12 text-center flex flex-col items-center gap-2">
                    <BarChart2 className="w-8 h-8 text-zinc-300 dark:text-zinc-600" />
                    <span className="text-sm text-zinc-500 dark:text-zinc-400 font-medium">No trend data available</span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">Response rate data will appear as follow-ups are sent.</span>
                  </div>
                ) : (
                  <svg 
                    viewBox={`0 0 ${lineChartWidth} ${lineChartHeight}`} 
                    width="100%" 
                    height="220" 
                    className="overflow-visible select-none"
                  >
                    <defs>
                      <linearGradient id="dashboardAreaGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-area-stop-0)" />
                        <stop offset="100%" stopColor="var(--chart-area-stop-100)" />
                      </linearGradient>
                    </defs>

                    {/* Y Grid lines */}
                    {[0, 0.25, 0.5, 0.75, 1].map((ratio, index) => {
                      const y = linePaddingY + ratio * (lineChartHeight - linePaddingY * 2)
                      const percent = Math.round(100 * (1 - ratio))
                      return (
                        <g key={index}>
                          <line 
                            x1={linePaddingX} 
                            y1={y} 
                            x2={lineChartWidth - linePaddingX} 
                            y2={y} 
                            stroke="var(--chart-grid)" 
                            strokeWidth="1"
                          />
                          <text 
                            x={linePaddingX - 10} 
                            y={y + 4} 
                            fill="var(--chart-text-muted)" 
                            fontSize="9" 
                            textAnchor="end"
                            fontFamily="monospace"
                          >
                            {percent}%
                          </text>
                        </g>
                      )
                    })}

                    {/* Shaded Area */}
                    {lineAreaPathString && (
                      <path d={lineAreaPathString} fill="url(#dashboardAreaGrad)" />
                    )}

                    {/* Line Path */}
                    {linePathString && (
                      <path 
                        d={linePathString}
                        fill="none"
                        stroke="var(--chart-line-stroke)"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}

                    {/* Dots */}
                    {linePoints.map((point, index) => {
                      const isHovered = hoveredPoint === index
                      return (
                        <g 
                          key={index}
                          onMouseEnter={() => setHoveredPoint(index)}
                          onMouseLeave={() => setHoveredPoint(null)}
                          className="cursor-pointer"
                        >
                          {isHovered && (
                            <circle 
                              cx={point.x}
                              cy={point.y}
                              r="8"
                              fill="var(--chart-halo)"
                              stroke="var(--chart-halo-stroke)"
                              strokeWidth="1"
                            />
                          )}
                          <circle 
                            cx={point.x}
                            cy={point.y}
                            r={isHovered ? "4.5" : "3.5"}
                            fill={isHovered ? "var(--chart-dot-hover-fill)" : "var(--chart-dot-fill)"}
                            stroke="var(--background)"
                            strokeWidth="1.5"
                            className="transition-all duration-200"
                          />
                          <text
                            x={point.x}
                            y={lineChartHeight - linePaddingY + 18}
                            fill={isHovered ? "var(--chart-text-active)" : "var(--chart-text-muted)"}
                            fontSize="9"
                            textAnchor="middle"
                          >
                            {point.label}
                          </text>
                          {isHovered && (
                            <text
                              x={point.x}
                              y={point.y - 10}
                              fill="var(--chart-text-active)"
                              fontSize="10"
                              fontWeight="bold"
                              textAnchor="middle"
                            >
                              {point.val}%
                            </text>
                          )}
                        </g>
                      )
                    })}
                  </svg>
                )}
              </div>
            </div>
            
            <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400 pt-4 border-t border-black/5 dark:border-white/5 font-mono">
              <span className="flex items-center gap-1"><Info className="w-3.5 h-3.5" /> Hover over points for reply-rate details</span>
              <span>Latest dashboard refresh</span>
            </div>
          </Card>
        </div>

        {/* Right Column (1/3 width): Recent Replies activity feed */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Recent replies</h2>
            <Link href="/leads" className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1">
              Review leads <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl shadow-lg overflow-hidden max-h-[360px] overflow-y-auto flex-grow">
            <CardContent className="p-0">
              {recentReplies.length === 0 ? (
                <div className="p-16 text-center text-zinc-400 dark:text-zinc-500 text-sm flex flex-col items-center justify-center gap-2">
                  <div className="w-12 h-12 rounded-2xl bg-zinc-100 dark:bg-white/5 flex items-center justify-center mb-1">
                    <Inbox className="w-6 h-6 text-zinc-300 dark:text-zinc-600" />
                  </div>
                  <span className="text-zinc-500 dark:text-zinc-400 font-medium">No inbound replies yet</span>
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">When leads reply, their responses will appear here.</span>
                </div>
              ) : (
                <ul className="divide-y divide-black/5 dark:divide-white/5">
                  {recentReplies.map((r, i) => {
                    const tone = getAvatarTone(r.lead_name || r.from || "U");
                    const channelLabel = {
                      email: "Email reply",
                      sms: "SMS reply",
                      call: "Call response",
                    }[r.channel] || "Lead reply";
                    const hasLeadLink = !!r.lead_id;
                    
                    return (
                      <motion.li 
                        key={r.id} 
                        initial={{ opacity: 0, x: 15 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.3, delay: i * 0.05 }}
                        onClick={() => {
                          if (r.lead_id) {
                            router.push(`/leads?leadId=${r.lead_id}`)
                          }
                        }}
                        className={`p-4 flex items-start gap-3 transition-colors ${hasLeadLink ? "hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer" : ""}`}
                      >
                        {/* Avatar */}
                        <div className={`w-8 h-8 rounded-full ${tone} flex items-center justify-center text-white text-xs font-bold shadow-md flex-shrink-0`}>
                          {(r.lead_name || r.from || "U")[0].toUpperCase()}
                        </div>
                        
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-zinc-800 dark:text-white truncate">
                              {r.lead_name || r.from || "Unknown"}
                            </span>
                            <span className="text-[10px] text-zinc-400 font-mono">
                              {new Date(r.at).toLocaleDateString()}
                            </span>
                          </div>
                          
                          <div className="flex items-center gap-1.5">
                            {r.channel === "email" ? (
                              <Mail className="w-3 h-3 text-purple-400" />
                            ) : r.channel === "sms" ? (
                              <MessageSquare className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <PhoneCall className="w-3 h-3 text-blue-400" />
                            )}
                            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{channelLabel}</span>
                          </div>
                          
                          <div className="p-2.5 rounded-xl bg-zinc-950/5 dark:bg-black/45 border border-black/5 dark:border-white/5 text-xs text-zinc-600 dark:text-zinc-300 leading-normal mt-1 break-words font-sans">
                            {r.body || "—"}
                          </div>
                        </div>
                      </motion.li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        
      </div>

      {/* Interactive Drill-Down Searchable Leads Drawer */}
      <AnimatePresence>
        {selectedStage && (
          <>
            {/* Backdrop Dim overlay */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedStage(null)}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            />

            {/* Slide-over Panel Content */}
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-white/95 dark:bg-zinc-950/95 backdrop-blur-2xl border-l border-black/5 dark:border-white/5 shadow-2xl flex flex-col justify-between"
            >
              <div className="flex-1 flex flex-col min-h-0">
                {/* Header */}
                <div className="p-6 border-b border-black/5 dark:border-white/5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
                        <Users className="w-5 h-5 text-zinc-500 dark:text-gray-400" />
                        {selectedStage} Leads
                      </h3>
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-zinc-950/5 dark:bg-white/10 text-zinc-800 dark:text-white">
                        {stageLeads.length}
                      </span>
                    </div>
                    <Button
                      onClick={() => setSelectedStage(null)}
                      className="bg-transparent hover:bg-black/5 dark:hover:bg-white/5 text-zinc-400 hover:text-zinc-900 dark:hover:text-white p-1.5 rounded-xl transition-all border-none"
                    >
                      <X className="w-5 h-5" />
                    </Button>
                  </div>

                  {/* Search Input Box */}
                  <div className="relative">
                    <Search className="absolute left-3.5 top-2.5 w-4 h-4 text-zinc-400 dark:text-zinc-600" />
                    <input
                      type="text"
                      placeholder="Search contacts by name, email, phone..."
                      value={stageSearchQuery}
                      onChange={(e) => setStageSearchQuery(e.target.value)}
                      className="w-full h-9 pl-10 pr-9 bg-zinc-950/5 dark:bg-black/45 border border-black/10 dark:border-white/5 rounded-xl text-sm placeholder:text-zinc-400 dark:placeholder:text-zinc-600 text-zinc-900 dark:text-white outline-none focus:border-black/20 dark:focus:border-white/20 transition-all font-sans"
                    />
                    {stageSearchQuery && (
                      <button
                        onClick={() => setStageSearchQuery("")}
                        className="absolute right-3 top-2.5 text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-all"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Leads Scrollable List */}
                <div className="flex-1 overflow-y-auto p-6 space-y-3">
                  {loadingStageLeads ? (
                    <div className="py-20 flex flex-col items-center justify-center space-y-3">
                      <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
                      <span className="text-xs text-zinc-500">Loading journey contacts...</span>
                    </div>
                  ) : filteredLeads.length === 0 ? (
                    <div className="py-20 flex flex-col items-center justify-center space-y-2 text-zinc-400 text-xs">
                      <Inbox className="w-8 h-8 text-zinc-300" />
                      <span>No contacts found for this status.</span>
                    </div>
                  ) : (
                    filteredLeads.map((lead) => {
                      const name = `${lead.first_name || ""} ${lead.last_name || ""}`.trim() || lead.email || lead.phone_raw || "Unknown Lead"
                      const tone = getAvatarTone(name)
                      return (
                        <div 
                          key={lead.id} 
                          onClick={() => {
                            setSelectedStage(null)
                            router.push(`/leads?leadId=${lead.id}`)
                          }}
                          className="p-4 bg-zinc-950/[0.01] dark:bg-white/[0.01] border border-black/5 dark:border-white/5 rounded-2xl flex items-start gap-3 hover:bg-zinc-950/[0.04] dark:hover:bg-white/[0.04] active:scale-[0.98] transition-all hover:scale-[1.01] group shadow-sm cursor-pointer"
                        >
                          <div className={`w-9 h-9 rounded-full ${tone} flex items-center justify-center text-white text-xs font-bold shadow-md flex-shrink-0`}>
                            {name[0].toUpperCase()}
                          </div>
                          
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-semibold text-zinc-800 dark:text-white truncate">
                                {name}
                              </span>
                              {lead.source && (
                                <span className="px-1.5 py-0.5 rounded bg-zinc-950/5 dark:bg-white/5 text-[10px] text-zinc-400 font-medium">
                                  {lead.source}
                                </span>
                              )}
                            </div>

                            <div className="text-[10px] text-zinc-500 dark:text-zinc-400 font-mono space-y-0.5">
                              {lead.email && <div className="truncate">Email: {lead.email}</div>}
                              {(lead.phone_raw || lead.phone_e164) && <div>Phone: {lead.phone_raw || lead.phone_e164}</div>}
                            </div>

                            {lead.journey_template && (
                              <div className="pt-1.5 flex items-center gap-1.5">
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/10">
                                  {lead.journey_template}
                                </span>
                                {lead.current_step !== undefined && (
                                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-medium">
                                    Step {lead.current_step}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>

              {/* Drawer Footer */}
              <div className="p-6 border-t border-black/5 dark:border-white/5 bg-zinc-950/[0.02] dark:bg-black/20 rounded-b-2xl">
                <Link href="/leads" onClick={() => setSelectedStage(null)}>
                  <Button variant="default">
                    View in Leads Manager <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
