import Foundation
import UserNotifications

final class BudgetNotificationManager {
    static let shared = BudgetNotificationManager()
    private static let selectedMemberKey = "selected_family_member"

    private init() {}

    struct BudgetAlert: Equatable {
        let title: String
        let body: String
        let category: String
    }

    func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func evaluateBudgetAlerts(
        categories: [BudgetCategory],
        transactions: [Transaction],
        member: FamilyMember = BudgetNotificationManager.currentMember
    ) {
        for alert in budgetAlerts(categories: categories, transactions: transactions, member: member) {
            notify(title: alert.title, body: alert.body, category: alert.category, member: member)
        }
    }

    func budgetAlerts(
        categories: [BudgetCategory],
        transactions: [Transaction],
        member: FamilyMember = BudgetNotificationManager.currentMember,
        now: Date = Date()
    ) -> [BudgetAlert] {
        let cal = Calendar.current
        let thisMonth = transactions.filter {
            member.canSee(dataOwnedBy: $0.ownerMember) && cal.isDate($0.date, equalTo: now, toGranularity: .month)
        }

        var spentByCategory: [String: Decimal] = [:]
        for tx in thisMonth {
            spentByCategory[tx.category, default: 0] += tx.amount
        }

        var alerts: [BudgetAlert] = []
        for cat in categories {
            let catKey = cat.name.contains(":") ? String(cat.name.split(separator: ":").last ?? "") : cat.name
            let spent = spentByCategory[catKey] ?? 0
            guard cat.monthlyBudget > 0 else { continue }
            let pct = spent / cat.monthlyBudget

            if pct > 1.0 {
                alerts.append(BudgetAlert(
                    title: "\(cat.name) Over Budget",
                    body: "You've spent \(formatCurrency(spent)) of \(formatCurrency(cat.monthlyBudget)). Over by \(formatCurrency(spent - cat.monthlyBudget)).",
                    category: cat.name
                ))
            } else if pct > 0.85 {
                alerts.append(BudgetAlert(
                    title: "\(cat.name) Almost at Limit",
                    body: "\(formatCurrency(spent)) spent of \(formatCurrency(cat.monthlyBudget)) (\(Int(Double(truncating: (pct * 100) as NSNumber)))%).",
                    category: cat.name
                ))
            }
        }

        return alerts
    }

    private func notify(title: String, body: String, category: String, member: FamilyMember) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.badge = 1

        let categorySlug = category.replacingOccurrences(of: " ", with: "-").lowercased()
        let id = "budget-\(member.rawValue)-\(categorySlug)"
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 3600, repeats: false)

        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        UNUserNotificationCenter.current().add(request)
    }

    func syncDaily(
        categories: [BudgetCategory],
        transactions: [Transaction],
        member: FamilyMember = BudgetNotificationManager.currentMember
    ) {
        requestPermission()
        evaluateBudgetAlerts(categories: categories, transactions: transactions, member: member)
    }

    private static var currentMember: FamilyMember {
        let raw = UserDefaults.standard.string(forKey: selectedMemberKey) ?? FamilyMember.victor.rawValue
        return FamilyMember(rawValue: raw) ?? .victor
    }
}
