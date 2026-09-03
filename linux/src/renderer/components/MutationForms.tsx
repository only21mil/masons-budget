import { useEffect, useId, useMemo, useState } from "react"
import { netWorthScopeFor } from "@vogel-vault/domain/family"
import type {
  BTCAccount,
  BTCBuy,
  BudgetCategory,
  TodoItem,
  Transaction,
} from "@vogel-vault/domain/readModel"

import { useAppState } from "../app/AppState.tsx"
import {
  bitcoinBuyLinkFor,
  bitcoinPostingGate,
  formatCentsInput,
  mutationOwner,
  parseExactCents,
  parseExactSats,
  stableId,
} from "../data/mutations.ts"
import type { MutationGate } from "../data/mutations.ts"
import {
  PAYMENT_SOURCES,
  isBitcoinDenominatedSource,
  isPaymentSource,
  isRetiredBitcoinSource,
  paymentSourceBlockReason,
  paymentSourceChoiceTransition,
  paymentSourceFromRow,
  paymentSourceLabel,
  paymentSourceRoute,
  paymentSourceSupportedActivities,
  transactionSubmission,
  type PaymentSource,
  type TransactionFormState,
} from "../data/paymentSource.ts"
import {
  type BillPayBudgetEffect,
  type BillPayPrefill,
  type LinuxBillPay,
  BILL_PAY_BUDGET_EFFECT_LABELS,
  billPayBudgetTreatmentFor,
  billPayPrefillFor,
} from "../data/billPayBudgetEffect.ts"
import { localMutationError } from "./CrudControls.tsx"
import { DialogFrame } from "./DialogFrame.tsx"
import { Button, Field, Select, TextInput } from "./primitives.tsx"
// The local task day, not a UTC slice of the timestamp: forms open at 23:30 in
// Vancouver must pre-fill today's date, not tomorrow's.
import { localDateKey } from "../pages/tasks/taskClock.tsx"

