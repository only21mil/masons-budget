# Vogel Vault transaction contract

This note fixes the payment-source catalogue and write routes for the Android, Linux, and Apple clients and the Convex backend. All four implementations must use the same catalogue. Adding, removing, or renaming an option requires one change that updates the shared contract, `shared/domain/fixtures/payment-source-cases.json`, every client implementation, and the client conformance tests.

UI labels are display text only. Clients persist and send the wire value. The shared contract and fixture are the machine-readable source of truth.

The `sources` array in `shared/domain/fixtures/payment-source-cases.json` defines the canonical picker order shown below. Every client conformance test must assert the exact ordered wire sequence. Treating the entries as a set, sorting them alphabetically, or grouping them by class is a contract failure. The Convex backend validates the same catalogue but does not render a picker.

| UI label | Wire value | Class | Supported activities | Row and mutation route |
|---|---|---|---|---|
| River | `river` | Bitcoin-native | spend, income, transfer | `transactions` for spend and income; transfers use the separate account route |
| Zeus Lightning | `zeus_lightning` | Bitcoin-native | spend, income, transfer | `transactions` for spend and income; transfers use the separate account route |
| Zeus On-chain | `zeus_on_chain` | Bitcoin-native | spend, income, transfer | `transactions` for spend and income; transfers use the separate account route |
| Strike | `strike` | Bitcoin-native | spend, income, transfer | `transactions` for spend and income; transfers use the separate account route |
| Coinbase Card | `coinbase_card` | fiat card | spend | `transactions` through `tables:upsertTransactionFromDevice` or `tables:upsertTransaction` |
| Aven | `aven` | fiat card | spend | `transactions` through the transaction mutations |
| SoFi Card | `sofi_card` | fiat card | spend | `transactions` through the transaction mutations |
| Capital One VX | `capital_one_vx` | fiat card | spend | `transactions` through the transaction mutations |
| River Bitcoin Bill Pay | `river_bitcoin_bill_pay` | bill-pay route | bill pay | `btcBillPays` through `tables:upsertBtcBillPayFromDevice` or `tables:upsertBtcBillPay` |

Payment-source wires and Bitcoin account keys are separate identifiers. A Bitcoin-native transaction stores its source wire in `card` and carries an explicit `bitcoinAccountKey` naming the balance to change. Adult Zeus and Strike accounts must be created or identified in the account data after Victor provides their balances. The contract must not guess account keys from payment-source wires.

Ordinary River spend, Income, and transfer activity uses the `river` catalogue entry. River Bitcoin Bill Pay remains a distinct action with the `river_bitcoin_bill_pay` wire, `btcBillPays` row, and bill-pay mutation. Neither wire aliases the other.

The four card sources store their wire value in `card` and omit `amountSats` and `bitcoinAccountKey`. Their existing category accounting remains unchanged.

Transaction clients send the canonical wire in `card`. `buildTransactionWriteRequest` derives the closed payment source from that field. Its optional `paymentSource` input is a typed alias for callers that already use it; when both fields are present, they must match. New device writes reject unknown values and UI labels. An existing unknown legacy card may only round-trip with the same card and Bitcoin posting fields. The retired `lightning` and `on_chain` wires are no longer selectable, but rows that already contain them remain eligible for this unchanged legacy round trip.

River Bitcoin Bill Pay stores its wire value in `platform` and debits the canonical River balance. A `btcBillPays` row carries `budgetEffect: "budget_category" | "credit_card_payment"`. New shared-contract writes must provide it. The shared TypeScript row permits absence while old clients transition, but `normalizeBTCBillPay` always fills `credit_card_payment`. The two Convex mutations accept an omitted value from already-shipped clients and use the same default. `budget_category` adds `amountUsdCents` to the selected category through `deriveBudgetSpend`; callers first apply `budgetBillPaysFor` so a legacy child row cannot enter an adult budget. `credit_card_payment` contributes zero and uses category `Credit Card Payment`. One action writes one `btcBillPays` row. It does not create a linked transaction row.

