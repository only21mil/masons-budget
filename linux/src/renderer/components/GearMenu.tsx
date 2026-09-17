// Top-bar menu for profile tools, settings, exports, and locking the window.

import { useEffect, useRef, useState } from "react"

import { useAppState } from "../app/AppState.tsx"
import { isAdult } from "@vogel-vault/domain/family"

import { Button } from "./primitives.tsx"
import { IconGlyph } from "./IconGlyph.tsx"
import { cx } from "./cx.ts"

const MENU_ITEMS = [
  { id: "family", label: "Family", icon: "users" as const },
  { id: "settings", label: "Settings", icon: "settings" as const },
  { id: "export", label: "Export", icon: "download" as const, adultOnly: true },
  { id: "lock", label: "Lock now", icon: "lock" as const },
] as const

export function GearMenu() {
  const { activeProfile, navigate, route, setLocked } = useAppState()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const items = MENU_ITEMS.filter((item) => !("adultOnly" in item) || isAdult(activeProfile))

  return (
    <div ref={rootRef} className="vv-gear-menu">
      <Button
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="App menu"
        onClick={() => setOpen((value) => !value)}
      >
        <IconGlyph name="settings" size={16} label="App menu" />
      </Button>
      {open ? (
        <div className="vv-gear-menu__panel" role="menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={cx(
                "vv-gear-menu__item",
                route === item.id && "vv-gear-menu__item--active",
              )}
              onClick={() => {
                if (item.id === "lock") setLocked(true)
                else navigate(item.id)
                setOpen(false)
              }}
            >
              <IconGlyph name={item.icon} size={15} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
