package com.sats21m.vogelvault.domain

/**
 * Sanitized fixture envelope.
 *
 * Remote reads remain disabled until runtime configuration enables them.
 * Everything here is invented sample data with the public Convex row shape and is
 * used by unconfigured builds, previews and screenshots.
 *
 * Two rules:
 *   1. No real balances, account numbers, merchants or identifiers. Ever.
 *   2. Records carry canonical owners exactly as Convex projects them — adults default
 *      to "victor" — so the visibility layer is exercised honestly.
 */
object Fixtures {

    /** Fixed instant so screenshots and tests are deterministic. */
    const val NOW_MILLIS: Long = 1_785_076_200_000L // 2026-07-26T14:30:00Z

    private const val MINUTE = 60_000L

    private val TRANSACTIONS = listOf(
        tx("tx-0001", "2026-07-26", "Neighborhood Market", "142.18", "Groceries", FamilyMember.VICTOR, "Debit"),
        tx("tx-0002", "2026-07-26", "Coffee Bar", "6.75", "Dining", FamilyMember.RACHEL, "Credit"),
        tx("tx-0003", "2026-07-25", "Payroll Deposit", "2480.00", "Income", FamilyMember.VICTOR, null),
        tx("tx-0004", "2026-07-25", "Hardware Store", "88.40", "Home", FamilyMember.VICTOR, "Debit"),
        tx("tx-0005", "2026-07-24", "Pharmacy", "24.10", "Health", FamilyMember.RACHEL, "Credit"),
        tx("tx-0006", "2026-07-23", "Electric Utility", "186.55", "Utilities", FamilyMember.VICTOR, "Debit"),
        tx("tx-0007", "2026-07-22", "Bookshop", "31.20", "Shopping", FamilyMember.RACHEL, "Credit"),
        tx("tx-0008", "2026-07-21", "Farmers Market", "52.00", "Groceries", FamilyMember.VICTOR, "Debit"),
        tx("tx-0009", "2026-07-20", "Internet Provider", "79.99", "Utilities", FamilyMember.VICTOR, "Debit"),
        tx("tx-0010", "2026-07-19", "Payroll Deposit", "2480.00", "Income", FamilyMember.VICTOR, null),
        // Purchases are positive for every owner.
        tx("tx-1001", "2026-07-25", "Game Store", "24.00", "Entertainment", FamilyMember.MASON, null),
        tx("tx-1002", "2026-07-22", "School Lunch", "12.50", "Food", FamilyMember.MASON, null),
        tx("tx-1003", "2026-07-20", "Trading Cards", "9.00", "Entertainment", FamilyMember.MASON, null),
        tx("tx-2001", "2026-07-24", "App Store", "4.99", "Entertainment", FamilyMember.MADDOX, null),
        tx("tx-2002", "2026-07-21", "Ice Cream", "6.25", "Food", FamilyMember.MADDOX, null),
        // June, so the month filter is demonstrably doing something. A July
        // budget must not count any of these.
        tx("tx-0101", "2026-06-24", "Neighborhood Market", "388.90", "Groceries", FamilyMember.VICTOR, "Debit"),
        tx("tx-0102", "2026-06-22", "Electric Utility", "201.40", "Utilities", FamilyMember.VICTOR, "Debit"),
        tx("tx-0103", "2026-06-20", "Coffee Bar", "58.15", "Dining", FamilyMember.RACHEL, "Credit"),
        tx("tx-0104", "2026-06-18", "Payroll Deposit", "2480.00", "Income", FamilyMember.VICTOR, null),
        tx("tx-0105", "2026-06-15", "Auto Fuel", "92.60", "Transport", FamilyMember.RACHEL, "Credit"),
        tx("tx-1101", "2026-06-23", "Book Fair", "18.00", "Entertainment", FamilyMember.MASON, null),
    )

    private fun tx(
        id: String,
        date: String,
        merchant: String,
        amount: String,
        category: String,
        owner: FamilyMember,
        card: String?,
    ) = Transaction(
        id = id,
        date = date,
        merchant = merchant,
        amount = Money.parseCents(amount),
        category = category,
        card = card,
        owner = owner,
    )

