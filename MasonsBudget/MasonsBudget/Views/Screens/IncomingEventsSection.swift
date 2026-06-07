import SwiftData
import SwiftUI

struct IncomingEventsSection: View {
    @Environment(\.theme) var theme

    let activeMember: FamilyMember
    let unit: DisplayUnit
    let holdingAccounts: [HoldingAccount]
    let budgetSnapshots: [MonthlyBudgetSnapshot]
    let btcPrice: Decimal

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
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        return (0 ..< 7).compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
    }

    private var weeklyPayAmount: Decimal {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "MMMM yyyy"

        let currentKey = activeMember == .mason ? "mason:\(formatter.string(from: Date()))" : formatter.string(from: Date())
        let currentSnapshot = budgetSnapshots.first { $0.monthKey == currentKey }
        if let river = currentSnapshot?.weeklyRiver, river > 0 { return river }
        if let gross = currentSnapshot?.weeklyGross, gross > 0 { return gross }

        if let latestPositiveRiver = budgetSnapshots
            .filter({ activeMember == .mason ? $0.monthKey.hasPrefix("mason:") : !$0.monthKey.contains(":") })
            .sorted(by: { $0.monthKey > $1.monthKey })
            .first(where: { $0.weeklyRiver > 0 })?.weeklyRiver
        {
            return latestPositiveRiver
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
        let calendar = Calendar.current
        var events: [IncomingEvent] = []

        for day in weekDays {
            let weekday = calendar.component(.weekday, from: day)

            if weekday == 6 {
                if activeMember == .victor || activeMember == .rachel {
                    events.append(IncomingEvent(
                        date: day,
                        icon: "arrow.down.circle.fill",
                        title: "Payday -> River",
                        subtitle: "Weekly DCA to BTC",
                        amountUSD: weeklyPayAmount,
                        color: theme.success,
                    ))
                }

                if weekly401kAmount > 0 {
                    events.append(IncomingEvent(
                        date: day,
                        icon: "chart.bar.fill",
                        title: "401k Contribution",
                        subtitle: memberAccounts.map(\.name).joined(separator: " + "),
                        amountUSD: weekly401kAmount,
                        color: theme.accent,
                    ))
                }
            }

            let dayOfMonth = calendar.component(.day, from: day)
            let month = calendar.component(.month, from: day)
            if month == 3 || month == 6 || month == 9 || month == 12, dayOfMonth == 15 {
                if activeMember == .mason {
                    events.append(IncomingEvent(
                        date: day,
                        icon: "gift.fill",
                        title: "401k Employer Match",
                        subtitle: "Quarterly 100% match",
                        amountUSD: weekly401kAmount * 13,
                        color: theme.plum,
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
        if !incomingEvents.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                header
                weekStrip
                    .padding(.horizontal, AppLayout.sectionPadding)
                eventRows
            }
        }
    }

    private var header: some View {
        HStack {
            Text("INCOMING")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
            Spacer()
            HStack(spacing: 4) {
                Image(systemName: "bolt.fill")
                    .font(AppFont.microStrong)
                    .foregroundStyle(theme.accent)
                AmountView(sats: weekTotalSats, unit: unit, size: 12, weight: .bold, accent: true, btcPrice: btcPrice)
                Text("this week")
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
            }
        }
        .padding(.horizontal, AppLayout.sectionPadding + 4)
    }

    private var weekStrip: some View {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let eventDates = Set(incomingEvents.map { calendar.startOfDay(for: $0.date) })

        return HStack(spacing: 0) {
            ForEach(weekDays, id: \.self) { day in
                let isToday = day == today
                let hasEvent = eventDates.contains(day)
                VStack(spacing: 4) {
                    Text(dayLabel(day))
                        .font(AppFont.microStrong)
                        .foregroundStyle(isToday ? .white : theme.textMuted)
                    Text("\(calendar.component(.day, from: day))")
                        .font(isToday ? AppFont.labelLargeStrong : AppFont.labelLarge)
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

    private var eventRows: some View {
        VStack(spacing: 0) {
            ForEach(Array(incomingEvents.enumerated()), id: \.element.id) { index, event in
                incomingEventRow(event)
                if index < incomingEvents.count - 1 {
                    Hairline(indent: 56)
                }
            }
        }
        .glassCard(padding: 0)
        .padding(.horizontal, AppLayout.sectionPadding)
    }

    private func incomingEventRow(_ event: IncomingEvent) -> some View {
        let sats: Decimal = btcPrice > 0 ? (event.amountUSD / btcPrice) * 100_000_000 : 0
        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(event.color.opacity(0.15))
                .frame(width: 38, height: 38)
                .overlay(
                    Image(systemName: event.icon)
                        .font(AppFont.iconTiny)
                        .foregroundStyle(event.color),
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(event.title)
                    .font(AppFont.labelLarge)
                    .foregroundStyle(theme.text)
                Text("\(relativeDay(event.date)) - \(event.subtitle)")
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
            }

            Spacer()

            AmountView(sats: sats, unit: unit, size: 14, weight: .bold, btcPrice: btcPrice)
        }
        .padding(14)
    }

    private func dayLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE"
        return formatter.string(from: date).uppercased()
    }

    private func relativeDay(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE"
        return formatter.string(from: date)
    }
}
