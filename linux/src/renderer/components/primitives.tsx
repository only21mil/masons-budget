// Core presentational primitives for the Graphite Ledger Cockpit.
//
// Badge, Button, Panel, StatusBanner, KPIStrip and the form controls live here
// because they share one visual contract and are meaningless apart. Larger
// primitives (DataTable, StateBlock, DialogFrame, AppShell) have their own files.

import { createContext, useContext, useId } from "react"
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react"

import { useAppState } from "../app/AppState.tsx"
import { DISPLAY_UNITS } from "../data/bitcoinDisplay.ts"
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

/**
 * Warning and negative share one glyph and differ only in colour, so a screen
 * reader gets no severity at all. Spoken, not drawn — the visual design stands.
 */
const BANNER_TONE_WORD: Record<BannerTone, string> = {
  info: "Note",
  warning: "Warning",
  negative: "Error",
  positive: "Success",
}

export function StatusBanner({ tone = "info", title, detail, action, className }: StatusBannerProps) {
  const urgent = tone === "negative"
  return (
    <div
      className={cx("vv-banner", `vv-banner--${tone}`, className)}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
    >
      <IconGlyph name={BANNER_ICON[tone]} size={15} className="vv-banner__icon" />
      <div className="vv-banner__text">
        <span className="vv-banner__title">
          <span className="vv-sr-only">{BANNER_TONE_WORD[tone]}</span>
          {title}
        </span>
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

/**
 * Provenance is carried by colour alone (planned is muted, estimated is dim plus
 * a dashed rule). Say it out loud too, or an estimate reads as a settled figure.
 */
const PROVENANCE_WORD: Record<Provenance, string | null> = {
  actual: null,
  planned: "Planned figure",
  estimated: "Estimated figure",
}

export function KPIStrip({ items, className }: KPIStripProps) {
  return (
    <div className={cx("vv-kpis", className)}>
      {items.map((item) => {
        const suppressed = item.value === SUPPRESSED
        const provenanceWord = suppressed ? null : PROVENANCE_WORD[item.provenance ?? "actual"]
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
              {suppressed ? (
                <>
                  {/* An em dash is announced as nothing by most screen readers, so a
                      withheld figure would be indistinguishable from a blank cell.
                      Suppression exists to say "unknown", never "zero". */}
                  <span aria-hidden="true">{SUPPRESSED}</span>
                  <span className="vv-sr-only">Unavailable</span>
                </>
              ) : (
                item.value
              )}
            </span>
            {provenanceWord ? <span className="vv-sr-only">{provenanceWord}</span> : null}
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

interface FieldContextValue {
  readonly controlId: string
  readonly describedBy?: string
  readonly invalid: boolean
}

/**
 * Field hands its generated id down instead of relying on the caller.
 *
 * `htmlFor` was optional and no page passed it, so every <label> pointed at
 * nothing and the control it sits above had no accessible name — the children
 * are siblings of the label, not descendants, so the implicit-wrapping fallback
 * never applied either.
 */
const FieldContext = createContext<FieldContextValue | null>(null)

export function Field({ label, hint, error, htmlFor, children }: FieldProps) {
  const generatedId = useId()
  const controlId = htmlFor ?? generatedId
  const messageId = `${controlId}-message`
  // Boolean() because `error` is a ReactNode — a bare `&&` would leak 0 or "".
  const invalid = Boolean(error)
  const message = error ?? hint

  return (
    <div className={cx("vv-field", invalid && "vv-field--error")}>
      <label className="vv-field__label" htmlFor={controlId}>
        {label}
      </label>
      <FieldContext.Provider
        value={{ controlId, describedBy: message ? messageId : undefined, invalid }}
      >
        {children}
      </FieldContext.Provider>
      {error ? (
        <p className="vv-field__error" id={messageId}>
          {error}
        </p>
      ) : hint ? (
        <p className="vv-field__hint" id={messageId}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function TextInput({
  className,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  const field = useContext(FieldContext)
  return (
    <input
      className={cx("vv-input", className)}
      id={id ?? field?.controlId}
      aria-describedby={describedBy ?? field?.describedBy}
      aria-invalid={invalid ?? (field?.invalid || undefined)}
      {...rest}
    />
  )
}

export function Select({
  className,
  children,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const field = useContext(FieldContext)
  return (
    <select
      className={cx("vv-input", "vv-select", className)}
      id={id ?? field?.controlId}
      aria-describedby={describedBy ?? field?.describedBy}
      aria-invalid={invalid ?? (field?.invalid || undefined)}
      {...rest}
    >
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
  /** Financial pages opt in; operational/task/admin pages do not show money units. */
  showDisplayUnit?: boolean
}

export function PageHeader({
  title,
  subtitle,
  actions,
  showDisplayUnit = false,
}: PageHeaderProps) {
  const { displayUnit, setDisplayUnit } = useAppState()

  return (
    <header className="vv-page__head">
      <div>
        <h1 className="vv-page__title">{title}</h1>
        {subtitle ? <p className="vv-page__subtitle">{subtitle}</p> : null}
      </div>
      <div className="vv-page__actions">
        {showDisplayUnit ? (
          <div className="vv-unit-toggle" role="group" aria-label="Bitcoin display unit">
            {DISPLAY_UNITS.map((unit) => (
              <button
                key={unit.storageKey}
                type="button"
                className={cx(
                  "vv-unit-toggle__option",
                  unit.storageKey === displayUnit && "vv-unit-toggle__option--selected",
                )}
                aria-pressed={unit.storageKey === displayUnit}
                onClick={() => setDisplayUnit(unit.storageKey)}
              >
                {unit.label}
              </button>
            ))}
          </div>
        ) : null}
        {actions}
      </div>
    </header>
  )
}

export function PageGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("vv-grid", className)}>{children}</div>
}
