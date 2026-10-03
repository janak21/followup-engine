import localFont from "next/font/local";
import "./globals.css";
import Script from "next/script";
import { ThemeProvider } from "@/components/ThemeProvider";
import { LayoutWrapper } from "@/components/LayoutWrapper";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { PromptProvider } from "@/components/ui/prompt-dialog";
import { resolveRequestContext } from "@/utils/role";
import { getCurrentUser } from "@/utils/supabase-server";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata = {
  title: "Follow-Up Engine",
  description: "Multi-channel automated outreach dashboard for managing email, SMS, and voice call follow-up journeys.",
  openGraph: {
    title: "Follow-Up Engine",
    description: "Multi-channel automated outreach dashboard for managing email, SMS, and voice call follow-up journeys.",
    type: "website",
  },
};

export default async function RootLayout({ children }) {
  // Server-resolve the current role so the sidebar can render the right nav set
  // for client viewers vs operators. Auth pages will fail this resolve — fine.
  let role = null
  let email = null
  let noMembership = false
  try {
    const ctx = await resolveRequestContext()
    role = ctx.role
    email = ctx.user?.email || null
  } catch {
    // Resolve failed: either no session (middleware sends them to login) or a
    // signed-in user without a tenant membership — show them why instead of a
    // dashboard whose every API call 401s.
    const user = await getCurrentUser().catch(() => null)
    if (user) {
      noMembership = true
      email = user.email || null
    }
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script
          id="theme-initializer"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `(function() {
              try {
                const saved = localStorage.getItem('theme');
                if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                  document.documentElement.classList.add('dark');
                } else {
                  document.documentElement.classList.remove('dark');
                }
              } catch (e) {}
            })()`
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-dvh bg-[#f9f9fb] dark:bg-surface-base text-foreground relative overflow-x-hidden transition-colors duration-300`}
      >
        <ThemeProvider>
          {/* Ambient surface glows — neutral, single light source, tinted to match theme */}
          <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
            <div className="absolute -top-[20%] -left-[10%] w-[55%] h-[55%] rounded-full bg-zinc-400/[0.07] dark:bg-white/[0.04] blur-[140px]" />
            <div className="absolute top-[45%] -right-[15%] w-[45%] h-[45%] rounded-full bg-zinc-300/[0.05] dark:bg-zinc-500/[0.04] blur-[130px]" />
            <div className="absolute -bottom-[25%] left-[15%] w-[45%] h-[45%] rounded-full bg-zinc-200/[0.06] dark:bg-white/[0.03] blur-[160px]" />
          </div>

          {/* Subtle grain to break digital flatness */}
          <div className="noise-overlay" aria-hidden="true" />

          <ToastProvider>
            <ConfirmProvider>
              <PromptProvider>
                <LayoutWrapper role={role} email={email} noMembership={noMembership}>
                  {children}
                </LayoutWrapper>
              </PromptProvider>
            </ConfirmProvider>
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

