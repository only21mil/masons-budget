import SwiftUI
import SwiftData

struct ExportView: View {
    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]
    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]
    @Query private var budgetSnapshots: [MonthlyBudgetSnapshot]
    @Query(sort: \NetWorthSnapshot.date, order: .reverse) private var netWorthSnapshots: [NetWorthSnapshot]

    @State private var showShareSheet = false
    @State private var exportURL: URL?

    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }

    private var myTransactions: [Transaction] {
        allTransactions.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Export", eyebrow: "Reports")

                VStack(spacing: 0) {
                    exportRow(
                        icon: "doc.text",
                        title: "Transactions CSV",
                        subtitle: "\(myTransactions.count) records",
                        action: exportTransactions
                    )
                    Hairline(indent: 52)
                    exportRow(
                        icon: "chart.bar.doc.horizontal",
                        title: "Budget Summary CSV",
                        subtitle: "Categories + spending",
                        action: exportBudgetSummary
                    )
                    Hairline(indent: 52)
                    exportRow(
                        icon: "target",
                        title: "Net Worth History CSV",
                        subtitle: "Monthly snapshots",
                        action: exportNetWorth
                    )
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .sheet(isPresented: $showShareSheet) {
            if let url = exportURL {
                ShareSheetView(url: url)
            }
        }
    }

    private func exportRow(icon: String, title: String, subtitle: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(theme.accent)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(theme.text)
                    Text(subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(theme.textFaint)
                }

                Spacer()

                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.accent)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Export Logic

    private func exportTransactions() {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"

        var csv = "Date,Merchant,Amount,Category,Card,Note,Owner\n"
        for tx in myTransactions {
            let row = [
                df.string(from: tx.date),
                csvEscape(tx.merchant),
                "\(tx.amount)",
                csvEscape(tx.category),
                csvEscape(tx.card ?? ""),
                csvEscape(tx.note ?? ""),
                tx.owner
            ].joined(separator: ",")
            csv += row + "\n"
        }
        shareCSV(csv, filename: "transactions-\(df.string(from: Date())).csv")
    }

    private func exportBudgetSummary() {
        let df = DateFormatter()
        df.dateFormat = "MMMM yyyy"
        let monthKey = df.string(from: Date())
        let cal = Calendar.current

        let monthTxns = myTransactions.filter { cal.isDate($0.date, equalTo: Date(), toGranularity: .month) }

        var csv = "Category,Budget,Actual,Remaining,Percent Used\n"
        for cat in categories.filter({ activeMember.sharesNetWorth(with: $0.ownerMember) && !$0.isIncome }) {
            let spent = monthTxns.filter { $0.category == cat.name && $0.isSpend }.reduce(Decimal(0)) { $0 + $1.spendAmount }
            let remaining = cat.monthlyBudget - spent
            let pct = cat.monthlyBudget > 0 ? Int(NSDecimalNumber(decimal: (spent / cat.monthlyBudget) * 100).doubleValue) : 0
            let row = [
                csvEscape(cat.name),
                "\(cat.monthlyBudget)",
                "\(spent)",
                "\(remaining)",
                "\(pct)%"
            ].joined(separator: ",")
            csv += row + "\n"
        }

        let dateFmt = DateFormatter()
        dateFmt.dateFormat = "yyyy-MM-dd"
        shareCSV(csv, filename: "budget-\(monthKey.replacingOccurrences(of: " ", with: "-")).csv")
    }

    private func exportNetWorth() {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"

        let mySnaps = netWorthSnapshots.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }

        var csv = "Date,Total USD,BTC USD,Holdings USD\n"
        for snap in mySnaps.reversed() {
            let row = [
                df.string(from: snap.date),
                "\(snap.totalValue)",
                "\(snap.btcValue)",
                "\(snap.holdingsValue)"
            ].joined(separator: ",")
            csv += row + "\n"
        }
        shareCSV(csv, filename: "net-worth-\(df.string(from: Date())).csv")
    }

    private func csvEscape(_ value: String) -> String {
        if value.contains(",") || value.contains("\"") || value.contains("\n") {
            return "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
        }
        return value
    }

    private func shareCSV(_ content: String, filename: String) {
        let tmpDir = FileManager.default.temporaryDirectory
        let fileURL = tmpDir.appendingPathComponent(filename)
        do {
            try content.write(to: fileURL, atomically: true, encoding: .utf8)
            exportURL = fileURL
            showShareSheet = true
        } catch {
            print("[Export] Failed to write \(filename): \(error)")
        }
    }
}

struct ShareSheetView: View {
    let url: URL

    var body: some View {
        #if os(iOS)
        ShareSheetRepresentable(url: url)
        #else
        VStack(spacing: 16) {
            Text("Export Ready")
                .font(.headline)
            Text(url.lastPathComponent)
                .font(.system(size: 13, design: .monospaced))
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(30)
        .frame(minWidth: 300)
        #endif
    }
}

#if os(iOS)
struct ShareSheetRepresentable: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ uvc: UIActivityViewController, context: Context) {}
}
#endif
