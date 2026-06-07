import SwiftUI
import SwiftData

struct TodayView: View {
    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue

    @Query(sort: \TodoItem.priority, order: .reverse) private var allTodos: [TodoItem]
    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var budgetSnapshots: [MonthlyBudgetSnapshot]

    @State private var draftText = ""
    @State private var showingDraft = false

    @Environment(\.modelContext) private var modelContext

    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }
    private var unit: DisplayUnit { DisplayUnit(rawValue: displayUnitRaw) ?? .btc }
    private var btcPrice: Decimal { BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice }

    private var myTodos: [TodoItem] {
        allTodos.filter { $0.ownerMember == activeMember && !$0.isDone }
    }

    private var todayTodos: [TodoItem] {
        let cal = Calendar.current
        return myTodos.filter { todo in
            todo.dueDate.map { cal.isDateInToday($0) } ?? false
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

    private var todayEyebrow: String {
        let df = DateFormatter()
        df.dateFormat = "EEEE · MMM d"
        return df.string(from: Date())
    }

    // MARK: - DCA Calendar Data

    private struct IncomingEvent: Identifiable {
        let id = UUID()
        let date: Date
        let icon: String
        let title: String
        let subtitle: String
        let amountUSD: Decimal
        let color: Color
    }

    private var weekDays: [Date] {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        return (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: today) }
    }

    private var weeklyPayAmount: Decimal {
        if let snapshot = budgetSnapshots.sorted(by: { $0.lastUpdated > $1.lastUpdated }).first {
            return snapshot.weeklyRiver
        }
        return 4308.83
    }

    private var memberAccounts: [HoldingAccount] {
        holdingAccounts.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var weekly401kAmount: Decimal {
        memberAccounts.reduce(Decimal(0)) { $0 + $1.weeklyContribution }
    }

    private var incomingEvents: [IncomingEvent] {
        let cal = Calendar.current
        var events: [IncomingEvent] = []

        for day in weekDays {
            let weekday = cal.component(.weekday, from: day)

            if weekday == 6 {
                if activeMember == .victor || activeMember == .rachel {
                    events.append(IncomingEvent(
                        date: day,
                        icon: "arrow.down.circle.fill",
                        title: "Payday → River",
                        subtitle: "Weekly DCA to BTC",
                        amountUSD: weeklyPayAmount,
                        color: theme.success
                    ))
                }

                if weekly401kAmount > 0 {
                    events.append(IncomingEvent(
                        date: day,
                        icon: "chart.bar.fill",
                        title: "401k Contribution",
                        subtitle: memberAccounts.map(\.name).joined(separator: " + "),
                        amountUSD: weekly401kAmount,
                        color: theme.accent
                    ))
                }
            }

            let dayOfMonth = cal.component(.day, from: day)
            let month = cal.component(.month, from: day)
            if (month == 3 || month == 6 || month == 9 || month == 12) && dayOfMonth == 15 {
                if activeMember == .mason {
                    events.append(IncomingEvent(
                        date: day,
                        icon: "gift.fill",
                        title: "401k Employer Match",
                        subtitle: "Quarterly 100% match",
                        amountUSD: weekly401kAmount * 13,
                        color: theme.plum
                    ))
                }
            }
        }

        return events.sorted { $0.date < $1.date }
    }

    private var weekTotalSats: Decimal {
        let total = incomingEvents.reduce(Decimal(0)) { $0 + $1.amountUSD }
        return btcPrice > 0 ? (total / btcPrice) * 100_000_000 : 0
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Today", eyebrow: todayEyebrow)

                if !incomingEvents.isEmpty {
                    incomingSection
                        .padding(.bottom, AppLayout.cardSpacing)
                }

                tasksSection
                    .padding(.bottom, AppLayout.cardSpacing)

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

    // MARK: - Incoming Section

    private var incomingSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("INCOMING")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.72)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                HStack(spacing: 4) {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(theme.accent)
                    AmountView(sats: weekTotalSats, unit: unit, size: 12, weight: .bold, accent: true, btcPrice: btcPrice)
                    Text("this week")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.textMuted)
                }
            }
            .padding(.horizontal, AppLayout.sectionPadding + 4)

            weekStrip
                .padding(.horizontal, AppLayout.sectionPadding)

            VStack(spacing: 0) {
                ForEach(Array(incomingEvents.enumerated()), id: \.element.id) { idx, event in
                    incomingEventRow(event)
                    if idx < incomingEvents.count - 1 {
                        Hairline(indent: 56)
                    }
                }
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private var weekStrip: some View {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let eventDates = Set(incomingEvents.map { cal.startOfDay(for: $0.date) })

        return HStack(spacing: 0) {
            ForEach(weekDays, id: \.self) { day in
                let isToday = day == today
                let hasEvent = eventDates.contains(day)
                VStack(spacing: 4) {
                    Text(dayLabel(day))
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(isToday ? .white : theme.textMuted)
                    Text("\(cal.component(.day, from: day))")
                        .font(.system(size: 14, weight: isToday ? .bold : .medium))
                        .foregroundStyle(isToday ? .white : theme.text)
                    Circle()
                        .fill(hasEvent ? theme.accent : Color.clear)
                        .frame(width: 5, height: 5)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(isToday ? theme.accent : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
        .padding(4)
        .background(theme.surface2)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func incomingEventRow(_ event: IncomingEvent) -> some View {
        let sats: Decimal = btcPrice > 0 ? (event.amountUSD / btcPrice) * 100_000_000 : 0
        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(event.color.opacity(0.15))
                .frame(width: 38, height: 38)
                .overlay(
                    Image(systemName: event.icon)
                        .font(.system(size: 16))
                        .foregroundStyle(event.color)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(event.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.text)
                Text("\(relativeDay(event.date)) · \(event.subtitle)")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.textFaint)
            }

            Spacer()

            AmountView(sats: sats, unit: unit, size: 14, weight: .bold, btcPrice: btcPrice)
        }
        .padding(14)
    }

    private func dayLabel(_ date: Date) -> String {
        let df = DateFormatter()
        df.dateFormat = "EEE"
        return df.string(from: date).uppercased()
    }

    private func relativeDay(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "Today" }
        if cal.isDateInTomorrow(date) { return "Tomorrow" }
        let df = DateFormatter()
        df.dateFormat = "EEE"
        return df.string(from: date)
    }

    // MARK: - Today Tasks

    private var tasksSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("TODAY")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.72)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                Text("\(todayTodos.count) remaining")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.textMuted)
            }
            .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                if todayTodos.isEmpty {
                    HStack {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 18))
                            .foregroundStyle(theme.success)
                        Text("All clear for today")
                            .font(.system(size: 14))
                            .foregroundStyle(theme.textMuted)
                        Spacer()
                    }
                    .padding(14)
                } else {
                    ForEach(Array(todayTodos.enumerated()), id: \.element.id) { idx, todo in
                        todoRow(todo: todo)
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
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(shortTermTodos.enumerated()), id: \.element.id) { idx, todo in
                    todoRowWithDate(todo: todo)
                    if idx < shortTermTodos.count - 1 {
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
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(longTermTodos.enumerated()), id: \.element.id) { idx, todo in
                    todoRowWithDate(todo: todo)
                    if idx < longTermTodos.count - 1 {
                        Hairline(indent: 48)
                    }
                }
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    // MARK: - Todo Row

    private func todoRow(todo: TodoItem) -> some View {
        HStack(spacing: 12) {
            Button {
                withAnimation(.easeOut(duration: 0.3)) {
                    todo.isDone = true
                    todo.updatedAt = .now
                    try? modelContext.save()
                    if todo.ownerMember == .victor {
                        AppWriteSyncService.pushTodo(todo)
                    }
                }
            } label: {
                Image(systemName: AppIcon.checkOpen)
                    .font(.system(size: 22))
                    .foregroundStyle(theme.borderStrong)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 2) {
                Text(todo.title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(theme.text)

                if let project = todo.project {
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(theme.accent.opacity(0.5))
                            .frame(width: 6, height: 6)
                        Text(project)
                            .font(.system(size: 11))
                            .foregroundStyle(theme.textFaint)
                    }
                }
            }

            Spacer()

            if todo.isFlagged {
                Image(systemName: AppIcon.flagFilled)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.accent)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func todoRowWithDate(todo: TodoItem) -> some View {
        HStack(spacing: 12) {
            Button {
                withAnimation(.easeOut(duration: 0.3)) {
                    todo.isDone = true
                    todo.updatedAt = .now
                    try? modelContext.save()
                    if todo.ownerMember == .victor {
                        AppWriteSyncService.pushTodo(todo)
                    }
                }
            } label: {
                Image(systemName: AppIcon.checkOpen)
                    .font(.system(size: 22))
                    .foregroundStyle(theme.borderStrong)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 2) {
                Text(todo.title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(theme.text)
                if let project = todo.project {
                    Text(project)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.textFaint)
                }
            }

            Spacer()

            if todo.isFlagged {
                Image(systemName: AppIcon.flagFilled)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.accent)
            }

            if let due = todo.dueDate {
                Text(relativeDue(due))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.accent)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private var addTaskRow: some View {
        Group {
            Hairline()
            if showingDraft {
                HStack(spacing: 12) {
                    Image(systemName: AppIcon.checkOpen)
                        .font(.system(size: 22))
                        .foregroundStyle(theme.borderStrong)
                    TextField("New task", text: $draftText)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(theme.text)
                        .onSubmit { addTask() }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            } else {
                Button { showingDraft = true } label: {
                    HStack(spacing: 12) {
                        Image(systemName: AppIcon.plus)
                            .font(.system(size: 20))
                            .foregroundStyle(theme.accent)
                        Text("Add task")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(theme.accent)
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func addTask() {
        guard !draftText.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let todo = TodoItem(
            id: UUID().uuidString,
            title: draftText,
            dueDate: Date(),
            owner: activeMember,
            createdBy: "app"
        )
        modelContext.insert(todo)
        try? modelContext.save()
        if activeMember == .victor {
            AppWriteSyncService.pushTodo(todo)
        }
        draftText = ""
        showingDraft = false
    }

    private func relativeDue(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "Today" }
        if cal.isDateInTomorrow(date) { return "Tomorrow" }
        let days = cal.dateComponents([.day], from: Date(), to: date).day ?? 0
        if days <= 7 { return "\(days)d" }
        let df = DateFormatter()
        df.dateFormat = "MMM d"
        return df.string(from: date)
    }
}
