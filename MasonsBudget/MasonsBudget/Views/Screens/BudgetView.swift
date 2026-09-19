import SwiftData
import SwiftUI

struct BudgetView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.theme) var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]

    @Query private var snapshots: [MonthlyBudgetSnapshot]

    @State private var showingIncome = false
    @State private var selectedMonthOffset: Int = 0

    private var unit: DisplayUnit {
        .usd
    }

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? BTCPriceService.fallbackPriceUSD
    }

    private var myCategories: [BudgetCategory] {
        categories.filter { activeMember.sharesNetWorth(with: $0.ownerMember) && !$0.isIncome }
    }

    private var selectedMonth: Date {
        Calendar.current.date(byAdding: .month, value: -selectedMonthOffset, to: LedgerClock.now) ?? LedgerClock.now
    }

    private var monthTransactions: [Transaction] {
        let cal = Calendar.current
        return allTransactions.filter { tx in
            activeMember.sharesNetWorth(with: tx.ownerMember) &&
                cal.isDate(tx.date, equalTo: selectedMonth, toGranularity: .month)
        }
    }

    private var monthSpent: Decimal {
        monthTransactions.reduce(Decimal(0)) { $0 + $1.spendAmount }
    }

    private var monthLimit: Decimal {
        myCategories.reduce(Decimal(0)) { $0 + $1.monthlyBudget }
    }

    private var isCurrent: Bool {
        selectedMonthOffset == 0
    }

    private func spentForOffset(_ offset: Int) -> Decimal {
        let cal = Calendar.current
        let date = cal.date(byAdding: .month, value: -offset, to: LedgerClock.now) ?? LedgerClock.now
        return allTransactions.filter { tx in
            activeMember.sharesNetWorth(with: tx.ownerMember) &&
                cal.isDate(tx.date, equalTo: date, toGranularity: .month) &&
                tx.isSpend
        }.reduce(Decimal(0)) { $0 + $1.spendAmount }
    }

    private var incomeSummary: CanonicalIncomeSummary? {
        guard let summary = canonicalFinancials.income.value,
              summary.rows.allSatisfy({ activeMember.sharesNetWorth(with: $0.owner) })
        else { return nil }
        return summary
    }

    private func incomeForOffset(_ offset: Int) -> Decimal? {
        guard let income = incomeSummary else { return nil }
        let cal = Calendar.current
        let date = cal.date(byAdding: .month, value: -offset, to: LedgerClock.now) ?? LedgerClock.now
        let df = AppFormatter.monthFormatter(for: "yyyy-MM")
        return income.amount(forMonth: df.string(from: date), emptyLedgerFallback: snapshot(for: date)?.mtdIncome)
    }

    private func savingsRateForOffset(_ offset: Int) -> Int? {
        guard let income = incomeForOffset(offset) else { return nil }
        guard income > 0 else { return nil }
        let spent = spentForOffset(offset)
        let saved = income - spent
        return max(0, Int(NSDecimalNumber(decimal: (saved / income) * 100).doubleValue))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(
                    title: "Budget",
                    eyebrow: monthEyebrow,
                )

                monthStrip
                    .padding(.bottom, AppLayout.cardSpacing)

                BudgetPlanCarryAction(viewer: activeMember, selectedMonth: selectedMonth) { targetMonth in
                    let currentKey = CategoryDetailView.monthKey(for: Date(), calendar: Calendar(identifier: .gregorian))
                    if let current = BudgetPlanCarry.monthIndex(currentKey),
                       let target = BudgetPlanCarry.monthIndex(targetMonth)
                    {
                        selectedMonthOffset = current - target
                    }
                }
                .id(activeMember)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                .padding(.bottom, AppLayout.cardSpacing)

                incomeSection
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                    .padding(.bottom, AppLayout.cardSpacing)

                spentCard
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                    .padding(.bottom, AppLayout.cardSpacing)

                categoriesSection
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .sheet(isPresented: $showingIncome) { AddTransactionView(initialType: .income) }
    }

    private func snapshot(for date: Date) -> MonthlyBudgetSnapshot? {
        let formatter = AppFormatter.monthFormatter(for: "MMMM yyyy")
        let prefix = activeMember.isAdult ? "" : "\(activeMember.rawValue):"
        return snapshots.first { $0.monthKey == prefix + formatter.string(from: date) }
    }

    private var incomeSection: some View {
        let month = CategoryDetailView.monthKey(for: selectedMonth)
        let summary = incomeSummary
        let snapshot = snapshot(for: selectedMonth)
        let ytd = summary?.yearToDate(
            forMonth: month, currentMonth: CategoryDetailView.monthKey(for: LedgerClock.now),
            snapshotYTD: snapshot?.ytdIncome,
        )
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("INCOME").ledgerType(.sectionLabel)
                Spacer()
                Button("+ Income") { showingIncome = true }
                    .ledgerType(.button)
                    .foregroundStyle(theme.accent)
                    .frame(minHeight: LedgerMetrics.minimumHitTarget)
            }
            Text("MTD: \(incomeForOffset(selectedMonthOffset).map(AppFormatter.formatCurrency) ?? "Unavailable")")
                .ledgerType(.rowPrimary)
            Text("YTD: \(ytd.map(AppFormatter.formatCurrency) ?? "Unavailable")")
                .ledgerType(.rowMeta)
            if let snapshot {
                Text("Weekly gross: \(AppFormatter.formatCurrency(snapshot.weeklyGross))")
                    .ledgerType(.rowMeta)
            }
            if let summary {
                let rows = summary.rows.filter { $0.month == month }
                if rows.isEmpty {
                    Text("No income entries this month").ledgerType(.rowMeta)
                }
                ForEach(rows, id: \.incomeId) { row in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(row.source).ledgerType(.rowPrimary)
                            Text(row.date).ledgerType(.rowMeta)
                        }
                        Spacer()
                        Text(AppFormatter.formatCurrency(Decimal(row.amountCents) / 100))
                            .ledgerType(.rowFigure)
                    }
                }
            }
        }
        .foregroundStyle(theme.text)
        .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
    }

    // MARK: - Month Eyebrow

    private var monthEyebrow: String {
        let df = AppFormatter.monthFormatter(for: "MMMM yyyy", locale: .current)
        let base = df.string(from: selectedMonth)
        return isCurrent ? "\(base) · MTD" : base
    }

    // MARK: - Month Strip

    private var monthStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(0 ..< 6, id: \.self) { offset in
                    monthChip(offset: offset)
                }
            }
            .padding(.horizontal, ledgerTokens.metrics.screenGutter)
        }
    }

    private static let monthChipFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "MMM"
        return df
    }()

    private func monthChip(offset: Int) -> some View {
        let isSelected = offset == selectedMonthOffset
        let date = Calendar.current.date(byAdding: .month, value: -offset, to: LedgerClock.now) ?? LedgerClock.now
        let label = Self.monthChipFormatter.string(from: date)
        let year = Calendar.current.component(.year, from: date)
        let rate = savingsRateForOffset(offset)

        return Button {
            selectedMonthOffset = offset
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(label) '\(String(year).suffix(2))\(offset == 0 ? " · now" : "")")
                    .ledgerType(.chip)
                    .foregroundStyle(isSelected ? theme.onAccent : theme.textMuted)

                if let rate {
                    Text("\(rate)%")
                        .ledgerType(.rowFigure)
                } else {
                    Text("--")
                        .ledgerType(.rowFigure)
                }
            }
            .foregroundStyle(isSelected ? theme.onAccent : theme.text)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(minWidth: 64, minHeight: LedgerMetrics.minimumHitTarget, alignment: .leading)
            .background(isSelected ? theme.accentFill : theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isSelected ? theme.accentFill : theme.border, lineWidth: 1),
            )
            .ledgerAnimation(.chipAndNavigation, value: isSelected)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(date.formatted(.dateTime.month(.wide).year()))
        .accessibilityValue(rate.map { "Savings rate \($0) percent" } ?? "Savings rate unavailable")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    // MARK: - Spent / Limit Card

    private var spentCard: some View {
        let limit = monthLimit
        let pct = limit > 0 ? min(1, NSDecimalNumber(decimal: monthSpent / limit).doubleValue) : 0

        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                // The denominator is the sum of category budgets, never
                // income — label it as the limit it actually is.
                Text("Spent / Limit")
                    .ledgerType(.kpiLabel)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    LedgerSettlingNumeral(value: NSDecimalNumber(decimal: monthSpent).doubleValue) {
                        AppFormatter.formatCurrency(Decimal($0))
                    }
                    .ledgerType(.kpiValue)
                    .foregroundStyle(theme.text)
                    Text("/ \(AppFormatter.formatCurrency(limit))")
                        .ledgerType(.rowFigure)
                        .foregroundStyle(theme.textMuted)
                }
            }

            LedgerProgressBar(fraction: pct, height: 8, cornerRadius: 4, fill: theme.accent, track: theme.surface2)

            HStack {
                Text("\(Int(pct * 100))% of budget spent")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                let saved = limit - monthSpent
                Text("\(AppFormatter.formatCurrency(max(saved, 0))) saved")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.success)
            }
        }
        .glassCard()
        .accessibilityElement(children: .combine)
    }

    // MARK: - Budget vs Actual

    // MARK: - Categories

    private var categoriesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("CATEGORIES")
                .ledgerType(.sectionLabel)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter + 4)

            VStack(spacing: 10) {
                if myCategories.isEmpty {
                    Text("No budget categories yet. Create categories in the desktop app, then refresh here.")
                        .ledgerType(.rowMeta)
                        .foregroundStyle(theme.textMuted)
                        .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
                }
                ForEach(myCategories, id: \.name) { cat in
                    NavigationLink {
                        CategoryDetailView(category: cat, selectedMonth: selectedMonth)
                    } label: {
                        categoryCard(cat: cat)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, ledgerTokens.metrics.screenGutter)
        }
    }

    private func categoryCard(cat: BudgetCategory) -> some View {
        let spent = spentInCategory(cat)
        let limit = cat.monthlyBudget
        let pct = limit > 0 ? NSDecimalNumber(decimal: min(spent / limit, 2)).doubleValue : 0
        let over = spent > limit
        let close = pct >= 0.85 && !over
        let statusColor = over ? theme.danger : close ? theme.warn : theme.success
        let statusSoft = over ? theme.dangerSoft : close ? theme.warnSoft : theme.successSoft
        let statusLabel = over ? "OVER" : close ? "CLOSE" : "ON TRACK"
        let remainingPct = max(0, Int((1 - pct) * 100))

        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 12)
                .fill(statusSoft)
                .frame(width: 38, height: 38)
                .overlay(
                    CatGlyphView(kind: cat.icon, size: 18, color: statusColor),
                )

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    HStack(spacing: 8) {
                        Text(cat.displayName)
                            .ledgerType(.rowPrimary)
                            .foregroundStyle(theme.text)
                        Text(statusLabel)
                            .ledgerType(.chip)
                            .foregroundStyle(statusColor)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(statusSoft)
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                    Spacer()
                    Text(AppFormatter.formatCurrency(spent))
                        .ledgerType(.rowFigure)
                        .foregroundStyle(theme.text)
                }

                Text("Spent \(AppFormatter.formatCurrency(spent)) · Limit \(AppFormatter.formatCurrency(limit)) · Remaining \(AppFormatter.formatCurrency(limit - spent))")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)

                HStack(spacing: 10) {
                    LedgerProgressBar(fraction: pct, height: 6, fill: statusColor, track: theme.surface2)

                    Text(over ? "+\(Int((pct - 1) * 100))% over" : "\(remainingPct)% left")
                        .ledgerType(.rowMeta)
                        .foregroundStyle(statusColor)
                        .frame(minWidth: 76, alignment: .trailing)
                }
            }
        }
        .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
    }

    private func spentInCategory(_ category: BudgetCategory) -> Decimal {
        monthTransactions
            .filter { category.matches($0) && $0.isSpend }
            .reduce(Decimal(0)) { $0 + $1.spendAmount }
    }
}

