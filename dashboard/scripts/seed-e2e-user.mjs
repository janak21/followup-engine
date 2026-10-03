// Seeds a confirmed E2E test user for local auth verification.
//
//   node scripts/seed-e2e-user.mjs
//
// Reads .env.local for the Supabase URL + service-role key and E2E_USER_EMAIL /
// E2E_USER_PASSWORD / E2E_TENANT_ID. Idempotent: safe to re-run.
//
// Deliberately exercises the real invite flow: it inserts a tenant_invites row
// BEFORE creating the auth user, so the consume_tenant_invites_on_signup
// trigger is what attaches the membership — the same path a real invited
// client takes when they sign up with a password.

import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
for (const line of readFileSync(join(root, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const email = process.env.E2E_USER_EMAIL
const password = process.env.E2E_USER_PASSWORD
const tenantId = process.env.E2E_TENANT_ID
const role = process.env.E2E_USER_ROLE || "member"

if (!url || !serviceKey) { console.error("Missing Supabase env"); process.exit(1) }
if (!email || !password || !tenantId) {
  console.error("Set E2E_USER_EMAIL, E2E_USER_PASSWORD, E2E_TENANT_ID in .env.local")
  process.exit(1)
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const { data: existing } = await admin
  .from("tenant_members")
  .select("user_id, role")

const { data: userList, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 })
if (listErr) { console.error("listUsers failed:", listErr.message); process.exit(1) }
let user = userList.users.find(u => (u.email || "").toLowerCase() === email.toLowerCase())

if (user) {
  console.log(`User ${email} already exists (${user.id}) — updating password.`)
  const { error } = await admin.auth.admin.updateUserById(user.id, { password, email_confirm: true })
  if (error) { console.error("updateUser failed:", error.message); process.exit(1) }
} else {
  // Invite first so the signup trigger performs the membership attach.
  const { error: invErr } = await admin.from("tenant_invites").insert({ email, tenant_id: tenantId, role })
  if (invErr && !/duplicate/i.test(invErr.message)) {
    console.error("invite insert failed:", invErr.message); process.exit(1)
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) { console.error("createUser failed:", error.message); process.exit(1) }
  user = data.user
  console.log(`Created confirmed user ${email} (${user.id}).`)
}

// Verify membership (trigger should have attached it; upsert as fallback for
// pre-existing users that never had one).
const { data: member } = await admin
  .from("tenant_members")
  .select("tenant_id, role")
  .eq("user_id", user.id)
  .maybeSingle()

if (member) {
  console.log(`Membership OK: tenant ${member.tenant_id}, role ${member.role} (attached by invite trigger or pre-existing).`)
} else {
  const { error } = await admin.from("tenant_members").upsert(
    { tenant_id: tenantId, user_id: user.id, role },
    { onConflict: "tenant_id,user_id" }
  )
  if (error) { console.error("membership upsert failed:", error.message); process.exit(1) }
  console.log(`Membership attached directly: tenant ${tenantId}, role ${role}. NOTE: invite trigger did not fire — check trg_consume_invites.`)
}
console.log("Seed complete.")
