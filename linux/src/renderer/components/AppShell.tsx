// The cockpit frame: persistent sidebar navigation, a top bar carrying the
// active profile and global sync state, and a scrolling content well.
//
// Navigation is persistent by design — this is a command center, not a mobile
// app, and Victor should never lose his place in the ledger to a drill-down.

import type { ReactNode } from "react"

import { useOptionalAppState } from "../app/AppState.tsx"
import { IconGlyph, type IconName } from "./IconGlyph.tsx"
import { HorizonMark, LedgerScanlines } from "./LedgerFoundations.tsx"
import { cx } from "./cx.ts"

export interface NavItem {
  readonly id: string
  readonly label: string
  readonly icon: IconName
  /** Rendered as a count pill, e.g. flagged todos. */
  readonly badge?: number
  /** What the badge counts, so the pill is not announced as a bare number. */
  readonly badgeLabel?: string
}

export interface NavSection {
  readonly id: string
  readonly label: string
  readonly items: readonly NavItem[]
}

export interface AppShellProps {
  sections: readonly NavSection[]
  activeId: string
  onNavigate: (id: string) => void
  topBar: ReactNode
  children: ReactNode
}

export function AppShell({ sections, activeId, onNavigate, topBar, children }: AppShellProps) {
  const preferences = useOptionalAppState()
  const theme = preferences?.ledgerTheme ?? "dark"
  const scanlines = preferences?.scanlinesEnabled ?? true
  const phosphor = preferences?.phosphorEnabled ?? true

  return (
    <div
      className="vv-shell vv-ledger-root"
      data-vv-theme={theme}
      data-vv-route={activeId}
      data-vv-phosphor={phosphor ? "on" : "off"}
    >
      <LedgerScanlines enabled={scanlines} />
      <nav className="vv-sidebar" aria-label="Primary">
        <div className="vv-sidebar__brand">
          <HorizonMark size={32} className="vv-sidebar__mark" title="Sovereign Budget App" />
          <span className="vv-sidebar__wordmark">
            <strong>SOVEREIGN</strong>
            <small>BUDGET APP</small>
          </span>
        </div>
        <div className="vv-sidebar__scroll vv-scroll">
          {sections.map((section) => (
            <div key={section.id} className="vv-navgroup">
              <p className="vv-navgroup__label">{section.label}</p>
              <ul className="vv-navgroup__list">
                {section.items.map((item) => {
                  const active = item.id === activeId
                  // Below 1366px the stylesheet sets display:none on the label,
                  // which removes it from the accessibility tree as well as the
                  // screen — leaving `title` as the only name, which is the
                  // weakest source and not exposed by every screen reader. Name
                  // the button outright so the compact pass cannot silence it.
                  const badgeName =
                    item.badge === undefined
                      ? null
                      : `${item.badge}${item.badgeLabel ? ` ${item.badgeLabel}` : ""}`
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={cx("vv-navitem", active && "vv-navitem--active")}
                        aria-current={active ? "page" : undefined}
                        aria-label={badgeName ? `${item.label}, ${badgeName}` : item.label}
                        onClick={() => onNavigate(item.id)}
                        title={item.label}
                      >
                        <IconGlyph name={item.icon} size={15} />
                        <span className="vv-navitem__label">{item.label}</span>
                        {item.badge ? <span className="vv-navitem__badge">{item.badge}</span> : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
      <div className="vv-main">
        <header className="vv-topbar">{topBar}</header>
        <main className="vv-content vv-scroll">{children}</main>
      </div>
    </div>
  )
}

export interface TopBarProps {
  profileControl: ReactNode
  syncState: ReactNode
  actions?: ReactNode
}

export function TopBar({ profileControl, syncState, actions }: TopBarProps) {
  return (
    <>
      <div className="vv-topbar__left">{profileControl}</div>
      <div className="vv-topbar__right">
        {syncState}
        {actions}
      </div>
    </>
  )
}