/// Both Apple navigation roots use BudgetView and this plan-only action.
struct BudgetPlanCarryAction: View {
    @Environment(\.theme) private var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    let viewer: FamilyMember
    let selectedMonth: Date
    var onLoaded: (ConvexBudgetDocumentRow) -> Void = { _ in }
    let onCopied: (String) -> Void

    @State private var document: ConvexBudgetDocumentRow?
    @State private var confirming: BudgetPlanCarryIntent?
    @State private var submitting = false
    @State private var loading = false
    @State private var message: String?
    @State private var acceptedIntent: BudgetPlanCarryIntent?
    @State private var generation = UUID()
    @State private var visible = true

    private var isActive: Bool {
        visible && selectedMemberRaw == viewer.rawValue
    }

    private var currentMonthKey: String {
        monthKey(LedgerClock.now)
    }

    private var selectedMonthKey: String {
        monthKey(selectedMonth)
    }

    private var intent: BudgetPlanCarryIntent? {
        guard acceptedIntent == nil else { return nil }
        return document?.planCarryEligibility(
            viewer: viewer, currentMonth: currentMonthKey, selectedMonth: selectedMonthKey,
        ).intent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let intent, let document {
                Text("\(BudgetPlanCarry.monthLabel(intent.toMonth)) has no budget plan yet")
                    .ledgerType(.rowPrimary)
                Text("Copy \(document.categories.count) categories totaling \(AppFormatter.formatCurrency(document.plannedCategoryTotal)) from \(BudgetPlanCarry.monthLabel(intent.fromMonth)).")
                    .ledgerType(.rowMeta)
                Text("Copies planned amounts only. Transactions and monthly history stay unchanged.")
                    .ledgerType(.rowMeta)
                Button("Copy \(BudgetPlanCarry.monthLabel(intent.fromMonth)) plan to \(BudgetPlanCarry.monthLabel(intent.toMonth))") {
                    confirming = intent
                }
                .disabled(submitting || loading)
                .accessibilityIdentifier("budget.copyPlan")
            }
            if submitting || loading {
                ProgressView()
            }
            if let message {
                Text(message)
                    .ledgerType(.rowMeta)
                    .accessibilityIdentifier("budget.copyPlan.feedback")
            }
            if message != nil, ConvexConfig.hasReadToken, !submitting, !loading {
                Button("Refresh budget plan") { Task { await loadPlan() } }
                    .ledgerType(.button)
                    .foregroundStyle(theme.accent)
                    .frame(minHeight: LedgerMetrics.minimumHitTarget)
            }
        }
        .foregroundStyle(theme.text)
        .onAppear { visible = true }
        .onDisappear {
            visible = false
            generation = UUID()
            confirming = nil
            loading = false
            submitting = false
        }
        .task { await loadPlan() }
        .onChange(of: selectedMonthKey) { _, _ in confirming = nil }
        .alert("Copy budget plan?", isPresented: Binding(
            get: { confirming != nil },
            set: {
                if !$0 {
                    confirming = nil
                }
            },
        ), presenting: confirming) { pending in
            Button("Cancel", role: .cancel) { confirming = nil }
            Button("Copy plan") {
                confirming = nil
                Task { await copyPlan(pending) }
            }
        } message: { pending in
            Text("Copy \(document?.categories.count ?? 0) category amounts to \(BudgetPlanCarry.monthLabel(pending.toMonth))? No transactions or historical months will be created.")
        }
    }

    private func monthKey(_ date: Date) -> String {
        CategoryDetailView.monthKey(for: date, calendar: Calendar(identifier: .gregorian))
    }

    @MainActor
    private func loadPlan() async {
        guard isActive, !loading, BudgetPlanCarry.canonicalIdentity(for: viewer) != nil else { return }
        let requestGeneration = generation
        loading = true
        defer {
            if generation == requestGeneration { loading = false }
        }
        do {
            let reader = ConvexRowReader(client: ConvexClient(deploymentURL: ConvexConfig.deploymentURL))
            let refreshed = try await reader.budget(viewer: viewer)
            guard isActive, generation == requestGeneration, !Task.isCancelled else { return }
            document = refreshed
            onLoaded(refreshed)
            if let acceptedIntent {
                guard let month = BudgetPlanCarry.canonicalStoredMonth(refreshed.month),
                      let revision = refreshed.updatedAtMs,
                      month >= acceptedIntent.toMonth,
                      revision > Double(acceptedIntent.baseUpdatedAtMs)
                else {
                    message = "The plan was copied. The refreshed plan is not available yet. Refresh before copying again."
                    return
                }
                self.acceptedIntent = nil
                onCopied(acceptedIntent.toMonth)
                message = "Copied the plan to \(BudgetPlanCarry.monthLabel(acceptedIntent.toMonth))."
            } else {
                message = nil
            }
        } catch {
            guard isActive, generation == requestGeneration, !Task.isCancelled else { return }
            message = acceptedIntent == nil
                ? (ConvexConfig.hasReadToken
                    ? "The budget plan could not be loaded. Refresh to try again."
                    : "Unavailable until this device is connected.")
                : "The plan was copied, but refresh failed. Refresh before copying again."
        }
    }

    @MainActor
    private func copyPlan(_ pending: BudgetPlanCarryIntent) async {
        guard isActive, !submitting, !loading, pending == intent else { return }
        let requestGeneration = generation
        submitting = true
        defer {
            if generation == requestGeneration { submitting = false }
        }
        if let blocked = AppWriteSyncService.writeBlocker(requiresSyncToken: false) {
            message = blocked.userMessage(operation: "Copy budget plan")
            return
        }
        do {
            // Keep the preview's revision. The server rejects a changed plan;
            // silently reading a newer revision here would bypass confirmation.
            try await AppWritebackClient().copyBudgetPlanForward(pending, activeProfile: viewer)
            guard isActive, generation == requestGeneration, !Task.isCancelled else { return }
            acceptedIntent = pending
            await loadPlan()
        } catch {
            guard isActive, generation == requestGeneration, !Task.isCancelled else { return }
            let result = ConvexWriteResult.classify(error)
            if result == .failed(.staleWrite) {
                document = nil
                message = "The budget plan changed on another device. Refresh and review it before copying."
            } else {
                message = result.userMessage(operation: "Copy budget plan")
            }
        }
    }
}
