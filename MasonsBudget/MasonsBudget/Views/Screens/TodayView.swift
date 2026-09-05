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
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Today", eyebrow: todayEyebrow)

                moneyOutCard
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)

                tasksSection
                    .padding(.bottom, AppLayout.cardSpacing)

                if !completedToday.isEmpty {
                    completedSection
                        .padding(.bottom, AppLayout.cardSpacing)
                }

                if !shortTermTodos.isEmpty {
                    shortTermSection
                        .padding(.bottom, AppLayout.cardSpacing)
                }

                if !longTermTodos.isEmpty {
                    longTermSection
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
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
                Text("MONEY OUT TODAY")
                    .font(AppFont.monoMicroStrong)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(AppFont.labelSmall)
                    .foregroundStyle(theme.danger)
            }

            switch moneyOutToday {
            case let .success(cents):
                Text(AppFormatter.formatCurrency(decimalMinorUnits(cents, scale: 2)))
                    .font(AppFont.largeNumberMono)
                    .foregroundStyle(theme.text)
                Text("Transactions plus eligible bill-pay principal and exact manual fees")
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
            case .failure:
                Text("UNAVAILABLE")
                    .font(AppFont.largeNumberMono)
                    .foregroundStyle(theme.warn)
                Text("An exact-cent input could not be verified.")
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
            }
        }
        .glassCard(padding: 16, radius: AppLayout.radiusMedium)
    }

    // MARK: - Today Tasks

    private var tasksSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("TODAY")
                    .font(AppFont.labelSmallStrong)
                    .tracking(AppFont.sectionTracking)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                Text("\(todayTodos.count) remaining")
                    .font(AppFont.labelSmallRegular)
                    .foregroundStyle(theme.textMuted)
            }
            .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                if todayTodos.isEmpty {
                    HStack {
                        Image(systemName: "checkmark.circle")
                            .font(AppFont.iconSmall)
                            .foregroundStyle(theme.success)
                        Text("All clear for today")
                            .font(AppFont.labelLarge)
                            .foregroundStyle(theme.textMuted)
                        Spacer()
                    }
                    .padding(14)
                } else {
                    ForEach(Array(todayTodos.enumerated()), id: \.element.id) { idx, todo in
                        TaskRowView(todo: todo)
                            .ledgerRowReveal(index: idx)
                        if idx < todayTodos.count - 1 {
                            Hairline(indent: 48)
                        }
                    }
                }

                addTaskRow
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    // MARK: - Short Term (This Week)

    private var shortTermSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("THIS WEEK")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(shortTermTodos.enumerated()), id: \.element.id) { idx, todo in
                    TaskRowView(todo: todo)
                    if idx < shortTermTodos.count - 1 {
                        Hairline(indent: 48)
                    }
                }
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private var completedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("COMPLETED TODAY")
                    .font(AppFont.labelSmallStrong)
                    .tracking(AppFont.sectionTracking)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                Text("\(completedToday.count) done")
                    .font(AppFont.labelSmallRegular)
                    .foregroundStyle(theme.success)
            }
            .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(completedToday.enumerated()), id: \.element.id) { idx, todo in
                    TaskRowView(todo: todo)
                    if idx < completedToday.count - 1 {
                        Hairline(indent: 48)
                    }
                }
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    // MARK: - Long Term

    private var longTermSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("LONG TERM")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(longTermTodos.enumerated()), id: \.element.id) { idx, todo in
                    TaskRowView(todo: todo)
                    if idx < longTermTodos.count - 1 {
                        Hairline(indent: 48)
                    }
                }
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
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
