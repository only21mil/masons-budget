import Foundation

enum MoneyOutTodayService {
    /// Adapts persisted Apple models into the exact-cent contract for one injected day.
    static func deriveCents(
        viewer: FamilyMember,
        now: Date,
        calendar: Calendar,
        transactions: [Transaction],
        billPays: [BTCBillPay],
    ) throws -> Int64 {
        let day = dayString(now, calendar: calendar)
        let transactionRows: [MoneyOutTodayTransaction] = try transactions.compactMap { transaction -> MoneyOutTodayTransaction? in
            guard calendar.isDate(transaction.date, inSameDayAs: now),
                  viewer.isSpendingScope(of: transaction.ownerMember)
            else { return nil }
            return try MoneyOutTodayTransaction(
                owner: transaction.ownerMember,
                day: day,
                amountCents: ExactMoney.cents(
                    from: transaction.amount,
                    field: "moneyOutToday.transaction.amount",
                ),
                category: transaction.category,
            )
        }
        let billPayRows: [MoneyOutTodayBillPay] = try billPays.compactMap { billPay -> MoneyOutTodayBillPay? in
            guard calendar.isDate(billPay.date, inSameDayAs: now),
                  viewer.isSpendingScope(of: billPay.ownerMember)
            else { return nil }
            return try MoneyOutTodayBillPay(
                owner: billPay.ownerMember,
                day: day,
                principalUsdCents: ExactMoney.cents(
                    from: billPay.amountUSD,
                    field: "moneyOutToday.billPay.amountUsd",
                ),
                feeUsdCents: ExactMoney.manualFeeCents(
                    from: billPay.feeUSD,
                    field: "moneyOutToday.billPay.feeUsd",
                ),
                budgetEffect: billPay.validatedBudgetEffect(),
            )
        }
        return try MoneyOutTodayContract.deriveCents(
            viewer: viewer,
            day: day,
            transactions: transactionRows,
            billPays: billPayRows,
        )
    }

    // Cached: this runs on every money-out-today derivation. Single-slot memo
    // — the hot path always passes the same calendar.
    private static var cachedDayFormatter: (calendar: Calendar, formatter: DateFormatter)?

    private static func dayString(_ date: Date, calendar: Calendar) -> String {
        let formatter: DateFormatter
        if let cached = cachedDayFormatter, cached.calendar == calendar {
            formatter = cached.formatter
        } else {
            formatter = DateFormatter()
            formatter.calendar = calendar
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = calendar.timeZone
            formatter.dateFormat = "yyyy-MM-dd"
            cachedDayFormatter = (calendar, formatter)
        }
        return formatter.string(from: date)
    }

}
