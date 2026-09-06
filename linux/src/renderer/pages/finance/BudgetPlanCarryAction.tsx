// "Copy August plan to September."
//
// Shown above the Budget figures only when the live plan lags the month the
// page is scoped to or the trusted current month, decided by the shared carry
// contract. The button opens a confirm dialog; confirming sends the one
// paired-device write. Success scopes the page to the new month; failure stays
// in the block in the standard banner.

import { formatUsd, sum } from "@vogel-vault/domain/money"
import type { Budget, Freshness } from "@vogel-vault/domain/readModel"
import { useId, useState } from "react"

import { useAppState } from "../../app/AppState.tsx"
import {
  Button,
  DialogFrame,
  StatusBanner,
  Panel,
  localMutationError,
} from "../../components/index.ts"
import {
  budgetMonthName,
  budgetPlanCarryRequest,
} from "../../data/budgetPlanCarry.ts"
import { stableId } from "../../data/mutations.ts"

export function BudgetPlanCarryAction({
  budget,
  status,
  selectedMonth,
}: {
  budget: Budget
  status: Freshness
  /** The month the page is scoped to. */
  selectedMonth: string
}) {
  const {
    activeProfile,
    currentMonth,
    isMutationPending,
    mutationGate,
    submitMutation,
  } = useAppState()
  const titleId = useId()
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only a live read carries the revision the copy fences on.
  if (status !== "live") return null
  // The request id is minted at submit time; a null here is the contract
  // withholding the action, so the block is not offered at all.
  const preview = budgetPlanCarryRequest({
    activeProfile,
    currentMonth,
    selectedMonth,
    budget,
    requestId: "preview",
  })
  if (preview === null) return null

  const gate = mutationGate("budgetPlan.copyForward", status, preview.owner)
  const pending = isMutationPending("budgetPlan.copyForward", preview.owner, preview.fromMonth)
  const busy = submitting || pending
  const fromName = budgetMonthName(preview.fromMonth)
  const toName = budgetMonthName(preview.toMonth)
  const planned = formatUsd(sum(budget.categories.map((category) => category.budget)))
  const count = budget.categories.length
  const detail =
    `Copy the ${fromName} plan forward: ${count} ${count === 1 ? "category" : "categories"}, ` +
    `${planned} planned. Transactions and income stay where they were recorded.`

  function cancel() {
    if (busy) return
    setConfirming(false)
  }

  async function confirm() {
    const request = budgetPlanCarryRequest({
      activeProfile,
      currentMonth,
      selectedMonth,
      budget,
      requestId: stableId("request"),
    })
    if (busy || !gate.allowed) return
    if (request === null) {
      setConfirming(false)
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await submitMutation(request)
    setSubmitting(false)
    const message = localMutationError(result)
    if (message === null) {
      setConfirming(false)
      return
    }
    setConfirming(false)
    setError(message)
  }

  return (
    <Panel title="Plan">
      <section aria-labelledby={titleId} aria-busy={busy || undefined}>
        <h2 id={titleId}>
          {toName} has no budget plan yet
        </h2>
        <p>{detail}</p>
        <div>
          <Button
            variant="primary"
            onClick={() => {
              setError(null)
              setConfirming(true)
            }}
            disabled={!gate.allowed || busy}
            title={gate.reason ?? undefined}
          >
            {`Copy ${fromName} plan to ${toName}`}
          </Button>
        </div>
        {error ? <StatusBanner tone="negative" title="Plan not copied" detail={error} /> : null}
        <DialogFrame
          open={confirming}
          title={`Copy ${fromName} plan to ${toName}?`}
          description={detail}
          onClose={cancel}
          busy={busy}
          footer={
            <>
              <Button onClick={cancel} disabled={busy}>{`Keep ${fromName}`}</Button>
              <Button variant="primary" onClick={() => void confirm()} disabled={!gate.allowed || busy} data-autofocus>
                {busy ? "Copying…" : `Confirm copy to ${toName}`}
              </Button>
            </>
          }
        >
          <p>
            The plan moves to {toName} in place. It keeps every category and amount,
            and {fromName} keeps its recorded transactions and income.
          </p>
        </DialogFrame>
      </section>
    </Panel>
  )
}