function optional(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function today(): string {
  return localDateKey(new Date())
}

/** Select value for a stored card string the closed source list does not know. */
const LEGACY_SOURCE_CHOICE = "__legacy-card"

function legacyCardOf(transaction: Transaction | null): string {
  if (!transaction || paymentSourceFromRow(transaction)) return ""
  return transaction.card ?? ""
}

function initialSourceChoice(transaction: Transaction | null): string {
  const source = transaction ? paymentSourceFromRow(transaction) : null
  if (source) return source
  return legacyCardOf(transaction) ? LEGACY_SOURCE_CHOICE : ""
}

function FormFooter({
  formId,
  busy,
  blocked,
  blockedReasonId,
  onCancel,
  verb,
}: {
  formId: string
  busy: boolean
  blocked?: boolean
  blockedReasonId?: string
  onCancel: () => void
  verb: string
}) {
  return (
    <>
      <Button onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button
        variant="primary"
        type="submit"
        form={formId}
        disabled={busy || blocked}
        aria-describedby={blocked ? blockedReasonId : undefined}
      >
        {busy ? "Saving…" : verb}
      </Button>
    </>
  )
}

function ErrorSummary({ error }: { error: string | null }) {
  return error ? <p className="vv-form-error" role="alert">{error}</p> : null
}

/**
 * The canonical River account, or null when it is missing or ambiguous.
 *
 * A Bitcoin buy posts to River and nowhere else, so this names the account the
 * purchase will credit rather than offering a choice the write cannot honour.
 * Matching key or label mirrors the server's own resolution, and more than one
 * match is refused for the same reason it is refused there: the credit would be
 * going somewhere nobody chose.
 */
export function canonicalRiverAccount(
  accounts: readonly BTCAccount[],
): BTCAccount | null {
  const matches = accounts.filter(
    (account) =>
      account.key.trim().toLocaleLowerCase("en-US") === "river" ||
      account.label.trim().toLocaleLowerCase("en-US") === "river",
  )
  return matches.length === 1 ? matches[0]! : null
}

export function TransactionFormDialog({
  open,
  transaction,
  defaultCategory,
  submissionGate,
  onRecordAsBillPay,
  onClose,
}: {
  open: boolean
  transaction: Transaction | null
  /** Opens the dialog on a category, so the Budget tab can add income directly. */
  defaultCategory?: string
  submissionGate?: MutationGate
  /**
   * Hands a River selection to the bill-pay form instead of dead-ending on the
   * pointer to the Bills page. The host owns both dialogs, so it closes this one
   * and opens that one; nothing is written here. Without a handler the River
   * selection stays blocked exactly as before.
   */
  onRecordAsBillPay?: (prefill: BillPayPrefill) => void
  onClose: () => void
}) {
  const { activeProfile, data, mutationCapabilities, submitMutation } = useAppState()
  const formId = useId()
  const blockedReasonId = useId()
  const [id, setId] = useState(() => transaction?.id ?? stableId("transaction"))
  const [date, setDate] = useState(transaction?.date ?? today())
  const [merchant, setMerchant] = useState(transaction?.merchant ?? "")
  const [amount, setAmount] = useState(
    transaction ? formatCentsInput(transaction.amount < 0n ? -transaction.amount : transaction.amount) : "",
  )
  const [transactionKind, setTransactionKind] = useState<"spend" | "credit">(
    transaction && transaction.amount < 0n ? "credit" : "spend",
  )
  const [category, setCategory] = useState(
    transaction?.category ?? defaultCategory ?? "Other",
  )
  const [sourceChoice, setSourceChoice] = useState(() => initialSourceChoice(transaction))
  const [bitcoinAccountKey, setBitcoinAccountKey] = useState(
    transaction?.bitcoinAccountKey ?? "",
  )
  const [note, setNote] = useState(transaction?.note ?? "")
  const [sats, setSats] = useState(transaction?.amountSats?.toString() ?? "")
  const [asBitcoinBuy, setAsBitcoinBuy] = useState(false)
  const [buySats, setBuySats] = useState("")
  const [buyPrice, setBuyPrice] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const riverAccount = canonicalRiverAccount(
    data.btcBalanceDocument.value?.accounts ?? [],
  )

  const isIncome = category.trim() === "Income"
  // Editing an existing row cannot switch it onto the paired write: the pair is
  // keyed by one shared id, and an already-stored transaction id is not it.
  const buyAvailable = isIncome && transaction === null
  // A linked income has no payment source: the write is btcBuy.upsert, not
  // transaction.upsert. So the whole source machinery stands down here, and a
  // selection left over from before the box was ticked neither shows nor blocks.
  const recordingBitcoinBuy = buyAvailable && asBitcoinBuy

  // Preserved verbatim so editing an unrelated field never rewrites a card
  // string this build does not recognise.
  const legacyCard = useMemo(() => legacyCardOf(transaction), [transaction])
  // The ledger this row lands on, canonicalised the same way the write is:
  // Victor and Rachel share the adult household, and an adult editing a Mason
  // row is spending Mason's Bitcoin.
  const ledgerScopeOwner = mutationOwner(
    "transaction.upsert",
    transaction?.owner ?? activeProfile,
  )
  // Net-worth scope, not visibility. An adult can SEE Mason's accounts, but a
  // household row may only be paid from the household's own stack — offering
  // Mason's account here let an adult debit a child's Bitcoin by accident.
  const bitcoinAccounts = useMemo(
    () => netWorthScopeFor(ledgerScopeOwner, data.btcAccounts.value),
    [ledgerScopeOwner, data.btcAccounts.value],
  )
  const selectedSource: PaymentSource | null =
    !recordingBitcoinBuy && isPaymentSource(sourceChoice) ? sourceChoice : null
  const offeredPaymentSources = PAYMENT_SOURCES.filter((source) =>
    !isIncome || paymentSourceSupportedActivities(source).includes("income")
  )
  // Bitcoin-native sources post a debit or credit on the transaction row.
  // River Bitcoin Bill Pay writes a different table and does not qualify here.
  const bitcoinNativeRow = selectedSource !== null &&
    isBitcoinDenominatedSource(selectedSource) &&
    paymentSourceRoute(selectedSource) === "transaction"
  const satsValue = sats.trim() ? parseExactSats(sats) : null
  const amountCents = parseExactCents(amount)
  const formState: TransactionFormState = {
    source: selectedSource,
    legacyCard: sourceChoice === LEGACY_SOURCE_CHOICE ? legacyCard : "",
    amountSats: satsValue,
    bitcoinAccountKey,
    kind: isIncome ? "credit" : transactionKind,
    category,
  }
  const sourceBlockReason = paymentSourceBlockReason(formState)
  // One pure builder decides every source field the save sends, so the button,
  // the capability gate and the payload cannot disagree about them.
  const submission = transactionSubmission(formState)
  // The row will carry amountSats from a Bitcoin-native source or untyped Income.
  // Those need the Bitcoin grant on top of transaction.upsert;
  // a USD-only card transaction does not. A blocked Bitcoin source still counts:
  // the grant is missing whether or not the sats have been typed yet.
  const postsBitcoin = bitcoinNativeRow ||
    (!recordingBitcoinBuy && submission.amountSats !== undefined)
  const retiredBitcoinRow = selectedSource === null &&
    isRetiredBitcoinSource(legacyCard) &&
    submission.amountSats !== undefined &&
    submission.bitcoinAccountKey !== undefined
  const ownerScopedBitcoinPosting = bitcoinNativeRow || retiredBitcoinRow
  const bitcoinCapability = postsBitcoin
    ? bitcoinPostingGate(
        mutationCapabilities,
        ownerScopedBitcoinPosting ? ledgerScopeOwner : undefined,
      )
    : null
  // River is a hand-off, not a save, so its own block never disables the button
  // it offers; the capability block cannot be typed away and comes first.
  const blockedReason = submissionGate && !submissionGate.allowed
    ? submissionGate.reason ?? "Current live transaction rows are required before editing."
    : bitcoinCapability !== null && !bitcoinCapability.allowed
      ? bitcoinCapability.reason
      : sourceBlockReason
  const riverHandoff = selectedSource !== null &&
    paymentSourceRoute(selectedSource) === "btc_bill_pay" &&
    onRecordAsBillPay !== undefined
  // The bill pay needs the same floor a transaction save needs; the sats, the
  // BTC price, and the fee are still the user's to enter on the other side.
  const handoffPrefill = riverHandoff &&
    merchant.trim() !== "" &&
    date !== "" &&
    category.trim() !== "" &&
    amountCents !== null &&
    amountCents > 0n
    ? billPayPrefillFor({ date, merchant, amountUsd: amountCents, category })
    : null

  useEffect(() => {
    if (!open) return
    setId(transaction?.id ?? stableId("transaction"))
    setDate(transaction?.date ?? today())
    setMerchant(transaction?.merchant ?? "")
    setAmount(
      transaction
        ? formatCentsInput(transaction.amount < 0n ? -transaction.amount : transaction.amount)
        : "",
    )
    setTransactionKind(transaction && transaction.amount < 0n ? "credit" : "spend")
    setCategory(transaction?.category ?? defaultCategory ?? "Other")
    setSourceChoice(initialSourceChoice(transaction))
    setBitcoinAccountKey(transaction?.bitcoinAccountKey ?? "")
    setNote(transaction?.note ?? "")
    setSats(transaction?.amountSats?.toString() ?? "")
    setAsBitcoinBuy(false)
    setBuySats("")
    setBuyPrice("")
    setError(null)
  }, [defaultCategory, open, transaction])

  /**
   * Switch payment source, dropping Bitcoin-source state the new one cannot use.
   *
   * Both fields belong to a Bitcoin-denominated source and are hidden for any
   * other choice. Leaving them set would keep the form blocked on a field the
   * user can no longer see, and hand the payload builder sats the new source
   * has no business carrying.
   */
  function chooseSource(next: string) {
    const nextState = paymentSourceChoiceTransition(
      { sourceChoice, sats, bitcoinAccountKey },
      next,
      {
        choice: LEGACY_SOURCE_CHOICE,
        card: legacyCard,
        amountSats: transaction?.amountSats,
        bitcoinAccountKey: transaction?.bitcoinAccountKey,
      },
    )
    setSourceChoice(nextState.sourceChoice)
    if (nextState.sats !== sats) setSats(nextState.sats)
    if (nextState.bitcoinAccountKey !== bitcoinAccountKey) {
      setBitcoinAccountKey(nextState.bitcoinAccountKey)
    }
  }

  async function submit() {
    if (submissionGate && !submissionGate.allowed) {
      setError(submissionGate.reason ?? "Current live transaction rows are required before editing.")
      return
    }
    const cents = amountCents
    if (!merchant.trim() || !date || cents === null || cents <= 0n || !category.trim()) {
      setError("Enter a date, merchant, category, and a positive amount with at most two decimals.")
      return
    }
    // Ahead of the payment-source and sat-Income checks, which belong to the
    // transaction row this path never writes.
    if (recordingBitcoinBuy) {
      if (!riverAccount) {
        setError("The canonical River account is unavailable, so the purchase has nowhere to land.")
        return
      }
      // One write. The buy carries the income beside it and is the only balance
      // posting, so no separate sat-denominated Income row is sent.
      const linked = bitcoinBuyLinkFor({
        recordAsBitcoinBuy: true,
        requestId: stableId("request"),
        id,
        actor: activeProfile,
        // Always a create, so there is no stored owner to preserve.
        owner: activeProfile,
        date,
        category: category.trim(),
        amountCents: cents,
        // The buy names the account it credits; the income names who paid.
        buySource: riverAccount.label,
        incomeSource: merchant.trim(),
        sats: parseExactSats(buySats),
        priceUsdCents: parseExactCents(buyPrice),
        note: optional(note),
      })
      if (!linked) {
        setError("Enter positive whole sats and a positive price per BTC for the purchase.")
        return
      }
      setBusy(true)
      const linkedResult = await submitMutation(linked)
      setBusy(false)
      const linkedMessage = localMutationError(linkedResult)
      setError(linkedMessage)
      if (!linkedMessage) onClose()
      return
    }

    if (bitcoinCapability !== null && !bitcoinCapability.allowed) {
      setError(bitcoinCapability.reason)
      return
    }
    if (sourceBlockReason) {
      setError(sourceBlockReason)
      return
    }
    // Only meaningful while the sats field IS the sat-Income field: with a
    // chosen source the builder ignores a stale value rather than refusing it.
    if (
      selectedSource === null &&
      !isRetiredBitcoinSource(formState.legacyCard) &&
      sats.trim() &&
      (category.trim() !== "Income" || satsValue === null || satsValue <= 0n)
    ) {
      setError("Bitcoin income must use the Income category and a positive whole-sats amount.")
      return
    }
    setBusy(true)
    const signed =
      category.trim() === "Income" || transactionKind === "spend" ? cents : -cents
    const sourceFields = submission
    const amountSats = sourceFields.amountSats
    const result = await submitMutation({
      kind: "transaction.upsert",
      requestId: stableId("request"),
      actor: activeProfile,
      id,
      owner: mutationOwner("transaction.upsert", transaction?.owner ?? activeProfile),
      date,
      merchant: merchant.trim(),
      amountCents: signed,
      transactionKind: category.trim() === "Income" ? "credit" : transactionKind,
      category: category.trim(),
      card: sourceFields.card,
      note: optional(note),
      ...(amountSats === undefined ? {} : { amountSats }),
      ...(sourceFields.bitcoinAccountKey === undefined
        ? {}
        : { bitcoinAccountKey: sourceFields.bitcoinAccountKey }),
      ...(transaction ? { baseUpdatedAtMs: transaction.updatedAtMs } : {}),
    })
    setBusy(false)
    const message = localMutationError(result)
    setError(message)
    if (!message) onClose()
  }

  return (
    <DialogFrame
      open={open}
      title={transaction ? "Edit transaction" : "Add transaction"}
      description="Stored amounts use exact cents. Purchases are positive; credits reduce spend."
      onClose={onClose}
      busy={busy}
      footer={(
        <FormFooter
          formId={formId}
          busy={busy}
          blocked={blockedReason !== null}
          blockedReasonId={blockedReasonId}
          onCancel={onClose}
          verb="Save transaction"
        />
      )}
    >
      <form id={formId} className="vv-form-grid" onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}>
        {blockedReason ? (
          <p id={blockedReasonId} className="vv-form-error" role="status">{blockedReason}</p>
        ) : null}
        {riverHandoff ? (
          <Button
            variant="primary"
            disabled={busy || handoffPrefill === null}
            title={
              handoffPrefill === null
                ? "Enter a date, payee, category, and a positive amount first."
                : undefined
            }
            onClick={() => {
              if (handoffPrefill === null) return
              onRecordAsBillPay?.(handoffPrefill)
            }}
          >
            Record as River bill payment
          </Button>
        ) : null}
        <ErrorSummary error={error} />
        <Field label="Record ID" hint="Stable and immutable after creation.">
          <TextInput value={id} readOnly />
        </Field>
        <Field label="Date"><TextInput data-autofocus type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Merchant"><TextInput value={merchant} onChange={(e) => setMerchant(e.target.value)} /></Field>
        <Field label="Amount (USD)" hint="For example, 12.34.">
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Kind">
          <Select value={transactionKind} onChange={(e) => setTransactionKind(e.target.value as "spend" | "credit")}>
            <option value="spend">Spend</option>
            <option value="credit">Credit or refund</option>
          </Select>
        </Field>
        <Field label="Category"><TextInput value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
        {buyAvailable ? (
          <Field
            label="Bitcoin"
            hint="One save records the income and the purchase together."
          >
            <label>
              <input
                type="checkbox"
                checked={asBitcoinBuy}
                onChange={(e) => setAsBitcoinBuy(e.target.checked)}
              /> Record as Bitcoin buy
            </label>
          </Field>
        ) : null}
        {recordingBitcoinBuy ? (
          <>
            <Field
              label="Bitcoin account"
              hint="A purchase credits the canonical River account and no other."
            >
              <TextInput
                value={riverAccount?.label ?? "Unavailable"}
                readOnly
              />
            </Field>
            <Field label="Sats purchased">
              <TextInput inputMode="numeric" value={buySats} onChange={(e) => setBuySats(e.target.value)} />
            </Field>
            <Field label="Price per BTC (USD)">
              <TextInput inputMode="decimal" value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)} />
            </Field>
          </>
        ) : (
          <Field
            label="Payment source"
            hint={isIncome
              ? "Where the Bitcoin arrives. Stored with the transaction."
              : "Where the money leaves from. Stored with the transaction."}
          >
            <Select value={sourceChoice} onChange={(e) => chooseSource(e.target.value)}>
              <option value="">No source</option>
              {legacyCard ? <option value={LEGACY_SOURCE_CHOICE}>{legacyCard}</option> : null}
              {offeredPaymentSources.map((source) => (
                <option key={source} value={source}>{paymentSourceLabel(source)}</option>
              ))}
            </Select>
          </Field>
        )}
        {bitcoinNativeRow ? (
          <>
            <Field
              label={isIncome ? "Bitcoin received (sats)" : "Bitcoin spent (sats)"}
              hint={isIncome
                ? "Required. Exact whole sats entering the selected Bitcoin source."
                : "Required. Exact whole sats leaving the selected Bitcoin source."}
            >
              <TextInput
                inputMode="numeric"
                value={sats}
                aria-invalid={satsValue === null || satsValue <= 0n || undefined}
                onChange={(e) => setSats(e.target.value)}
              />
            </Field>
            <Field
              label="Bitcoin account"
              hint={isIncome
                ? "Required. The account these sats enter."
                : "Required. The account these sats leave."}
            >
              <Select
                value={bitcoinAccountKey}
                aria-invalid={!bitcoinAccountKey.trim() || undefined}
                onChange={(e) => setBitcoinAccountKey(e.target.value)}
              >
                <option value="">Choose an account</option>
                {bitcoinAccounts.map((account) => (
                  <option key={account.key} value={account.key}>{account.label}</option>
                ))}
              </Select>
            </Field>
          </>
        ) : isIncome && !recordingBitcoinBuy ? (
          <Field
            label="Bitcoin received (sats)"
            hint="Optional. When present, these exact sats are added to River. USD-only income does not invent Bitcoin."
          >
            <TextInput inputMode="numeric" value={sats} onChange={(e) => setSats(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Note"><TextInput value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </form>
    </DialogFrame>
  )
}

export function TodoFormDialog({
  open,
  todo,
  defaultDue,
  onClose,
}: {
  open: boolean
  todo: TodoItem | null
  defaultDue?: string
  onClose: () => void
}) {
  const { activeProfile, submitMutation } = useAppState()
  const formId = useId()
  const [id, setId] = useState(() => todo?.id ?? stableId("todo"))
  const [title, setTitle] = useState(todo?.title ?? "")
  const [project, setProject] = useState(todo?.project ?? "")
  const [area, setArea] = useState(todo?.area ?? "")
  const [due, setDue] = useState(todo?.due ?? defaultDue ?? "")
  const [notes, setNotes] = useState(todo?.notes ?? "")
  const [flagged, setFlagged] = useState(todo?.flagged ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setId(todo?.id ?? stableId("todo"))
    setTitle(todo?.title ?? "")
    setProject(todo?.project ?? "")
    setArea(todo?.area ?? "")
    setDue(todo?.due ?? defaultDue ?? "")
    setNotes(todo?.notes ?? "")
    setFlagged(todo?.flagged ?? false)
    setError(null)
  }, [defaultDue, open, todo])

  async function submit() {
    if (!title.trim()) {
      setError("Enter a task title.")
      return
    }
    setBusy(true)
    const result = await submitMutation({
      kind: "todo.upsert",
      requestId: stableId("request"),
      actor: activeProfile,
      id,
      owner: todo?.owner ?? activeProfile,
      title: title.trim(),
      done: todo?.done ?? false,
      flagged,
      project: optional(project),
      area: optional(area),
      due: optional(due),
      notes: optional(notes),
      lane: todo?.lane ?? undefined,
      priority: todo?.priority ?? undefined,
      createdAt: todo?.createdAt ?? undefined,
      updatedAt: todo?.updatedAt ?? undefined,
      completedAt: todo?.completedAt ?? undefined,
      ...(todo ? { baseUpdatedAtMs: todo.updatedAtMs } : {}),
    })
    setBusy(false)
    const message = localMutationError(result)
    setError(message)
    if (!message) onClose()
  }

  return (
    <DialogFrame
      open={open}
      title={todo ? "Edit task" : "Add task"}
      description="Task identity and owner remain fixed after creation."
      onClose={onClose}
      busy={busy}
      footer={<FormFooter formId={formId} busy={busy} onCancel={onClose} verb="Save task" />}
    >
      <form id={formId} className="vv-form-grid" onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}>
        <ErrorSummary error={error} />
        <Field label="Task" htmlFor={`${formId}-title`}>
          <TextInput id={`${formId}-title`} data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Due date"><TextInput type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Project"><TextInput value={project} onChange={(e) => setProject(e.target.value)} /></Field>
        <Field label="Area"><TextInput value={area} onChange={(e) => setArea(e.target.value)} /></Field>
        <Field label="Notes"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <Field label="Attention">
          <label><input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} /> Flag this task</label>
        </Field>
      </form>
    </DialogFrame>
  )
}

