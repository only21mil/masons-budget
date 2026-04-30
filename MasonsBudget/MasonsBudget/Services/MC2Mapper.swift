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
        ymd.timeZone = TimeZone(secondsFromGMT: 0)
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
        MonthlyBudgetSnapshot(
            monthKey: dto.month,
            avenBalance: dto.avenBalance ?? 0,
            coinbaseOneBalance: 0,
            weeklyGross: dto.income?.weeklyGross ?? 0,
            weeklyStrike: dto.income?.weeklyStrike ?? 0,
            weeklyRiver: dto.income?.weeklyRiver ?? 0,
            monthlyGross: dto.income?.monthlyGross ?? 0,
            payFrequency: dto.income?.payFrequency ?? "weekly",
            strategyNote: dto.strategy?.strategyNote
        )
    }

    static func mapBudgetCategories(_ dtos: [MC2BudgetCategory]) -> [BudgetCategory] {
        dtos.enumerated().map { index, dto in
            BudgetCategory(
                name: dto.name,
                icon: dto.icon ?? "questionmark.circle",
                monthlyBudget: dto.budget,
                sortOrder: index
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

    static func mapBTCBuy(_ dto: MC2BTCBuy) -> BTCBuy {
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
            archimedesRequestId: dto.archimedesRequestId
        )
    }

    static func mapBTCBillPay(_ dto: MC2BTCBillPay) -> BTCBillPay {
        BTCBillPay(
            id: dto.id,
            date: parseDate(dto.date),
            merchant: dto.merchant,
            category: dto.category,
            amountUSD: dto.amountUsd,
            btcSpent: dto.btcSpent,
            btcPrice: dto.btcPrice,
            feeUSD: dto.feeUsd,
            platform: dto.platform ?? "Strike",
            note: dto.note,
            reference: dto.reference
        )
    }

    static func mapFinances(_ finances: MC2Finances, owner: FamilyMember) -> [HoldingAccount] {
        finances.retirement.accounts.map { key, account in
            let holdingAccount = HoldingAccount(
                name: key,
                provider: account.provider ?? key,
                owner: owner,
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
    }

    static func mapSonBalances(_ son: MC2SonBalances) -> [BTCAccount] {
        [
            BTCAccount(key: "son-strike-mason", label: "Strike", custody: .exchange, btc: son.strike, fiat: 0, owner: .mason),
            BTCAccount(key: "son-river-mason", label: "River", custody: .exchange, btc: son.river, fiat: 0, owner: .mason),
            BTCAccount(key: "son-coldcard-mason", label: "Coldcard", custody: .selfCustody, btc: son.coldcard, fiat: 0, owner: .mason),
        ]
    }
}
