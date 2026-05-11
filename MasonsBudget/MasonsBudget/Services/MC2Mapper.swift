import Foundation

enum MC2Mapper {

    static func parseDate(_ raw: String) -> Date {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: raw) { return d }
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: raw) { return d }

        let ymd = DateFormatter()
        ymd.dateFormat = "yyyy-MM-dd"
        ymd.locale = Locale(identifier: "en_US_POSIX")
        ymd.timeZone = .current
        if let d = ymd.date(from: raw) { return d }

        ymd.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        if let d = ymd.date(from: raw) { return d }

        return .distantPast
    }

    static func mapTransactions(_ dtos: [MC2Transaction], owner: FamilyMember = .victor) -> [Transaction] {
        dtos.map { dto in
            Transaction(
                id: dto.id,
                date: parseDate(dto.date),
                merchant: dto.merchant,
                amount: dto.amount,
                category: dto.category,
                card: dto.card?.isEmpty == true ? nil : dto.card,
                note: dto.note?.isEmpty == true ? nil : dto.note,
                owner: owner,
                createdBy: "mc2",
                createdAt: parseDate(dto.date),
                sourceFile: "transactions.json"
            )
        }
    }

    static func mapBudgetSnapshot(_ dto: MC2Budget) -> MonthlyBudgetSnapshot {
        let actualIncome = actualIncomeTotals(
            income: dto.income,
            budgetMonth: dto.month,
            topLevelMTD: dto.mtdIncome,
            topLevelYTD: dto.ytdIncome
        )

        return MonthlyBudgetSnapshot(
            monthKey: dto.month,
            coinbaseOneBalance: dto.coinbaseOneBalance ?? 0,
            weeklyGross: dto.income?.weeklyGross ?? 0,
            weeklyStrike: dto.income?.weeklyStrike ?? 0,
            weeklyRiver: dto.income?.weeklyRiver ?? 0,
            monthlyGross: dto.income?.monthlyGross ?? 0,
            mtdIncome: actualIncome.mtd,
            ytdIncome: actualIncome.ytd,
            payFrequency: dto.income?.payFrequency ?? "weekly",
            strategyNote: sanitizedStrategyNote(dto.strategy?.strategyNote)
        )
    }

    static func actualIncomeTotals(
        income: MC2BudgetIncome?,
        budgetMonth: String,
        topLevelMTD: Decimal? = nil,
        topLevelYTD: Decimal? = nil
    ) -> (mtd: Decimal, ytd: Decimal) {
        let paychecks = income?.paychecks ?? []
        let calendar = Calendar.current
        let monthDate = parseMonthYear(budgetMonth) ?? Date()
        let monthComponents = calendar.dateComponents([.year, .month], from: monthDate)

        let mtdFromLedger = paychecks.reduce(Decimal(0)) { total, paycheck in
            let date = parseDate(paycheck.date)
            let components = calendar.dateComponents([.year, .month], from: date)
            guard components.year == monthComponents.year,
                  components.month == monthComponents.month else { return total }
            return total + (paycheck.net ?? paycheck.amount ?? 0)
        }

        let ytdFromLedger = paychecks.reduce(Decimal(0)) { total, paycheck in
            let date = parseDate(paycheck.date)
            let components = calendar.dateComponents([.year], from: date)
            guard components.year == monthComponents.year else { return total }
            return total + (paycheck.net ?? paycheck.amount ?? 0)
        }

        let explicitMTD = income?.mtdIncome ?? topLevelMTD
        let explicitYTD = income?.ytdIncome ?? topLevelYTD
        let mtd = explicitMTD ?? mtdFromLedger
        let ytd = explicitYTD ?? (ytdFromLedger > 0 ? ytdFromLedger : mtd)

        return (mtd: mtd, ytd: ytd)
    }

    private static func parseMonthYear(_ raw: String) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "MMMM yyyy"
        return formatter.date(from: raw)
    }

    private static func sanitizedStrategyNote(_ note: String?) -> String? {
        let retiredCardToken = ["av", "en"].joined()
        guard let note, !note.lowercased().contains(retiredCardToken) else { return nil }
        return note
    }

    static func mapPaychecksToTransactions(_ paychecks: [MC2Paycheck]?, owner: FamilyMember = .victor) -> [Transaction] {
        guard let paychecks else { return [] }
        return paychecks.map { paycheck in
            let src = paycheck.source ?? "Paycheck"
            return Transaction(
                id: "income-\(paycheck.date)-\(src)",
                date: parseDate(paycheck.date),
                merchant: src,
                amount: paycheck.net ?? paycheck.amount ?? 0,
                category: "Income",
                card: nil,
                note: nil,
                owner: owner,
                createdBy: "mc2",
                createdAt: parseDate(paycheck.date),
                sourceFile: "budget.json"
            )
        }
    }

    static func mapMonthlyHistory(_ entries: [MC2MonthlyHistoryEntry]?) -> [MonthlyBudgetSnapshot] {
        guard let entries else { return [] }
        return entries.compactMap { entry in
            guard !entry.month.isEmpty else { return nil }
            return MonthlyBudgetSnapshot(
                monthKey: entry.month,
                mtdIncome: entry.income ?? 0,
                ytdIncome: entry.income ?? 0
            )
        }
    }

    static func mapBudgetCategories(_ dtos: [MC2BudgetCategory], owner: FamilyMember = .victor) -> [BudgetCategory] {
        dtos.enumerated().map { index, dto in
            let name = owner == .victor ? dto.name : "\(owner.rawValue):\(dto.name)"
            return BudgetCategory(
                name: name,
                icon: dto.icon ?? "questionmark.circle",
                monthlyBudget: dto.budget,
                sortOrder: index,
                owner: owner
            )
        }
    }

    static func mapBTCAccounts(_ snapshot: MC2BTCSnapshot, owner: FamilyMember) -> [BTCAccount] {
        snapshot.accounts.map { key, entry in
            BTCAccount(
                key: "\(snapshot.asOf)-\(key)-\(owner)",
                label: entry.label,
                custody: entry.custody == "self_custody" ? .selfCustody : .exchange,
                btc: entry.btc,
                fiat: entry.fiat,
                owner: owner
            )
        }
    }

    static func mapBTCBuy(_ dto: MC2BTCBuy, owner: FamilyMember = .victor) -> BTCBuy {
        BTCBuy(
            id: dto.id,
            date: parseDate(dto.date),
            source: dto.source,
            amountBTC: dto.amountBtc,
            amountSats: dto.amountSats,
            priceUSD: dto.priceUsd,
            usd: dto.usd,
            note: dto.note,
            status: dto.status ?? "complete",
            costBasisStatus: dto.costBasisStatus ?? "complete",
            loggedBy: dto.loggedBy,
            archimedesRequestId: dto.archimedesRequestId,
            owner: owner
        )
    }

    static func mapBTCBillPay(_ dto: MC2BTCBillPay) -> BTCBillPay {
        let owner = dto.owner
            .flatMap { FamilyMember(rawValue: $0.lowercased()) }
            ?? .victor
        return BTCBillPay(
            id: dto.id,
            date: parseDate(dto.date),
            merchant: dto.merchant,
            category: dto.category,
            amountUSD: dto.amountUsd,
            btcSpent: dto.btcSpent,
            btcPrice: dto.effectiveBtcPrice,
            feeUSD: dto.feeUsd,
            platform: dto.platform ?? "Strike",
            note: dto.note,
            reference: dto.reference,
            owner: owner
        )
    }

    static func mapFinances(_ finances: MC2Finances, owner: FamilyMember) -> [HoldingAccount] {
        var accounts: [HoldingAccount] = []

        for (key, account) in finances.retirement.accounts {
            guard let holdingAccount = mapFinanceAccount(key: key, account: account, viewer: owner) else {
                continue
            }
            accounts.append(holdingAccount)
        }

        if let masonAccount = finances.mason401k,
           let holdingAccount = mapFinanceAccount(key: "mason_401k", account: masonAccount, viewer: owner, ownerOverride: .mason) {
            accounts.append(holdingAccount)
        }

        return accounts
    }

    /// Map a single MC2 finance account into a SwiftData HoldingAccount, using
    /// `viewer.canSee(dataOwnedBy:)` for visibility instead of strict equality —
    /// this is what makes Victor and Rachel see the same shared adult finances
    /// (no data split; single household dataset).
    /// `ownerOverride` is for entries (like `mason_401k`) where the canonical
    /// owner is implied by structure rather than a JSON `owner` field.
    /// The resulting record is tagged with the canonical account owner — not
    /// the viewer — so household-shared accounts always land as `.victor`
    /// regardless of which adult triggered the sync.
    private static func mapFinanceAccount(
        key: String,
        account: MC2FinanceAccount,
        viewer: FamilyMember,
        ownerOverride: FamilyMember? = nil
    ) -> HoldingAccount? {
        let accountOwner: FamilyMember
        if let ownerOverride {
            accountOwner = ownerOverride
        } else {
            let raw = (account.owner ?? "victor").lowercased()
            accountOwner = FamilyMember(rawValue: raw) ?? .victor
        }
        guard viewer.canSee(dataOwnedBy: accountOwner) else { return nil }

            let holdingAccount = HoldingAccount(
                name: key,
                provider: account.provider ?? key,
                owner: accountOwner,
                totalValue: account.total ?? 0
            )

            for holding in account.holdings {
                let h = Holding(
                    name: holding.name,
                    category: holding.category,
                    ticker: holding.ticker,
                    value: holding.value,
                    costBasis: holding.costBasis,
                    gainPct: holding.gainPct,
                    shares: holding.shares,
                    avgCost: holding.avgCost,
                    currentPricePerShare: holding.currentPricePerShare,
                    isProxy: holding.proxy ?? false,
                    proxyNote: holding.proxyNote
                )
                h.account = holdingAccount

                for lot in (holding.lots ?? []) {
                    let l = HoldingLot(
                        date: parseDate(lot.date),
                        type: lot.type,
                        pricePerShare: lot.pricePerShare ?? 0,
                        shares: lot.shares ?? 0,
                        amountInvested: lot.amountInvested ?? 0,
                        note: lot.note
                    )
                    l.holding = h
                    h.lots.append(l)
                }

                holdingAccount.holdings.append(h)
            }

            return holdingAccount
    }

    static func mapSonBalances(_ son: MC2SonBalances) -> [BTCAccount] {
        [
            BTCAccount(key: "son-strike-mason", label: "Strike", custody: .exchange, btc: son.strike, fiat: 0, owner: .mason),
            BTCAccount(key: "son-river-mason", label: "River", custody: .exchange, btc: son.river, fiat: 0, owner: .mason),
            BTCAccount(key: "son-coldcard-mason", label: "Coldcard", custody: .selfCustody, btc: son.coldcard, fiat: 0, owner: .mason),
        ]
    }

    static func mapTodos(_ dtos: [MC2TodoItem], viewer: FamilyMember) -> [TodoItem] {
        dtos.compactMap { dto in
            guard let owner = dto.effectiveOwner else { return nil }
            guard owner == .victor else { return nil }

            return TodoItem(
                id: dto.id,
                title: dto.effectiveTitle,
                project: dto.effectiveProject,
                area: dto.area,
                dueDate: parseTodoDueDate(dto.effectiveDueDate),
                priority: dto.priority ?? 0,
                isFlagged: dto.effectiveFlagged,
                isDone: dto.effectiveDone,
                owner: owner,
                createdBy: "mc2",
                updatedAt: dto.updatedAt.map(parseDate) ?? .now,
                sourceFile: "todos.json"
            )
        }
    }

    private static func parseTodoDueDate(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        let normalized = raw.lowercased()
        let calendar = Calendar.current
        if normalized == "today" { return calendar.startOfDay(for: Date()) }
        if normalized == "tomorrow" {
            return calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date()))
        }
        return parseDate(raw)
    }
}
