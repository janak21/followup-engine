import { assertSafeEnv } from "./assertSafeEnv.js";

assertSafeEnv();

export function isAnonTenantAllowed() {
  return process.env.ALLOW_ANON_TENANT === "1" && process.env.NODE_ENV !== "production";
}