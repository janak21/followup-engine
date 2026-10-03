"use client"

import React, { useState, useRef, useEffect, useCallback } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, Check } from "lucide-react"

/**
 * CustomSelect – a fully accessible, portal-based dropdown.
 *
 * The menu is rendered into document.body via React Portal so it is NEVER
 * clipped by a parent overflow:hidden/auto container (e.g. the Journey Builder
 * config drawer). Position is calculated from the trigger's bounding rect and
 * auto-flips upward when there is not enough space below.
 */
export default function CustomSelect({
  value,
  options = [],
  onChange,
  placeholder = "Select option...",
  disabled = false,
  direction = "down",          // "down" | "up" – overridden by auto-flip logic
  triggerClassName = "",
  menuClassName = "",
  align = "center",            // "left" | "center" | "right"
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [menuStyle, setMenuStyle] = useState({})
  const [openUp, setOpenUp] = useState(direction === "up")

  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  // ── Position the portal menu against the trigger ──────────────────────────
  const computePosition = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const MENU_HEIGHT = 240 // max-h-60 ≈ 240px
    const spaceBelow = window.innerHeight - rect.bottom
    const shouldOpenUp = direction === "up" || (direction !== "down_force" && spaceBelow < MENU_HEIGHT && rect.top > MENU_HEIGHT)
    setOpenUp(shouldOpenUp)

    const style = {
      // App layering scale: content 10 · topbar 30 · backdrop 40 · sidebar 50
      // · overlay/modal 100 · toast 150 · dialog 200 · popover 300. This portal
      // must sit above any overlay it is opened from (incl. dialogs), so 300.
      position: "fixed",
      zIndex: 300,
      width: rect.width,
      minWidth: 150,
    }

    if (shouldOpenUp) {
      style.bottom = window.innerHeight - rect.top + 4
    } else {
      style.top = rect.bottom + 4
    }

    if (align === "left") {
      style.left = rect.left
    } else if (align === "right") {
      style.right = window.innerWidth - rect.right
    } else {
      // center
      style.left = rect.left + rect.width / 2
      style.transform = "translateX(-50%)"
    }

    setMenuStyle(style)
  }, [align, direction])

  // Recompute on open and on scroll/resize while open
  useEffect(() => {
    if (!isOpen) return
    computePosition()
    window.addEventListener("scroll", computePosition, true)
    window.addEventListener("resize", computePosition)
    return () => {
      window.removeEventListener("scroll", computePosition, true)
      window.removeEventListener("resize", computePosition)
    }
  }, [isOpen, computePosition])

  // ── Click-outside to close ────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    function handleClickOutside(e) {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target) &&
        menuRef.current  && !menuRef.current.contains(e.target)
      ) {
        setIsOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [isOpen])

  // ── Reset focus index on close ────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) setFocusedIndex(-1)
  }, [isOpen])

  // ── Keyboard navigation ───────────────────────────────────────────────────
  const handleKeyDown = (e) => {
    if (disabled) return
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      if (!isOpen) {
        setIsOpen(true)
      } else if (focusedIndex >= 0 && focusedIndex < options.length) {
        onChange(options[focusedIndex].value)
        setIsOpen(false)
      }
    } else if (e.key === "Escape") {
      setIsOpen(false)
    } else if (e.key === "ArrowDown") {
      e.preventDefault()
      if (!isOpen) {
        setIsOpen(true)
      } else {
        setFocusedIndex((prev) => (prev + 1) % options.length)
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      if (!isOpen) {
        setIsOpen(true)
      } else {
        setFocusedIndex((prev) => (prev - 1 + options.length) % options.length)
      }
    }
  }

  const selectedOption = options.find((opt) => opt.value === value)

  // ── Menu element (rendered via portal) ───────────────────────────────────
  const menu = isOpen && typeof document !== "undefined" && createPortal(
    <div
      ref={menuRef}
      style={menuStyle}
      className={
        menuClassName ||
        "max-h-60 overflow-y-auto rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-surface-1 p-1 shadow-xl backdrop-blur-md"
      }
    >
      {options.length === 0 ? (
        <div className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300 text-center">
          No options available
        </div>
      ) : (
        options.map((opt, index) => {
          const isSelected = opt.value === value
          const isFocused = index === focusedIndex
          const isDisabled = opt.disabled === true
          return (
            <button
              key={opt.value ?? index}
              type="button"
              disabled={isDisabled}
              onMouseDown={(e) => {
                // Prevent blur from firing before click is registered
                e.preventDefault()
                if (isDisabled) return
                onChange(opt.value)
                setIsOpen(false)
              }}
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                isDisabled
                  ? "text-zinc-400 dark:text-zinc-600 cursor-not-allowed opacity-60"
                  : isSelected
                  ? "bg-zinc-900/5 dark:bg-white/5 text-zinc-900 dark:text-white"
                  : isFocused
                  ? "bg-zinc-900/10 dark:bg-white/10 text-zinc-900 dark:text-white"
                  : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-900/5 dark:hover:bg-white/[0.06] hover:text-zinc-900 dark:hover:text-white"
              }`}
            >
              <span className="flex items-center gap-1.5 truncate">
                {opt.color && (
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: opt.color }}
                  />
                )}
                {opt.icon && <span className="shrink-0">{opt.icon}</span>}
                <span className="truncate">{opt.label}</span>
                {opt.description && (
                  <span className="ml-1 shrink-0 text-[10px] font-normal text-zinc-400 dark:text-zinc-600">
                    {opt.description}
                  </span>
                )}
              </span>
              {isSelected && (
                <Check className="w-3.5 h-3.5 text-zinc-900 dark:text-white shrink-0" />
              )}
            </button>
          )
        })
      )}
    </div>,
    document.body
  )

  return (
    <div
      className="relative inline-block w-full text-left"
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={
          triggerClassName ||
          `flex w-full items-center justify-between gap-2 px-3 py-1.5 rounded-xl text-xs font-medium border outline-none transition-all duration-200 bg-zinc-950/5 dark:bg-white/5 border-zinc-300 dark:border-white/10 text-zinc-800 dark:text-gray-200 ${
            disabled
              ? "opacity-65 cursor-not-allowed"
              : "cursor-pointer hover:bg-zinc-950/10 dark:hover:bg-white/10 focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:border-ring"
          }`
        }
      >
        <span className="flex items-center gap-1.5 truncate">
          {selectedOption?.color && (
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0 animate-pulse"
              style={{ backgroundColor: selectedOption.color }}
            />
          )}
          {selectedOption?.icon && (
            <span className="shrink-0 text-zinc-500 dark:text-gray-400">
              {selectedOption.icon}
            </span>
          )}
          <span className="truncate">{selectedOption?.label || placeholder}</span>
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-zinc-500 dark:text-gray-400 transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {menu}
    </div>
  )
}
