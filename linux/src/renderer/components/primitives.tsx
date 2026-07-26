// Core presentational primitives for the Graphite Ledger Cockpit.
//
// Badge, Button, Panel, StatusBanner, KPIStrip and the form controls live here
// because they share one visual contract and are meaningless apart. Larger
// primitives (DataTable, StateBlock, DialogFrame, AppShell) have their own files.

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react"

import { IconGlyph, type IconName } from "./IconGlyph.tsx"
import { cx } from "./cx.ts"

// ── Badge ───────────────────────────────────────────────────────────────────

export type BadgeTone = "neutral" | "accent" | "positive" | "negative" | "warning" | "info"

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  icon?: IconName
  className?: string
}

export function Badge({ children, tone = "neutral", icon, className }: BadgeProps) {
  return (
    <span className={cx("vv-badge", `vv-badge--${tone}`, className)}>
      {icon ? <IconGlyph name={icon} size={12} /> : null}
      {children}
    </span>
  )
}

// ── Button ──────────────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  icon?: IconName
  /** Icon-only buttons still need an accessible name. */
  iconOnly?: boolean
}

export function Button({
  variant = "secondary",
  icon,
  iconOnly = false,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("vv-button", `vv-button--${variant}`, iconOnly && "vv-button--icon", className)}
      {...rest}
    >
      {icon ? <IconGlyph name={icon} size={14} /> : null}
      {iconOnly ? <span className="vv-sr-only">{children}</span> : children}
    </button>
  )
}

// ── Panel ───────────────────────────────────────────────────────────────────

export interface PanelProps {
  title?: ReactNode
  /** Where this panel's numbers came from — the cockpit always says. */
  source?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** Removes interior padding for tables that manage their own. */
  flush?: boolean
}

export function Panel({ title, source, actions, children, className, flush = false }: PanelProps) {
  return (
    <section className={cx("vv-panel", className)}>
      {title || actions || source ? (
        <header className="vv-panel__head">
          <div className="vv-panel__titles">
            {title ? <h2 className="vv-panel__title">{title}</h2> : null}
            {source ? <p className="vv-panel__source">{source}</p> : null}
          </div>
          {actions ? <div className="vv-panel__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx("vv-panel__body", flush && "vv-panel__body--flush")}>{children}</div>
    </section>
  )
}

// ── StatusBanner ────────────────────────────────────────────────────────────

export type BannerTone = "info" | "warning" | "negative" | "positive"

export interface StatusBannerProps {
  tone?: BannerTone
  title: ReactNode
  detail?: ReactNode
  action?: ReactNode
  className?: string
}

const BANNER_ICON: Record<BannerTone, IconName> = {
  info: "circle-alert",
  warning: "alert",
  negative: "alert",
  positive: "check",
}

export function StatusBanner({ tone = "info", title, detail, action, className }: StatusBannerProps) {
  return (
    <div className={cx("vv-banner", `vv-banner--${tone}`, className)} role="status">
      <IconGlyph name={BANNER_ICON[tone]} size={15} className="vv-banner__icon" />
      <div className="vv-banner__text">
        <span className="vv-banner__title">{title}</span>
        {detail ? <span className="vv-banner__detail">{detail}</span> : null}
      </div>
      {action ? <div className="vv-banner__action">{action}</div> : null}
    </div>
  )
}

// ── KPIStrip ────────────────────────────────────────────────────────────────

export type Provenance = "actual" | "planned" | "estimated"

/**
 * Placeholder for a figure that could not be read.
 *
 * Shared rather than a literal so KPIStrip can recognise a suppressed value and
 * drop its tone and hint. A red or green em dash implies a reading that does not
 * exist, and a hint like "1 category" leaks the very number being withheld.
 */
export const SUPPRESSED = "\u2014"

export interface KPI {
  readonly label: string
  readonly value: string
  readonly hint?: string
  readonly tone?: "neutral" | "positive" | "negative" | "accent"
  readonly provenance?: Provenance
}

export interface KPIStripProps {
  items: readonly KPI[]
  className?: string
}

export function KPIStrip({ items, className }: KPIStripProps) {
  return (
    <div className={cx("vv-kpis", className)}>
      {items.map((item) => {
        const suppressed = item.value === SUPPRESSED
        return (
          <div
            key={item.label}
            className={cx("vv-kpi", !suppressed && item.tone && `vv-kpi--${item.tone}`)}
          >
            <span className="vv-kpi__label">{item.label}</span>
            <span
              className={cx(
                "vv-kpi__value",
                "vv-num",
                suppressed ? "vv-dim" : `vv-${item.provenance ?? "actual"}`,
              )}
            >
              {item.value}
            </span>
            {!suppressed && item.hint ? <span className="vv-kpi__hint">{item.hint}</span> : null}
          </div>
        )
      })}
    </div>
  )
}

// ── Form primitives ─────────────────────────────────────────────────────────

export interface FieldProps {
  label: string
  hint?: ReactNode
  error?: ReactNode
  htmlFor?: string
  children: ReactNode
}

export function Field({ label, hint, error, htmlFor, children }: FieldProps) {
  // Boolean() because `error` is a ReactNode — a bare `&&` would leak 0 or "".
  return (
    <div className={cx("vv-field", Boolean(error) && "vv-field--error")}>
      <label className="vv-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="vv-field__error">{error}</p>
      ) : hint ? (
        <p className="vv-field__hint">{hint}</p>
      ) : null}
    </div>
  )
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("vv-input", className)} {...rest} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("vv-input", "vv-select", className)} {...rest}>
      {children}
    </select>
  )
}

export interface ToolbarProps {
  children: ReactNode
  className?: string
}

export function Toolbar({ children, className }: ToolbarProps) {
  return <div className={cx("vv-toolbar", className)}>{children}</div>
}

// ── Page scaffolding ────────────────────────────────────────────────────────

export interface PageHeaderProps {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="vv-page__head">
      <div>
        <h1 className="vv-page__title">{title}</h1>
        {subtitle ? <p className="vv-page__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="vv-page__actions">{actions}</div> : null}
    </header>
  )
}

export function PageGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("vv-grid", className)}>{children}</div>
}
