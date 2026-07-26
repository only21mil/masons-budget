// Every page in the cockpit renders five states: normal, stale, error, empty and
// loading. StateBlock is how the four non-normal ones are shown, so they look
// the same everywhere and none of them can be mistaken for real data.

import type { ReactNode } from "react"

import { IconGlyph, type IconName } from "./IconGlyph.tsx"
import { Badge, Button } from "./primitives.tsx"
import { cx } from "./cx.ts"

export type BlockState = "empty" | "error" | "stale" | "loading"

export interface StateBlockProps {
  state: BlockState
  title?: ReactNode
  detail?: ReactNode
  onRetry?: () => void
  className?: string
}

const DEFAULTS: Record<BlockState, { icon: IconName; title: string; detail: string }> = {
  empty: {
    icon: "circle-dashed",
    title: "Nothing here yet",
    detail: "No records have synced into this view.",
  },
  error: {
    icon: "alert",
    title: "Could not load",
    detail: "The last read from MC2 failed. Showing nothing rather than something wrong.",
  },
  stale: {
    icon: "circle-alert",
    title: "Showing stale data",
    detail: "The bridge has not refreshed recently. Treat these figures as out of date.",
  },
  loading: {
    icon: "refresh",
    title: "Loading",
    detail: "Reading from the local bridge.",
  },
}

export function StateBlock({ state, title, detail, onRetry, className }: StateBlockProps) {
  const fallback = DEFAULTS[state]
  // A failed read is the one state worth interrupting for; polite would queue it
  // behind whatever the user is already reading.
  const urgent = state === "error"
  return (
    <div
      className={cx("vv-state", `vv-state--${state}`, className)}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
    >
      <IconGlyph
        name={fallback.icon}
        size={22}
        className={cx("vv-state__icon", state === "loading" && "vv-state__icon--spin")}
      />
      <p className="vv-state__title">{title ?? fallback.title}</p>
      <p className="vv-state__detail">{detail ?? fallback.detail}</p>
      {onRetry && state !== "loading" ? (
        <Button icon="refresh" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  )
}

/** Skeleton rows for a table or list that is still loading. */
export function LoadingBlock({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx("vv-loading", className)} aria-busy="true" aria-live="polite">
      <span className="vv-sr-only">Loading</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="vv-loading__row" style={{ animationDelay: `${index * 60}ms` }} />
      ))}
    </div>
  )
}

/**
 * A compact freshness marker for panel headers. The cockpit never shows a number
 * without saying how much to trust it.
 */
export function FreshnessTag({
  status,
  updatedAt,
}: {
  status: "live" | "stale" | "error" | "empty" | "loading"
  updatedAt: number | null
}) {
  if (status === "live") {
    // The live tag shows a bare timestamp; that it means "synced" is carried by
    // the green pill and the tick, neither of which a screen reader reports.
    return (
      <Badge tone="positive" icon="check">
        <span className="vv-sr-only">Synced</span>
        {formatWhen(updatedAt)}
      </Badge>
    )
  }
  if (status === "stale") {
    return <Badge tone="warning" icon="circle-alert">Stale · {formatWhen(updatedAt)}</Badge>
  }
  if (status === "error") {
    return <Badge tone="negative" icon="alert">Read failed</Badge>
  }
  if (status === "loading") {
    return <Badge tone="info" icon="refresh">Loading</Badge>
  }
  return <Badge tone="neutral" icon="circle-dashed">No data</Badge>
}

function formatWhen(updatedAt: number | null): string {
  if (updatedAt === null) return "never"
  const deltaMs = Date.now() - updatedAt
  if (deltaMs < 60_000) return "just now"
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
