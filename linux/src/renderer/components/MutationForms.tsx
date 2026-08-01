import { useEffect, useId, useMemo, useState } from "react"
import type {
  BTCAccount,
  BTCBillPay,
  BTCBuy,
  BudgetCategory,
  TodoItem,
  Transaction,
} from "@vogel-vault/domain/readModel"

import { useAppState } from "../app/AppState.tsx"
import {
  formatCentsInput,
  mutationOwner,
  parseExactCents,
  parseExactSats,
  stableId,
} from "../data/mutations.ts"
import type { MutationGate } from "../data/mutations.ts"
import { localMutationError } from "./CrudControls.tsx"
import { DialogFrame } from "./DialogFrame.tsx"
import { Button, Field, Select, TextInput } from "./primitives.tsx"

function optional(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
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

export function TransactionFormDialog({
  open,
  transaction,
  submissionGate,
  onClose,
}: {
  open: boolean
  transaction: Transaction | null
  submissionGate?: MutationGate
  onClose: () => void
}) {
  const { activeProfile, submitMutation } = useAppState()
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
  const [category, setCategory] = useState(transaction?.category ?? "Other")
  const [card, setCard] = useState(transaction?.card ?? "")
  const [note, setNote] = useState(transaction?.note ?? "")
  const [incomeSats, setIncomeSats] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    setCategory(transaction?.category ?? "Other")
    setCard(transaction?.card ?? "")
    setNote(transaction?.note ?? "")
    setIncomeSats("")
    setError(null)
  }, [open, transaction])

  async function submit() {
    if (submissionGate && !submissionGate.allowed) {
      setError(submissionGate.reason ?? "Current live transaction rows are required before editing.")
      return
    }
    const cents = parseExactCents(amount)
    const satsValue = incomeSats.trim() ? parseExactSats(incomeSats) : null
    if (!merchant.trim() || !date || cents === null || cents <= 0n || !category.trim()) {
      setError("Enter a date, merchant, category, and a positive amount with at most two decimals.")
      return
    }
    if (incomeSats.trim() && (category.trim() !== "Income" || satsValue === null || satsValue <= 0n)) {
      setError("Bitcoin income must use the Income category and a positive whole-sats amount.")
      return
    }
    setBusy(true)
    const signed =
      category.trim() === "Income" || transactionKind === "spend" ? cents : -cents
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
      card: optional(card),
      note: optional(note),
      ...(satsValue === null ? {} : { amountSats: satsValue }),
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
          blocked={submissionGate ? !submissionGate.allowed : false}
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
        {submissionGate && !submissionGate.allowed ? (
          <p id={blockedReasonId} className="vv-form-error" role="status">
            {submissionGate.reason ?? "Current live transaction rows are required before editing."}
          </p>
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
        {category.trim() === "Income" ? (
          <Field
            label="Bitcoin received (sats)"
            hint="Optional. When present, these exact sats are added to River. USD-only income does not invent Bitcoin."
          >
            <TextInput inputMode="numeric" value={incomeSats} onChange={(e) => setIncomeSats(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Card"><TextInput value={card} onChange={(e) => setCard(e.target.value)} /></Field>
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
  onClose,
}: {
  open: boolean
  payment: BTCBillPay | null
  onClose: () => void
}) {
  const { activeProfile, submitMutation } = useAppState()
  const formId = useId()
  const [id, setId] = useState(() => payment?.id ?? stableId("bill"))
  const [date, setDate] = useState(payment?.date ?? today())
  const [merchant, setMerchant] = useState(payment?.merchant ?? "")
  const [category, setCategory] = useState(payment?.category ?? "Bills")
  const [amount, setAmount] = useState(payment ? formatCentsInput(payment.amountUsd) : "")
  const [sats, setSats] = useState(payment?.btcSpentSats.toString() ?? "")
  const [price, setPrice] = useState(payment ? formatCentsInput(payment.btcPrice) : "")
  const [fee, setFee] = useState(payment ? formatCentsInput(payment.feeUsd) : "0.00")
  const [platform, setPlatform] = useState(payment?.platform ?? "")
  const [reference, setReference] = useState(payment?.reference ?? "")
  const [note, setNote] = useState(payment?.note ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setId(payment?.id ?? stableId("bill"))
    setDate(payment?.date ?? today())
    setMerchant(payment?.merchant ?? "")
    setCategory(payment?.category ?? "Bills")
    setAmount(payment ? formatCentsInput(payment.amountUsd) : "")
    setSats(payment?.btcSpentSats.toString() ?? "")
    setPrice(payment ? formatCentsInput(payment.btcPrice) : "")
    setFee(payment ? formatCentsInput(payment.feeUsd) : "0.00")
    setPlatform(payment?.platform ?? "")
    setReference(payment?.reference ?? "")
    setNote(payment?.note ?? "")
    setError(null)
  }, [open, payment])

  async function submit() {
    const amountValue = parseExactCents(amount)
    const satsValue = parseExactSats(sats)
    const priceValue = parseExactCents(price)
    const feeValue = parseExactCents(fee)
    if (!date || !merchant.trim() || !category.trim() || !amountValue || !satsValue || !priceValue || feeValue === null || amountValue <= 0n || satsValue <= 0n || priceValue <= 0n || feeValue < 0n) {
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
      category: category.trim(),
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
        <Field label="Category"><TextInput value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
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
