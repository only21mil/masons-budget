import { formatUsd } from "@vogel-vault/domain/money"

export type BudgetProgressTone = "positive" | "warning" | "negative"

export interface BudgetProgressState {
  readonly tone: BudgetProgressTone
  readonly statusLabel: "ON TRACK" | "CLOSE" | "OVER"
  readonly percentageLabel: string
  readonly progressPercent: number
  readonly hasPositiveLimit: boolean
}

/**
 * Mirrors BudgetView.categoryCard on iOS using exact integer cents.
 *
 * iOS changes to CLOSE at 85%, changes to OVER only above 100%, caps the
 * displayed ratio at 200%, and truncates the remaining/over percentage. The
 * bar itself is capped at 100%. A non-positive limit has no meaningful ratio,
 * so it keeps the iOS zero-ratio guard without inventing a percentage.
 */
export function budgetProgressState(spent: bigint, limit: bigint): BudgetProgressState {
  if (limit <= 0n) {
    const over = spent > limit
    return {
      tone: over ? "negative" : "positive",
      statusLabel: over ? "OVER" : "ON TRACK",
      percentageLabel: "No positive limit",
      progressPercent: 0,
      hasPositiveLimit: false,
    }
  }

  const cappedSpent = spent > limit * 2n ? limit * 2n : spent
  const over = spent > limit
  const close = spent * 100n >= limit * 85n && !over
  const progressBasisPoints = cappedSpent <= 0n
    ? 0n
    : cappedSpent >= limit
      ? 10_000n
      : (cappedSpent * 10_000n) / limit

  if (over) {
    const overPercent = ((cappedSpent - limit) * 100n) / limit
    return {
      tone: "negative",
      statusLabel: "OVER",
      percentageLabel: `+${overPercent}% over`,
      progressPercent: Number(progressBasisPoints) / 100,
      hasPositiveLimit: true,
    }
  }

  const remainingPercent = ((limit - cappedSpent) * 100n) / limit
  return {
    tone: close ? "warning" : "positive",
    statusLabel: close ? "CLOSE" : "ON TRACK",
    percentageLabel: `${remainingPercent < 0n ? 0n : remainingPercent}% left`,
    progressPercent: Number(progressBasisPoints) / 100,
    hasPositiveLimit: true,
  }
}

export interface BudgetProgressProps {
  readonly category: string
  readonly spent: bigint
  readonly limit: bigint
}

export function BudgetProgress({ category, spent, limit }: BudgetProgressProps) {
  const state = budgetProgressState(spent, limit)
  const valueText = state.hasPositiveLimit
    ? `${state.statusLabel}, ${state.percentageLabel}`
    : `${state.statusLabel}, no positive limit; ${formatUsd(spent)} spent`

  return (
    <div className={`vv-budget-progress vv-budget-progress--${state.tone}`}>
      <div className="vv-budget-progress__labels">
        <span className="vv-budget-progress__status">{state.statusLabel}</span>
        <span className="vv-budget-progress__percentage">{state.percentageLabel}</span>
      </div>
      <div
        className="vv-budget-progress__track"
        role="progressbar"
        aria-label={`${category} budget use`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={state.progressPercent}
        aria-valuetext={valueText}
      >
        <span
          className="vv-budget-progress__fill"
          style={{ width: `${state.progressPercent}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
