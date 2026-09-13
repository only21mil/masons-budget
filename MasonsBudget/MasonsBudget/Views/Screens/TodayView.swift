import os
import SwiftData
import SwiftUI

struct TodayView: View {
    private static let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "TodayTodos")

    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \TodoItem.priority, order: .reverse) private var allTodos: [TodoItem]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]
    @Query(sort: \BTCBillPay.date, order: .reverse) private var allBillPays: [BTCBillPay]

    @State private var showingDraft = false

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var visibleTodos: [TodoItem] {
        allTodos.filter { activeMember.canAccessTodo(ownedBy: $0.ownerMember) }
    }

    private var myTodos: [TodoItem] {
        visibleTodos.filter { !$0.isDone }
    }

    private var todayTodos: [TodoItem] {
        let cal = Calendar.current
        let now = Date()
        return myTodos.filter { todo in
            Self.isDueTodayOrOverdue(todo.dueDate, now: now, calendar: cal)
        }
    }

    private var shortTermTodos: [TodoItem] {
        let cal = Calendar.current
        let weekFromNow = cal.date(byAdding: .day, value: 7, to: Date()) ?? Date()
        return myTodos.filter { todo in
            guard let due = todo.dueDate else { return false }
            return !cal.isDateInToday(due) && due <= weekFromNow && due > Date()
        }
    }

    private var longTermTodos: [TodoItem] {
        let cal = Calendar.current
        let weekFromNow = cal.date(byAdding: .day, value: 7, to: Date()) ?? Date()
        return myTodos.filter { todo in
            if let due = todo.dueDate {
                return due > weekFromNow
            }
            return true
        }
    }

    private var completedToday: [TodoItem] {
        visibleTodos.filter { Self.wasCompletedToday($0, now: Date(), calendar: .current) }
    }

    private var moneyOutToday: Result<Int64, Error> {
        Result {
            try MoneyOutTodayService.deriveCents(
                viewer: activeMember,
                now: Date(),
                calendar: .current,
                transactions: allTransactions,
                billPays: allBillPays
            )
        }
    }

    private static let eyebrowFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "EEEE · MMM d"
        return df
    }()

    private var todayEyebrow: String {
        Self.eyebrowFormatter.string(from: Date())
    }

    var body: some View {
        List {
            ScreenHeader(title: "Today", eyebrow: todayEyebrow)
                .listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
            NavigationLink { ActivityView(todayOnly: true) } label: { moneyOutCard }
                .buttonStyle(.plain).listRowSeparator(.hidden)
            Section("Today · \(todayTodos.count) remaining") {
                if todayTodos.isEmpty { Text("All clear for today").ledgerType(.rowPrimary) }
                taskRows(todayTodos)
                addTaskRow
            }
            if !completedToday.isEmpty {
                Section("Completed today") { taskRows(completedToday) }
            }
            if !shortTermTodos.isEmpty {
                Section("This week") { taskRows(shortTermTodos) }
            }
            if !longTermTodos.isEmpty {
                Section("Long term") { taskRows(longTermTodos) }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .foregroundStyle(theme.text)
        .background(theme.bg)
        .modifier(LedgerListRefresh())
    }

    private func taskRows(_ rows: [TodoItem]) -> some View {
        ForEach(rows) { todo in
            TaskRowView(todo: todo)
                .listRowInsets(EdgeInsets())
                .listRowBackground(theme.surface)
        }
    }

    static func isDueTodayOrOverdue(_ dueDate: Date?, now: Date = Date(), calendar: Calendar = .current) -> Bool {
        guard let dueDate else { return false }
        return calendar.startOfDay(for: dueDate) <= calendar.startOfDay(for: now)
    }

    static func wasCompletedToday(_ todo: TodoItem, now: Date = Date(), calendar: Calendar = .current) -> Bool {
        guard todo.isDone else { return false }
        if let completedAt = todo.completedAt {
            return calendar.isDate(completedAt, inSameDayAs: now)
        }
        return todo.dueDate.map { calendar.isDate($0, inSameDayAs: now) } ?? false
    }

    private var moneyOutCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Spent today")
                    .ledgerType(.kpiLabel)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(AppFont.icon(size: 12, weight: .semibold))
                    .foregroundStyle(theme.danger)
            }

            switch moneyOutToday {
            case let .success(cents):
                Text(AppFormatter.formatCurrency(decimalMinorUnits(cents, scale: 2)))
                    .ledgerType(.kpiValue)
                    .foregroundStyle(theme.text)
                Text("Spending and bill payments, including fees")
                    .ledgerType(.body)
                    .foregroundStyle(theme.textMuted)
            case .failure:
                Text("UNAVAILABLE")
                    .ledgerType(.kpiValue)
                    .foregroundStyle(theme.warn)
                Text("Today’s spending could not be loaded.")
                    .ledgerType(.body)
                    .foregroundStyle(theme.textMuted)
            }
        }
        .glassCard(padding: 16, radius: AppLayout.radiusMedium)
        .accessibilityElement(children: .combine)
    }

    private var addTaskRow: some View {
        Group {
            Hairline()
            InlineAddTaskBar(
                defaultDueDate: Calendar.current.startOfDay(for: Date()),
                // Keep the closure literal at the @MainActor @Sendable
                // destination so Swift never has to convert an isolated
                // function value after the fact.
                onResult: { result in
                    guard !result.isOk else { return }
                    let cause =
                        result.userMessage(operation: "Save todo")
                        ?? "unknown cause"
                    Self.log.error("Todo writeback rejected: \(cause, privacy: .public)")
                },
                isExpanded: $showingDraft,
            )
        }
    }
}
