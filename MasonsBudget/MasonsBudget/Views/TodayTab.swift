import SwiftData
import SwiftUI

struct TodayTab: View {
    @Environment(\.modelContext) private var modelContext
    @Query private var todos: [TodoItem]
    @Query(sort: \BTCBillPay.date, order: .reverse) private var billPays: [BTCBillPay]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @AppStorage(BTCPriceService.priceKey) private var liveBTCPriceUSD: Double = 0
    @AppStorage("btc_display_unit") private var btcDisplayUnitRaw: String = BitcoinDisplayUnit.btc.rawValue
    @State private var draftTitle = ""
    @State private var isSaving = false

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var liveBTCPrice: Decimal? {
        liveBTCPriceUSD > 0 ? Decimal(liveBTCPriceUSD) : nil
    }

    private var visibleTodos: [TodoItem] {
        todos
            .filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
            .sorted { lhs, rhs in
                switch (lhs.dueDate, rhs.dueDate) {
                case let (l?, r?): return l < r
                case (_?, nil): return true
                case (nil, _?): return false
                case (nil, nil): return lhs.title < rhs.title
                }
            }
    }

    private var todayTodos: [TodoItem] {
        visibleTodos.filter { todo in
            guard let due = todo.dueDate else { return !todo.isDone }
            return Calendar.current.isDateInToday(due)
        }
    }

    private var upcomingTodos: [TodoItem] {
        visibleTodos.filter { todo in
            guard let due = todo.dueDate else { return false }
            return due > Calendar.current.startOfDay(for: Date()) && !Calendar.current.isDateInToday(due)
        }
    }

    private var openBills: [BTCBillPay] {
        billPays
            .filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
            .prefix(4)
            .map { $0 }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AppTheme.cardSpacing) {
                    header
                    if !openBills.isEmpty {
                        billPaySection
                    }
                    tasksSection(title: "Today", todos: todayTodos, emptyText: "No tasks due today")
                    addTaskCard
                    tasksSection(title: "Upcoming", todos: upcomingTodos, emptyText: "No upcoming tasks")
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 16)
                .padding(.bottom, 32)
            }
            .background(AppTheme.background.ignoresSafeArea())
            .navigationTitle("Today")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(Date.now, format: .dateTime.weekday(.wide).month(.wide).day())
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(AppTheme.accentColor)
                .textCase(.uppercase)
            Text("\(todayTodos.filter { !$0.isDone }.count) open tasks")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(AppTheme.primaryText)
            Text("Tasks sync through MC2 alongside Bitcoin bill pay, buys, income, and budget data.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var billPaySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Bitcoin Bill Pay")
            VStack(spacing: 0) {
                if openBills.isEmpty {
                    emptyRow("No synced bill pays yet")
                } else {
                    ForEach(Array(openBills.enumerated()), id: \.element.id) { index, bill in
                        billRow(bill)
                        if index < openBills.count - 1 { Divider().overlay(AppTheme.cardBorder) }
                    }
                }
            }
            .glassCard()
        }
    }

    private func tasksSection(title: String, todos: [TodoItem], emptyText: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle(title)
            VStack(spacing: 0) {
                if todos.isEmpty {
                    emptyRow(emptyText)
                } else {
                    ForEach(Array(todos.enumerated()), id: \.element.id) { index, todo in
                        todoRow(todo)
                        if index < todos.count - 1 { Divider().overlay(AppTheme.cardBorder) }
                    }
                }
            }
            .glassCard()
        }
    }

    private var addTaskCard: some View {
        HStack(spacing: 10) {
            Image(systemName: "plus.circle.fill")
                .foregroundStyle(AppTheme.accentColor)
            TextField("Add task", text: $draftTitle)
                .textFieldStyle(.plain)
                .foregroundStyle(AppTheme.primaryText)
                .onSubmit { addTask() }
            Button {
                addTask()
            } label: {
                Image(systemName: isSaving ? "hourglass" : "arrow.up.circle.fill")
                    .font(.title3)
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppTheme.accentColor)
            .disabled(draftTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
        }
        .glassCard(highlight: true)
    }

    private func todoRow(_ todo: TodoItem) -> some View {
        HStack(spacing: 12) {
            Button {
                toggle(todo)
            } label: {
                Image(systemName: todo.isDone ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(todo.isDone ? AppTheme.accentColor : AppTheme.secondaryText)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 3) {
                Text(todo.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(todo.isDone ? AppTheme.secondaryText : AppTheme.primaryText)
                    .strikethrough(todo.isDone)
                    .lineLimit(2)
                Text(todoMeta(todo))
                    .font(AppTheme.monoCaption)
                    .foregroundStyle(AppTheme.secondaryText)
                    .lineLimit(1)
            }
            Spacer()
            if todo.isFlagged {
                Image(systemName: "flag.fill")
                    .foregroundStyle(AppTheme.accentColor)
            }
        }
        .padding(.vertical, 10)
    }

    private func billRow(_ bill: BTCBillPay) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "bitcoinsign.circle.fill")
                .foregroundStyle(AppTheme.accentColor)
                .font(.title3)
            VStack(alignment: .leading, spacing: 3) {
                Text(bill.merchant)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.primaryText)
                Text("\(bill.platform) · \(bill.date, format: .dateTime.month().day())")
                    .font(AppTheme.monoCaption)
                    .foregroundStyle(AppTheme.secondaryText)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(formatCurrency(bill.amountUSD))
                    .font(AppTheme.monoData)
                    .foregroundStyle(AppTheme.primaryText)
                BitcoinAmountView(
                    btc: bill.btcSpent,
                    unit: BitcoinDisplayUnit(rawValue: btcDisplayUnitRaw) ?? .btc,
                    liveBTCPrice: liveBTCPrice,
                    font: AppTheme.monoCaption,
                    color: AppTheme.secondaryText
                )
            }
        }
        .padding(.vertical, 10)
    }

    private func emptyRow(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(AppTheme.secondaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 12)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(AppTheme.secondaryText)
            .textCase(.uppercase)
    }

    private func todoMeta(_ todo: TodoItem) -> String {
        var parts: [String] = []
        if let project = todo.project, !project.isEmpty { parts.append(project) }
        if let due = todo.dueDate { parts.append(due.formatted(date: .abbreviated, time: .omitted)) }
        if parts.isEmpty { parts.append("Inbox") }
        return parts.joined(separator: " · ")
    }

    private func toggle(_ todo: TodoItem) {
        todo.isDone.toggle()
        todo.updatedAt = .now
        saveLocalAndRemote(todo)
    }

    private func addTask() {
        let title = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        draftTitle = ""
        let todo = TodoItem(
            id: "vv-\(UUID().uuidString)",
            title: title,
            project: "Inbox",
            dueDate: Calendar.current.startOfDay(for: Date()),
            owner: currentMember,
            createdBy: "vogel-vault"
        )
        modelContext.insert(todo)
        saveLocalAndRemote(todo)
    }

    private func saveLocalAndRemote(_ todo: TodoItem) {
        do {
            try modelContext.save()
        } catch {
            return
        }

        let dto = MC2TodoItem(appTodo: todo)
        isSaving = true
        Task {
            _ = try? await ConvexClient(deploymentURL: ConvexConfig.deploymentURL).upsertTodo(dto)
            await MainActor.run {
                isSaving = false
            }
        }
    }
}

#Preview {
    TodayTab()
}