Ordinary River Bitcoin-native activity, River bill pay, Zeus Lightning, Zeus On-chain, and Strike are adult-household Bitcoin flows. Rachel canonicalizes to the shared Victor ledger; Mason and Maddox cannot post against it.

The sync-token bill-pay mutation keeps accepting legacy child rows for import compatibility. New shared and device routes reject them. `budgetBillPaysFor` excludes those legacy rows from the adult budget, and they never post against the adult Bitcoin ledger.

Zeus Lightning, Zeus On-chain, and Strike store their wire value in `card`. They require a positive `amountSats` and an explicit selected `bitcoinAccountKey`. A spend debits that account. Income credits it. Both directions remain adult-household only.

`tables:upsertTransactionFromDevice` always requires `transactions:write`. It additionally requires `bitcoin:write` when the submitted row carries `amountSats` or the existing row carries `balancePostingVersion: 1`. This covers Bitcoin-native spend and Income creation, edits, transitions, deletion, and balance reversal. No transfer-specific capability authorizes a transaction write. The backend must be deployed before clients send these rows.

## Income entered as a Bitcoin buy

`tables:upsertBtcBuyFromDevice` and `tables:upsertBtcBuy` accept an optional `linkedIncome` object:

```text
args.sourceFile = "bitcoin-buys"
args.buy = { id, owner, date, source, sats, priceUsdCents, usdCents, ... }
args.linkedIncome = {
  id, owner, date, amountCents, source, sourceFile: "income", ...
}
```

The client generates one stable ID and persists it across retries. Both legs use that ID, the same canonical adult owner, and the same date; `linkedIncome.amountCents` equals `buy.usdCents`. The income row uses `sourceKey: "id:<id>"`. The income leg counts toward income, while the buy is the only leg that posts sats to River. Bitcoin buys remain canonical-River writes and are outside the bidirectional payment-source change. The buy stores a backend-only linkage marker that is omitted from public wire responses. Exact retry creates no second row and applies no second balance posting. Paired correction and deletion are not part of this contract version, so linked pairs are immutable. The device route requires both `transactions:write` and `bitcoin:write`. This flow is adult-household only.

## Bitcoin transfers

Account transfers use `tables:upsertBtcTransferFromDevice` or `tables:upsertBtcTransfer` with `{id, owner, date, fromAccountKey, toAccountKey, sats, feeSats, note?}`. A transfer persists no payment-source wire. It debits `fromAccountKey` and credits `toAccountKey`; the catalogue controls which Bitcoin-native options clients offer, while the transfer row remains account-to-account. Both accounts must be distinct known adult-household accounts, `sats` is positive, and `feeSats` is nonnegative. The principal has no effect on income or spending. With a fee, the balance rule is `totalAfter = totalBefore - feeSats`; a zero-fee transfer leaves total BTC and net worth unchanged. The device route requires `bitcoin:write`.

## Net-worth scope

Adult net worth includes the adult household BTC balance and all adult retirement accounts. Victor and Rachel receive the same total. Mason's BTC and `mason_401k` remain visible to adults on Mason's profile but do not enter an adult total. `selectNetWorth` scopes retirement accounts itself and expects its `bitcoinSats` input to have already used `scope: "netWorth"`.

## Contract fixtures

- `shared/domain/fixtures/visibility-cases.json` pins household visibility and BTC account scope.
- `shared/domain/fixtures/finance-market-cases.json` pins BTC plus retirement valuation and Mason's exclusion from adult totals.
- `shared/domain/fixtures/payment-source-cases.json` pins all nine wire values, direction-neutral classes, supported activities, and routes. Each client conformance test must match this fixture.
- `shared/domain/fixtures/income-buy-write-cases.json` pins the atomic income-plus-buy payload and canonical adult owner.
- `shared/domain/fixtures/write-payload-cases.json` pins exact transaction write encoding and rejection cases.
- `shared/domain/fixtures/convex-wire-golden/` contains authenticated production observations for transactions, Bitcoin buys, bill pays, and accounts. It has no populated transfer-row capture; transfer decoding remains covered by synthetic client tests until production can supply an observed row.
