import { formatUsd } from "@vogel-vault/domain/money"
import { budgetHealth } from "@vogel-vault/domain/finance"

export interface BudgetProgressProps {
  readonly category: string
  readonly spent: bigint
  readonly limit: bigint
}

export function BudgetProgress({ category, spent, limit }: BudgetProgressProps) {
  const health = budgetHealth(limit, spent)
  const progressPercent = health.barBasisPoints / 100
  const percentageLabel = limit <= 0n
    ? "No positive limit"
    : health.overPercent !== null
      ? `+${health.overPercent}% over`
      : `${health.remainingPercent}% left`
  const valueText = limit > 0n
    ? `${health.label}, ${percentageLabel}`
    : `${health.label}, no positive limit; ${formatUsd(spent)} spent`

  return (
    <div className={`vv-budget-progress vv-budget-progress--${health.status}`}>
      <div className="vv-budget-progress__labels">
        <span className="vv-budget-progress__status">{health.label}</span>
        <span className="vv-budget-progress__percentage">{percentageLabel}</span>
      </div>
      <div
        className="vv-budget-progress__track"
        role="progressbar"
        aria-label={`${category} budget use`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
        aria-valuetext={valueText}
      >
        <span
          className="vv-budget-progress__fill"
          style={{ width: `${progressPercent}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
