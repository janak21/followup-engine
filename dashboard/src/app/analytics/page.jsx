"use client"

import { useEffect, useState } from "react"
import { motion } from "framer-motion"
import { 
  TrendingUp, Zap, PhoneCall, Mail, MessageSquare, 
  ArrowUpRight, ArrowDownRight, Calendar, AlertCircle, Info, 
  Loader2, RefreshCw, BarChart2
} from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { getCachedData, setCachedData } from "@/utils/apiCache"
import { apiFetch } from "@/utils/apiFetch"
import { Button } from "@/components/ui/button"
import { AppIcon } from "@/components/AppIcon"

export default function AnalyticsPage() {
  const [data, setData] = useState(() => getCachedData("analytics"))
  const [loading, setLoading] = useState(() => !getCachedData("analytics"))
  const [error, setError] = useState("")
  const [hoveredBar, setHoveredBar] = useState(null)
  const [hoveredLinePoint, setHoveredLinePoint] = useState(null)
  const [hoveredDailyPoint, setHoveredDailyPoint] = useState(null)

  useEffect(() => {
    const hasCache = !!getCachedData("analytics")
    fetchAnalytics(hasCache)
  }, [])

  const fetchAnalytics = async (silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    try {
      const analyticsData = await apiFetch("/api/analytics")
      if (!analyticsData.data) throw new Error("Analytics service returned no data")
      setData(analyticsData.data)
      setCachedData("analytics", analyticsData.data)
    } catch (err) {
      console.error("Failed to fetch analytics:", err)
      setError(err.message || "Could not load analytics.")
    } finally {
      setLoading(false)
    }
  }

  // Loading Skeleton
  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-4">
        <Loader2 className="w-8 h-8 animate-spin text-zinc-400 dark:text-gray-400" />
        <span className="text-sm text-zinc-500 dark:text-gray-500">Loading analytics insights...</span>
      </div>
    )
  }

  // Error state — only when there is no cached data to fall back to.
  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-4 text-center px-6">
        <AlertCircle className="w-8 h-8 text-rose-500" />
        <div>
          <p className="text-sm font-semibold text-zinc-900 dark:text-white">Analytics could not be loaded</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 max-w-sm">
            {error || "The analytics service did not return data."} Your leads and journeys are unaffected — this only impacts reporting.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchAnalytics(false)}>
          <RefreshCw className="w-4 h-4 mr-2" /> Try again
        </Button>
      </div>
    )
  }

  const { kpis, actionBreakdown, responseRatesOverTime, dailySentOverTime } = data

  // Render stats cards
  const stats = [
    {
      title: "Response Rate",
      value: kpis.responseRate,
      icon: TrendingUp,
      desc: "Email/SMS reply leads divided by contacted leads, last 30d",
      trend: "Last 30 days",
      positive: true
    },
    {
      title: "Call Success Rate",
      value: kpis.callSuccessRate,
      icon: PhoneCall,
      desc: "Calls answered divided by call attempts, last 30d",
      trend: "Last 30 days",
      positive: true
    },
    {
      title: "Active Journeys",
      value: kpis.activeJourneys,
      icon: Zap,
      desc: "Active follow-up journeys",
      trend: "Stable",
      positive: true
    },
    {
      title: "Completed Actions (24h)",
      value: kpis.dailySentCounts,
      icon: RefreshCw,
      desc: "Follow-up actions completed in the last 24 hours",
      trend: "Completed actions",
      positive: true
    }
  ]

  // --- SVG BAR CHART CALCULATIONS (Outbound action types) ---
  const barChartHeight = 220
  const barChartWidth = 460
  const paddingX = 40
  const paddingY = 30
  const barMaxVal = Math.max(...actionBreakdown.map(d => d.count)) * 1.15
  const barWidth = 60
  const barSpacing = (barChartWidth - paddingX * 2 - barWidth * actionBreakdown.length) / (actionBreakdown.length - 1)

  // --- SVG LINE CHART CALCULATIONS (Lead response rates over time) ---
  const lineChartHeight = 220
  const lineChartWidth = 500
  const linePaddingX = 50
  const linePaddingY = 30
  
  // Response rates are percentages (0-100)
  const getLineCoordinates = (dataset, isCount = false, customWidth = lineChartWidth) => {
    if (!dataset || dataset.length === 0) return []
    
    let maxVal = isCount ? Math.max(...dataset.map(d => d.count)) * 1.15 : 100
    if (maxVal === 0) maxVal = 10 // Prevent division by zero
    
    const stepX = dataset.length > 1 ? (customWidth - linePaddingX * 2) / (dataset.length - 1) : 0
    
    return dataset.map((d, i) => {
      const val = isCount ? d.count : d.rate
      const x = dataset.length > 1 ? linePaddingX + i * stepX : customWidth / 2
      const y = lineChartHeight - linePaddingY - (val / maxVal) * (lineChartHeight - linePaddingY * 2)
      return { x, y, label: d.label, val }
    })
  }

  const linePoints = getLineCoordinates(responseRatesOverTime)
  const linePathString = linePoints.reduce((acc, p, i) => {
    return i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`
  }, "")

  // Area path string to close the polygon for background gradient fill
  const lineAreaPathString = linePoints.length > 0 
    ? `${linePathString} L ${linePoints[linePoints.length - 1].x} ${lineChartHeight - linePaddingY} L ${linePoints[0].x} ${lineChartHeight - linePaddingY} Z`
    : ""

  // --- SVG AREA CHART CALCULATIONS (completed outbound actions over time) ---
  const dailyPoints = getLineCoordinates(dailySentOverTime, true, lineChartWidth + 200)
  const dailyPathString = dailyPoints.reduce((acc, p, i) => {
    return i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`
  }, "")
  
  const dailyAreaPathString = dailyPoints.length > 0
    ? `${dailyPathString} L ${dailyPoints[dailyPoints.length - 1].x} ${lineChartHeight - linePaddingY} L ${dailyPoints[0].x} ${lineChartHeight - linePaddingY} Z`
    : ""

  return (
    <div className="space-y-8 pb-10">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
            <AppIcon name="analytics" size={32} className="text-zinc-700 dark:text-gray-300" />
            Performance Analytics
          </h1>
          <p className="text-sm text-zinc-500 dark:text-gray-400 mt-1">
            Real-time performance metrics and conversation analytics.
          </p>
        </div>
        <Button
          onClick={() => fetchAnalytics(false)}
          className="bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-800 dark:text-white border border-black/5 dark:border-white/5 rounded-xl px-4 py-2 font-medium transition-all flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" /> Refresh Insights
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-amber-800 dark:text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-2" role="status">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>Refresh failed — showing the last loaded data. {error}</span>
        </div>
      )}

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: i * 0.05 }}
          >
            <Card className="bg-white/40 dark:bg-white/[0.02] border-black/5 dark:border-white/5 backdrop-blur-xl hover:bg-white/60 dark:hover:bg-white/[0.04] transition-colors duration-300 rounded-2xl relative overflow-hidden">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-gray-500">
                  {stat.title}
                </CardTitle>
                <div className="w-8 h-8 rounded-full bg-zinc-950/5 dark:bg-white/5 flex items-center justify-center shadow-inner">
                  <stat.icon className="w-4 h-4 text-zinc-500 dark:text-gray-400" />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold text-zinc-900 dark:text-white tracking-tight mb-1">
                  {stat.value}
                </div>
                <div className="text-xs text-zinc-500 dark:text-gray-400 mb-2">{stat.desc}</div>
                <div className="flex items-center text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                  <ArrowUpRight className="w-3.5 h-3.5 mr-0.5" />
                  <span>{stat.trend}</span>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        
        {/* OUTBOUND ACTIONS BREAKDOWN BAR CHART */}
        <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-6 flex flex-col justify-between">
          <div>
            <CardHeader className="p-0 mb-4">
              <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                <BarChart2 className="w-5 h-5 text-zinc-500 dark:text-gray-400" /> Outbound Actions by Type
              </CardTitle>
              <CardDescription className="text-zinc-500 dark:text-gray-400">
                Follow-up actions attempted in the last 30 days by channel.
              </CardDescription>
            </CardHeader>
            
            {/* Custom interactive SVG Bar Chart */}
            <div className="relative flex items-center justify-center py-4">
              <svg 
                width={barChartWidth} 
                height={barChartHeight} 
                className="overflow-visible select-none"
              >
                {/* Background Grid Lines */}
                {[0, 0.25, 0.5, 0.75, 1].map((ratio, index) => {
                  const y = paddingY + ratio * (barChartHeight - paddingY * 2)
                  const val = Math.round(barMaxVal * (1 - ratio))
                  return (
                    <g key={index}>
                      <line 
                        x1={paddingX} 
                        y1={y} 
                        x2={barChartWidth - paddingX} 
                        y2={y} 
                        stroke="var(--chart-grid)" 
                        strokeWidth="1"
                      />
                      <text 
                        x={paddingX - 10} 
                        y={y + 4} 
                        fill="var(--chart-text-muted)" 
                        fontSize="9" 
                        textAnchor="end"
                        fontFamily="monospace"
                      >
                        {val}
                      </text>
                    </g>
                  )
                })}

                {/* Bars */}
                {actionBreakdown.map((item, index) => {
                  const x = paddingX + index * (barWidth + barSpacing) + barSpacing / 2
                  const ratio = item.count / barMaxVal
                  const h = ratio * (barChartHeight - paddingY * 2)
                  const y = barChartHeight - paddingY - h
                  const isHovered = hoveredBar === index

                  return (
                    <g 
                      key={item.type}
                      onMouseEnter={() => setHoveredBar(index)}
                      onMouseLeave={() => setHoveredBar(null)}
                      className="cursor-pointer"
                    >
                      {/* Interactive Bar */}
                      <rect
                        x={x}
                        y={y}
                        width={barWidth}
                        height={h}
                        rx="6"
                        ry="6"
                        fill={isHovered ? "var(--chart-bar-hover-bg)" : "var(--chart-bar-bg)"}
                        stroke={isHovered ? "var(--chart-bar-hover-stroke)" : "var(--chart-bar-stroke)"}
                        strokeWidth="1"
                        className="transition-all duration-300"
                      />

                      {/* Accent Gradient Line atop the bar */}
                      <rect
                        x={x}
                        y={y}
                        width={barWidth}
                        height="4"
                        rx="2"
                        fill={item.type === "Email" ? "#94a3b8" : item.type === "SMS" ? "#fbbf24" : "#60a5fa"}
                        opacity={isHovered ? 1 : 0.7}
                      />

                      {/* X Axis Labels */}
                      <text
                        x={x + barWidth / 2}
                        y={barChartHeight - paddingY + 18}
                        fill={isHovered ? "var(--chart-text-active)" : "var(--chart-text-muted)"}
                        fontSize="10"
                        fontWeight="500"
                        textAnchor="middle"
                      >
                        {item.type}
                      </text>

                      {/* Hover Count Value Text */}
                      {isHovered && (
                        <text
                          x={x + barWidth / 2}
                          y={y - 8}
                          fill="var(--chart-text-active)"
                          fontSize="11"
                          fontWeight="bold"
                          textAnchor="middle"
                        >
                          {item.count}
                        </text>
                      )}
                    </g>
                  )
                })}
              </svg>
            </div>
          </div>
          
          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-gray-500 pt-4 border-t border-black/5 dark:border-white/5">
            <span className="flex items-center gap-1.5"><Info className="w-3.5 h-3.5" /> Hover on channels to see volume count</span>
            <span className="font-mono">Updated just now</span>
          </div>
        </Card>

        {/* RESPONSE RATES OVER TIME LINE CHART */}
        <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-6 flex flex-col justify-between">
          <div>
            <CardHeader className="p-0 mb-4">
              <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-zinc-500 dark:text-gray-400" /> Lead Response Rates
              </CardTitle>
              <CardDescription className="text-zinc-500 dark:text-gray-400">
                Unique leads who replied by email or SMS divided by contacted leads for each day.
              </CardDescription>
            </CardHeader>

            {/* Custom interactive SVG Line Chart */}
            <div className="relative flex items-center justify-center py-4">
              <svg 
                width={lineChartWidth} 
                height={lineChartHeight}
                className="overflow-visible select-none"
              >
                <defs>
                  {/* Linear Gradient for line background fill */}
                  <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-area-stop-0)" />
                    <stop offset="100%" stopColor="var(--chart-area-stop-100)" />
                  </linearGradient>
                </defs>

                {/* Y Axis Grid lines */}
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

                {/* Shaded Area underneath the line */}
                {lineAreaPathString && (
                  <path 
                    d={lineAreaPathString}
                    fill="url(#areaGrad)"
                  />
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

                {/* Data Points */}
                {linePoints.map((point, index) => {
                  const isHovered = hoveredLinePoint === index
                  return (
                    <g 
                      key={index}
                      onMouseEnter={() => setHoveredLinePoint(index)}
                      onMouseLeave={() => setHoveredLinePoint(null)}
                      className="cursor-pointer"
                    >
                      {/* Hover state halo */}
                      {isHovered && (
                        <circle 
                          cx={point.x}
                          cy={point.y}
                          r="9"
                          fill="var(--chart-halo)"
                          stroke="var(--chart-halo-stroke)"
                          strokeWidth="1"
                        />
                      )}
                      
                      {/* Visible Point dot */}
                      <circle 
                        cx={point.x}
                        cy={point.y}
                        r={isHovered ? "5" : "3.5"}
                        fill={isHovered ? "var(--chart-dot-hover-fill)" : "var(--chart-dot-fill)"}
                        stroke="var(--background)"
                        strokeWidth="1.5"
                        className="transition-all duration-200"
                      />

                      {/* X Label */}
                      <text
                        x={point.x}
                        y={lineChartHeight - linePaddingY + 18}
                        fill={isHovered ? "var(--chart-text-active)" : "var(--chart-text-muted)"}
                        fontSize="9"
                        textAnchor="middle"
                      >
                        {point.label}
                      </text>

                      {/* Floating tooltip text above point */}
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
            </div>
          </div>

          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-gray-500 pt-4 border-t border-black/5 dark:border-white/5">
            <span className="flex items-center gap-1.5"><Info className="w-3.5 h-3.5" /> Hover on nodes to reveal daily percentages</span>
            <span className="font-mono">Weekly Trend</span>
          </div>
        </Card>
      </div>

      {/* DAILY SENT OUTBOUND TREND AREA CHART */}
      <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
          <div>
            <CardHeader className="p-0">
              <CardTitle className="text-lg text-zinc-900 dark:text-white flex items-center gap-2">
                <RefreshCw className="w-5 h-5 text-zinc-500 dark:text-gray-400" /> Daily Outbound Journey Activity
              </CardTitle>
              <CardDescription className="text-zinc-500 dark:text-gray-400">
                Number of follow-up actions completed per day over the week.
              </CardDescription>
            </CardHeader>
          </div>
        </div>

        <div className="relative flex items-center justify-center py-4">
          <svg 
            width={lineChartWidth + 240} // Wider chart for daily logs
            height={lineChartHeight + 10}
            className="overflow-visible select-none"
          >
            <defs>
              <linearGradient id="dailyGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(251,191,36,0.08)" />
                <stop offset="100%" stopColor="rgba(251,191,36,0.0)" />
              </linearGradient>
            </defs>

            {/* Y Grid */}
            {[0, 0.25, 0.5, 0.75, 1].map((ratio, index) => {
              const y = linePaddingY + ratio * (lineChartHeight - linePaddingY * 2)
              const maxCount = Math.max(...dailySentOverTime.map(d => d.count)) * 1.15
              const val = Math.round(maxCount * (1 - ratio))
              return (
                <g key={index}>
                  <line 
                    x1={linePaddingX} 
                    y1={y} 
                    x2={lineChartWidth + 200 - linePaddingX} 
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
                    {val}
                  </text>
                </g>
              )
            })}

            {/* Area */}
            {dailyAreaPathString && (
              <path 
                d={dailyAreaPathString}
                fill="url(#dailyGrad)"
              />
            )}

            {/* Line */}
            {dailyPathString && (
              <path 
                d={dailyPathString}
                fill="none"
                stroke="#fbbf24"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Dots */}
            {dailyPoints.map((point, index) => {
              const isHovered = hoveredDailyPoint === index

              return (
                <g 
                  key={index}
                  onMouseEnter={() => setHoveredDailyPoint(index)}
                  onMouseLeave={() => setHoveredDailyPoint(null)}
                  className="cursor-pointer"
                >
                  {isHovered && (
                    <circle 
                      cx={point.x}
                      cy={point.y}
                      r="9"
                      fill="rgba(251,191,36,0.15)"
                      stroke="rgba(251,191,36,0.2)"
                      strokeWidth="1"
                    />
                  )}
                  
                  <circle 
                    cx={point.x}
                    cy={point.y}
                    r={isHovered ? "5" : "3.5"}
                    fill={isHovered ? "#fbbf24" : "rgba(251,191,36,0.8)"}
                    stroke="var(--background)"
                    strokeWidth="1.5"
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
                      {point.val} sent
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      </Card>
    </div>
  )
}