export function BudgetCategoryFormDialog({
  open,
  category,
  month,
  onClose,
}: {
  open: boolean
  category: BudgetCategory | null
  month: string
  onClose: () => void
}) {
  const { activeProfile, data, submitMutation } = useAppState()
  const formId = useId()
  const [name, setName] = useState(category?.name ?? "")
  const [icon, setIcon] = useState(category?.icon ?? "")
  const [amount, setAmount] = useState(category ? formatCentsInput(category.budget) : "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(category?.name ?? "")
    setIcon(category?.icon ?? "")
    setAmount(category ? formatCentsInput(category.budget) : "")
    setError(null)
  }, [category, open])

  async function submit() {
    const cents = parseExactCents(amount)
    if (!name.trim() || cents === null || cents < 0n) {
      setError("Enter a category name and a non-negative planned amount.")
      return
    }
    setBusy(true)
    const result = await submitMutation({
      kind: "budgetCategory.upsert",
      requestId: stableId("request"),
      actor: activeProfile,
      owner: mutationOwner("budgetCategory.upsert", data.budget.value?.owner ?? activeProfile),
      month,
      name: name.trim(),
      ...(category ? { originalName: category.name } : {}),
      icon: optional(icon),
      budgetCents: cents,
      ...(data.budget.value
        ? { baseUpdatedAtMs: data.budget.value.updatedAtMs }
        : {}),
    })
    setBusy(false)
    const message = localMutationError(result)
    setError(message)
    if (!message) onClose()
  }

  return (
    <DialogFrame
      open={open}
      title={category ? "Edit budget category" : "Add budget category"}
      description={`Planned amount for ${month}. Actual spend remains transaction-derived.`}
      onClose={onClose}
      busy={busy}
      footer={<FormFooter formId={formId} busy={busy} onCancel={onClose} verb="Save category" />}
    >
      <form id={formId} className="vv-form-grid" onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}>
        <ErrorSummary error={error} />
        <Field label="Category" hint={category ? "Immutable while editing." : undefined}>
          <TextInput data-autofocus value={name} readOnly={Boolean(category)} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Icon name"><TextInput value={icon} onChange={(e) => setIcon(e.target.value)} /></Field>
        <Field label="Planned amount (USD)">
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </form>
    </DialogFrame>
  )
}

