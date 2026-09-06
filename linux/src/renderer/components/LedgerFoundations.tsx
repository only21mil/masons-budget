import type { HTMLAttributes, ReactNode, SVGProps } from "react"
import { useId } from "react"

import { cx } from "./cx.ts"

type VectorFrameProps = Omit<
  SVGProps<SVGSVGElement>,
  "aria-hidden" | "children" | "focusable" | "height" | "role" | "viewBox" | "width"
> & {
  readonly children: ReactNode
  readonly size?: number | string
  readonly title?: string
}

function VectorFrame({ children, size = 24, title, ...rest }: VectorFrameProps) {
  const titleId = useId()

  return (
    <svg
      {...rest}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? "img" : undefined}
      aria-labelledby={title ? titleId : undefined}
      aria-hidden={title ? undefined : "true"}
      focusable="false"
    >
      {title ? <title id={titleId}>{title}</title> : null}
      {children}
    </svg>
  )
}

export type LedgerVectorProps = Omit<VectorFrameProps, "children">

/** Locked Horizon mark from handoff turn 6, with full-canvas horizon rules. */
export function HorizonMark(props: LedgerVectorProps) {
  return (
    <VectorFrame {...props}>
      <rect width="24" height="24" fill="var(--vv-ledger-mark-tile)" />
      <g
        transform="translate(12 9.4) scale(0.435) translate(-13 -12.7)"
        fill="none"
        stroke="var(--vv-ledger-mark-stroke)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9.4 6h4.2c1.7 0 3 1.1 3 2.7 0 1.4-1 2.4-2.4 2.7 1.7.2 2.9 1.3 2.9 2.9 0 1.7-1.4 2.9-3.3 2.9H9.4V6z" />
        <path d="M9.4 11.4h4.6" />
        <path d="M11 3.2v2.8M11 19.4v2.8M13.6 3.2v2.8M13.6 19.4v2.8" />
      </g>
      <g fill="var(--vv-ledger-mark-stroke)">
        <rect x="0" y="15.1" width="24" height="1.6" fillOpacity=".5" />
        <rect x="0" y="17.6" width="24" height="1.25" fillOpacity=".3" />
        <rect x="0" y="19.75" width="24" height=".95" fillOpacity=".17" />
      </g>
    </VectorFrame>
  )
}

/** Exact proposed car glyph from the locked working prototype. */
export function CarGlyph(props: LedgerVectorProps) {
  return (
    <VectorFrame
      {...props}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 13.5 5 8h14l2 5.5v3.5h-2.6M3 13.5V17h2.6m0 0h11.8M5 13.5h14" />
      <path d="M5.6 17a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0M15 17a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0" />
    </VectorFrame>
  )
}

/** Exact proposed pet paw glyph from the locked working prototype. */
export function PawGlyph(props: LedgerVectorProps) {
  return (
    <VectorFrame
      {...props}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5.4 9.6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M10.4 7.6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M15.4 9.6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0" />
      <path d="M8.2 15.4c0-2.1 1.7-3.4 3.8-3.4s3.8 1.3 3.8 3.4c0 2.3-1.7 3.5-3.8 3.5s-3.8-1.2-3.8-3.5z" />
    </VectorFrame>
  )
}

export type PaymentRail = "lightning" | "on-chain"

/** Exact Bolt/Chain wire glyphs from Design/icons.jsx. */
export function PaymentRailGlyph({ rail, ...props }: LedgerVectorProps & { readonly rail: PaymentRail }) {
  return (
    <VectorFrame
      {...props}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {rail === "lightning" ? (
        <path d="M13 3 5 13h6l-1 8 8-10h-6l1-8z" />
      ) : (
        <>
          <rect x="3" y="8" width="7" height="8" rx="1.5" />
          <rect x="14" y="8" width="7" height="8" rx="1.5" />
          <path d="M10 12h4" />
        </>
      )}
    </VectorFrame>
  )
}

export interface LedgerScanlinesProps {
  readonly className?: string
  readonly enabled?: boolean
}

/**
 * Decorative only. The fixed accessibility and pointer-event contract must not
 * be weakened when a future screen connects this to the Scanlines setting.
 */
export function LedgerScanlines({ enabled = true, className }: LedgerScanlinesProps) {
  if (!enabled) return null

  return (
    <div
      className={cx("vv-ledger-scanlines", className)}
      aria-hidden="true"
      role="presentation"
    />
  )
}

export type LedgerSemanticTone = "neutral" | "bitcoin" | "positive" | "negative" | "unavailable"

export interface LedgerSemanticValueProps extends HTMLAttributes<HTMLSpanElement> {
  readonly children: ReactNode
  /** Spoken state such as "Gain", "Loss", "Bitcoin", or "Unavailable". */
  readonly meaning: string
  readonly tone?: LedgerSemanticTone
}

/** Pairs semantic colour with words so colour is never the only state signal. */
export function LedgerSemanticValue({
  children,
  className,
  meaning,
  tone = "neutral",
  ...rest
}: LedgerSemanticValueProps) {
  return (
    <span
      {...rest}
      className={cx("vv-ledger-semantic", `vv-ledger-semantic--${tone}`, className)}
    >
      <span className="vv-sr-only">{meaning}: </span>
      {children}
    </span>
  )
}
