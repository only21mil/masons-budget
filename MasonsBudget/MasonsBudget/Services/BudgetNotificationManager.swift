import Foundation
import UserNotifications

final class BudgetNotificationManager {
    static let shared = BudgetNotificationManager()

    private init() {}

    func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func evaluateBudgetAlerts(categories: [BudgetCategory], transactions: [Transaction]) {
        let cal = Calendar.current
        let now = Date()
        let thisMonth = transactions.filter { cal.isDate($0.date, equalTo: now, toGranularity: .month) }

        var spentByCategory: [String: Decimal] = [:]
        for tx in thisMonth {
            spentByCategory[tx.category, default: 0] += tx.amount
        }

        for cat in categories {
            let spent = spentByCategory[cat.name] ?? 0
            guard cat.monthlyBudget > 0 else { continue }
            let pct = spent / cat.monthlyBudget

            if pct > 1.0 {
                notify(
                    title: "\(cat.name) Over Budget",
                    body: "You've spent \(formatCurrency(spent)) of \(formatCurrency(cat.monthlyBudget)). Over by \(formatCurrency(spent - cat.monthlyBudget)).",
                    category: cat.name
                )
            } else if pct > 0.85 {
                notify(
                    title: "\(cat.name) Almost at Limit",
                    body: "\(formatCurrency(spent)) spent of \(formatCurrency(cat.monthlyBudget)) (\(Int(Double(truncating: (pct * 100) as NSNumber)))%).",
                    category: cat.name
                )
            }
        }
    }

    private func notify(title: String, body: String, category: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.badge = 1

        let id = "budget-\(category.replacingOccurrences(of: " ", with: "-").lowercased())"
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])

        let calendar = Calendar.current
        var comps = calendar.dateComponents([.hour], from: Date())
        comps.hour = (comps.hour ?? 9) + 1
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)

        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        UNUserNotificationCenter.current().add(request)
    }

    func syncDaily(categories: [BudgetCategory], transactions: [Transaction]) {
        requestPermission()
        evaluateBudgetAlerts(categories: categories, transactions: transactions)
    }
}
