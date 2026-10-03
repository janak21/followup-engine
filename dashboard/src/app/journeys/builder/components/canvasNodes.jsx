"use client"

import {
  PhoneCall, MessageSquare, Mail, AlertCircle, Trash2, Save, Clock, GitMerge, Sparkles,
  Activity, Tag, Database, Sliders, Play, Pause, RefreshCw, X, AlertTriangle, Link2, Info,
  Code, FileText, UserPlus, UserSearch, GitFork, Plus
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Handle, Position, getBezierPath, BaseEdge, EdgeLabelRenderer } from "@xyflow/react"
import { STEP_TYPES, getJourneyNodeDisplay, outcomesForStep } from "@/lib/journeyStepTypes"

// Icon registry — maps schema's icon name strings to lucide components.
// Keep this in sync with imports above.
const ICON_REGISTRY = {
  PhoneCall, MessageSquare, Mail, AlertCircle, Clock, GitMerge, Sparkles,
  Activity, Tag, Database, Sliders, Play, Pause, RefreshCw, X,
  AlertTriangle, Link2, Info, Code, FileText, Trash2, Save,
  UserPlus, UserSearch
}

// Resolve a registry icon-name string (STEP_TYPES[type].icon) to its lucide
// component. Shared with the add-step picker so icons have a single source.
export function resolveStepIcon(iconName) {
  return ICON_REGISTRY[iconName] || AlertCircle
}

// A dashed "+" affordance hanging beneath an unwired outcome handle. Clicking
// it opens the action picker for that exact (source, outcome). `nodrag` keeps
// React Flow from starting a node drag on the click.
function AddStub({ leftPct = 50, onClick, title = "Add step" }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick?.() }}
      className="nodrag absolute z-20 flex items-center justify-center w-6 h-6 rounded-full border border-dashed border-indigo-400/70 dark:border-indigo-300/50 bg-white dark:bg-zinc-900 text-indigo-500 shadow-sm hover:bg-indigo-500 hover:text-white hover:border-indigo-500 transition-colors"
      style={{ left: `${leftPct}%`, top: "100%", transform: "translate(-50%, 14px)" }}
    >
      <Plus className="w-3.5 h-3.5" />
    </button>
  )
}

function inlineContentHint(step) {
  const body = String(step?.inline_body || "").trim().replace(/\s+/g, " ")
  if (!body) return null
  return body.length > 40 ? `${body.slice(0, 40)}...` : body
}