export function BtcBuyFormDialog({
  open,
  buy,
  onClose,
}: {
  open: boolean
  buy: BTCBuy | null
  onClose: () => void
}) {
  const { activeProfile, submitMutation } = useAppState()
  const formId = useId()
  const [id, setId] = useState(() => buy?.id ?? stableId("buy"))
  const [date, setDate] = useState(buy?.date ?? today())
  const [source, setSource] = useState(buy?.source ?? "")
  const [sats, setSats] = useState(buy?.sats.toString() ?? "")
  const [price, setPrice] = useState(buy ? formatCentsInput(buy.priceUsd) : "")
  const [cost, setCost] = useState(buy ? formatCentsInput(buy.usd) : "")
  const [note, setNote] = useState(buy?.note ?? "")
  const [basis, setBasis] = useState(buy?.costBasisStatus ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setId(buy?.id ?? stableId("buy"))
    setDate(buy?.date ?? today())
    setSource(buy?.source ?? "")
    setSats(buy?.sats.toString() ?? "")
    setPrice(buy ? formatCentsInput(buy.priceUsd) : "")
    setCost(buy ? formatCentsInput(buy.usd) : "")
    setNote(buy?.note ?? "")
    setBasis(buy?.costBasisStatus ?? "")
    setError(null)
  }, [buy, open])

  async function submit() {
    const satsValue = parseExactSats(sats)
    const priceValue = parseExactCents(price)
    const costValue = parseExactCents(cost)
    if (!date || !source.trim() || !satsValue || !priceValue || !costValue || satsValue <= 0n || priceValue <= 0n || costValue <= 0n) {
      setError("Enter a date, source, positive whole sats, price, and cost.")
      return
    }
    setBusy(true)
    const result = await submitMutation({
      kind: "btcBuy.upsert",
      requestId: stableId("request"),
      actor: activeProfile,
      id,
      owner: mutationOwner("btcBuy.upsert", buy?.owner ?? activeProfile),
      date,
      source: source.trim(),
      sats: satsValue,
      priceUsdCents: priceValue,
      usdCents: costValue,
      note: optional(note),
      buyStatus: buy?.status ?? undefined,
      costBasisStatus: optional(basis),
      loggedBy: buy?.loggedBy ?? undefined,
      archimedesRequestId: buy?.archimedesRequestId ?? undefined,
      ...(buy ? { baseUpdatedAtMs: buy.updatedAtMs } : {}),
    })
    setBusy(false)
    const message = localMutationError(result)
    setError(message)
    if (!message) onClose()
  }

  return (
    <DialogFrame
      open={open}
      title={buy ? "Edit Bitcoin buy" : "Add Bitcoin buy"}
      description="Sats and USD values are stored exactly; average cost remains derived."
      onClose={onClose}
      busy={busy}
      footer={<FormFooter formId={formId} busy={busy} onCancel={onClose} verb="Save buy" />}
    >
      <form id={formId} className="vv-form-grid" onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}>
        <ErrorSummary error={error} />
        <Field label="Record ID"><TextInput value={id} readOnly /></Field>
        <Field label="Date"><TextInput data-autofocus type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Source"><TextInput value={source} onChange={(e) => setSource(e.target.value)} /></Field>
        <Field label="Sats"><TextInput inputMode="numeric" value={sats} onChange={(e) => setSats(e.target.value)} /></Field>
        <Field label="Price per BTC (USD)"><TextInput inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="Total cost (USD)"><TextInput inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
        <Field label="Cost basis status"><TextInput value={basis} onChange={(e) => setBasis(e.target.value)} /></Field>
        <Field label="Note"><TextInput value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </form>
    </DialogFrame>
  )
}

