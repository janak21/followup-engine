"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LogOut, Hexagon, Sun, Moon, Eye, ChevronLeft, ChevronRight, X } from "lucide-react"
import { useTheme } from "@/components/ThemeProvider"
import { TenantSwitcher } from "./TenantSwitcher"
import { AppIcon } from "@/components/AppIcon"

const OPERATOR_ROLES = new Set(["owner", "admin", "member"])

export function Sidebar({ role = null, email = null, isCollapsed = false, onToggleCollapse, isMobileOpen = false, onCloseMobile }) {
  const pathname = usePathname()
  const { theme, toggleTheme } = useTheme()
  const isOperator = OPERATOR_ROLES.has(role)

  // Client viewers see only Dashboard / Leads / Analytics. Operator-only items
  // are gated below; rendering them and 404'ing on click is worse UX.
  const navItems = [
    { name: "Dashboard",     href: "/",                          iconName: "dashboard",     visible: true },
    { name: "Analytics",     href: "/analytics",                 iconName: "analytics",     visible: true },
    { name: "Leads",         href: "/leads",                     iconName: "leads",         visible: true },
    { name: "Journeys",      href: "/journeys",                  iconName: "journeys",      visible: isOperator },
    { name: "AI Agents",     href: "/settings/ai-agents",        iconName: "aiAgents",      visible: isOperator },
    { name: "Custom Fields", href: "/settings/custom-fields",    iconName: "customFields",  visible: isOperator },
    { name: "Suppressions",  href: "/suppressions",              iconName: "suppressions",  visible: isOperator },
    { name: "Operations",    href: "/operations",                iconName: "operations",    visible: isOperator },
    { name: "Errors",        href: "/errors",                    iconName: "errors",        visible: isOperator },
    { name: "Audit",         href: "/audit",                     iconName: "audit",         visible: isOperator },
    { name: "Documentation", href: "/docs",                      iconName: "documentation", visible: true },
    { name: "Settings",      href: "/settings",                  iconName: "settings",      visible: isOperator },
  ].filter(i => i.visible)

  return (
    <aside className={`${isCollapsed ? "w-16" : "w-64"} ${isMobileOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0 fixed inset-y-0 left-0 z-50 flex flex-col border-r border-black/5 dark:border-white/5 bg-white/80 dark:bg-black/60 lg:bg-white/40 lg:dark:bg-black/20 backdrop-blur-2xl transition-transform duration-300 lg:transition-all`}>
      <div className={`flex ${isCollapsed ? "flex-col gap-3 items-center pt-4 pb-2 px-1" : "items-center justify-between p-4"} mb-2`}>
        <div className={isCollapsed ? "w-full" : "flex-1"}>
          <TenantSwitcher isCollapsed={isCollapsed} />
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="hidden lg:inline-flex p-2 rounded-lg border border-black/10 dark:border-white/10 bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-all duration-300 focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
        >
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <ChevronLeft className="w-4 h-4" />
          )}
        </button>
        {/* Mobile-only close button */}
        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden inline-flex p-2 rounded-lg border border-black/10 dark:border-white/10 bg-zinc-950/5 dark:bg-white/5 hover:bg-zinc-950/10 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-colors focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="Close navigation menu"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav className={`flex-1 ${isCollapsed ? "px-2" : "px-4"} space-y-1.5 overflow-y-auto`}>
        {navItems.map((item) => {
          const isActive = pathname === item.href
          return (
            <Link
              key={item.name}
              href={item.href}
              className={`flex items-center ${isCollapsed ? "justify-center px-1" : "px-3"} py-3 rounded-xl text-sm font-medium transition-all duration-300 group relative ${
                isActive
                  ? "bg-zinc-950/5 dark:bg-white/10 text-zinc-900 dark:text-white shadow-[0_0_20px_rgba(0,0,0,0.01)] dark:shadow-[0_0_20px_rgba(255,255,255,0.03)] border border-zinc-950/10 dark:border-white/10"
                  : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-950/5 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-white border border-transparent"
              }`}
              aria-current={isActive ? "page" : undefined}
              title={isCollapsed ? item.name : undefined}
              style={isActive && !isCollapsed ? { paddingLeft: '14px' } : undefined}
            >
              {isActive && !isCollapsed && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-zinc-900 dark:bg-white" />
              )}
              <AppIcon
                name={item.iconName}
                size={20}
                className={`${isCollapsed ? "" : "mr-3"} transition-colors duration-300 ${
                  isActive ? "text-zinc-900 dark:text-white" : "text-zinc-600 dark:text-zinc-400 group-hover:text-zinc-800 dark:group-hover:text-zinc-200"
                }`}
              />
              {!isCollapsed && item.name}
            </Link>
          )
        })}
      </nav>

      <div className="p-4 border-t border-black/5 dark:border-white/5 flex flex-col gap-2">
        {email && (
          <div 
            className={`rounded-xl bg-zinc-950/5 dark:bg-white/[0.04] flex items-center justify-center ${isCollapsed ? "w-10 h-10 mx-auto" : "px-3 py-2 gap-2"} mb-1 text-[11px] text-zinc-600 dark:text-zinc-300`}
            title={`${email} (${role})`}
          >
            {role === "client_viewer"
              ? <Eye className="w-4 h-4 text-blue-500 flex-shrink-0" />
              : <Hexagon className="w-4 h-4 text-emerald-500 flex-shrink-0" />}
            {!isCollapsed && (
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-zinc-800 dark:text-white">{email}</div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-600 dark:text-zinc-400">{role || "anon"}</div>
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={toggleTheme}
          className={`flex items-center w-full ${isCollapsed ? "justify-center px-1" : "px-3"} py-3 rounded-xl text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-950/5 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-white transition-all duration-300 border border-transparent hover:border-black/10 dark:hover:border-white/10 focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background`}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={isCollapsed ? (theme === "dark" ? "Light Mode" : "Dark Mode") : undefined}
        >
          {theme === "dark" ? (
            <Sun className={`w-5 h-5 ${isCollapsed ? "" : "mr-3"} text-amber-500 transition-transform duration-500 hover:rotate-45`} />
          ) : (
            <Moon className={`w-5 h-5 ${isCollapsed ? "" : "mr-3"} text-violet-600 transition-transform duration-500 hover:-rotate-12`} />
          )}
          {!isCollapsed && (theme === "dark" ? "Light Mode" : "Dark Mode")}
        </button>

        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className={`flex items-center w-full ${isCollapsed ? "justify-center px-1" : "px-3"} py-3 rounded-xl text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-950/5 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-white transition-all duration-300 border border-transparent hover:border-black/10 dark:hover:border-white/10 focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background`}
            aria-label="Sign out"
            title={isCollapsed ? "Sign Out" : undefined}
          >
            <LogOut className={`w-5 h-5 ${isCollapsed ? "" : "mr-3"} text-zinc-600 dark:text-zinc-400`} />
            {!isCollapsed && "Sign Out"}
          </button>
        </form>
      </div>
    </aside>
  )
}
