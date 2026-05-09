import SwiftUI
import SwiftData

/// Drill-down view showing all transactions in a single budget category.
struct CategoryDetailView: View {
    let categoryName: String
    let categoryIcon: String
    let budget: Decimal
    let spent: Decimal
    let transactions: [Transaction]

    @Environment(\.modelContext) private var modelContext
    @State private var transactionToDelete: Transaction?
    @State private var transactionToEdit: Transaction?
    private let syncClient = ConvexClient(deploymentURL: ConvexConfig.deploymentURL)

    private var sortedTransactions: [Transaction] {
        transactions
            .filter { $0.category == categoryName }
            .sorted(by: { $0.date > $1.date })
    }

    private var pct: Double {
        budget > 0 ? Double(truncating: (spent / budget) as NSNumber) : 0
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppTheme.cardSpacing) {
                // Category summary header
                VStack(spacing: 8) {
                    Text("\(categoryIcon) \(categoryName)")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(AppTheme.primaryText)

                    HStack(spacing: 16) {
                        VStack(spacing: 2) {
                            Text("Spent")
                                .font(.caption2)
                                .foregroundStyle(AppTheme.secondaryText)
                            Text(formatCurrency(spent))
                                .font(.title2.weight(.bold))
                                .foregroundStyle(pct > 1.0 ? AppTheme.negative : AppTheme.primaryText)
                        }
                        VStack(spacing: 2) {
                            Text("Budget")
                                .font(.caption2)
                                .foregroundStyle(AppTheme.secondaryText)
                            Text(formatCurrency(budget))
                                .font(.title2.weight(.bold))
                                .foregroundStyle(AppTheme.primaryText)
                        }
                        VStack(spacing: 2) {
                            Text("Remaining")
                                .font(.caption2)
                                .foregroundStyle(AppTheme.secondaryText)
                            Text(formatCurrency(budget - spent))
                                .font(.title2.weight(.bold))
                                .foregroundStyle(spent > budget ? AppTheme.negative : AppTheme.positive)
                        }
                    }

                    // Progress bar
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 4)
                                .fill(AppTheme.surface2)
                                .frame(height: 8)
                            RoundedRectangle(cornerRadius: 4)
                                .fill(pct > 1.0 ? AppTheme.negative : AppTheme.accentColor)
                                .frame(width: max(0, min(geo.size.width, CGFloat(pct) * geo.size.width)), height: 8)
                        }
                    }
                    .frame(height: 8)
                }
                .glassCard(highlight: true)

                // Transaction list
                if sortedTransactions.isEmpty {
                    Text("No transactions this month")
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.tertiaryText)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 32)
                } else {
                    Text("\(sortedTransactions.count) transaction\(sortedTransactions.count == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    ForEach(sortedTransactions, id: \.id) { tx in
                        Button {
                            transactionToEdit = tx
                        } label: {
                            TransactionRow(
                                merchant: tx.merchant,
                                amount: tx.amount,
                                category: tx.category,
                                date: tx.date,
                                card: tx.card
                            )
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button {
                                transactionToEdit = tx
                            } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                            Button(role: .destructive) {
                                transactionToDelete = tx
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, AppTheme.horizontalPadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .background(AppTheme.background)
        .navigationTitle(categoryName)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .sheet(isPresented: Binding(
            get: { transactionToEdit != nil },
            set: { if !$0 { transactionToEdit = nil } }
        )) {
            if let tx = transactionToEdit {
                EditTransactionView(transaction: tx) { savedTransaction in
                    saveAndSync(savedTransaction)
                    transactionToEdit = nil
                }
            }
        }
        .alert("Delete Transaction?", isPresented: Binding(
            get: { transactionToDelete != nil },
            set: { if !$0 { transactionToDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { transactionToDelete = nil }
            Button("Delete", role: .destructive) {
                if let tx = transactionToDelete {
                    modelContext.delete(tx)
                    try? modelContext.save()
                }
                transactionToDelete = nil
            }
        } message: {
            if let tx = transactionToDelete {
                Text("Delete \(tx.merchant) — \(formatCurrency(tx.amount))?")
            }
        }
    }

    private func saveAndSync(_ transaction: Transaction) {
        do {
            try modelContext.save()
            pushTransaction(transaction)
        } catch {
            assertionFailure("Failed to save edited transaction: \(error)")
        }
    }

    private func pushTransaction(_ transaction: Transaction) {
        let fileName = transaction.ownerMember == .mason ? "mason-transactions" : "transactions"
        let dto = MC2Transaction(appTransaction: transaction)
        Task {
            do {
                try await syncClient.appendTransaction(dto, to: fileName)
            } catch {
                assertionFailure("Failed to sync edited transaction: \(error)")
            }
        }
    }
}