export function BillPayFormDialog({
  open,
  payment,
  prefill,
  onClose,
}: {
  open: boolean
  payment: LinuxBillPay | null
  /**
   * Seed values for a new bill pay, handed over by the transaction form. A
   * stored row always wins, so an edit is never overwritten by a stale hand-off.
   */
  prefill?: BillPayPrefill
  onClose: () => void
}) {
  const { activeProfile, submitMutation } = useAppState()
  const formId = useId()
  const seed = payment === null ? prefill ?? null : null
  const [id, setId] = useState(() => payment?.id ?? stableId("bill"))
  const [date, setDate] = useState(payment?.date ?? seed?.date ?? today())
  const [merchant, setMerchant] = useState(payment?.merchant ?? seed?.merchant ?? "")
  // A row written before the amendment decodes as credit_card_payment, so an
  // edit of one opens on that option rather than silently promoting it into a
  // budget it never came out of.
  const [budgetEffect, setBudgetEffect] = useState<BillPayBudgetEffect>(
    payment?.budgetEffect ?? seed?.budgetEffect ?? "budget_category",
  )
  const [category, setCategory] = useState(payment?.category ?? seed?.category ?? "Bills")
  const [amount, setAmount] = useState(
    payment ? formatCentsInput(payment.amountUsd) : seed ? formatCentsInput(seed.amountUsd) : "",
  )
  const [sats, setSats] = useState(payment?.btcSpentSats.toString() ?? "")
  const [price, setPrice] = useState(payment ? formatCentsInput(payment.btcPrice) : "")
  const [fee, setFee] = useState(payment ? formatCentsInput(payment.feeUsd) : "0.00")
  const [platform, setPlatform] = useState(payment?.platform ?? seed?.platform ?? "")
  const [reference, setReference] = useState(payment?.reference ?? "")
  const [note, setNote] = useState(payment?.note ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const treatment = billPayBudgetTreatmentFor({ budgetEffect, category })

  useEffect(() => {
    if (!open) return
    setId(payment?.id ?? stableId("bill"))
    setDate(payment?.date ?? seed?.date ?? today())
    setMerchant(payment?.merchant ?? seed?.merchant ?? "")
    setBudgetEffect(payment?.budgetEffect ?? seed?.budgetEffect ?? "budget_category")
    setCategory(payment?.category ?? seed?.category ?? "Bills")
    setAmount(
      payment ? formatCentsInput(payment.amountUsd) : seed ? formatCentsInput(seed.amountUsd) : "",
    )
    setSats(payment?.btcSpentSats.toString() ?? "")
    setPrice(payment ? formatCentsInput(payment.btcPrice) : "")
    setFee(payment ? formatCentsInput(payment.feeUsd) : "0.00")
    setPlatform(payment?.platform ?? seed?.platform ?? "")
    setReference(payment?.reference ?? "")
    setNote(payment?.note ?? "")
    setError(null)
  }, [open, payment, seed])

  async function submit() {
    const amountValue = parseExactCents(amount)
    const satsValue = parseExactSats(sats)
    const priceValue = parseExactCents(price)
    const feeValue = parseExactCents(fee)
    if (!date || !merchant.trim() || !treatment.category || !amountValue || !satsValue || !priceValue || feeValue === null || amountValue <= 0n || satsValue <= 0n || priceValue <= 0n || feeValue < 0n) {
      setError("Enter positive payment, sats, and price values; the fee may be zero.")
      return
    }
    setBusy(true)
    const result = await submitMutation({
      kind: "btcBillPay.upsert",
      requestId: stableId("request"),
      actor: activeProfile,
      id,
      owner: mutationOwner("btcBillPay.upsert", payment?.owner ?? activeProfile),
      date,
      merchant: merchant.trim(),
      // Both fields come from the one seam, so the stored category and the
      // stored effect can never disagree.
      category: treatment.category,
      budgetEffect: treatment.effect,
      amountUsdCents: amountValue,
      btcSpentSats: satsValue,
      btcPriceCents: priceValue,
      feeUsdCents: feeValue,
      platform: optional(platform),
      reference: optional(reference),
      note: optional(note),
      ...(payment ? { baseUpdatedAtMs: payment.updatedAtMs } : {}),
    })
    setBusy(false)
    const message = localMutationError(result)
    setError(message)
    if (!message) onClose()
  }

  return (
    <DialogFrame
      open={open}
      title={payment ? "Edit bill payment" : "Add bill payment"}
      description="The stored USD, sats, price, and fee are exact ledger values."
      onClose={onClose}
      busy={busy}
      footer={<FormFooter formId={formId} busy={busy} onCancel={onClose} verb="Save payment" />}
    >
      <form id={formId} className="vv-form-grid" onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}>
        <ErrorSummary error={error} />
        <Field label="Record ID"><TextInput value={id} readOnly /></Field>
        <Field label="Date"><TextInput data-autofocus type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Payee"><TextInput value={merchant} onChange={(e) => setMerchant(e.target.value)} /></Field>
        <Field
          label="Budget effect"
          hint="A budget category payment comes out of that category for this month. A credit card payment does not touch the budget."
        >
          <Select
            value={budgetEffect}
            onChange={(e) => setBudgetEffect(e.target.value as BillPayBudgetEffect)}
          >
            <option value="budget_category">
              {BILL_PAY_BUDGET_EFFECT_LABELS.budget_category}
            </option>
            <option value="credit_card_payment">
              {BILL_PAY_BUDGET_EFFECT_LABELS.credit_card_payment}
            </option>
          </Select>
        </Field>
        {treatment.categorySelectable ? (
          <Field label="Category">
            <TextInput value={category} onChange={(e) => setCategory(e.target.value)} />
          </Field>
        ) : (
          <Field label="Category" hint="Fixed for a credit card payment.">
            <TextInput value={treatment.category} readOnly />
          </Field>
        )}
        <Field label="Amount (USD)"><TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Sats spent"><TextInput inputMode="numeric" value={sats} onChange={(e) => setSats(e.target.value)} /></Field>
        <Field label="BTC price (USD)"><TextInput inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="Fee (USD)"><TextInput inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
        <Field label="Platform"><TextInput value={platform} onChange={(e) => setPlatform(e.target.value)} /></Field>
        <Field label="Reference"><TextInput value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <Field label="Note"><TextInput value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </form>
    </DialogFrame>
  )
}

