import SwiftData
import SwiftUI
import UniformTypeIdentifiers

struct CSVImportView: View {
    @Environment(\.theme) var theme
    @Environment(\.dismiss) var dismiss
    @Environment(\.modelContext) var modelContext
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \Transaction.date, order: .reverse) private var existingTransactions: [Transaction]

    @State private var step: ImportStep = .pick
    @State private var selectedSource: ImportSource?
    @State private var importedRows: [ImportedTransaction] = []
    @State private var selectedRows: Set<UUID> = []
    @State private var isImporting = false
    @State private var showFilePicker = false
    @State private var importCount = 0

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private let service = CSVImportService()

    enum ImportStep {
        case pick, preview, done
    }

    var body: some View {
        NavigationStack {
            ZStack {
                theme.bg.ignoresSafeArea()

                switch step {
                case .pick: pickView
                case .preview: previewView
                case .done: doneView
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if step != .done {
                        Button("Cancel") { dismiss() }
                            .foregroundStyle(theme.accent)
                    }
                }
            }
            .navigationTitle("Import CSV")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
        }
        .fileImporter(
            isPresented: $showFilePicker,
            allowedContentTypes: [UTType.commaSeparatedText, UTType.plainText],
            allowsMultipleSelection: false,
        ) { result in
            handleFile(result)
        }
    }

    // MARK: - Step 1: Pick Source

    private var pickView: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Import", eyebrow: "Choose source")

                VStack(spacing: 10) {
                    ForEach(ImportSource.allCases) { source in
                        sourceCard(source: source)
                    }
                }
                .padding(.horizontal, AppLayout.sectionPadding)
            }
            .padding(.bottom, 40)
        }
    }

    private func sourceCard(source: ImportSource) -> some View {
        Button {
            selectedSource = source
            showFilePicker = true
        } label: {
            HStack(spacing: 14) {
                RoundedRectangle(cornerRadius: 10)
                    .fill(theme.accentSoft)
                    .frame(width: 40, height: 40)
                    .overlay(
                        Text(sourceGlyph(source))
                            .font(.system(size: 18)),
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(source.rawValue)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(theme.text)
                    Text(sourceDesc(source))
                        .font(.system(size: 12))
                        .foregroundStyle(theme.textFaint)
                }

                Spacer()

                Image(systemName: AppIcon.arrowRight)
                    .font(.system(size: 12))
                    .foregroundStyle(theme.textFaint)
            }
            .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Step 2: Preview

    private var previewView: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 0) {
                    previewHeader

                    VStack(spacing: 0) {
                        ForEach(Array(importedRows.enumerated()), id: \.element.id) { idx, row in
                            previewRow(row: row)
                            if idx < importedRows.count - 1 {
                                Hairline(indent: 48)
                            }
                        }
                    }
                    .glassCard(padding: 0)
                    .padding(.horizontal, AppLayout.sectionPadding)
                }
                .padding(.bottom, 100)
            }

            importButton
        }
    }

    private var previewHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(importedRows.count) rows parsed")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(theme.text)

            let income = importedRows.filter(\.isIncome)
            let spends = importedRows.filter { !$0.isIncome }
            HStack(spacing: 12) {
                Text("\(income.count) income")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.success)
                Text("\(spends.count) spends")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, AppLayout.sectionPadding)
        .padding(.vertical, 12)
    }

    private func previewRow(row: ImportedTransaction) -> some View {
        let isSelected = selectedRows.contains(row.id)
        return HStack(spacing: 12) {
            Button {
                if isSelected { selectedRows.remove(row.id) }
                else { selectedRows.insert(row.id) }
            } label: {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(isSelected ? theme.accent : theme.borderStrong)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 2) {
                Text(row.merchant)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(row.category)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.textFaint)
                    Text("·")
                        .foregroundStyle(theme.textFaint)
                    Text(formatDate(row.date))
                        .font(.system(size: 11))
                        .foregroundStyle(theme.textFaint)
                }
            }

            Spacer()

            Text("\(row.isIncome ? "+" : "−")\(abs(row.sats))")
                .font(.system(size: 13, weight: .bold, design: .monospaced))
                .foregroundStyle(row.isIncome ? theme.success : theme.text)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private var importButton: some View {
        let count = selectedRows.count
        return VStack(spacing: 0) {
            LinearGradient(colors: [theme.bg.opacity(0), theme.bg], startPoint: .top, endPoint: .bottom)
                .frame(height: 30)

            HStack(spacing: 8) {
                Button {
                    step = .pick
                    importedRows = []
                    selectedRows = []
                } label: {
                    Text("Back")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(theme.text)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 14)
                        .background(theme.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(theme.border, lineWidth: 1))
                }

                Button { performImport() } label: {
                    HStack {
                        if isImporting {
                            ProgressView()
                                .tint(Color(hex: 0x1A0D00))
                        }
                        Text("Import \(count) transaction\(count == 1 ? "" : "s")")
                            .font(.system(size: 14, weight: .heavy))
                    }
                    .foregroundStyle(Color(hex: 0x1A0D00))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .disabled(count == 0 || isImporting)
            }
            .padding(.horizontal, AppLayout.sectionPadding)
            .padding(.bottom, 22)
            .background(theme.bg)
        }
    }

    // MARK: - Step 3: Done

    private var doneView: some View {
        VStack(spacing: 6) {
            Text("✓")
                .font(.system(size: 46))
                .padding(.bottom, 4)

            Text("\(importCount) transactions added")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(theme.text)

            Text("Recurring patterns will be detected on next sync.")
                .font(.system(size: 12))
                .foregroundStyle(theme.textMuted)

            Button { dismiss() } label: {
                Text("Done")
                    .font(.system(size: 14, weight: .heavy))
                    .foregroundStyle(Color(hex: 0x1A0D00))
                    .padding(.horizontal, 28)
                    .padding(.vertical, 12)
                    .background(theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(.top, 20)
        }
    }

    // MARK: - Actions

    private func handleFile(_ result: Result<[URL], Error>) {
        guard let source = selectedSource else { return }
        guard case let .success(urls) = result, let url = urls.first else { return }

        guard url.startAccessingSecurityScopedResource() else { return }
        defer { url.stopAccessingSecurityScopedResource() }

        guard let data = try? Data(contentsOf: url) else { return }

        do {
            let rows = try service.parseCSV(data: data, source: source)
            let unique = service.filterDuplicates(rows, existing: existingTransactions)
            importedRows = unique
            selectedRows = Set(unique.map(\.id))
            step = .preview
        } catch {
            importedRows = []
            step = .pick
        }
    }

    private func performImport() {
        isImporting = true
        let selected = importedRows.filter { selectedRows.contains($0.id) }
        let sourceTag = "csv-import-\(selectedSource?.rawValue ?? "custom")-\(formatDate(Date()))"
        let transactions = service.toTransactions(selected, owner: activeMember, sourceTag: sourceTag)

        for tx in transactions {
            modelContext.insert(tx)
        }
        try? modelContext.save()
        transactions.forEach { AppWriteSyncService.pushTransaction($0, owner: activeMember) }

        importCount = transactions.count
        isImporting = false
        step = .done
    }

    // MARK: - Helpers

    private func sourceGlyph(_ source: ImportSource) -> String {
        switch source {
        case .strike: "⚡"
        case .cashApp: "$"
        case .coinbase: "C"
        case .kraken: "K"
        case .selfCustody: "⛓"
        case .custom: "∎"
        }
    }

    private func sourceDesc(_ source: ImportSource) -> String {
        switch source {
        case .strike: "Date, Amount BTC, Type, Memo"
        case .cashApp: "Date, Asset Amount, Notes"
        case .coinbase: "Timestamp, Quantity, Spot Price USD"
        case .kraken: "time, asset, amount, fee"
        case .selfCustody: "Generic Bitcoin Core CSV"
        case .custom: "Map columns yourself"
        }
    }

    private func formatDate(_ date: Date) -> String {
        let df = DateFormatter()
        df.dateFormat = "MMM d"
        return df.string(from: date)
    }
}