// Custom Edge with midpoint Delete Button and Outcome Labels
function ButtonEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data
}) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetPosition,
    targetX,
    targetY,
  });

  const outcomeColors = {
    answered: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20",
    replied: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20",
    sent: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20",
    no_answer: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 border-amber-200 dark:border-amber-500/20",
    no_reply: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 border-amber-200 dark:border-amber-500/20",
    voicemail: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400 border-indigo-200 dark:border-indigo-500/20",
    default: "bg-zinc-50 text-zinc-700 dark:bg-zinc-500/10 dark:text-zinc-400 border-zinc-200 dark:border-zinc-500/20",
  }

  const outcomeKey = data?.outcomeKey || data?.label
  const labelClass = data?.label ? (outcomeColors[outcomeKey] || "bg-zinc-50 text-zinc-700 dark:bg-zinc-500/10 dark:text-zinc-400 border-zinc-200 dark:border-zinc-500/20") : ""

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={{ stroke: '#6366f1', strokeWidth: 2.5, ...style }} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan flex items-center gap-1 bg-white dark:bg-zinc-900 border border-black/10 dark:border-white/10 rounded-full px-1.5 py-0.5 shadow-md select-none group"
        >
          {data?.label && (
            <span className={`text-[8px] tracking-wider font-bold px-1.5 py-0.2 rounded border leading-none ${labelClass}`}>
              {data.label}
            </span>
          )}
          <button
            onClick={(event) => {
              event.stopPropagation();
              if (data && data.onDelete) {
                data.onDelete(id);
              }
            }}
            className="w-4 h-4 rounded-full bg-zinc-100 hover:bg-red-500 hover:text-white dark:bg-zinc-800 dark:hover:bg-red-600 text-zinc-500 dark:text-zinc-400 flex items-center justify-center text-[10px] font-bold transition-colors cursor-pointer border border-black/5 dark:border-white/5"
            title="Delete connection"
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// Custom Trigger Node Component
function TriggerNode({ data }) {
  const triggerType = data?.triggerType || "lead_enrolled";
  const triggerConfig = data?.triggerConfig || {};
  const isSelected = data?.isSelected || false;
  const isHighlighted = data?.isHighlighted || false;
  const onClick = data?.onClick;
  const onAddStep = data?.onAddStep;
  // The trigger has a single implicit "default" output. Show a "+" when it is
  // not yet wired to a first step.
  const triggerWired = data?.triggerNextStep !== null && data?.triggerNextStep !== undefined;
  const isEmptyJourney = (data?.stepCount ?? 0) === 0;

  const labelText = data?.label || triggerType.replace("_", " ");

  return (
    <div
      onClick={onClick}
      className={`w-72 rounded-2xl border bg-white dark:bg-zinc-900 shadow-md p-4 flex flex-col gap-2 hover:border-zinc-400 dark:hover:border-white/20 transition-all cursor-pointer ${
        isSelected ? "ring-2 ring-zinc-500 dark:ring-white/40" : ""
      } ${
        isHighlighted
          ? "border-purple-500/50 dark:border-purple-400/50 ring-2 ring-purple-500/20 dark:ring-purple-400/20 shadow-[0_0_15px_rgba(168,85,247,0.15)]"
          : "border-zinc-200 dark:border-white/5"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 shrink-0">
          <Activity className="w-5 h-5" />
        </div>
        <div className="overflow-hidden">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Start trigger</span>
          <h3 className="font-semibold text-sm truncate text-zinc-900 dark:text-white capitalize">
            {labelText}
          </h3>
          {triggerType === "tag_added" && triggerConfig.tag && (
            <span className="inline-flex items-center gap-1 mt-1 text-[10px] bg-zinc-100 dark:bg-white/10 px-2 py-0.5 rounded-full text-zinc-600 dark:text-zinc-300 font-medium font-mono">
              <Tag className="w-2.5 h-2.5" /> {triggerConfig.tag}
            </span>
          )}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="default"
        style={{ bottom: -4, width: 10, height: 10, background: '#a855f7', border: '2px solid var(--background)' }}
      />

      {/* Guided "+": add the first step. Prominent, with copy, on an empty journey. */}
      {!triggerWired && onAddStep && (
        isEmptyJourney ? (
          <div
            className="nodrag absolute left-1/2 top-full -translate-x-1/2 flex flex-col items-center gap-1.5 pt-4"
            style={{ width: 220 }}
          >
            <button
              type="button"
              title="Add the first step"
              onClick={(e) => { e.stopPropagation(); onAddStep({ sourceNodeId: "trigger", outcomeKey: "default" }); }}
              className="flex items-center justify-center w-9 h-9 rounded-full border-2 border-dashed border-indigo-400 dark:border-indigo-300/60 bg-white dark:bg-zinc-900 text-indigo-500 shadow-md hover:bg-indigo-500 hover:text-white hover:border-indigo-500 transition-colors"
            >
              <Plus className="w-5 h-5" />
            </button>
            <span className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 text-center">
              Add the first step of your follow-up
            </span>
          </div>
        ) : (
          <AddStub
            leftPct={50}
            title="Add the first step"
            onClick={() => onAddStep({ sourceNodeId: "trigger", outcomeKey: "default" })}
          />
        )
      )}
    </div>
  );
}

// Custom Step Node Component
function StepNode({ data, type }) {
  const isSelected = data?.isSelected || false;
  const onClick = data?.onClick;
  const onDelete = data?.onDelete;
  const onAddStep = data?.onAddStep;

  // An outcome is "wired" when it routes to another step (numeric next_step).
  // Missing or terminal ({ exit }) outcomes are unwired and get a "+" stub.
  const isOutcomeWired = (outcomeId) =>
    typeof data?.step?.on_outcome?.[outcomeId]?.next_step === "number";

  let step = data?.step;
  if (!step) {
    const isExit = type === "output" || data?.label?.toLowerCase().includes("exit") || false;
    step = {
      index: 99,
      type: isExit ? "exit_flow" : "sms",
      label: data?.label || (isExit ? "End Journey" : "Action Step"),
      template_key: "none"
    };
  }

  // Resolve appearance from the shared step-types schema. Falls back to a generic gray
  // node if a step's type isn't registered (forwards-compat for old saved journeys).
  const typeCfg = STEP_TYPES[step.type];
  const nodeDisplay = getJourneyNodeDisplay(step.type);
  const nodeStyles = typeCfg
    ? { icon: ICON_REGISTRY[typeCfg.icon] || AlertCircle, border: typeCfg.borderClass, iconColor: typeCfg.iconClass }
    : { icon: AlertCircle, border: "border-zinc-500/10", iconColor: "bg-zinc-500/10 text-zinc-500" };

  const IconComponent = nodeStyles.icon;

  const highlightStatus = data?.highlightStatus;
  const highlightClass = highlightStatus === 'current'
    ? "ring-2 ring-blue-500 dark:ring-blue-400 border-blue-500 dark:border-blue-400 shadow-[0_0_20px_rgba(59,130,246,0.25)]"
    : highlightStatus === 'visited'
    ? "border-emerald-500/60 dark:border-emerald-400/60 ring-2 ring-emerald-500/10 dark:ring-emerald-400/10 shadow-[0_0_15px_rgba(16,185,129,0.15)]"
    : nodeStyles.border;

  return (
    <div
      className={`rounded-2xl border bg-white dark:bg-zinc-900 shadow-md p-4 flex flex-col justify-between relative w-[280px] h-[130px] hover:border-zinc-400 dark:hover:border-white/20 transition-all group ${
        highlightClass
      } ${isSelected ? "ring-2 ring-zinc-500 dark:ring-white/40" : ""}`}
    >
      {/* Target input Handle (Top Center) */}
      <Handle
        type="target"
        position={Position.Top}
        id="target"
        style={{ top: -4, width: 10, height: 10, background: '#94a3b8', border: '2px solid var(--background)' }}
      />

      {/* Hover preview of template */}
      {data.templatePreview && (
        <div className="absolute left-1/2 bottom-full mb-2 -translate-x-1/2 w-64 bg-zinc-900/95 dark:bg-black/95 text-white p-3 rounded-xl border border-white/10 shadow-2xl opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-50 text-[10px] space-y-1.5 leading-relaxed font-sans">
          {data.templatePreview.subject && (
            <div className="font-bold border-b border-white/10 pb-1 truncate text-zinc-300">
              Subject: {data.templatePreview.subject}
            </div>
          )}
          <div className="whitespace-pre-wrap line-clamp-6 text-zinc-400 font-mono text-[9px]">
            {data.templatePreview.body}
          </div>
        </div>
      )}

      {/* Card Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 cursor-pointer" onClick={onClick}>
          <div className={`p-2 rounded-xl ${nodeStyles.iconColor} shrink-0`}>
            <IconComponent className="w-5 h-5" />
          </div>
          <div className="overflow-hidden">
            <span className="text-[9px] font-mono text-zinc-400 block font-normal leading-none mb-0.5">Step #{step.index}</span>
            <h3 className="font-semibold text-sm text-zinc-900 dark:text-white capitalize truncate leading-tight">
              {step.label || nodeDisplay.label}
            </h3>
            {!step.label && step.type && (
              <span className="text-[9px] text-zinc-400 dark:text-zinc-500">Key: {step.type}</span>
            )}
          </div>
        </div>
        
        <button 
          onClick={(e) => {
            e.stopPropagation();
            onDelete(step.index);
          }}
          className="p-1 rounded hover:bg-red-500/10 text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Delete node"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Node Details Inline */}
      <div 
        className="text-[10px] text-zinc-500 dark:text-zinc-400 border-t border-black/5 dark:border-white/5 pt-2 flex-1 cursor-pointer overflow-hidden mt-1.5"
        onClick={onClick}
      >
        {step.type === "wait" && (() => {
          // Prefer the user-typed action_name; fall back to a derived summary.
          let summary
          if (step.action_name) summary = step.action_name
          else if (step.mode === "until" && step.until?.datetime) {
            const d = new Date(step.until.datetime)
            summary = isNaN(d) ? "Wait until …" : `Wait until ${d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
          } else {
            const amt = step.duration?.amount ?? step.delay?.amount ?? 0
            const unit = step.duration?.unit ?? step.delay?.unit ?? "minutes"
            summary = `Wait ${amt} ${unit}`
          }
          const aw = step.advance_window
          return (
            <div className="font-medium text-amber-500 space-y-0.5">
              <div className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                <span className="truncate">{summary}</span>
              </div>
              {aw?.enabled && (
                <div className="text-[9px] text-amber-400/80 font-normal">
                  ◷ {(aw.days || []).join("")} · {aw.window?.start || "09:00"}–{aw.window?.end || "17:00"}
                </div>
              )}
            </div>
          )
        })()}
        {(step.type === "sms" || step.type === "email" || step.type === "call" || step.type === "team_alert") && (
          <div className="text-zinc-400 truncate">
            {(step.type === "sms" || step.type === "email") && inlineContentHint(step)
              ? `Message: ${inlineContentHint(step)}`
              : `Template: ${step.template_key || "none"}`}
          </div>
        )}
        {step.type === "http_request" && (
          <div className="space-y-0.5">
            <div className="flex items-center gap-1">
              <span className="font-bold uppercase text-orange-500">{step.http_method || "POST"}</span>
              <span className="truncate max-w-[170px] font-mono text-zinc-400">{step.http_url || "url"}</span>
            </div>
            {step.response_var && (
              <span className="text-[9px] bg-orange-500/10 text-orange-500 px-1.5 py-0.5 rounded-full font-mono font-medium">
                var: {step.response_var}
              </span>
            )}
          </div>
        )}
        {(step.type === "add_tag" || step.type === "remove_tag") && (
          <div className="flex items-center gap-1">
            <span className="font-medium font-mono bg-zinc-100 dark:bg-white/10 px-2 py-0.5 rounded-full truncate max-w-[210px] text-zinc-400">
              {step.type === "add_tag" ? "+" : "-"} {step.tag_name || "tag"}
            </span>
          </div>
        )}
        {step.type === "conditional_split" && (
          <div className="text-cyan-500 font-medium flex items-center gap-1">
            <GitMerge className="w-3.5 h-3.5" />
            <span>{Array.isArray(step.branches) && step.branches.length > 0 ? `${step.branches.length} branches + Else` : "Yes / No branch split"}</span>
          </div>
        )}
        {step.type === "ab_split" && (
          <div className="text-fuchsia-500 font-medium flex items-center gap-1">
            <GitFork className="w-3.5 h-3.5" />
            <span>A {Math.max(0, Math.min(100, Number(step.split_percent_a ?? 50) || 0))}% / B {100 - Math.max(0, Math.min(100, Number(step.split_percent_a ?? 50) || 0))}%</span>
          </div>
        )}
        {step.type === "update_lead" && (() => {
          // Show new multi-field shape if present; legacy single-field as fallback.
          const fieldsArr = Array.isArray(step.fields) ? step.fields : null
          if (fieldsArr && fieldsArr.length > 0) {
            return (
              <div className="text-indigo-500 font-medium space-y-0.5">
                <div className="flex items-center gap-1">
                  <Database className="w-3.5 h-3.5" />
                  <span className="truncate">{step.action_name || "Update lead"}</span>
                </div>
                <div className="text-[9px] text-zinc-400">{fieldsArr.length} field{fieldsArr.length === 1 ? "" : "s"} mapped</div>
              </div>
            )
          }
          // Legacy
          return (
            <div className="space-y-0.5 font-mono text-[9px] text-zinc-400">
              <div>update: <span className="font-bold text-indigo-500">{step.update_field || "field"}</span></div>
              <div className="truncate">val: {step.update_value || "value"}</div>
            </div>
          )
        })()}
        {step.type === "wait_reply" && (
          <div className="flex items-center gap-1 font-medium text-amber-500">
            <Clock className="w-3.5 h-3.5" />
            <span>Timeout: {step.delay?.amount ?? 12} {step.delay?.unit ?? "hours"}</span>
          </div>
        )}
        {step.type === "exit_flow" && (
          <div className="text-rose-500 font-semibold flex items-center gap-1">
            <X className="w-3.5 h-3.5" />
            <span>Stop follow-up for this lead</span>
          </div>
        )}
        {step.type === "create_lead" && (
          <div className="text-violet-500 font-medium space-y-0.5">
            <div className="flex items-center gap-1">
              <UserPlus className="w-3.5 h-3.5" />
              <span className="truncate">{step.action_name || "Create lead"}</span>
            </div>
            <div className="text-[9px] text-zinc-400">
              {Array.isArray(step.fields) && step.fields.length > 0
                ? `${step.fields.length} field${step.fields.length === 1 ? "" : "s"} mapped`
                : "no fields yet"}
            </div>
          </div>
        )}
        {step.type === "find_lead" && (
          <div className="text-violet-500 font-medium space-y-0.5">
            <div className="flex items-center gap-1">
              <UserSearch className="w-3.5 h-3.5" />
              <span className="truncate">{step.action_name || "Find lead"}</span>
            </div>
            <div className="text-[9px] text-zinc-400">
              {Array.isArray(step.filters) && step.filters.length > 0
                ? `${step.filters.length} ${step.match_strategy === "any" ? "OR" : "AND"} filter${step.filters.length === 1 ? "" : "s"}`
                : "no filters yet"}
            </div>
          </div>
        )}
        {step.type === "find_lead_from_payload" && (
          <div className="text-violet-500 font-medium space-y-0.5">
            <div className="flex items-center gap-1">
              <UserSearch className="w-3.5 h-3.5" />
              <span className="truncate">{step.action_name || "Find Lead"}</span>
            </div>
            <div className="text-[9px] text-zinc-400">
              {Array.isArray(step.search) && step.search.length > 0
                ? `${step.search.length} search field${step.search.length === 1 ? "" : "s"}`
                : "no search configured"}
            </div>
          </div>
        )}
      </div>

      {/* Output handles — driven entirely by STEP_TYPES.outcomes from the schema.
          Adding a new outcome to a step type = edit src/lib/journeyStepTypes.js. */}
      {(() => {
        const handles = outcomesForStep(step);
        if (handles.length === 0) return null; // terminal step (exit_flow)

        // For single-outcome ("Continue") steps render a small unlabeled socket so the
        // node doesn't waste space on a useless label.
        if (handles.length === 1) {
          const h = handles[0];
          return (
            <>
              <Handle
                type="source"
                position={Position.Bottom}
                id={h.id}
                title={h.label}
                style={{ left: '50%', bottom: -4, width: 9, height: 9, background: h.color, border: '1.5px solid var(--background)' }}
              />
              {onAddStep && !isOutcomeWired(h.id) && (
                <AddStub
                  leftPct={50}
                  title={`Add step after ${h.label}`}
                  onClick={() => onAddStep({ sourceNodeId: String(step.index), outcomeKey: h.id })}
                />
              )}
            </>
          );
        }

        const n = handles.length;
        const wide = n <= 4;
        const handleSize = wide ? 9 : 7;
        const labelSize = wide ? '9px' : '7px';
        return (
          <>
            <div
              className="absolute w-full left-0 px-3 flex justify-between pointer-events-none font-bold leading-none"
              style={{ bottom: 8, fontSize: labelSize }}
            >
              {handles.map(h => (
                <span
                  key={h.id}
                  style={{ color: h.color, flex: 1, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }}
                >
                  {h.label}
                </span>
              ))}
            </div>
            {handles.map((h, idx) => (
              <Handle
                key={h.id}
                type="source"
                position={Position.Bottom}
                id={h.id}
                title={h.label}
                style={{
                  left: `${((idx + 0.5) / n) * 100}%`,
                  bottom: -4,
                  width: handleSize,
                  height: handleSize,
                  background: h.color,
                  border: '1.5px solid var(--background)'
                }}
              />
            ))}
            {onAddStep && handles.map((h, idx) => (
              !isOutcomeWired(h.id) ? (
                <AddStub
                  key={`add-${h.id}`}
                  leftPct={((idx + 0.5) / n) * 100}
                  title={`Add step after ${h.label}`}
                  onClick={() => onAddStep({ sourceNodeId: String(step.index), outcomeKey: h.id })}
                />
              ) : null
            ))}
          </>
        );
      })()}
    </div>
  );
}

const nodeTypes = {
  customTrigger: TriggerNode,
  customStep: StepNode,
  input: TriggerNode,
  default: StepNode,
  output: StepNode
};

const edgeTypes = {
  buttonEdge: ButtonEdge
};


export { nodeTypes, edgeTypes }
