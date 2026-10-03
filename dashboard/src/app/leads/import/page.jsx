"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  FileText,
  Loader2,
  Search,
  Upload,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Alert } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import CustomSelect from "@/components/ui/custom-select"
import { apiFetch } from "@/utils/apiFetch"

const STEPS = ["Upload", "Map columns", "Review", "Finish"]
const DO_NOT_IMPORT = "__skip"

const DUPLICATE_OPTIONS = [
  {
    value: "skip",
    label: "Skip existing leads",
    description: "New leads are added. Rows that match existing leads are skipped.",
  },
  {
    value: "update_missing",
    label: "Update missing fields only",
    description: "Existing leads keep their current values. Empty fields can be filled in.",
  },
  {
    value: "overwrite",
    label: "Overwrite mapped fields",
    description: "Mapped fields from the CSV replace values on matching existing leads.",
  },
]

function formatBytes(bytes = 0) {
  if (!bytes) return "0 KB"
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function groupedOptions(options = []) {
  const groups = new Map()
  for (const option of options) {
    const group = option.group || "Lead fields"
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(option)
  }
  return [...groups.entries()]
}

function StepIndicator({ currentStep }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {STEPS.map((step, index) => {
        const active = index === currentStep
        const complete = index < currentStep
        return (
          <div key={step} className="flex items-center gap-2">
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
              complete
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : active
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-black"
                  : "border-black/10 bg-white text-zinc-400 dark:border-white/10 dark:bg-white/[0.03]"
            }`}>
              {complete ? <Check className="h-4 w-4" /> : index + 1}
            </div>
            <div className="min-w-0">
              <div className={`truncate text-xs font-semibold ${active ? "text-zinc-900 dark:text-white" : "text-zinc-500 dark:text-gray-400"}`}>
                {step}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SummaryCard({ label, value, tone = "default" }) {
  const toneClass = tone === "warning"
    ? "border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300"
    : tone === "success"
      ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
      : "border-black/10 bg-white text-zinc-800 dark:border-white/10 dark:bg-white/[0.03] dark:text-gray-200"
  return (
    <div className={`rounded-lg border p-4 ${toneClass}`}>
      <div className="text-2xl font-semibold">{value ?? 0}</div>
      <div className="mt-1 text-xs text-zinc-500 dark:text-gray-400">{label}</div>
    </div>
  )
}

export default function LeadImportPage() {
  const router = useRouter()
  const fileInputRef = useRef(null)
  const [step, setStep] = useState(0)
  const [file, setFile] = useState(null)
  const [sourceLabel, setSourceLabel] = useState("CSV Import")
  const [preview, setPreview] = useState(null)
  const [mappings, setMappings] = useState({})
  const [duplicateMode, setDuplicateMode] = useState("skip")
  const [columnFilter, setColumnFilter] = useState("all")
  const [columnSearch, setColumnSearch] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState(null)
  const [journeys, setJourneys] = useState([])
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [enrollJourney, setEnrollJourney] = useState("")
  const [enrollPreview, setEnrollPreview] = useState(null)
  const [enrollResult, setEnrollResult] = useState(null)
  const [enrollLoading, setEnrollLoading] = useState(false)
  const [enrollError, setEnrollError] = useState("")

  const mappingOptions = preview?.mapping_options || []
  const review = preview?.review || {}
  const mappedCount = Object.values(mappings).filter((value) => value && value !== DO_NOT_IMPORT).length
  const unmappedCount = Object.values(mappings).filter((value) => value === DO_NOT_IMPORT).length

  const filteredHeaders = useMemo(() => {
    const search = columnSearch.trim().toLowerCase()
    return (preview?.headers || []).filter((column) => {
      const key = column.normalized || `column_${column.index + 1}`
      const mapped = mappings[key] || DO_NOT_IMPORT
      if (columnFilter === "mapped" && mapped === DO_NOT_IMPORT) return false
      if (columnFilter === "unmapped" && mapped !== DO_NOT_IMPORT) return false
      if (!search) return true
      return String(column.header || "").toLowerCase().includes(search)
    })
  }, [columnFilter, columnSearch, mappings, preview?.headers])

  const handleFile = (nextFile) => {
    setFile(nextFile || null)
    setPreview(null)
    setMappings({})
    setResult(null)
    setError("")
    if (nextFile) parseFile(nextFile)
  }

  const parseFile = async (selectedFile = file) => {
    if (!selectedFile) {
      setError("Choose a CSV file first.")
      return
    }

    setLoading(true)
    setError("")
    setPreview(null)
    const formData = new FormData()
    formData.append("file", selectedFile)
    formData.append("campaign_type", sourceLabel || "CSV Import")

    try {
      const json = await apiFetch("/api/leads/import/preview", {
        method: "POST",
        body: formData,
      })
      setPreview(json.data)
      setMappings(json.data?.mappings || {})
    } catch (err) {
      setError(err.message || "Could not read this CSV.")
    } finally {
      setLoading(false)
    }
  }

  const commitImport = async () => {
    if (!preview?.batch?.id) {
      setError("Upload and preview the CSV before importing leads.")
      return
    }
    setLoading(true)
    setError("")
    try {
      const json = await apiFetch("/api/leads/import/commit", {
        json: {
          batch_id: preview.batch.id,
          mappings,
          duplicate_mode: duplicateMode,
        },
      })
      setResult({ batch: json.data, summary: json.summary })
      setStep(3)
    } catch (err) {
      setError(err.message || "Import failed.")
    } finally {
      setLoading(false)
    }
  }

  const goNext = () => {
    if (step === 0 && preview) setStep(1)
    else if (step === 1) setStep(2)
    else if (step === 2) commitImport()
  }

  const goBack = () => {
    if (step === 0) router.push("/leads")
    else setStep((current) => Math.max(0, current - 1))
  }

  const canContinue = step === 0 ? !!preview && !loading : step === 1 ? !!preview : step === 2 ? !!preview && !loading : false
  const selectedDuplicateOption = DUPLICATE_OPTIONS.find((option) => option.value === duplicateMode)
  const batchId = result?.batch?.id || preview?.batch?.id

  useEffect(() => {
    fetch("/api/journeys")
      .then((res) => res.json())
      .then((json) => setJourneys(json.data || []))
      .catch(() => setJourneys([]))
  }, [])

  const fetchEnrollPreview = async (journeyKey) => {
    const key = String(journeyKey || "").trim()
    setEnrollJourney(key)
    setEnrollPreview(null)
    setEnrollResult(null)
    setEnrollError("")
    if (!key || !batchId) return

    setEnrollLoading(true)
    try {
      const json = await apiFetch("/api/leads/bulk-enroll", {
        json: {
          import_id: batchId,
          journey_key: key,
          start_behavior: "now",
          dry_run: true,
        },
      })
      setEnrollPreview(json.data)
    } catch (err) {
      setEnrollError(err.message || "Could not preview enrollment.")
    } finally {
      setEnrollLoading(false)
    }
  }

  const commitImportEnroll = async () => {
    if (!batchId || !enrollJourney) return
    setEnrollLoading(true)
    setEnrollError("")
    try {
      const json = await apiFetch("/api/leads/bulk-enroll", {
        json: {
          import_id: batchId,
          journey_key: enrollJourney,
          start_behavior: "now",
        },
      })
      setEnrollResult(json.data)
      setEnrollPreview(null)
    } catch (err) {
      setEnrollError(err.message || "Could not enroll this import.")
    } finally {
      setEnrollLoading(false)
    }
  }

  return (
    <div className="min-h-[100dvh] bg-zinc-50 text-zinc-900 dark:bg-surface-base dark:text-white">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[1400px] flex-col px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col gap-4 border-b border-black/10 pb-5 dark:border-white/10 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <button
              type="button"
              onClick={() => router.push("/leads")}
              className="mb-4 inline-flex items-center gap-2 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-gray-400 dark:hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Leads
            </button>
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white">Import leads</h1>
            <p className="mt-2 text-sm text-zinc-500 dark:text-gray-400">
              Upload a CSV, map columns, then review before adding leads.
            </p>
          </div>
          <div className="w-full lg:max-w-xl">
            <StepIndicator currentStep={step} />
          </div>
        </div>

        {error && (
          <Alert variant="danger" className="mb-4">{error}</Alert>
        )}

        <main className="flex-1 pb-28">
          {step === 0 && (
            <section className="grid gap-6 lg:grid-cols-[1fr_360px]">
              <div
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  handleFile(event.dataTransfer.files?.[0])
                }}
                className="flex min-h-[420px] flex-col items-center justify-center rounded-lg border border-dashed border-black/20 bg-white p-8 text-center dark:border-white/15 dark:bg-white/[0.03]"
              >
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-lg bg-zinc-950/5 dark:bg-white/10">
                  {loading ? <Loader2 className="h-7 w-7 animate-spin text-zinc-500" /> : <Upload className="h-7 w-7 text-zinc-500" />}
                </div>
                <h2 className="text-xl font-semibold">Upload your CSV</h2>
                <p className="mt-2 max-w-md text-sm text-zinc-500 dark:text-gray-400">
                  Choose a CSV file with lead names, emails, phone numbers, or custom columns.
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(event) => handleFile(event.target.files?.[0])}
                />
                <Button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-6 h-10 rounded-lg bg-zinc-950 px-4 text-white hover:bg-zinc-800 dark:bg-white dark:text-black"
                >
                  Select CSV file
                </Button>
                <p className="mt-3 text-xs text-zinc-400">Accepted format: CSV. Maximum size: 5 MB.</p>
                {file && (
                  <div className="mt-6 flex items-center gap-3 rounded-lg border border-black/10 bg-zinc-50 px-4 py-3 text-left dark:border-white/10 dark:bg-black/30">
                    <FileText className="h-5 w-5 text-zinc-500" />
                    <div>
                      <div className="text-sm font-medium">{file.name}</div>
                      <div className="text-xs text-zinc-500">{formatBytes(file.size)}</div>
                    </div>
                  </div>
                )}
                {preview && (
                  <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    File parsed successfully
                  </div>
                )}
              </div>
              <aside className="rounded-lg border border-black/10 bg-white p-5 dark:border-white/10 dark:bg-white/[0.03]">
                <h3 className="text-sm font-semibold">What happens next</h3>
                <p className="mt-2 text-sm text-zinc-500 dark:text-gray-400">
                  Importing leads will not start a journey. You can enroll leads after reviewing them.
                </p>
                <div className="mt-5 space-y-3 text-sm">
                  {["Map CSV columns to lead fields", "Choose how to handle existing leads", "Review counts and row issues before importing"].map((item) => (
                    <div key={item} className="flex items-center gap-2 text-zinc-700 dark:text-gray-300">
                      <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-6">
                  <label className="text-xs font-medium text-zinc-500 dark:text-gray-400">Import source label</label>
                  <Input
                    value={sourceLabel}
                    onChange={(event) => setSourceLabel(event.target.value)}
                    disabled={loading || !!preview}
                    placeholder="e.g. webinar leads"
                    className="mt-2 h-10 rounded-lg border-black/10 bg-white dark:border-white/10 dark:bg-black/30"
                  />
                </div>
              </aside>
            </section>
          )}

          {step === 1 && (
            <section className="space-y-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h2 className="text-xl font-semibold">Map columns</h2>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-gray-400">
                    Map each CSV column to a lead field, a custom field, or choose Do not import.
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                    <Input
                      value={columnSearch}
                      onChange={(event) => setColumnSearch(event.target.value)}
                      placeholder="Search columns"
                      className="h-10 w-full rounded-lg border-black/10 bg-white pl-9 sm:w-64 dark:border-white/10 dark:bg-white/[0.03]"
                    />
                  </div>
                  <div className="flex rounded-lg border border-black/10 bg-white p-1 dark:border-white/10 dark:bg-white/[0.03]">
                    {["all", "mapped", "unmapped"].map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        onClick={() => setColumnFilter(filter)}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${
                          columnFilter === filter
                            ? "bg-zinc-950 text-white dark:bg-white dark:text-black"
                            : "text-zinc-500 hover:text-zinc-900 dark:text-gray-400 dark:hover:text-white"
                        }`}
                      >
                        {filter === "all" ? "All columns" : filter}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-black/10 bg-white dark:border-white/10 dark:bg-white/[0.03]">
                <div className="min-w-[980px]">
                  <div className="grid grid-cols-[1.2fr_1.3fr_150px_280px] gap-4 border-b border-black/10 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-white/10 dark:text-gray-400">
                    <div>CSV column</div>
                    <div>Sample values</div>
                    <div>Status</div>
                    <div>Example Co field</div>
                  </div>
                  <div className="max-h-[58vh] overflow-y-auto">
                    {filteredHeaders.map((column) => {
                      const key = column.normalized || `column_${column.index + 1}`
                      const mapped = mappings[key] || DO_NOT_IMPORT
                      const samples = preview?.samples?.[key] || []
                      return (
                        <div key={key} className="grid grid-cols-[1.2fr_1.3fr_150px_280px] gap-4 border-b border-black/5 px-4 py-3 last:border-b-0 dark:border-white/5">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-zinc-900 dark:text-white">{column.header || `Column ${column.index + 1}`}</div>
                          </div>
                          <div className="truncate text-sm text-zinc-500 dark:text-gray-400">
                            {samples.length ? samples.join(" / ") : "No sample values"}
                          </div>
                          <div>
                            <span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-medium ${
                              mapped === DO_NOT_IMPORT
                                ? "bg-zinc-950/5 text-zinc-500 dark:bg-white/10 dark:text-gray-400"
                                : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            }`}>
                              {mapped === DO_NOT_IMPORT ? "Not imported" : "Mapped"}
                            </span>
                          </div>
                          <select
                            value={mapped}
                            onChange={(event) => setMappings((current) => ({ ...current, [key]: event.target.value }))}
                            className="h-9 rounded-lg border border-black/10 bg-white px-2 text-sm text-zinc-900 dark:border-white/10 dark:bg-black/30 dark:text-white"
                          >
                            {groupedOptions(mappingOptions).map(([group, options]) => (
                              <optgroup key={group} label={group}>
                                {options.map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="grid gap-6 lg:grid-cols-[1fr_420px]">
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold">Review import</h2>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-gray-400">
                    This will add or update leads only. No journeys will start.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <SummaryCard label="Rows scanned" value={review.total_rows} />
                  <SummaryCard label="Ready to import" value={review.ready_rows} tone="success" />
                  <SummaryCard label="Existing leads found" value={review.duplicate_rows} />
                  <SummaryCard label="Rows with errors" value={review.error_rows} tone={review.error_rows ? "warning" : "default"} />
                  <SummaryCard label="Unmapped columns" value={unmappedCount} />
                  <SummaryCard label="Mapped fields" value={mappedCount} />
                </div>
                {(review.errors || []).length > 0 && (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
                    <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-200">Rows to skip</h3>
                    <div className="mt-3 overflow-hidden rounded-lg border border-amber-500/20">
                      {(review.errors || []).slice(0, 8).map((row) => (
                        <div key={`${row.row}-${row.error}`} className="grid grid-cols-[90px_1fr] border-b border-amber-500/10 px-3 py-2 text-sm last:border-b-0">
                          <div className="text-amber-700 dark:text-amber-300">Row {row.row}</div>
                          <div className="text-zinc-700 dark:text-gray-300">{row.error}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <aside className="h-fit rounded-lg border border-black/10 bg-white p-5 dark:border-white/10 dark:bg-white/[0.03]">
                <h3 className="text-sm font-semibold">Existing leads</h3>
                <p className="mt-1 text-sm text-zinc-500 dark:text-gray-400">Choose what should happen when a row matches a lead you already have.</p>
                <div className="mt-4">
                  <CustomSelect
                    value={duplicateMode}
                    onChange={setDuplicateMode}
                    options={DUPLICATE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                    triggerClassName="w-full h-10 bg-white dark:bg-black/30 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white text-sm rounded-lg px-3 outline-none flex items-center justify-between"
                  />
                  <p className="mt-2 text-xs text-zinc-500 dark:text-gray-400">{selectedDuplicateOption?.description}</p>
                </div>
                <div className="mt-5 rounded-lg border border-sky-500/20 bg-sky-500/10 p-3 text-xs text-sky-700 dark:text-sky-300">
                  Imported leads are saved for review. Follow-up journeys are started separately from the Leads page.
                </div>
              </aside>
            </section>
          )}

          {step === 3 && result && (
            <section className="mx-auto max-w-4xl text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-7 w-7" />
              </div>
              <h2 className="mt-5 text-2xl font-semibold">Import finished</h2>
              <p className="mt-2 text-sm text-zinc-500 dark:text-gray-400">Your leads are ready to review. No journeys were started.</p>
              <div className="mt-8 grid gap-3 sm:grid-cols-4">
                <SummaryCard label="Created" value={result.summary?.created} tone="success" />
                <SummaryCard label="Updated" value={result.summary?.updated} />
                <SummaryCard label="Skipped existing" value={result.summary?.skipped_duplicates} />
                <SummaryCard label="Failed rows" value={result.summary?.failed_rows} tone={result.summary?.failed_rows ? "warning" : "default"} />
              </div>
              <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
                <Button
                  type="button"
                  onClick={() => router.push(batchId ? `/leads?import=${encodeURIComponent(batchId)}` : "/leads")}
                  className="h-10 rounded-lg bg-zinc-950 px-4 text-white hover:bg-zinc-800 dark:bg-white dark:text-black"
                >
                  Review imported leads
                </Button>
                <Button
                  type="button"
                  disabled={!batchId}
                  onClick={() => {
                    setEnrollOpen(true)
                    setEnrollPreview(null)
                    setEnrollResult(null)
                    setEnrollError("")
                  }}
                  className="h-10 rounded-lg border border-black/10 bg-white px-4 text-zinc-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-gray-400"
                >
                  Enroll this import in a journey
                </Button>
                <Button
                  type="button"
                  onClick={() => router.push("/leads")}
                  className="h-10 rounded-lg border border-black/10 bg-white px-4 text-zinc-800 hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03] dark:text-white"
                >
                  Go to Leads
                </Button>
              </div>
              <p className="mt-3 text-xs text-zinc-500 dark:text-gray-400">
                You can enroll eligible leads now, or review imported leads first.
              </p>
            </section>
          )}
        </main>

        {enrollOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
            <div className="absolute inset-0" onClick={() => !enrollLoading && setEnrollOpen(false)} />
            <div className="relative w-full max-w-lg rounded-lg border border-black/10 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-surface-1">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold text-zinc-950 dark:text-white">Enroll leads from this import</h3>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-gray-400">Only leads from this import will be considered.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setEnrollOpen(false)}
                  disabled={enrollLoading}
                  className="text-zinc-400 hover:text-zinc-900 dark:hover:text-white"
                >
                  ×
                </button>
              </div>

              {enrollError && (
                <Alert variant="danger" className="mt-4">{enrollError}</Alert>
              )}

              {enrollResult ? (
                <div className="mt-5 space-y-4">
                  <Alert variant="success" className="p-4">
                    {enrollResult.summary?.enrolled || 0} enrolled, {(enrollResult.summary?.skipped_already_active || 0) + (enrollResult.summary?.skipped_opted_out || 0) + (enrollResult.summary?.skipped_suppressed || 0) + (enrollResult.summary?.skipped_missing_contact || 0)} skipped, {enrollResult.summary?.failed || 0} failed.
                  </Alert>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      onClick={() => setEnrollOpen(false)}
                      className="h-10 rounded-lg bg-zinc-950 px-4 text-white dark:bg-white dark:text-black"
                    >
                      Done
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-5 space-y-4">
                  <div>
                    <label className="text-xs font-medium text-zinc-500 dark:text-gray-400">Journey</label>
                    <CustomSelect
                      value={enrollJourney}
                      onChange={fetchEnrollPreview}
                      options={[
                        { value: "", label: "Choose a journey" },
                        ...journeys.filter((journey) => journey.active).map((journey) => ({ value: journey.journey_key, label: journey.name || journey.journey_key })),
                      ]}
                      triggerClassName="mt-2 w-full h-10 bg-white dark:bg-black/30 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white text-sm rounded-lg px-3 outline-none flex items-center justify-between"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {[
                      ["Eligible", enrollPreview?.summary?.ready || 0],
                      ["Already active", enrollPreview?.summary?.skipped_already_active || 0],
                      ["Opted out", enrollPreview?.summary?.skipped_opted_out || 0],
                      ["Suppressed", enrollPreview?.summary?.skipped_suppressed || 0],
                      ["Missing contact", enrollPreview?.summary?.skipped_missing_contact || 0],
                      ["Failed", enrollPreview?.summary?.failed || 0],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-black/10 bg-zinc-50 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                        <div className="text-lg font-semibold text-zinc-950 dark:text-white">{value}</div>
                        <div className="text-[11px] text-zinc-500 dark:text-gray-400">{label}</div>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      onClick={() => setEnrollOpen(false)}
                      disabled={enrollLoading}
                      className="h-10 rounded-lg border border-black/10 bg-white px-4 text-zinc-800 dark:border-white/10 dark:bg-white/[0.03] dark:text-white"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      onClick={commitImportEnroll}
                      disabled={enrollLoading || !enrollJourney || (enrollPreview?.summary?.ready || 0) === 0}
                      variant="default"
                    >
                      {enrollLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Enroll eligible leads
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {step < 3 && (
          <footer className="fixed inset-x-0 bottom-0 z-40 border-t border-black/10 bg-white/95 px-4 py-3 backdrop-blur dark:border-white/10 dark:bg-surface-base/95">
            <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3">
              <Button
                type="button"
                onClick={goBack}
                disabled={loading}
                className="h-10 rounded-lg border border-black/10 bg-white px-4 text-zinc-800 hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03] dark:text-white"
              >
                Back
              </Button>
              <div className="flex items-center gap-3">
                {step === 1 && (
                  <div className="hidden text-xs text-zinc-500 dark:text-gray-400 sm:block">
                    {mappedCount} mapped, {unmappedCount} not imported
                  </div>
                )}
                <Button
                  type="button"
                  onClick={goNext}
                  disabled={!canContinue}
                  variant="default"
                >
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {step === 2 ? "Import leads" : "Continue"}
                </Button>
              </div>
            </div>
          </footer>
        )}
      </div>
    </div>
  )
}