    /** Dedicated demo income rows; transaction-shaped income remains only a mirror. */
    private val INCOME = listOf(
        IncomeEntry(
            id = "income-0001",
            date = "2026-07-25",
            month = "2026-07",
            amountCents = Money.parseCents("2480.00"),
            sourceName = "Payroll",
            note = null,
            owner = FamilyMember.VICTOR,
        ),
        IncomeEntry(
            id = "income-0002",
            date = "2026-07-19",
            month = "2026-07",
            amountCents = Money.parseCents("2480.00"),
            sourceName = "Payroll",
            note = null,
            owner = FamilyMember.VICTOR,
        ),
    )

    private val ADULT_BUDGET = Budget(
        month = "2026-07",
        categories = listOf(
            category("Groceries", "900", "614.18"),
            category("Utilities", "400", "266.54"),
            category("Dining", "250", "188.20"),
            category("Transport", "320", "146.30"),
            category("Home", "300", "288.40"),
            category("Health", "200", "74.10"),
            category("Shopping", "180", "211.20"),
            category("Entertainment", "120", "45.99"),
        ),
        income = BudgetIncome(
            weeklyGrossCents = Money.parseCents("1240"),
            monthlyGrossCents = Money.parseCents("4960"),
            mtdIncomeCents = Money.parseCents("4960"),
            ytdIncomeCents = Money.parseCents("34720"),
            payFrequency = "weekly",
        ),
        strategyNote = "Sample strategy note. Not real guidance.",
        owner = FamilyMember.VICTOR,
    )

    private val MASON_BUDGET = Budget(
        month = "2026-07",
        categories = listOf(
            category("Entertainment", "40", "33.00"),
            category("Food", "30", "12.50"),
            category("Saving", "30", "0"),
        ),
        income = null,
        owner = FamilyMember.MASON,
    )

    private fun category(name: String, budget: String, spent: String) =
        BudgetCategory(name, Money.parseCents(budget), Money.parseCents(spent))

    private val BTC_ACCOUNTS = listOf(
        account("coldcard", "Cold Storage", Custody.SELF_CUSTODY, "0.42000000", "39270.00", FamilyMember.VICTOR),
        account("lightning", "Lightning Wallet", Custody.SELF_CUSTODY, "0.01850000", "1729.75", FamilyMember.VICTOR),
        account("exchange-dca", "DCA Exchange", Custody.EXCHANGE, "0.03400000", "3179.00", FamilyMember.VICTOR),
        account("mason-stack", "Mason Stack", Custody.EXCHANGE, "0.00120000", "112.20", FamilyMember.MASON),
        account("maddox-stack", "Maddox Stack", Custody.EXCHANGE, "0.00045000", "42.08", FamilyMember.MADDOX),
    )

    private fun account(
        key: String,
        label: String,
        custody: Custody,
        btc: String,
        fiat: String,
        owner: FamilyMember,
    ) = BtcAccount(key, label, custody, Money.parseBtcToSats(btc), Money.parseCents(fiat), owner)

    private val BTC_BUYS = listOf(
        buy("buy-0001", "2026-07-24", "DCA Exchange", "0.00210000", "93500.00", "196.35", FamilyMember.VICTOR),
        buy("buy-0002", "2026-07-17", "DCA Exchange", "0.00205000", "91200.00", "186.96", FamilyMember.VICTOR),
        buy("buy-0003", "2026-07-10", "DCA Exchange", "0.00218000", "89400.00", "194.89", FamilyMember.VICTOR),
        buy("buy-0004", "2026-07-03", "DCA Exchange", "0.00201000", "94100.00", "189.14", FamilyMember.VICTOR),
        buy("buy-0005", "2026-07-14", "Gift", "0.00040000", "91000.00", "36.40", FamilyMember.MASON),
    )

    private fun buy(
        id: String,
        date: String,
        source: String,
        btc: String,
        price: String,
        usd: String,
        owner: FamilyMember,
    ) = BtcBuy(
        id = id,
        date = date,
        source = source,
        sats = Money.parseBtcToSats(btc),
        priceUsdCents = Money.parseCents(price),
        usdCents = Money.parseCents(usd),
        costBasisStatus = "confirmed",
        owner = owner,
    )

    private val BTC_BILL_PAYS = listOf(
        BtcBillPay(
            id = "bill-pay-0001",
            date = "2026-07-18",
            merchant = "Electric Utility",
            category = "Utilities",
            amountUsdCents = Money.parseCents("186.55"),
            btcSpentSats = Money.parseBtcToSats("0.00205000"),
            feeUsdCents = 0L,
            platform = "Strike",
            note = null,
            owner = FamilyMember.VICTOR,
        ),
    )

