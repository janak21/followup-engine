// Pure helpers for resolving the active tenant from a signed cookie hint and
// the user's verified membership list. These functions contain no I/O and are
// safe to import in tests.

/**
 * Resolve which tenant id should be used for the current request.
 *
 * @param {string|null} activeTenantId - The tenant id decoded from the signed
 *   `active_tenant_id` cookie. May be null/invalid.
 * @param {Array<{tenant_id: string}>} memberships - The user's verified
 *   tenant_members rows, ordered by created_at ascending (earliest first).
 * @returns {string|null} The active tenant id if it is a valid membership,
 *   otherwise the earliest membership id, or null if the user has none.
 */
export function resolveActiveTenantId(activeTenantId, memberships) {
  if (!Array.isArray(memberships) || memberships.length === 0) {
    return null;
  }
  const isMember = memberships.some((m) => m.tenant_id === activeTenantId);
  if (isMember) {
    return activeTenantId;
  }
  return memberships[0].tenant_id;
}
