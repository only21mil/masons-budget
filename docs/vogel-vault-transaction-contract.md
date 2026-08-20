# Vogel Vault transaction contract

This note fixes the wire values and write routes shared by the Android and Linux clients. Clients must send one of these seven payment-source strings:

| UI label | Wire value | Row and mutation route |
|---|---|---|
| River Bitcoin Bill Pay | `river_bitcoin_bill_pay` | `btcBillPays` through `tables:upsertBtcBillPayFromDevice` or `tables:upsertBtcBillPay` |
| Coinbase Card | `coinbase_card` | `transactions` through `tables:upsertTransactionFromDevice` or `tables:upsertTransaction` |
| Aven | `aven` | `transactions` through the transaction mutations |
| SoFi Card | `sofi_card` | `transactions` through the transaction mutations |
| Capital One VX | `capital_one_vx` | `transactions` through the transaction mutations |
| Lightning | `lightning` | `transactions` through the transaction mutations |
| On-chain | `on_chain` | `transactions` through the transaction mutations |

The four card sources store their wire value in `card` and omit `amountSats` and `bitcoinAccountKey`. Their existing category accounting remains unchanged.

River Bitcoin Bill Pay stores its wire value in `platform` and debits the canonical River balance. A `btcBillPays` row carries `budgetEffect: "budget_category" | "credit_card_payment"`. New shared-contract writes must provide it. The two Convex mutations accept an omitted value from already-shipped clients and treat it as `credit_card_payment`; stored legacy rows use the same default. `budget_category` adds `amountUsdCents` to the selected category through `deriveBudgetSpend`; callers first apply `budgetBillPaysFor` so a legacy child row cannot enter an adult budget. `credit_card_payment` contributes zero and uses category `Credit Card Payment`. One action writes one `btcBillPays` row. It does not create a linked transaction row.

River bill pay, Lightning, and On-chain are adult-household Bitcoin flows. Rachel canonicalizes to the shared Victor ledger; Mason and Maddox cannot post against it.

Lightning and On-chain store their wire value in `card`. They require a positive `amountSats` and the selected `bitcoinAccountKey`; the backend debits that account.

`tables:upsertTransactionFromDevice` always requires `transactions:write`. It additionally requires `bitcoin:write` when the submitted row carries `amountSats` or the existing row carries `balancePostingVersion: 1`. This covers Lightning and On-chain creation, edits, transitions, deletion, and balance reversal. No transfer-specific capability authorizes a transaction write. The backend must be deployed before clients send Lightning or On-chain rows.

## Income entered as a Bitcoin buy

`tables:upsertBtcBuyFromDevice` and `tables:upsertBtcBuy` accept an optional `linkedIncome` object:

```text
args.sourceFile = "bitcoin-buys"
args.buy = { id, owner, date, source, sats, priceUsdCents, usdCents, ... }
args.linkedIncome = {
  id, owner, date, amountCents, source, sourceFile: "income", ...
}
```

The client generates one stable ID and persists it across retries. Both legs use that ID, the same canonical adult owner, and the same date; `linkedIncome.amountCents` equals `buy.usdCents`. The income row uses `sourceKey: "id:<id>"`. The income leg counts toward income, while the buy is the only leg that posts sats to River. The buy stores a backend-only linkage marker that is omitted from public wire responses. Exact retry creates no second row and applies no second balance posting. Paired correction and deletion are not part of this contract version, so linked pairs are immutable. The device route requires both `transactions:write` and `bitcoin:write`. This flow is adult-household only.

## Bitcoin transfers

Account transfers use `tables:upsertBtcTransferFromDevice` or `tables:upsertBtcTransfer` with `{id, owner, date, fromAccountKey, toAccountKey, sats, feeSats, note?}`. Both accounts must be distinct known adult-household accounts, `sats` is positive, and `feeSats` is nonnegative. The principal moves from source to destination and has no effect on income or spending. With a fee, the balance rule is `totalAfter = totalBefore - feeSats`; a zero-fee transfer leaves total BTC and net worth unchanged. The device route requires `bitcoin:write`.

## Net-worth scope

Adult net worth includes the adult household BTC balance and all adult retirement accounts. Victor and Rachel receive the same total. Mason's BTC and `mason_401k` remain visible to adults on Mason's profile but do not enter an adult total. `selectNetWorth` scopes retirement accounts itself and expects its `bitcoinSats` input to have already used `scope: "netWorth"`.

## Contract fixtures

- `shared/domain/fixtures/visibility-cases.json` pins household visibility and BTC account scope.
- `shared/domain/fixtures/finance-market-cases.json` pins BTC plus retirement valuation and Mason's exclusion from adult totals.
- `shared/domain/fixtures/payment-source-cases.json` pins all seven wire values and their routes.
- `shared/domain/fixtures/income-buy-write-cases.json` pins the atomic income-plus-buy payload and canonical adult owner.
- `shared/domain/fixtures/write-payload-cases.json` pins exact transaction write encoding and rejection cases.
- `shared/domain/fixtures/convex-wire-golden/` contains authenticated production observations for transactions, Bitcoin buys, bill pays, and accounts. It has no populated transfer-row capture; transfer decoding remains covered by synthetic client tests until production can supply an observed row.
