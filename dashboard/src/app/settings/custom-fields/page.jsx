"use client"

import { useEffect, useState, useMemo } from "react"
import { motion } from "framer-motion"
import {
  Database, Plus, Edit2, Trash2, Loader2, AlertCircle, FolderPlus,
  Folder, Search, X, Copy, Check, Save, Info, ChevronDown, GripVertical,
  ChevronLeft, ChevronRight
} from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { AppIcon } from "@/components/AppIcon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getCachedData, setCachedData } from "@/utils/apiCache"
import CustomSelect from "@/components/ui/custom-select"
import { useToast } from "@/components/ui/toast"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import { apiFetch } from "@/utils/apiFetch"
import {
  getCustomFieldMergeTag,
  getCustomFieldTypeDisplay,
  getCustomFieldUsageSummary,
} from "@/lib/customFieldDisplay"

const FIELD_TYPES = [
  { id: "single_line",  label: "Single line text" },
  { id: "multi_line",   label: "Multi line text" },
  { id: "number",       label: "Number" },
  { id: "date",         label: "Date" },
  { id: "boolean",      label: "Toggle (true/false)" },
  { id: "dropdown",     label: "Dropdown (single)" },
  { id: "radio",        label: "Radio select" },
  { id: "multi_select", label: "Multi-select" },
  { id: "email",        label: "Email" },
  { id: "phone",        label: "Phone" },
  { id: "url",          label: "URL" },
]

const NEEDS_OPTIONS = new Set(["dropdown", "radio", "multi_select"])

function slugify(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")
}

const BLANK_FORM = {
  id: null,
  label: "",
  key: "",
  type: "single_line",
  folder: "",
  description: "",
  placeholder: "",
  default_value: "",
  options: [],
  required: false,
  active: true,
}

