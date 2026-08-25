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
                  ownerIsInScope(transaction.ownerMember, viewer: viewer)
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
                  ownerIsInScope(billPay.ownerMember, viewer: viewer)
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

    private static func dayString(_ date: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private static func ownerIsInScope(
        _ owner: FamilyMember,
        viewer: FamilyMember,
    ) -> Bool {
        viewer.isAdult ? owner.isAdult : owner == viewer
    }
}
