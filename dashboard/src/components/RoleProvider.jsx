"use client"

import { createContext, useContext } from "react"

// Lightweight role context. The server layout resolves the role once and
// passes it down through this provider so every client component can call
// useRole() / useIsOperator() without an extra fetch.

const RoleContext = createContext({ role: null, email: null })

const OPERATOR_ROLES = new Set(["owner", "admin", "member"])

export function RoleProvider({ role = null, email = null, children }) {
  return (
    <RoleContext.Provider value={{ role, email }}>
      {children}
    </RoleContext.Provider>
  )
}

export function useRole() {
  return useContext(RoleContext)
}

export function useIsOperator() {
  const { role } = useContext(RoleContext)
  return OPERATOR_ROLES.has(role)
}

export function useIsClientViewer() {
  const { role } = useContext(RoleContext)
  return role === "client_viewer"
}
