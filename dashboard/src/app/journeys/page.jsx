"use client"

import React, { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import { 
  GitFork, Plus, Edit2, Trash2, ToggleLeft, ToggleRight, Copy,
  Loader2, Play, Pause, AlertCircle, Info, Calendar, Search, Sparkles,
  ChevronDown, ChevronRight, ChevronLeft, Folder, FolderPlus, X, GripVertical
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { AppIcon } from "@/components/AppIcon"
import { getCachedData, setCachedData } from "@/utils/apiCache"
import { useToast } from "@/components/ui/toast"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { usePrompt } from "@/components/ui/prompt-dialog"
import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import CustomSelect from "@/components/ui/custom-select"
import { getStatusPillClass } from "@/lib/statusDisplay"
import { apiFetch } from "@/utils/apiFetch"

// Helper to build recursive folder tree from flat list of folder paths
function buildFolderTree(foldersList) {
  const root = { name: "Root", path: "", children: [] };
  const sorted = [...foldersList].sort((a, b) => a.localeCompare(b));
  const map = { "": root };
  
  for (const path of sorted) {
    const parts = path.split('/');
    let currentPath = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      
      if (!map[currentPath]) {
        const node = { name: part, path: currentPath, children: [] };
        map[currentPath] = node;
        
        const parentNode = map[parentPath];
        if (parentNode) {
          parentNode.children.push(node);
        }
      }
    }
  }
  
  return root.children;
}

function getJourneyListStatusDisplay(journey) {
  const rawStatus = String(journey?.spec?.status || "").toLowerCase()
  if (rawStatus === "archived" || journey?.archived) {
    return { label: "Archived", variant: "neutral", title: "This journey is archived." }
  }
  if (rawStatus === "paused") {
    return { label: "Paused", variant: "warning", title: "This journey is paused." }
  }
  if (journey?.active === true) {
    return { label: "Active", variant: "success", title: "This journey is available for active follow-up." }
  }
  if (journey?.active === false) {
    return { label: "Draft", variant: "neutral", title: "This journey is saved but not active." }
  }
  return { label: "Unknown", variant: "neutral", title: "Journey status is not available." }
}

function metricValue(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : "—"
}

function formatLastActivity(value) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default function JourneysPage() {
  const router = useRouter()
  const { pushToast } = useToast()
  const confirm = useConfirm()
  const prompt = usePrompt()
  const [journeys, setJourneys] = useState(() => getCachedData("journeys_list") || [])
  const [folders, setFolders] = useState(() => getCachedData("journeys_folders") || [])
  const [loading, setLoading] = useState(() => !getCachedData("journeys_list"))
  const [searchQuery, setSearchQuery] = useState("")
  
  // Unified folder explorer navigation state
  const [currentFolderPath, setCurrentFolderPath] = useState("")
  
  // Folder CRUD modal states
  const [showFolderModal, setShowFolderModal] = useState(false)
  const [folderForm, setFolderForm] = useState({ name: "", parentPath: "", originalPath: "", mode: "create" })
  const [folderError, setFolderError] = useState("")
  const [savingFolder, setSavingFolder] = useState(false)

  // Move journey states
  const [showMoveModal, setShowMoveModal] = useState(false)
  const [journeyToMove, setJourneyToMove] = useState(null)
  const [targetFolderForMove, setTargetFolderForMove] = useState("")

  // Drag and drop states
  const [draggingJourneyId, setDraggingJourneyId] = useState(null)
  const [dragOverNodePath, setDragOverNodePath] = useState(null)
  const [draggableJourneyId, setDraggableJourneyId] = useState(null)

  // Delete modal state
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [journeyToDelete, setJourneyToDelete] = useState(null)

  // Listen to cross-tab cache sync events
  useEffect(() => {
    const handleCacheUpdated = (e) => {
      const { key, data } = e.detail || {}
      if (key === "journeys_list") {
        setJourneys(data)
        setLoading(false)
      } else if (key === "journeys_folders") {
        setFolders(data)
      }
    }

    window.addEventListener("api-cache-updated", handleCacheUpdated)

    return () => {
      window.removeEventListener("api-cache-updated", handleCacheUpdated)
    }
  }, [])

  useEffect(() => {
    const hasCache = !!getCachedData("journeys_list")
    fetchJourneys(hasCache)
    fetchFolders()
  }, [])

  const fetchJourneys = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const data = await apiFetch("/api/journeys?include_inactive=1&include_metrics=1")
      setJourneys(data.data || [])
      setCachedData("journeys_list", data.data || [])
    } catch (err) {
      console.error("Failed to load journeys:", err)
      pushToast("error", err.message || "Failed to load journeys")
    } finally {
      setLoading(false)
    }
  }

  const fetchFolders = async () => {
    try {
      const json = await apiFetch("/api/journeys/folders")
      setFolders(json.data?.folders || [])
      setCachedData("journeys_folders", json.data?.folders || [])
    } catch (err) {
      console.error("Failed to load folders:", err)
    }
  }

  const handleToggleActive = async (journey) => {
    try {
      await apiFetch("/api/journeys", { method: "PUT", json: { id: journey.id, active: !journey.active } })
      {
        setJourneys(journeys.map(j => j.id === journey.id ? { ...j, active: !j.active } : j))
      }
    } catch (err) {
      console.error("Failed to update active state:", err)
      pushToast("error", err.message || "Failed to update journey")
    }
  }

  // PHASE6: pause holds the journey's running sends and blocks new
  // enrollments; waits/internal steps continue. Unpausing is one click.
  const handleTogglePause = async (journey) => {
    try {
      await apiFetch("/api/journeys", { method: "PUT", json: { id: journey.id, paused: !journey.paused } })
      {
        setJourneys(journeys.map(j => j.id === journey.id ? { ...j, paused: !j.paused } : j))
      }
    } catch (err) {
      console.error("Failed to update paused state:", err)
    }
  }

  const handleDeleteClick = (journey) => {
    setJourneyToDelete(journey)
    setIsDeleteOpen(true)
  }

  const confirmDelete = async () => {
    if (!journeyToDelete) return
    try {
      await apiFetch(`/api/journeys?id=${journeyToDelete.id}`, { method: "DELETE" })
      {
        setJourneys(journeys.filter(j => j.id !== journeyToDelete.id))
        setIsDeleteOpen(false)
        setJourneyToDelete(null)
        fetchFolders() // count updates
      }
    } catch (err) {
      console.error("Failed to delete journey:", err)
      pushToast("error", err.message || "Failed to delete journey")
    }
  }

  // Folder actions
  const openCreateFolder = (parentPath = null) => {
    setFolderForm({
      name: "",
      parentPath: parentPath || "",
      originalPath: "",
      mode: parentPath ? "subfolder" : "create"
    })
    setFolderError("")
    setShowFolderModal(true)
  }

  const openRenameFolder = (path) => {
    const parts = path.split('/')
    const name = parts[parts.length - 1]
    setFolderForm({
      name,
      parentPath: "",
      originalPath: path,
      mode: "rename"
    })
    setFolderError("")
    setShowFolderModal(true)
  }

  const handleDeleteFolder = async (path) => {
    const count = journeys.filter(j => 
      j.spec?.folder === path || 
      (j.spec?.folder && j.spec.folder.startsWith(path + "/"))
    ).length

    const msg = count > 0
      ? `${count} journey(s) inside this folder (and its subfolders) will move to Uncategorized — they will NOT be deleted.`
      : "This cannot be undone."

    if (!(await confirm({
      title: `Delete folder "${path}"?`,
      message: msg,
      confirmLabel: "Delete folder",
      destructive: true,
    }))) return

    try {
      const ok = await apiFetch(`/api/journeys/folders?name=${encodeURIComponent(path)}`, { method: "DELETE" })
        .then(() => true)
        .catch((err) => { pushToast("error", err.message || "Failed to delete folder"); return false })
      if (ok) {
        if (currentFolderPath === path || currentFolderPath.startsWith(path + "/")) {
          setCurrentFolderPath("")
        }
        fetchFolders()
        fetchJourneys()
      }
    } catch (err) {
      console.error("Failed to delete folder:", err)
    }
  }

  const saveFolder = async (e) => {
    e.preventDefault()
    const trimmed = folderForm.name.trim()
    if (!trimmed) { setFolderError("Folder name is required"); return }
    if (trimmed.includes('/')) { setFolderError("Folder name cannot contain '/' character"); return }

    let finalName = trimmed
    if (folderForm.mode === "subfolder" && folderForm.parentPath) {
      finalName = `${folderForm.parentPath}/${trimmed}`
    }

    setSavingFolder(true)
    setFolderError("")
    try {
      if (folderForm.mode === "rename") {
        try {
          await apiFetch("/api/journeys/folders", { method: "PUT", json: { from: folderForm.originalPath, to: finalName } })
        } catch (err) {
          setFolderError(err.message || "Failed to rename folder"); return
        }
        
        if (currentFolderPath === folderForm.originalPath) {
          setCurrentFolderPath(finalName)
        } else if (currentFolderPath.startsWith(folderForm.originalPath + "/")) {
          setCurrentFolderPath(finalName + currentFolderPath.slice(folderForm.originalPath.length))
        }
      } else {
        try {
          await apiFetch("/api/journeys/folders", { json: { name: finalName } })
        } catch (err) {
          setFolderError(err.message || "Failed to create folder"); return
        }
      }
      
      setShowFolderModal(false)
      fetchFolders()
      fetchJourneys()
    } catch (err) {
      setFolderError(err.message || "An error occurred")
    } finally {
      setSavingFolder(false)
    }
  }

  // Move journey / Drag & Drop
  const handleMoveJourney = async (journeyId, newFolder) => {
    try {
      const journey = journeys.find(j => j.id === journeyId)
      if (!journey) return
      
      const updatedSpec = { ...(journey.spec || {}), folder: newFolder }
      if (!newFolder) {
        delete updatedSpec.folder
      }
      
      await apiFetch("/api/journeys", { method: "PUT", json: { id: journeyId, spec: updatedSpec } })
      fetchJourneys()
      fetchFolders()
    } catch (err) {
      console.error("Failed to move journey:", err)
      pushToast("error", err.message || "Failed to move journey")
    }
  }

  const handleDropJourney = (journeyId, targetFolder) => {
    if (!journeyId) return
    handleMoveJourney(journeyId, targetFolder)
  }

  const openMoveModal = (journey) => {
    setJourneyToMove(journey)
    setTargetFolderForMove(journey.spec?.folder || "")
    setShowMoveModal(true)
  }

  const confirmMoveJourney = async () => {
    if (!journeyToMove) return
    const dest = targetFolderForMove || null
    await handleMoveJourney(journeyToMove.id, dest)
    setShowMoveModal(false)
    setJourneyToMove(null)
  }

  // Filter Journeys for list/table view
  const filteredJourneys = journeys.filter(j => {
    const matchesSearch = searchQuery
      ? ((j.name || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
         (j.journey_key || "").toLowerCase().includes(searchQuery.toLowerCase()))
      : true
      
    if (!matchesSearch) return false

    // If a search query is active, bypass directory nesting to show all matches flat
    if (searchQuery) return true

    // Otherwise, show only journeys in the current directory level
    if (currentFolderPath === "") return !j.spec?.folder
    return j.spec?.folder === currentFolderPath
  })

  // Get folders in the current directory level
  const getImmediateFolders = () => {
    if (currentFolderPath === "") {
      // Root level folders: no "/" in their path
      return folders.filter(f => !f.includes('/'))
    } else {
      // Subfolders: start with `${currentFolderPath}/` and have no additional "/" after
      const prefix = `${currentFolderPath}/`
      return folders.filter(f => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
    }
  }

  return (
    <div className="space-y-6">
      {/* Header Panel */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-zinc-900 to-zinc-600 dark:from-white dark:to-zinc-400 bg-clip-text text-transparent flex items-center gap-2">
            <AppIcon name="journeys" size={32} className="text-zinc-600 dark:text-zinc-400" />
            Journeys
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400 mt-1">
            Build and monitor automated follow-up journeys across calls, SMS, email, and AI replies.
          </p>
        </div>
        <Button 
          onClick={() => router.push("/journeys/builder")}
          variant="default"
        >
          <Plus className="w-4 h-4" />
          Create Journey
        </Button>
      </div>      {/* Unified Folder Explorer Card */}
      <Card className="border border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20 backdrop-blur-md rounded-2xl overflow-hidden shadow-xl">
        {/* Path bar & Explorer Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-black/5 dark:border-white/5 pb-4 px-6 pt-5 bg-zinc-50/20 dark:bg-black/10 gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            {currentFolderPath !== "" && (
              <button
                onClick={() => {
                  const parts = currentFolderPath.split('/')
                  const parent = parts.slice(0, -1).join('/')
                  setCurrentFolderPath(parent)
                }}
                className="p-1.5 rounded-xl bg-zinc-950/5 hover:bg-zinc-950/10 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-all active:scale-95 border border-black/5 dark:border-white/5 shrink-0"
                title="Go back"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            <div className="flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400 truncate font-medium">
              <span
                onDragOver={(e) => {
                  e.preventDefault()
                  if (draggingJourneyId) setDragOverNodePath("")
                }}
                onDragLeave={() => setDragOverNodePath(null)}
                onDrop={(e) => {
                  e.preventDefault()
                  handleDropJourney(draggingJourneyId, "")
                }}
                onClick={() => setCurrentFolderPath("")}
                className={`cursor-pointer transition-all px-2 py-0.5 rounded-lg border leading-tight ${
                  dragOverNodePath === ""
                    ? "bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400 scale-[1.02]"
                    : currentFolderPath === ""
                    ? "text-zinc-900 dark:text-white border-transparent"
                    : "hover:text-zinc-800 dark:hover:text-white border-transparent hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                Root
              </span>
              {currentFolderPath !== "" && currentFolderPath.split('/').map((part, index, arr) => {
                const path = arr.slice(0, index + 1).join('/')
                const isDragOver = dragOverNodePath === path
                const isLast = index === arr.length - 1
                return (
                  <React.Fragment key={path}>
                    <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                    <span
                      onDragOver={(e) => {
                        e.preventDefault()
                        if (draggingJourneyId) setDragOverNodePath(path)
                      }}
                      onDragLeave={() => setDragOverNodePath(null)}
                      onDrop={(e) => {
                        e.preventDefault()
                        handleDropJourney(draggingJourneyId, path)
                      }}
                      onClick={() => setCurrentFolderPath(path)}
                      className={`cursor-pointer transition-all px-2 py-0.5 rounded-lg border truncate leading-tight ${
                        isDragOver
                          ? "bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400 scale-[1.02]"
                          : isLast
                          ? "font-semibold text-zinc-900 dark:text-white border-transparent"
                          : "hover:text-zinc-800 dark:hover:text-white border-transparent hover:bg-black/5 dark:hover:bg-white/5"
                      }`}
                    >
                      {part}
                    </span>
                  </React.Fragment>
                )
              })}
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0 ml-auto sm:ml-0">
            <div className="relative w-48 sm:w-56 md:w-64">
              <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-400" />
              <Input
                placeholder="Search all journeys..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 text-xs h-8.5 rounded-xl w-full text-zinc-900 dark:text-white focus-visible:ring-1 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20"
              />
            </div>
            {!searchQuery && (
              <Button
                onClick={() => openCreateFolder(currentFolderPath || null)}
                variant="outline"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                <span>New Folder</span>
              </Button>
            )}
          </div>
        </div>

        {/* Explorer Content */}
        <CardContent className="p-0">
          {loading && journeys.length === 0 ? (
            <div className="p-20 flex flex-col items-center justify-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">Loading journeys...</p>
            </div>
          ) : (
            (() => {
              const immediateFolders = searchQuery ? [] : getImmediateFolders()
              const showEmptyState = immediateFolders.length === 0 && filteredJourneys.length === 0

              if (showEmptyState) {
                const isGlobalEmpty = journeys.length === 0 && folders.length === 0 && !searchQuery
                return (
                  <div className="p-16 text-center border border-dashed border-black/10 dark:border-white/10 rounded-2xl m-6 bg-zinc-50/5 dark:bg-black/5 animate-fade-in">
                    <Folder className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
                    <h3 className="text-base font-semibold text-zinc-900 dark:text-white mb-1">
                      {isGlobalEmpty ? "No journeys yet" : "This folder is empty"}
                    </h3>
                    <p className="text-zinc-500 dark:text-zinc-400 text-xs max-w-sm mx-auto mb-6">
                      {isGlobalEmpty
                        ? "No journeys yet. Create your first follow-up journey to start automating calls, SMS, email, and AI replies."
                        : "No subfolders or journeys are inside this directory. Create one to get started."}
                    </p>
                    <div className="flex items-center justify-center gap-3">
                      <Button 
                        onClick={() => openCreateFolder(currentFolderPath || null)}
                        variant="outline"
                      >
                        <FolderPlus className="w-3.5 h-3.5" />
                        Create Subfolder
                      </Button>
                      <Button 
                        onClick={() => router.push("/journeys/builder")}
                        variant="default"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Create Journey
                      </Button>
                    </div>
                  </div>
                )
              }

              return (
                <div className="flex flex-col">
                  {/* Folders Grid Section */}
                  {immediateFolders.length > 0 && (
                    <div className="p-6 border-b border-black/5 dark:border-white/5 bg-zinc-50/[0.01] dark:bg-white/[0.003]">
                      <div className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3">Folders</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        {immediateFolders.map(folderPath => {
                          const folderName = folderPath.split('/').pop()
                          const recursiveCount = journeys.filter(j => 
                            j.spec?.folder === folderPath || 
                            (j.spec?.folder && j.spec.folder.startsWith(folderPath + "/"))
                          ).length
                          const isDragOver = dragOverNodePath === folderPath

                          return (
                            <div
                              key={folderPath}
                              onDragOver={(e) => {
                                e.preventDefault()
                                if (draggingJourneyId) setDragOverNodePath(folderPath)
                              }}
                              onDragLeave={() => {
                                if (dragOverNodePath === folderPath) setDragOverNodePath(null)
                              }}
                              onDrop={(e) => {
                                e.preventDefault()
                                handleDropJourney(draggingJourneyId, folderPath)
                              }}
                              onClick={() => {
                                setCurrentFolderPath(folderPath)
                                setDragOverNodePath(null)
                              }}
                              className={`group relative flex items-center gap-3.5 p-4 rounded-2xl border bg-white/40 dark:bg-black/20 hover:bg-white/60 dark:hover:bg-black/35 hover:border-black/10 dark:hover:border-white/10 shadow-sm transition-all duration-200 cursor-pointer select-none ${
                                isDragOver
                                  ? "ring-2 ring-blue-500 border-blue-500/50 bg-blue-500/5 dark:bg-blue-500/10 scale-[1.02]"
                                  : "border-black/5 dark:border-white/5"
                              }`}
                            >
                              <div className="p-2.5 rounded-xl bg-sky-500/10 dark:bg-sky-500/20 text-sky-500 dark:text-sky-400 shrink-0">
                                <Folder className="w-5 h-5 fill-sky-500/10" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <h3 className="font-semibold text-xs text-zinc-900 dark:text-white truncate leading-snug">
                                  {folderName}
                                </h3>
                                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono mt-0.5">
                                  {recursiveCount} {recursiveCount === 1 ? "journey" : "journeys"}
                                </p>
                              </div>

                              {/* Hover actions */}
                              <div className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity duration-150 shrink-0">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openCreateFolder(folderPath)
                                  }}
                                  className="p-1 hover:bg-black/5 dark:hover:bg-white/10 rounded text-zinc-400 hover:text-zinc-950 dark:hover:text-white"
                                  title="Add subfolder"
                                >
                                  <FolderPlus className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openRenameFolder(folderPath)
                                  }}
                                  className="p-1 hover:bg-black/5 dark:hover:bg-white/10 rounded text-zinc-400 hover:text-zinc-950 dark:hover:text-white"
                                  title="Rename folder"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleDeleteFolder(folderPath)
                                  }}
                                  className="p-1 hover:bg-red-500/10 rounded text-zinc-400 hover:text-red-600"
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

                  {/* Journeys List Section */}
                  {filteredJourneys.length > 0 && (
                    <div className="p-6">
                      {!searchQuery && immediateFolders.length > 0 && (
                        <div className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3">Journeys</div>
                      )}
                      {searchQuery && (
                        <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-3 px-1">
                          Search results: {filteredJourneys.length} match{filteredJourneys.length === 1 ? "" : "es"} found
                        </div>
                      )}

                      <div className="border border-black/5 dark:border-white/5 rounded-2xl overflow-x-auto bg-white/30 dark:bg-black/10">
                        <Table>
                          <TableHeader className="bg-zinc-50/50 dark:bg-white/5 border-b border-black/5 dark:border-white/5">
                            <TableRow>
                              <TableHead className="w-8 pl-4 pr-0"></TableHead>
                              <TableHead className="font-semibold text-zinc-900 dark:text-white py-3 pl-3 min-w-[260px]">Journey</TableHead>
                              <TableHead className="font-semibold text-zinc-900 dark:text-white py-3">Status</TableHead>
                              <TableHead className="font-semibold text-zinc-900 dark:text-white py-3 text-right">Running leads</TableHead>
                              <TableHead className="font-semibold text-zinc-900 dark:text-white py-3 text-right">Replies</TableHead>
                              <TableHead className="font-semibold text-zinc-900 dark:text-white py-3 text-right">Issues</TableHead>
                              <TableHead className="font-semibold text-zinc-900 dark:text-white py-3">Last activity</TableHead>
                              <TableHead className="font-semibold text-zinc-900 dark:text-white py-3">Steps</TableHead>
                              <TableHead className="font-semibold text-zinc-900 dark:text-white py-3 pr-6 text-right">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {filteredJourneys.map((journey) => {
                              const steps = journey.spec?.steps || []
                              const metrics = journey.metrics
                              const statusDisplay = getJourneyListStatusDisplay(journey)
                              return (
                                <TableRow 
                                  key={journey.id} 
                                  draggable={draggableJourneyId === journey.id}
                                  onDragStart={(e) => {
                                    setDraggingJourneyId(journey.id)
                                    try { e.dataTransfer.setData("text/plain", journey.id) } catch {}
                                    e.dataTransfer.effectAllowed = "move"
                                  }}
                                  onDragEnd={() => {
                                    setDraggingJourneyId(null)
                                    setDragOverNodePath(null)
                                  }}
                                  onClick={() => router.push(`/journeys/builder?id=${journey.id}`)}
                                  className={`border-b border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer ${draggingJourneyId === journey.id ? "opacity-40" : ""}`}
                                >
                                  <TableCell className="py-3.5 pl-4 pr-0 w-8">
                                    <div 
                                      onMouseEnter={() => setDraggableJourneyId(journey.id)}
                                      onMouseLeave={() => setDraggableJourneyId(null)}
                                      className="cursor-grab active:cursor-grabbing text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-400 p-1"
                                      title="Drag to move folder"
                                    >
                                      <GripVertical className="w-4 h-4" />
                                    </div>
                                  </TableCell>
                                  <TableCell className="font-medium text-zinc-900 dark:text-white py-3.5 pl-3">
                                    <div>
                                      <div className="font-semibold text-sm">{journey.name || journey.journey_key || "Untitled Journey"}</div>
                                      {journey.journey_key && (
                                        <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono mt-0.5">
                                          Key: {journey.journey_key}
                                        </div>
                                      )}
                                      {journey.spec?.folder ? (
                                        <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-normal mt-0.5 flex items-center gap-1.5">
                                          <Folder className="w-3 h-3 text-zinc-400 shrink-0" />
                                          <span className="truncate">{journey.spec.folder}</span>
                                        </div>
                                      ) : (
                                        <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-normal mt-0.5 flex items-center gap-1.5">
                                          <GitFork className="w-3 h-3 text-zinc-400 shrink-0" />
                                          <span>Root Directory</span>
                                        </div>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell className="py-3.5">
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleToggleActive(journey); }}
                                      className="focus:outline-none transition-transform active:scale-95"
                                      title={`${statusDisplay.title} Click to ${journey.active ? "pause" : "activate"} this journey.`}
                                    >
                                      <span className={getStatusPillClass(statusDisplay.variant, "text-xs")}>
                                        {journey.active ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5" />}
                                        {statusDisplay.label}
                                      </span>
                                    </button>
                                    {journey.draft_spec ? (
                                      <Badge
                                        variant="warning"
                                        className="ml-2"
                                        title={`Unpublished draft saved${journey.draft_updated_at ? ` ${new Date(journey.draft_updated_at).toLocaleString()}` : ""}. Publish to make it live.`}
                                      >
                                        Unpublished
                                      </Badge>
                                    ) : null}
                                    {journey.paused ? (
                                      <Badge
                                        variant="warning"
                                        className="ml-2"
                                        title="Sends are paused; waits/internal steps continue. New enrollments are blocked."
                                      >
                                        Paused
                                      </Badge>
                                    ) : null}
                                  </TableCell>
                                  <TableCell className="text-right text-zinc-700 dark:text-zinc-200 py-3.5 font-mono text-xs" title="Leads currently marked active in this journey.">
                                    {metrics ? metricValue(metrics.running_leads) : "—"}
                                  </TableCell>
                                  <TableCell className="text-right text-zinc-700 dark:text-zinc-200 py-3.5 font-mono text-xs" title="Current leads in this journey where a reply has been recorded.">
                                    {metrics ? metricValue(metrics.replied_leads) : "—"}
                                  </TableCell>
                                  <TableCell className="text-right py-3.5 font-mono text-xs" title="Failed outbound actions found for current leads in this journey.">
                                    <span className={metrics?.failed_actions > 0 ? "text-rose-600 dark:text-rose-400 font-semibold" : "text-zinc-700 dark:text-zinc-200"}>
                                      {metrics ? metricValue(metrics.failed_actions) : "—"}
                                    </span>
                                  </TableCell>
                                  <TableCell className="text-zinc-500 dark:text-zinc-400 py-3.5 text-xs" title="Most recent lead activity available for this journey.">
                                    {metrics ? formatLastActivity(metrics.last_activity_at) : "—"}
                                  </TableCell>
                                  <TableCell className="text-zinc-600 dark:text-zinc-300 py-3.5">
                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-100 dark:bg-white/10 text-zinc-800 dark:text-zinc-200">
                                      {steps.length} {steps.length === 1 ? 'Step' : 'Steps'}
                                    </span>
                                  </TableCell>
                                  <TableCell className="py-3.5 pr-6 text-right">
                                    <div className="flex items-center justify-end gap-1.5">
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => { e.stopPropagation(); handleTogglePause(journey); }}
                                        className="h-8 w-8 p-0 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-500/10 text-zinc-600 dark:text-zinc-300"
                                        title={journey.paused ? "Resume sends for this journey. Waits/internal steps continue regardless." : "Pause sends for this journey. Waits/internal steps continue. New enrollments are blocked."}
                                      >
                                        {journey.paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => { e.stopPropagation(); router.push(`/journeys/builder?id=${journey.id}`); }}
                                        className="h-8 w-8 p-0 rounded-lg hover:bg-zinc-100 dark:hover:bg-white/10 text-zinc-600 dark:text-zinc-300"
                                        title="Edit in Visual Builder"
                                      >
                                        <Edit2 className="w-4 h-4" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => { e.stopPropagation(); openMoveModal(journey); }}
                                        className="h-8 w-8 p-0 rounded-lg hover:bg-zinc-100 dark:hover:bg-white/10 text-zinc-600 dark:text-zinc-300"
                                        title="Move to Folder"
                                      >
                                        <Folder className="w-4 h-4" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={async (e) => {
                                          e.stopPropagation()
                                          const newName = await prompt({
                                            title: "Clone journey",
                                            message: "Name for the new copy:",
                                            defaultValue: `${journey.name} (copy)`,
                                            confirmLabel: "Create copy",
                                          })
                                          if (!newName) return
                                          let json
                                          try {
                                            json = await apiFetch(`/api/journeys/${journey.id}/clone`, { json: { name: newName } })
                                          } catch (err) {
                                            pushToast("error", err.message || "Clone failed"); return
                                          }
                                          router.push(`/journeys/builder?id=${json.data.id}`)
                                        }}
                                        className="h-8 w-8 p-0 rounded-lg hover:bg-zinc-100 dark:hover:bg-white/10 text-zinc-600 dark:text-zinc-300"
                                        title="Clone journey"
                                      >
                                        <Copy className="w-4 h-4" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => { e.stopPropagation(); handleDeleteClick(journey); }}
                                        className="h-8 w-8 p-0 rounded-lg hover:bg-red-500/10 text-red-500"
                                        title="Delete"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </Button>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                </div>
              )
            })()
          )}
        </CardContent>
      </Card>

      {/* Create / Rename / Subfolder modal */}
      <AnimatePresence>
        {showFolderModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !savingFolder && setShowFolderModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative w-full max-w-md bg-white dark:bg-zinc-900 border border-black/10 dark:border-white/10 rounded-2xl p-6 shadow-2xl space-y-4 z-10"
            >
              <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
                <h2 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
                  <FolderPlus className="w-5 h-5 text-zinc-400" />
                  {folderForm.mode === "rename" 
                    ? "Rename Folder" 
                    : folderForm.mode === "subfolder" 
                    ? "Create Subfolder" 
                    : "Create Folder"}
                </h2>
                <button 
                  onClick={() => setShowFolderModal(false)} 
                  disabled={savingFolder} 
                  className="text-zinc-400 hover:text-zinc-900 dark:hover:text-white p-1 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {folderError && (
                <Alert variant="danger">{folderError}</Alert>
              )}

              <form onSubmit={saveFolder} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500 font-medium block">
                    {folderForm.mode === "subfolder" 
                      ? `Subfolder Name (inside "${folderForm.parentPath}")` 
                      : "Folder Name"}
                  </label>
                  <Input
                    autoFocus
                    required
                    placeholder={folderForm.mode === "subfolder" ? "Inbound" : "Marketing"}
                    value={folderForm.name}
                    onChange={(e) => setFolderForm({ ...folderForm, name: e.target.value })}
                    className="h-9 text-sm bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-xl w-full text-zinc-900 dark:text-white focus-visible:ring-1 focus-visible:ring-zinc-950/20"
                  />
                  {folderForm.mode === "rename" && (
                    <p className="text-[10px] text-zinc-400 mt-1.5 leading-normal">
                      Renaming "{folderForm.originalPath}" updates this folder, its subfolders, and all contained journeys.
                    </p>
                  )}
                </div>

                <div className="flex justify-end gap-3 pt-3 border-t border-black/5 dark:border-white/5">
                  <Button 
                    type="button" 
                    onClick={() => setShowFolderModal(false)} 
                    disabled={savingFolder}
                    className="bg-transparent border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-300 rounded-xl hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    Cancel
                  </Button>
                  <Button 
                    type="submit" 
                    disabled={savingFolder} 
                    variant="default"
                  >
                    {savingFolder ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</>
                    ) : (
                      <><Sparkles className="w-4 h-4 mr-2" /> {folderForm.mode === "rename" ? "Save" : "Create"}</>
                    )}
                  </Button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Move Journey Modal */}
      <AnimatePresence>
        {showMoveModal && journeyToMove && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowMoveModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative w-full max-w-md bg-white dark:bg-zinc-900 border border-black/10 dark:border-white/10 rounded-2xl p-6 shadow-2xl space-y-4 z-10"
            >
              <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
                <h2 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
                  <Folder className="w-5 h-5 text-zinc-400" />
                  Move Journey
                </h2>
                <button 
                  onClick={() => setShowMoveModal(false)} 
                  className="text-zinc-400 hover:text-zinc-900 dark:hover:text-white p-1 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                Move <span className="font-semibold text-zinc-800 dark:text-zinc-200">"{journeyToMove.name}"</span> to a folder:
              </p>

              <div className="space-y-1.5">
                <label className="text-xs text-zinc-500 font-medium block">Select Folder</label>
                <CustomSelect
                  value={targetFolderForMove}
                  onChange={(val) => setTargetFolderForMove(val)}
                  options={[
                    { value: "", label: "— Uncategorized —" },
                    ...folders.map(f => ({ value: f, label: f }))
                  ]}
                  triggerClassName="w-full h-9 px-3 text-xs bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl outline-none text-zinc-900 dark:text-white flex items-center justify-between focus:border-zinc-950/20 focus:ring-1 focus:ring-zinc-950/20"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-black/5 dark:border-white/5">
                <Button 
                  type="button" 
                  onClick={() => setShowMoveModal(false)} 
                  className="bg-transparent border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-300 rounded-xl hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Cancel
                </Button>
                <Button 
                  onClick={confirmMoveJourney}
                  variant="default"
                >
                  Move
                </Button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {isDeleteOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsDeleteOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative w-full max-w-md bg-white dark:bg-zinc-900 border border-black/10 dark:border-white/10 rounded-2xl p-6 shadow-2xl space-y-4 z-10"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-red-500/10 text-red-500">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">Delete Journey</h3>
                  <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
                    Are you sure you want to delete <span className="font-semibold text-zinc-800 dark:text-zinc-200">"{journeyToDelete?.name}"</span>?
                    This action is permanent and cannot be undone. Leads currently enrolled in this journey will not progress.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button 
                  onClick={() => setIsDeleteOpen(false)}
                  className="bg-transparent border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-300 rounded-xl hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Cancel
                </Button>
                <Button 
                  onClick={confirmDelete}
                  variant="destructive"
                >
                  Delete
                </Button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}