export function BtcTransferFormDialog({
  open,
  submissionGate,
  onClose,
}: {
  open: boolean
  submissionGate?: MutationGate
  onClose: () => void
}) {
  const { activeProfile, data, submitMutation } = useAppState()
  const formId = useId()
  const blockedReasonId = useId()
  const accounts = useMemo(
    () => data.btcBalanceDocument.value?.accounts ?? [],
    [data.btcBalanceDocument.value],
  )
  const [id, setId] = useState(() => stableId("btc-transfer"))
  const [date, setDate] = useState(today())
  const [fromAccountKey, setFromAccountKey] = useState("")
  const [toAccountKey, setToAccountKey] = useState("")
  const [sats, setSats] = useState("")
  const [feeSats, setFeeSats] = useState("0")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setId(stableId("btc-transfer"))
    setDate(today())
    setFromAccountKey(accounts[0]?.key ?? "")
    setToAccountKey(accounts.find((account) => account.key !== accounts[0]?.key)?.key ?? "")
    setSats("")
    setFeeSats("0")
    setNote("")
    setError(null)
  }, [accounts, open])

  async function submit() {
    if (submissionGate && !submissionGate.allowed) {
      setError(submissionGate.reason ?? "Current live Bitcoin balances are required before transferring.")
      return
    }
    const satsValue = parseExactSats(sats)
    const feeValue = parseExactSats(feeSats)
    if (
      !date ||
      !fromAccountKey ||
      !toAccountKey ||
      fromAccountKey === toAccountKey ||
      satsValue === null ||
      satsValue <= 0n ||
      feeValue === null
    ) {
      setError("Choose two different accounts, positive whole sats, and a non-negative fee.")
      return
    }
    setBusy(true)
    const result = await submitMutation({
      kind: "btcTransfer.upsert",
      requestId: stableId("request"),
      actor: activeProfile,
      id,
      owner: mutationOwner("btcTransfer.upsert", activeProfile),
      date,
      fromAccountKey,
      toAccountKey,
      sats: satsValue,
      feeSats: feeValue,
      note: optional(note),
    })
    setBusy(false)
    const message = localMutationError(result)
    setError(message)
    if (!message) onClose()
  }

  return (
    <DialogFrame
      open={open}
      title="Transfer Bitcoin"
      description="The source pays the transfer amount plus any network fee; the destination receives the transfer amount."
      onClose={onClose}
      busy={busy}
      footer={(
        <FormFooter
          formId={formId}
          busy={busy}
          blocked={submissionGate ? !submissionGate.allowed : false}
          blockedReasonId={blockedReasonId}
          onCancel={onClose}
          verb="Transfer Bitcoin"
        />
      )}
    >
      <form id={formId} className="vv-form-grid" onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}>
        {submissionGate && !submissionGate.allowed ? (
          <p id={blockedReasonId} className="vv-form-error" role="status">
            {submissionGate.reason ?? "Current live Bitcoin balances are required before transferring."}
          </p>
        ) : null}
        <ErrorSummary error={error} />
        <Field label="Transfer ID"><TextInput value={id} readOnly /></Field>
        <Field label="Date"><TextInput data-autofocus type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="From">
          <Select value={fromAccountKey} onChange={(e) => setFromAccountKey(e.target.value)}>
            <option value="">Select source account</option>
            {accounts.map((account) => (
              <option key={account.key} value={account.key}>{account.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="To">
          <Select value={toAccountKey} onChange={(e) => setToAccountKey(e.target.value)}>
            <option value="">Select destination account</option>
            {accounts.map((account) => (
              <option key={account.key} value={account.key}>{account.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Sats to transfer"><TextInput inputMode="numeric" value={sats} onChange={(e) => setSats(e.target.value)} /></Field>
        <Field label="Network fee (sats)" hint="Charged to the source account.">
          <TextInput inputMode="numeric" value={feeSats} onChange={(e) => setFeeSats(e.target.value)} />
        </Field>
        <Field label="Note"><TextInput value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </form>
    </DialogFrame>
  )
}

export function BtcAccountFormDialog({
  open,
  account,
  onClose,
}: {
  open: boolean
  account: BTCAccount | null
  onClose: () => void
}) {
  const { activeProfile, data, submitMutation } = useAppState()
  const formId = useId()
  const [key, setKey] = useState(account?.key ?? "")
  const [label, setLabel] = useState(account?.label ?? "")
  const [custody, setCustody] = useState<"exchange" | "self_custody">(account?.custody ?? "self_custody")
  const [sats, setSats] = useState(account?.sats.toString() ?? "")
  const [asOf, setAsOf] = useState(
    account?.asOf.slice(0, 10) ??
    data.btcBalanceDocument.value?.asOf.slice(0, 10) ??
    today(),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setKey(account?.key ?? "")
    setLabel(account?.label ?? "")
    setCustody(account?.custody ?? "self_custody")
    setSats(account?.sats.toString() ?? "")
    setAsOf(
      account?.asOf.slice(0, 10) ??
      data.btcBalanceDocument.value?.asOf.slice(0, 10) ??
      today(),
    )
    setError(null)
  }, [account, data.btcBalanceDocument.value?.asOf, open])

  async function submit() {
    const satsValue = parseExactSats(sats)
    if (!key.trim() || !label.trim() || satsValue === null) {
      setError("Enter an account key, label, and whole sats amount.")
      return
    }
    setBusy(true)
    const result = await submitMutation({
      kind: "btcAccount.upsert",
      requestId: stableId("request"),
      actor: activeProfile,
      key: key.trim(),
      owner: mutationOwner("btcAccount.upsert", account?.owner ?? activeProfile),
      label: label.trim(),
      custody,
      sats: satsValue,
      asOf: `${asOf}T00:00:00Z`,
      ...(data.btcBalanceDocument.value
        ? { baseUpdatedAtMs: data.btcBalanceDocument.value.updatedAtMs }
        : {}),
    })
    setBusy(false)
    const message = localMutationError(result)
    setError(message)
    if (!message) onClose()
  }

  return (
    <DialogFrame
      open={open}
      title={account ? "Edit BTC account" : "Add BTC account"}
      description="Only the BTC quantity is editable. USD valuation requires independent provenance."
      onClose={onClose}
      busy={busy}
      footer={<FormFooter formId={formId} busy={busy} onCancel={onClose} verb="Save account" />}
    >
      <form id={formId} className="vv-form-grid" onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}>
        <ErrorSummary error={error} />
        <Field label="Account key" hint={account ? "Immutable while editing." : "Stable machine-readable name."}>
          <TextInput data-autofocus value={key} readOnly={Boolean(account)} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label="Label"><TextInput value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <Field label="Custody">
          <Select value={custody} onChange={(e) => setCustody(e.target.value as "exchange" | "self_custody")}>
            <option value="self_custody">Self custody</option>
            <option value="exchange">Exchange</option>
          </Select>
        </Field>
        <Field label="Sats"><TextInput inputMode="numeric" value={sats} onChange={(e) => setSats(e.target.value)} /></Field>
        <Field label="As of"><TextInput type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
      </form>
    </DialogFrame>
  )
}
