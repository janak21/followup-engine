import { cn } from "@/lib/utils"
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react"

// Inline message banner (not a toast, not a modal). Unifies the hand-rolled
// "border + tinted bg + icon + text" boxes that used to repeat across pages.
//
//   <Alert variant="danger">Something went wrong.</Alert>
//   <Alert variant="warning" title="Heads up">Details…</Alert>
//   <Alert variant="success" size="sm">Saved.</Alert>
//
// variant: danger | warning | success | info   (default danger)
// size:    sm | default                          (default default)
// title:   optional bold lead line
// icon:    show the leading variant icon          (default true)

const VARIANTS = {
  danger:  { box: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300", Icon: AlertCircle },
  warning: { box: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300", Icon: AlertTriangle },
  success: { box: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", Icon: CheckCircle2 },
  info:    { box: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300", Icon: Info },
}

const SIZE = {
  sm: "p-3 rounded-lg text-xs",
  default: "p-3 rounded-xl text-sm",
}

export function Alert({
  variant = "danger",
  size = "default",
  title,
  icon = true,
  className,
  children,
  ...props
}) {
  const v = VARIANTS[variant] || VARIANTS.danger
  const Icon = v.Icon
  return (
    <div
      role="alert"
      className={cn("flex items-start gap-2 border leading-relaxed", SIZE[size] || SIZE.default, v.box, className)}
      {...props}
    >
      {icon && <Icon className="w-4 h-4 mt-0.5 shrink-0" />}
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold mb-0.5">{title}</div>}
        {children}
      </div>
    </div>
  )
}
