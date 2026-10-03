"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { RoleProvider } from "@/components/RoleProvider";
import { NoWorkspace } from "@/components/NoWorkspace";

export function LayoutWrapper({ children, role = null, email = null, noMembership = false }) {
  const pathname = usePathname();
  const isAuthPage = pathname?.startsWith("/auth");
  const isBuilderPage = pathname === "/journeys/builder";

  // Collapse state management (desktop) + off-canvas drawer state (mobile)
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    const saved = localStorage.getItem("sidebar-collapsed");
    if (saved === "true") {
      setIsCollapsed(true);
    }
  }, []);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setIsMobileOpen(false);
  }, [pathname]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.style.overflow = isMobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [isMobileOpen]);

  const handleToggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  };

  // Signed-in but not a member of any tenant — explain instead of rendering a
  // dashboard whose every request fails. Auth pages stay reachable (signout).
  if (noMembership && !isAuthPage) {
    return <NoWorkspace email={email} />;
  }

  if (isAuthPage) {
    return (
      <div className="flex min-h-dvh relative z-10 justify-center items-center">
        <main className="flex-1 p-8 min-w-0">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    );
  }

  if (isBuilderPage) {
    return (
      <RoleProvider role={role} email={email}>
        <div className="flex min-h-dvh relative z-10">
          <main className="flex-1 min-w-0">
            {children}
          </main>
        </div>
      </RoleProvider>
    );
  }

  // Desktop reserves space for the fixed sidebar; on mobile the sidebar is an
  // off-canvas overlay so the main column stays full-width (ml-0).
  const desktopMargin = !isMounted
    ? "lg:ml-64"
    : isCollapsed
    ? "lg:ml-16"
    : "lg:ml-64";

  return (
    <RoleProvider role={role} email={email}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-xl focus:bg-white dark:focus:bg-zinc-900 focus:text-zinc-900 dark:focus:text-white focus:shadow-lg focus:border focus:border-zinc-200 dark:focus:border-white/10 text-sm font-medium"
      >
        Skip to content
      </a>
      <div className="flex min-h-dvh relative z-10">
        {/* Mobile backdrop — only interactive below lg while the drawer is open */}
        {isMobileOpen && (
          <div
            className="lg:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
            aria-hidden="true"
            onClick={() => setIsMobileOpen(false)}
          />
        )}
        <Sidebar
          role={role}
          email={email}
          isCollapsed={isCollapsed}
          onToggleCollapse={handleToggleCollapse}
          isMobileOpen={isMobileOpen}
          onCloseMobile={() => setIsMobileOpen(false)}
        />
        <main id="main-content" className={`flex-1 transition-all duration-300 ml-0 ${desktopMargin} min-w-0`}>
          {/* Mobile top bar with hamburger — hidden on desktop */}
          <div className="lg:hidden sticky top-0 z-30 flex items-center gap-3 px-4 h-14 border-b border-black/5 dark:border-white/5 bg-white/70 dark:bg-black/40 backdrop-blur-xl">
            <button
              type="button"
              onClick={() => setIsMobileOpen(true)}
              className="p-2 -ml-2 rounded-lg text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background outline-none"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <span className="text-sm font-semibold text-zinc-900 dark:text-white">Example Co</span>
          </div>
          <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
            {children}
          </div>
        </main>
      </div>
    </RoleProvider>
  );
}
