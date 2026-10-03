"use client"

// Leads-table column descriptors + custom-field form controls. Extracted
// verbatim from leads/page.jsx.

import CustomSelect from "@/components/ui/custom-select"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  getComplianceStatusDisplay,
  getConversationStatusDisplay,
  getJourneyStatusDisplay,
  getLeadStatusDisplay,
} from "@/lib/statusDisplay"
import { StatusPill } from "./leadDisplay"

// ----- Leads-table column descriptors -----
// Each column has: id, label, defaultVisible, group, render(lead, ctx) → ReactNode, align?, cellClass?
// Custom-field columns are added dynamically from the tenant's schema.
const STANDARD_COLUMNS = [
  { id: "first_name",       label: "First name",      group: "Identity",  defaultVisible: true,
    render: (lead) => <span className="font-semibold text-zinc-800 dark:text-gray-200">{lead.first_name || "---"}</span> },
  { id: "last_name",        label: "Last name",       group: "Identity",  defaultVisible: true,
    render: (lead) => <span className="text-zinc-700 dark:text-gray-300">{lead.last_name || "---"}</span> },
  { id: "email",            label: "Email",           group: "Identity",  defaultVisible: true,
    render: (lead) => <span className="text-xs font-mono text-zinc-700 dark:text-gray-300">{lead.email || "---"}</span> },
  { id: "phone",            label: "Phone",           group: "Identity",  defaultVisible: true,
    render: (lead) => <span className="text-xs font-mono text-zinc-700 dark:text-gray-300">{lead.phone_raw || lead.phone_e164 || "---"}</span> },
  { id: "journey_template", label: "Journey",         group: "Journey",   defaultVisible: false,
    render: (lead, journeys = []) => {
      const j = journeys.find(x => x.journey_key?.toLowerCase() === lead.journey_template?.toLowerCase())
      return (
        <span className="text-xs text-zinc-700 dark:text-gray-300 font-medium">
          {j ? j.name : (lead.journey_template || "---")}
        </span>
      )
    }
  },
  { id: "lead_status",      label: "Lead status",     group: "Status",    defaultVisible: true, align: "center",
    render: (lead) => <StatusPill display={getLeadStatusDisplay(lead.journey_status, lead)} /> },
  { id: "journey_status",   label: "Journey status",  group: "Status",    defaultVisible: true, align: "center",
    render: (lead) => <StatusPill display={getJourneyStatusDisplay(lead.journey_status, lead)} /> },
  { id: "responded",        label: "Conversation",    group: "Status", defaultVisible: false, align: "center",
    render: (lead) => <StatusPill display={getConversationStatusDisplay(lead)} /> },
  { id: "opt_out",          label: "Contactability",  group: "Status", defaultVisible: false, align: "center",
    render: (lead) => <StatusPill display={getComplianceStatusDisplay(lead)} /> },
  { id: "created_at",       label: "Created at",      group: "Meta",      defaultVisible: false,
    render: (lead) => <span className="text-xs text-zinc-500">{lead.created_at ? new Date(lead.created_at).toLocaleString() : "---"}</span> },
]

const LS_KEY = "leads_table_visible_columns_v1"

function defaultVisibleIds(customFieldsSchema) {
  const ids = STANDARD_COLUMNS.filter(c => c.defaultVisible).map(c => c.id)
  // Custom fields off by default — the user explicitly opts in via the column picker.
  return ids
}

// ----- Helpers: render type-aware inputs and display values from a custom field schema -----
function groupCustomFieldsByFolder(schema) {
  const active = (schema || []).filter(f => f.active !== false)
  const map = {}
  for (const f of active) {
    const folder = f.folder?.trim() || "Custom Fields"
    if (!map[folder]) map[folder] = []
    map[folder].push(f)
  }
  Object.values(map).forEach(arr => arr.sort((a, b) => (a.display_order || 0) - (b.display_order || 0) || a.label.localeCompare(b.label)))
  return map
}

