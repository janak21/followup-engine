import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiBrain03FreeIcons,
  AlertCircleFreeIcons,
  Analytics03FreeIcons,
  Audit02FreeIcons,
  BookOpen01FreeIcons,
  CodeSquareFreeIcons,
  DashboardSquare03FreeIcons,
  Database02FreeIcons,
  DatabaseFreeIcons,
  Invoice03FreeIcons,
  Layout03FreeIcons,
  MailAccount01FreeIcons,
  MailBlockFreeIcons,
  Notification03FreeIcons,
  Queue02FreeIcons,
  Settings02FreeIcons,
  UserGroupFreeIcons,
  WorkflowSquare03FreeIcons,
} from "@hugeicons/core-free-icons"

const ICONS = {
  dashboard: DashboardSquare03FreeIcons,
  analytics: Analytics03FreeIcons,
  leads: UserGroupFreeIcons,
  journeys: WorkflowSquare03FreeIcons,
  aiAgents: AiBrain03FreeIcons,
  customFields: Database02FreeIcons,
  suppressions: MailBlockFreeIcons,
  operations: Queue02FreeIcons,
  errors: AlertCircleFreeIcons,
  audit: Audit02FreeIcons,
  documentation: BookOpen01FreeIcons,
  settings: Settings02FreeIcons,
  templates: Layout03FreeIcons,
  channels: MailAccount01FreeIcons,
  billing: Invoice03FreeIcons,
  data: DatabaseFreeIcons,
  developer: CodeSquareFreeIcons,
  needsAttention: Notification03FreeIcons,
}

export const APP_ICON_NAMES = Object.keys(ICONS)

export function AppIcon({ name, size = 20, className = "", "aria-hidden": ariaHidden = true, ...props }) {
  const icon = ICONS[name] || ICONS.dashboard

  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      color="currentColor"
      strokeWidth={1.75}
      className={className}
      aria-hidden={ariaHidden}
      {...props}
    />
  )
}

