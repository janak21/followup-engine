import { cn } from "@/lib/utils"
import { getStatusClass, getStatusDotClass } from "@/lib/statusDisplay"

// Shared status/label pill. Colors come from the single source of truth in
// lib/statusDisplay, so a <Badge variant="warning"/> renders identically to
// getStatusPillClass("warning") and to the <StatusPill/> used in tables.
//
//   <Badge variant="success">Active</Badge>
//   <Badge variant="warning" dot>Needs reply</Badge>
//   <Badge variant="neutral" size="sm">tag</Badge>
//
// variant: success | warning | danger | neutral | info | ai   (default neutral)
// size:    sm | default | lg                                    (default default)
// dot:     show a leading status dot                            (default false)

const SIZE = {
  sm: "gap-1 px-1.5 py-0.5 text-[10px]",
  default: "gap-1.5 px-2 py-0.5 text-[10px]",
  lg: "gap-1.5 px-2.5 py-1 text-[11px]",
}

export function Badge({
  variant = "neutral",
  size = "default",
  dot = false,
  className,
  children,
  ...props
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-semibold whitespace-nowrap",
        SIZE[size] || SIZE.default,
        getStatusClass(variant),
        className
      )}
      {...props}
    >
      {dot && <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", getStatusDotClass(variant))} />}
      {children}
    </span>
  )
}