    private val TODOS = listOf(
        TodoItem("todo-0001", "Reconcile July statements", area = "Finance", due = "2026-07-27", flagged = true, owner = FamilyMember.VICTOR),
        TodoItem("todo-0002", "Review insurance renewal", area = "Home", due = "2026-07-30", owner = FamilyMember.VICTOR),
        TodoItem("todo-0003", "Schedule annual checkup", area = "Health", due = "2026-07-28", owner = FamilyMember.RACHEL),
        TodoItem("todo-0004", "Plan birthday weekend", project = "Family Calendar", owner = FamilyMember.RACHEL),
        TodoItem("todo-0005", "Export Q2 records", project = "Tax Prep", flagged = true, owner = FamilyMember.VICTOR),
        TodoItem("todo-0006", "File receipts", project = "Tax Prep", done = true, owner = FamilyMember.VICTOR),
        TodoItem("todo-0007", "Finish reading assignment", area = "School", due = "2026-07-27", owner = FamilyMember.MASON),
        TodoItem("todo-0008", "Tidy room", area = "Home", done = true, owner = FamilyMember.MASON),
        TodoItem("todo-0009", "Practice piano", area = "Music", due = "2026-07-26", owner = FamilyMember.MADDOX),
    )

    /**
     * Build the envelope for a profile.
     *
     * Budget is per-owner with no fall-through to the adult budget: adults share
     * the household budget, Mason has dedicated child finance data, and
     * Maddox has none — so his budget slice is genuinely empty. Defaulting to the
     * adult budget here leaked household categories to Maddox in the Linux client.
     */
    fun envelope(
        activeProfile: FamilyMember,
        status: Freshness = Freshness.DEMO,
    ): ReadModel {
        val budget = when {
            activeProfile.isAdult -> ADULT_BUDGET
            activeProfile.hasDedicatedChildFinanceFiles -> MASON_BUDGET
            else -> null
        }
        val empty = status == Freshness.EMPTY
        val stamp = if (status == Freshness.DEMO || status == Freshness.EMPTY) null else NOW_MILLIS - 4 * MINUTE
        val latestVisibleBuy =
            if (empty) null
            else BTC_BUYS.visibleTo(activeProfile).maxByOrNull { it.date }
        val balanceAccounts =
            if (empty) emptyList() else BTC_ACCOUNTS.netWorthScopeFor(activeProfile)
        val balance = balanceAccounts.takeIf { it.isNotEmpty() }?.let { accounts ->
            BtcBalance(
                owner = if (activeProfile.isAdult) FamilyMember.VICTOR else activeProfile,
                asOf = "2026-07-26",
                accounts = accounts,
                totalSats = accounts.sumOf { it.sats },
                fiatCents = accounts.sumOf { it.fiatCents },
                exchangeSats = accounts.filter { it.custody == Custody.EXCHANGE }.sumOf { it.sats },
                selfCustodySats =
                    accounts.filter { it.custody == Custody.SELF_CUSTODY }.sumOf { it.sats },
            )
        }

        return ReadModel(
            transactions = Slice(status, if (empty) emptyList() else TRANSACTIONS, stamp, "Demo fixtures · transactions"),
            budget = Slice(status, if (empty) null else budget, stamp, "Demo fixtures · budget"),
            btcAccounts = Slice(status, if (empty) emptyList() else BTC_ACCOUNTS, stamp, "Demo fixtures · btc-balance-snapshot"),
            btcBuys = Slice(status, if (empty) emptyList() else BTC_BUYS, stamp, "Demo fixtures · bitcoin-buys"),
            todos = Slice(status, if (empty) emptyList() else TODOS, stamp, "Demo fixtures · todos"),
            btcPriceCents = latestVisibleBuy?.priceUsdCents ?: 0L,
            btcPriceAsOf = latestVisibleBuy?.date,
            income = Slice(status, if (empty) emptyList() else INCOME, stamp, "Demo fixtures · income"),
            btcBalance = Slice(status, balance, stamp, "Demo fixtures · bitcoin balance"),
            btcBillPays =
                Slice(
                    status,
                    if (empty) emptyList() else BTC_BILL_PAYS,
                    stamp,
                    "Demo fixtures · bitcoin bill pays",
                ),
        )
    }
}