function CustomFieldInput({ field, value, onChange }) {
  const inputClass = "bg-white dark:bg-surface-3 border-black/10 dark:border-white/5 text-zinc-900 dark:text-white h-9 rounded-xl placeholder:text-zinc-400 dark:placeholder:text-gray-600 focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/20 text-sm"
  const placeholder = field.placeholder || `Enter ${field.label.toLowerCase()}`

  switch (field.type) {
    case "multi_line":
      return (
        <textarea
          rows={3}
          placeholder={placeholder}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full p-3 text-sm bg-white dark:bg-surface-3 border border-black/10 dark:border-white/5 rounded-xl outline-none text-zinc-900 dark:text-white"
        />
      )
    case "number":
      return (
        <Input
          type="number"
          placeholder={placeholder}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          className={inputClass}
        />
      )
    case "date":
      return <Input type="date" value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={inputClass} />
    case "boolean":
      return (
        <label className="flex items-center gap-2 h-9 cursor-pointer">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="w-4 h-4 rounded border-black/10 dark:border-white/10"
          />
          <span className="text-xs text-zinc-700 dark:text-gray-300">{value ? "Yes" : "No"}</span>
        </label>
      )
    case "dropdown":
      return (
        <CustomSelect
          value={value ?? ""}
          options={(field.options || []).map(o => ({ value: o, label: o }))}
          onChange={onChange}
          placeholder="— pick a value —"
          triggerClassName="w-full h-9 px-3 text-xs bg-white dark:bg-surface-3 border border-black/10 dark:border-white/5 rounded-xl outline-none text-zinc-900 dark:text-white flex items-center justify-between"
        />
      )
    case "radio":
      return (
        <div className="flex flex-wrap gap-3 py-1">
          {(field.options || []).map(o => (
            <label key={o} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" name={field.key} value={o} checked={value === o} onChange={() => onChange(o)} />
              <span>{o}</span>
            </label>
          ))}
        </div>
      )
    case "multi_select": {
      const arr = Array.isArray(value) ? value : []
      return (
        <div className="flex flex-wrap gap-3 py-1">
          {(field.options || []).map(o => (
            <label key={o} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={arr.includes(o)}
                onChange={(e) => {
                  if (e.target.checked) onChange([...arr, o])
                  else onChange(arr.filter(v => v !== o))
                }}
              />
              <span>{o}</span>
            </label>
          ))}
        </div>
      )
    }
    case "email":
      return <Input type="email" placeholder={placeholder} value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={inputClass} />
    case "phone":
      return <Input type="tel" placeholder={placeholder} value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={inputClass} />
    case "url":
      return <Input type="url" placeholder={placeholder || "https://..."} value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={inputClass} />
    case "single_line":
    default:
      return <Input type="text" placeholder={placeholder} value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={inputClass} />
  }
}

function CustomFieldDisplay({ field, value }) {
  if (value === undefined || value === null || value === "") {
    return <span className="text-zinc-400 dark:text-gray-500">---</span>
  }
  switch (field.type) {
    case "boolean":
      return <Badge variant={value ? "success" : "neutral"} size="sm">{value ? "YES" : "NO"}</Badge>
    case "multi_select":
      if (Array.isArray(value)) {
        if (value.length === 0) return <span className="text-zinc-400">---</span>
        return (
          <div className="flex flex-wrap gap-1">
            {value.map(v => <Badge key={v} variant="neutral" size="sm">{v}</Badge>)}
          </div>
        )
      }
      return <span>{String(value)}</span>
    case "url":
      return <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-500 dark:text-blue-400 hover:underline break-all">{String(value)}</a>
    case "email":
      return <a href={`mailto:${value}`} className="text-blue-500 dark:text-blue-400 hover:underline">{String(value)}</a>
    case "phone":
      return <a href={`tel:${value}`} className="text-blue-500 dark:text-blue-400 hover:underline">{String(value)}</a>
    case "date":
      try {
        return <span>{new Date(value).toLocaleDateString()}</span>
      } catch {
        return <span>{String(value)}</span>
      }
    default:
      return <span className="text-zinc-700 dark:text-gray-300 break-words">{String(value)}</span>
  }
}



// =========================================================================

export {
  STANDARD_COLUMNS,
  LS_KEY,
  defaultVisibleIds,
  groupCustomFieldsByFolder,
  CustomFieldInput,
  CustomFieldDisplay,
}