export default function CustomFieldsPage() {
  const { pushToast } = useToast()
  const confirm = useConfirm()
  const [fields, setFields] = useState(() => getCachedData("custom_fields_list") || [])
  const [folders, setFolders] = useState(() => getCachedData("custom_fields_folders") || [])
  const [loading, setLoading] = useState(() => !getCachedData("custom_fields_list"))
  const [error, setError] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [folderFilter, setFolderFilter] = useState("all")
  const [copiedKey, setCopiedKey] = useState(null)
  const [usageSources, setUsageSources] = useState(() => ({
    checked: false,
    templates: [],
    journeys: [],
    error: "",
  }))

  // Modal state
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(BLANK_FORM)
  const [keyManuallyEdited, setKeyManuallyEdited] = useState(false)
  const [optionsText, setOptionsText] = useState("")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState("")

  // Folder modal state
  const [showFolderModal, setShowFolderModal] = useState(false)
  const [folderForm, setFolderForm] = useState({ name: "", originalName: null }) // originalName set during rename
  const [folderError, setFolderError] = useState("")
  const [savingFolder, setSavingFolder] = useState(false)
  // Field modal — toggle for "Add new folder" inline input
  const [addingNewFolder, setAddingNewFolder] = useState(false)
  const [newFolderInline, setNewFolderInline] = useState("")

  // Drag-and-drop reorder state
  const [draggingId, setDraggingId] = useState(null)
  const [dragOverId, setDragOverId] = useState(null)
  const [dragOverNodePath, setDragOverNodePath] = useState(null)
  const [reordering, setReordering] = useState(false)

  const handleMoveFieldToFolder = async (field, newFolder) => {
    try {
      const payload = {
        ...field,
        folder: newFolder ? newFolder.trim() : null
      }
      await apiFetch("/api/custom-fields", { method: "PUT", json: payload })
      await load()
    } catch (err) {
      pushToast("error", err.message || "Failed to move field")
    }
  }

  // Persist a new global field order to the server. Optimistic — caller has
  // already mutated local `fields` state.
  const persistOrder = async (newFields) => {
    const orderedIds = newFields.map(f => f.id)
    setReordering(true)
    try {
      await apiFetch("/api/custom-fields", { method: "PATCH", json: { ordered_ids: orderedIds } })
    } catch (err) {
      setError(err.message || "Reorder failed")
      await load()
    } finally {
      setReordering(false)
    }
  }

  // Drop handler — moves draggingId to be positioned where targetId currently sits.
  // Reorder is allowed only within the same folder.
  const handleDrop = (targetId, targetFolder) => {
    if (!draggingId || draggingId === targetId) return
    const dragged = fields.find(f => f.id === draggingId)
    if (!dragged) return
    const draggedFolder = dragged.folder || "Uncategorized"
    if (draggedFolder !== targetFolder) return // ignore cross-folder drops

    // Rebuild fields: take current sorted list, move dragged to the target's index.
    const sorted = [...fields].sort((a, b) =>
      (a.display_order || 0) - (b.display_order || 0) || a.label.localeCompare(b.label)
    )
    const fromIdx = sorted.findIndex(f => f.id === draggingId)
    const toIdx = sorted.findIndex(f => f.id === targetId)
    if (fromIdx < 0 || toIdx < 0) return

    const next = [...sorted]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)

    // Re-assign display_order to match new positions (optimistic).
    const nextWithOrder = next.map((f, idx) => ({ ...f, display_order: idx }))
    setFields(nextWithOrder)
    setDraggingId(null)
    setDragOverId(null)
    persistOrder(nextWithOrder)
  }

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    try {
      const json = await apiFetch("/api/custom-fields")
      setFields(json.data?.fields || [])
      setFolders(json.data?.folders || [])
      setCachedData("custom_fields_list", json.data?.fields || [])
      setCachedData("custom_fields_folders", json.data?.folders || [])
    } catch (err) {
      setError(err.message || "Failed to load custom fields")
    } finally {
      setLoading(false)
    }
  }

  const loadUsageSources = async () => {
    try {
      const [templatesRes, journeysRes] = await Promise.all([
        fetch("/api/templates"),
        fetch("/api/journeys?include_inactive=1"),
      ])
      if (!templatesRes.ok || !journeysRes.ok) {
        setUsageSources({ checked: false, templates: [], journeys: [], error: "Usage has not been fully checked." })
        return
      }
      const [templatesJson, journeysJson] = await Promise.all([
        templatesRes.json(),
        journeysRes.json(),
      ])
      setUsageSources({
        checked: true,
        templates: templatesJson.data || [],
        journeys: journeysJson.data || [],
        error: "",
      })
    } catch {
      setUsageSources({ checked: false, templates: [], journeys: [], error: "Usage has not been fully checked." })
    }
  }

  useEffect(() => {
    const hasCache = !!getCachedData("custom_fields_list")
    load(hasCache)
    loadUsageSources()
  }, [])

  // ---------- Folder handlers ----------
  const openCreateFolder = () => {
    setFolderForm({ name: "", originalName: null })
    setFolderError("")
    setShowFolderModal(true)
  }

  const openRenameFolder = (name) => {
    setFolderForm({ name, originalName: name })
    setFolderError("")
    setShowFolderModal(true)
  }

  const saveFolder = async (e) => {
    e?.preventDefault?.()
    const trimmed = folderForm.name.trim()
    if (!trimmed) { setFolderError("Folder name is required"); return }
    setSavingFolder(true)
    setFolderError("")
    try {
      if (folderForm.originalName) {
        try {
          await apiFetch("/api/custom-fields/folders", { method: "PUT", json: { from: folderForm.originalName, to: trimmed } })
        } catch (err) {
          setFolderError(err.message || "Rename failed"); return
        }
      } else {
        try {
          await apiFetch("/api/custom-fields/folders", { json: { name: trimmed } })
        } catch (err) {
          setFolderError(err.message || "Create failed"); return
        }
      }
      setShowFolderModal(false)
      await load()
    } finally {
      setSavingFolder(false)
    }
  }

  const deleteFolder = async (name) => {
    const fieldsInFolder = fields.filter(f => f.folder === name)
    const msg = fieldsInFolder.length > 0
      ? `${fieldsInFolder.length} field(s) in this folder will move to Uncategorized — they will NOT be deleted.`
      : "This cannot be undone."
    if (!(await confirm({
      title: `Delete folder "${name}"?`,
      message: msg,
      confirmLabel: "Delete folder",
      destructive: true,
    }))) return
    try {
      await apiFetch(`/api/custom-fields/folders?name=${encodeURIComponent(name)}`, { method: "DELETE" })
      if (folderFilter === name) setFolderFilter("all")
      load()
    } catch (err) {
      pushToast("error", err.message || "Delete failed")
    }
  }

  // Filtered list
  const filteredFields = useMemo(() => {
    return (fields || [])
      .filter(f => {
        if (searchQuery) return true // search globally when query is active
        if (folderFilter === "all") {
          return !f.folder // root shows uncategorized fields
        }
        if (folderFilter === "__none__") {
          return !f.folder
        }
        return f.folder === folderFilter
      })
      .filter(f => !searchQuery || f.label.toLowerCase().includes(searchQuery.toLowerCase()) || f.key.toLowerCase().includes(searchQuery.toLowerCase()))
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0) || a.label.localeCompare(b.label))
  }, [fields, folderFilter, searchQuery])

  const grouped = useMemo(() => {
    const map = {}
    // Seed with every known folder (so empty folders render too)
    for (const f of folders) {
      map[f] = []
    }
    for (const f of filteredFields) {
      const k = f.folder || "Uncategorized"
      if (!map[k]) map[k] = []
      map[k].push(f)
    }
    // Only show Uncategorized if it has fields
    if (map.Uncategorized && map.Uncategorized.length === 0) delete map.Uncategorized
    return map
  }, [filteredFields, folders])

  const openCreate = () => {
    setForm(BLANK_FORM)
    setOptionsText("")
    setKeyManuallyEdited(false)
    setFormError("")
    setShowModal(true)
  }

  const openEdit = (f) => {
    setForm({
      ...BLANK_FORM,
      ...f,
      folder: f.folder || "",
      description: f.description || "",
      placeholder: f.placeholder || "",
      default_value: f.default_value ?? "",
      options: Array.isArray(f.options) ? f.options : [],
      required: !!f.required,
      active: f.active !== false,
    })
    setOptionsText(Array.isArray(f.options) ? f.options.join("\n") : "")
    setKeyManuallyEdited(true)
    setFormError("")
    setShowModal(true)
  }

  const handleLabelChange = (val) => {
    setForm(prev => {
      const next = { ...prev, label: val }
      if (!keyManuallyEdited && !next.id) {
        next.key = slugify(val)
      }
      return next
    })
  }

  const handleSave = async (e) => {
    e?.preventDefault?.()
    setFormError("")
    if (!form.label.trim()) { setFormError("Field name is required"); return }
    let options = null
    if (NEEDS_OPTIONS.has(form.type)) {
      options = optionsText.split("\n").map(s => s.trim()).filter(Boolean)
      if (!options.length) { setFormError(`${form.type} fields need at least one option`); return }
    }
    setSaving(true)
    try {
      const payload = {
        ...form,
        key: slugify(form.key || form.label),
        folder: form.folder ? form.folder.trim() : null,
        options,
      }
      const method = form.id ? "PUT" : "POST"
      try {
        await apiFetch("/api/custom-fields", { method, json: payload })
      } catch (err) {
        setFormError(err.message || "Save failed"); return
      }
      setShowModal(false)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (f) => {
    const usage = getCustomFieldUsageSummary(f, usageSources)
    const usageCopy = usage.checked
      ? usage.detail
      : "Usage has not been fully checked."
    if (!(await confirm({
      title: `Delete custom field "${f.label}" (${f.key})?`,
      message: `Deleting this field may break templates, webhook mappings, or journey conditions that reference its key.\n\n${usageCopy}\n\nExisting leads keep their stored values, but new leads will no longer show this field.`,
      confirmLabel: "Delete field",
      destructive: true,
    }))) return
    try {
      await apiFetch(`/api/custom-fields?id=${f.id}`, { method: "DELETE" })
      load()
    } catch (err) {
      pushToast("error", err.message || "Delete failed")
    }
  }

  const copyKey = (key) => {
    navigator.clipboard?.writeText(getCustomFieldMergeTag(key))
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div className="max-w-2xl">
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
              <AppIcon name="customFields" size={28} /> Custom fields
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
              Store reusable lead details for templates, journey conditions, webhook mappings, and lead profiles. Use fields as merge tags like <span className="font-mono bg-black/5 dark:bg-white/5 px-1 rounded">{`{{coverage_type}}`}</span> or conditions like <span className="font-mono bg-black/5 dark:bg-white/5 px-1 rounded">custom.coverage_type</span>.
            </p>
          </div>
          <div className="flex gap-3 flex-shrink-0">
            <Button 
              onClick={openCreate} 
              variant="default"
            >
              <Plus className="w-4 h-4" /> Create field
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="danger" className="mb-4">{error}</Alert>
        )}

        {usageSources.error && (
          <Alert variant="warning" className="mb-4">Usage not checked. Review templates, journey conditions, and webhook mappings before renaming or deleting fields.</Alert>
        )}

        {/* Finder-style Explorer Card */}
        <Card className="bg-white/40 dark:bg-white/[0.02] border border-black/5 dark:border-white/5 backdrop-blur-xl rounded-2xl shadow-xl overflow-hidden mb-6">
          {/* Navigation Breadcrumbs & Actions bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 border-b border-black/5 dark:border-white/5 bg-zinc-50/[0.01] dark:bg-white/[0.003] rounded-t-2xl">
            <div className="flex items-center gap-3 min-w-0">
              {folderFilter !== "all" && (
                <button
                  onClick={() => setFolderFilter("all")}
                  className="p-1.5 rounded-xl bg-zinc-950/5 hover:bg-zinc-950/10 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-all active:scale-95 border border-black/5 dark:border-white/5 shrink-0"
                  title="Go back"
                  aria-label="Back to all folders"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              )}
              <div className="flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400 truncate font-medium">
                <span
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (draggingId) setDragOverNodePath("")
                  }}
                  onDragLeave={() => setDragOverNodePath(null)}
                  onDrop={(e) => {
                    e.preventDefault()
                    const dragged = fields.find(f => f.id === draggingId)
                    if (dragged) {
                      handleMoveFieldToFolder(dragged, "")
                    }
                    setDraggingId(null)
                    setDragOverNodePath(null)
                  }}
                  onClick={() => setFolderFilter("all")}
                  className={`cursor-pointer transition-all px-2 py-0.5 rounded-lg border leading-tight ${
                    dragOverNodePath === ""
                      ? "bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400 scale-[1.02]"
                      : folderFilter === "all"
                      ? "text-zinc-900 dark:text-white border-transparent"
                      : "hover:text-zinc-800 dark:hover:text-white border-transparent hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                >
                  All Custom Fields
                </span>
                {folderFilter !== "all" && (
                  <>
                    <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                    <span className="font-semibold text-zinc-900 dark:text-white border-transparent px-2 py-0.5 rounded-lg">
                      {folderFilter === "__none__" ? "Uncategorized" : folderFilter}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0 ml-auto sm:ml-0">
              <div className="relative w-48 sm:w-56 md:w-64">
                <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-400" />
                <Input
                  placeholder="Search custom fields..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 text-xs h-8.5 rounded-xl w-full text-zinc-900 dark:text-white"
                />
              </div>
              {!searchQuery && (
                <Button
                  onClick={openCreateFolder}
                  variant="outline"
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                  <span>New Folder</span>
                </Button>
              )}
            </div>
          </div>

          <CardContent className="p-0 border-t border-black/5 dark:border-white/5">
            {loading && fields.length === 0 ? (
              <div className="p-20 flex flex-col items-center justify-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
                <p className="text-zinc-500 dark:text-zinc-400 text-sm">Loading custom fields...</p>
              </div>
            ) : (
              <div className="flex flex-col">
                {/* Folders Grid Section - Only visible in Root/All view when not searching */}
                {folderFilter === "all" && !searchQuery && folders.length > 0 && (
                  <div className="p-6 border-b border-black/5 dark:border-white/5 bg-zinc-50/[0.01] dark:bg-white/[0.003]">
                    <div className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3">Folders</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      {folders.map(folder => {
                        const count = fields.filter(f => f.folder === folder).length
                        const isDragOver = dragOverNodePath === folder
                        return (
                          <div
                            key={folder}
                            onClick={() => {
                              setFolderFilter(folder)
                              setDragOverNodePath(null)
                            }}
                            onDragOver={(e) => {
                              e.preventDefault()
                              if (draggingId) setDragOverNodePath(folder)
                            }}
                            onDragLeave={() => {
                              if (dragOverNodePath === folder) setDragOverNodePath(null)
                            }}
                            onDrop={(e) => {
                              e.preventDefault()
                              const dragged = fields.find(f => f.id === draggingId)
                              if (dragged) {
                                handleMoveFieldToFolder(dragged, folder)
                              }
                              setDraggingId(null)
                              setDragOverNodePath(null)
                            }}
                            className={`group relative flex items-center justify-between p-4 rounded-2xl border bg-white/40 dark:bg-black/20 hover:bg-white/60 dark:hover:bg-black/35 hover:border-black/10 dark:hover:border-white/10 shadow-sm transition-all duration-200 cursor-pointer select-none ${
                              isDragOver
                                ? "ring-2 ring-blue-500 border-blue-500/50 bg-blue-500/5 dark:bg-blue-500/10 scale-[1.02]"
                                : "border-black/5 dark:border-white/5"
                            }`}
                          >
                            <div className="flex items-center gap-3.5 min-w-0">
                              <div className="p-2.5 rounded-xl bg-blue-500/10 dark:bg-blue-500/20 text-blue-500 dark:text-blue-400 shrink-0">
                                <Folder className="w-4 h-4" />
                              </div>
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-zinc-900 dark:text-white truncate">{folder}</div>
                                <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-medium">{count} {count === 1 ? "field" : "fields"}</div>
                              </div>
                            </div>
                            
                            {/* Actions (reveal on hover) */}
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openRenameFolder(folder)
                                }}
                                className="p-1.5 hover:bg-zinc-100 dark:hover:bg-white/5 rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
                                title="Rename folder"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  deleteFolder(folder)
                                }}
                                className="p-1.5 hover:bg-rose-500/10 rounded text-zinc-500 hover:text-rose-600"
                                title="Delete folder"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Fields Table Section */}
                <div className="p-0">
                  {/* Section Title if in Root/All view */}
                  {folderFilter === "all" && !searchQuery && (
                    <div className="px-6 pt-6 pb-2 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
                      Uncategorized Fields ({filteredFields.length})
                    </div>
                  )}

                  {filteredFields.length === 0 ? (
                    <div className="p-16 text-center border-t border-transparent">
                      <Database className="h-10 w-10 text-zinc-300 dark:text-zinc-600 mx-auto mb-3" />
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-white mb-1">
                        {searchQuery ? "No matching fields" : "No fields in this directory"}
                      </h3>
                      <p className="text-zinc-500 dark:text-zinc-400 text-xs max-w-sm mx-auto mb-4">
                        {searchQuery 
                          ? "Try searching for a different field name, key, or merge tag."
                          : "Create fields here to store lead details like policy type, renewal date, or quote amount."}
                      </p>
                      {!searchQuery && (
                        <Button 
                          onClick={openCreate}
                          variant="default"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          Create Field
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-8" />
                          <TableHead>Field name</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Key (copy as merge tag)</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Used in</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredFields.map(f => {
                          const isDragging = draggingId === f.id
                          const isDragOver = dragOverId === f.id && draggingId && draggingId !== f.id
                          const draggedField = draggingId ? fields.find(x => x.id === draggingId) : null
                          const sameFolder = draggedField && (draggedField.folder || "") === (f.folder || "")
                          const dropAllowed = isDragOver && sameFolder
                          const typeDisplay = getCustomFieldTypeDisplay(f.type)
                          const usage = getCustomFieldUsageSummary(f, usageSources)
                          return (
                            <TableRow
                              key={f.id}
                              draggable={!reordering}
                              onDragStart={(e) => {
                                setDraggingId(f.id)
                                try { e.dataTransfer.setData("text/plain", f.id) } catch {}
                                e.dataTransfer.effectAllowed = "move"
                              }}
                              onDragOver={(e) => {
                                if (draggedField && (draggedField.folder || "") === (f.folder || "")) {
                                  e.preventDefault()
                                  e.dataTransfer.dropEffect = "move"
                                  if (dragOverId !== f.id) setDragOverId(f.id)
                                }
                              }}
                              onDragLeave={() => { if (dragOverId === f.id) setDragOverId(null) }}
                              onDrop={(e) => { e.preventDefault(); handleDrop(f.id, f.folder || "") }}
                              onDragEnd={() => { setDraggingId(null); setDragOverId(null) }}
                              className={`${isDragging ? "opacity-40" : ""} ${dropAllowed ? "outline outline-2 outline-blue-500/60 -outline-offset-2" : ""}`}
                            >
                              <TableCell className="w-8 cursor-grab active:cursor-grabbing text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Drag to reorder">
                                <GripVertical className="w-4 h-4" />
                              </TableCell>
                              <TableCell>
                                <div className="font-semibold text-zinc-800 dark:text-gray-200 flex items-center gap-2">
                                  <span>{f.label}</span>
                                  {searchQuery && f.folder && (
                                    <Badge variant="info" size="sm" className="uppercase tracking-wider">
                                      {f.folder}
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                                  {f.description || "No description yet."}
                                </div>
                              </TableCell>
                              <TableCell className="text-xs">
                                <Badge variant="neutral" size="sm">
                                  {typeDisplay.label}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <button
                                  type="button"
                                  onClick={() => copyKey(f.key)}
                                  className="font-mono text-xs text-zinc-700 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1"
                                  title="Copy as merge tag"
                                  aria-label={`Copy merge tag for ${f.label}`}
                                >
                                  <span>{getCustomFieldMergeTag(f)}</span>
                                  {copiedKey === f.key ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 opacity-60" />}
                                </button>
                                <div className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-1">Key: <span className="font-mono">{f.key}</span></div>
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-col gap-1">
                                  <span className={`w-fit px-2 py-0.5 rounded-full border text-[10px] font-semibold ${
                                    f.required
                                      ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30"
                                      : "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 border-zinc-500/20"
                                  }`}>
                                    {f.required ? "Required" : "Optional"}
                                  </span>
                                  <span className={`w-fit px-2 py-0.5 rounded-full border text-[10px] font-semibold ${
                                    f.active === false
                                      ? "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/20"
                                      : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                                  }`}>
                                    {f.active === false ? "Inactive" : "Active"}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell className="text-xs text-zinc-600 dark:text-zinc-300">
                                <span title={usage.detail}>{usage.checked ? usage.label : "—"}</span>
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex justify-end gap-1">
                                  <button onClick={() => openEdit(f)} className="p-1.5 hover:bg-zinc-100 dark:hover:bg-white/5 rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-white" title="Edit" aria-label={`Edit ${f.label}`}><Edit2 className="w-3.5 h-3.5" /></button>
                                  <button onClick={() => handleDelete(f)} className="p-1.5 hover:bg-rose-500/10 rounded text-zinc-500 hover:text-rose-600" title="Delete" aria-label={`Delete ${f.label}`}><Trash2 className="w-3.5 h-3.5" /></button>
                                </div>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {reordering && (
          <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 text-white text-xs shadow-lg">
            <Loader2 className="w-3 h-3 animate-spin" /> Saving order…
          </div>
        )}

        {/* Reference hint */}
        <div className="p-4 rounded-xl bg-blue-500/[0.04] border border-blue-500/20 text-xs text-zinc-600 dark:text-zinc-300 space-y-1.5">
          <div className="font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5" /> How to reference custom fields
          </div>
          <div><b>In templates:</b> <span className="font-mono">{`Hi {{first_name}}, your {{coverage_type}} is ready.`}</span></div>
          <div><b>In journey conditions:</b> choose a custom field and reference <span className="font-mono">custom.coverage_type</span></div>
          <div><b>In webhook mappings:</b> map incoming fields to the same custom field key.</div>
          <div><b>In request bodies:</b> <span className="font-mono">{`{ "coverage": "{{coverage_type}}" }`}</span></div>
        </div>
      </motion.div>

      {/* Create / Edit modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="absolute inset-0" onClick={() => !saving && setShowModal(false)} />
          <div className="relative w-full max-w-2xl bg-white dark:bg-surface-1 border border-black/10 dark:border-white/10 rounded-2xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-zinc-900 dark:text-white">
                {form.id ? `Edit custom field` : "Create a custom field"}
              </h2>
              <button onClick={() => setShowModal(false)} disabled={saving} className="text-zinc-400 hover:text-zinc-900 dark:hover:text-white p-1" aria-label="Close custom field modal">
                <X className="w-5 h-5" />
              </button>
            </div>

            {formError && (
              <Alert variant="danger" className="mb-4">{formError}</Alert>
            )}

            {form.id && (
              <Alert variant="warning" size="sm" icon={false} title="Before editing" className="mb-4">
                This field can be used in templates, journey conditions, webhook mappings, and lead profiles.
                {getCustomFieldUsageSummary(form, usageSources).checked
                  ? ` ${getCustomFieldUsageSummary(form, usageSources).detail}`
                  : " Usage has not been fully checked."}
              </Alert>
            )}

            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Field name *</Label>
                  <Input
                    required
                    placeholder="Company size"
                    value={form.label}
                    onChange={(e) => handleLabelChange(e.target.value)}
                    className="h-9 text-sm bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 rounded-xl"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs flex items-center gap-1.5">
                    Key
                    <span title="System identifier. Used as {{key}} in templates and custom.key in conditions. Immutable after creation." className="cursor-help text-zinc-400">
                      <Info className="w-3 h-3" />
                    </span>
                  </Label>
                  <Input
                    disabled={!!form.id}
                    placeholder="company_size"
                    value={form.key}
                    onChange={(e) => {
                      setKeyManuallyEdited(true)
                      setForm({ ...form, key: slugify(e.target.value) })
                    }}
                    className="h-9 text-sm bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 rounded-xl font-mono disabled:opacity-50"
                  />
                  <p className="text-[10px] text-zinc-400">{form.id ? "Locked. Create a new field if you need to rename." : "Auto-generated from name. Edit if you want something specific."}</p>
                  <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    {form.id
                      ? "Key is stable after creation to avoid breaking references."
                      : "Changing the key later is not supported because templates and journeys may reference it."}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Field type *</Label>
                  <CustomSelect
                    value={form.type}
                    onChange={(val) => setForm({ ...form, type: val })}
                    options={FIELD_TYPES.map(t => ({ value: t.id, label: t.label }))}
                    triggerClassName="w-full h-9 px-3 text-sm bg-white dark:bg-surface-3 border border-black/10 dark:border-white/10 rounded-xl outline-none text-zinc-900 dark:text-white flex items-center justify-between cursor-pointer"
                    align="left"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Folder</Label>
                  {addingNewFolder ? (
                    <div className="flex gap-1.5">
                      <Input
                        autoFocus
                        placeholder="New folder name"
                        value={newFolderInline}
                        onChange={(e) => setNewFolderInline(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            const trimmed = newFolderInline.trim()
                            if (trimmed) {
                              setForm({ ...form, folder: trimmed })
                              setAddingNewFolder(false)
                              setNewFolderInline("")
                            }
                          }
                        }}
                        className="h-9 text-sm bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 rounded-xl"
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          const trimmed = newFolderInline.trim()
                          if (trimmed) {
                            setForm({ ...form, folder: trimmed })
                            setAddingNewFolder(false)
                            setNewFolderInline("")
                          }
                        }}
                        className="h-9 rounded-xl"
                      >Use</Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => { setAddingNewFolder(false); setNewFolderInline("") }}
                        className="h-9 rounded-xl"
                      >Cancel</Button>
                    </div>
                  ) : (
                    <CustomSelect
                      value={form.folder || ""}
                      onChange={(val) => {
                        if (val === "__new__") {
                          setAddingNewFolder(true)
                          setNewFolderInline("")
                        } else {
                          setForm({ ...form, folder: val })
                        }
                      }}
                      options={[
                        { value: "", label: "— No folder (Uncategorized) —" },
                        ...folders.map(f => ({ value: f, label: f })),
                        ...(form.folder && !folders.includes(form.folder) ? [{ value: form.folder, label: `${form.folder} (unsaved)` }] : []),
                        { value: "__new__", label: "＋ Create new folder…" }
                      ]}
                      triggerClassName="w-full h-9 px-3 text-sm bg-white dark:bg-surface-3 border border-black/10 dark:border-white/10 rounded-xl outline-none text-zinc-900 dark:text-white flex items-center justify-between cursor-pointer"
                      align="left"
                    />
                  )}
                  <p className="text-[10px] text-zinc-400 font-sans">Pick an existing folder or create a new one inline.</p>
                </div>
              </div>

              {NEEDS_OPTIONS.has(form.type) && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Options *<span className="text-zinc-400 font-normal"> (one per line)</span></Label>
                  <textarea
                    rows={4}
                    placeholder="Small\nMedium\nLarge\nEnterprise"
                    value={optionsText}
                    onChange={(e) => setOptionsText(e.target.value)}
                    className="w-full p-3 text-sm bg-white dark:bg-surface-3 border border-black/10 dark:border-white/10 rounded-xl font-mono"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label className="text-xs">Description</Label>
                <Input
                  placeholder="What this field represents"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="h-9 text-sm bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 rounded-xl"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Placeholder</Label>
                  <Input
                    placeholder="Type here…"
                    value={form.placeholder}
                    onChange={(e) => setForm({ ...form, placeholder: e.target.value })}
                    className="h-9 text-sm bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 rounded-xl"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Default value</Label>
                  <Input
                    placeholder=""
                    value={typeof form.default_value === "object" ? "" : (form.default_value ?? "")}
                    onChange={(e) => setForm({ ...form, default_value: e.target.value })}
                    className="h-9 text-sm bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 rounded-xl"
                  />
                </div>
              </div>

              <div className="flex gap-6">
                <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.required}
                    onChange={(e) => setForm({ ...form, required: e.target.checked })}
                    className="w-4 h-4 rounded border-black/15 dark:border-white/10 bg-white dark:bg-surface-3 text-zinc-900 dark:text-white accent-zinc-900 dark:accent-white focus:ring-0 focus:ring-offset-0 cursor-pointer"
                  />
                  Required
                </label>
                <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.active}
                    onChange={(e) => setForm({ ...form, active: e.target.checked })}
                    className="w-4 h-4 rounded border-black/15 dark:border-white/10 bg-white dark:bg-surface-3 text-zinc-900 dark:text-white accent-zinc-900 dark:accent-white focus:ring-0 focus:ring-offset-0 cursor-pointer"
                  />
                  Active
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-black/5 dark:border-white/5">
                <Button type="button" variant="outline" onClick={() => setShowModal(false)} disabled={saving}>Cancel</Button>
                <Button type="submit" disabled={saving} variant="default">
                  {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> {form.id ? "Save changes" : "Create field"}</>}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create / Rename folder modal */}
      {showFolderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="absolute inset-0" onClick={() => !savingFolder && setShowFolderModal(false)} />
          <div className="relative w-full max-w-md bg-white dark:bg-surface-1 border border-black/10 dark:border-white/10 rounded-2xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
                <FolderPlus className="w-5 h-5" /> {folderForm.originalName ? "Rename folder" : "Create folder"}
              </h2>
              <button onClick={() => setShowFolderModal(false)} disabled={savingFolder} className="text-zinc-400 hover:text-zinc-900 dark:hover:text-white p-1" aria-label="Close folder modal">
                <X className="w-5 h-5" />
              </button>
            </div>

            {folderError && (
              <Alert variant="danger" className="mb-4">{folderError}</Alert>
            )}

            <form onSubmit={saveFolder} className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Folder name *</Label>
                <Input
                  autoFocus
                  required
                  placeholder="Company info"
                  value={folderForm.name}
                  onChange={(e) => setFolderForm({ ...folderForm, name: e.target.value })}
                  className="h-9 text-sm bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 rounded-xl"
                />
                {folderForm.originalName && (
                  <p className="text-[10px] text-zinc-400">
                    Renaming "{folderForm.originalName}" also updates every field currently in that folder.
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-black/5 dark:border-white/5">
                <Button type="button" variant="outline" onClick={() => setShowFolderModal(false)} disabled={savingFolder}>Cancel</Button>
                <Button type="submit" disabled={savingFolder} variant="default">
                  {savingFolder ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> {folderForm.originalName ? "Save" : "Create"}</>}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
