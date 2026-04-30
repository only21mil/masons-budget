import SwiftUI
import SwiftData

struct CategoryManagementView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]
    @State private var showAddSheet = false
    @State private var editingCategory: BudgetCategory?

    private var totalBudget: Decimal {
        categories.reduce(Decimal(0)) { $0 + $1.monthlyBudget }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppTheme.cardSpacing) {
                if categories.isEmpty {
                    emptyState
                } else {
                    budgetSummary
                    categoryList
                }
            }
            .padding(.horizontal, AppTheme.horizontalPadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .background(AppTheme.background)
        .navigationTitle("Categories")
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button { showAddSheet = true } label: {
                    Image(systemName: "plus.circle.fill")
                        .foregroundStyle(AppTheme.accentColor)
                }
            }
        }
        .sheet(isPresented: $showAddSheet) {
            CategoryEditView(mode: .add) { name, icon, budget in
                let cat = BudgetCategory(name: name, icon: icon, monthlyBudget: budget, sortOrder: categories.count)
                modelContext.insert(cat)
                try? modelContext.save()
            }
        }
        .sheet(item: $editingCategory) { category in
            CategoryEditView(mode: .edit(category)) { name, icon, budget in
                category.name = name
                category.icon = icon
                category.monthlyBudget = budget
                try? modelContext.save()
            }
        }
    }

    private var budgetSummary: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("TOTAL MONTHLY BUDGET")
                    .font(.caption2)
                    .foregroundStyle(AppTheme.secondaryText)
                    .tracking(0.5)
                Text(formatCurrency(totalBudget))
                    .font(AppTheme.largeNumber)
                    .foregroundStyle(AppTheme.primaryText)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("\(categories.count)")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundStyle(AppTheme.accentColor)
                Text("categories")
                    .font(.caption2)
                    .foregroundStyle(AppTheme.tertiaryText)
            }
        }
        .glassCard(highlight: true)
    }

    private var categoryList: some View {
        ForEach(categories, id: \.name) { category in
            Button {
                editingCategory = category
            } label: {
                HStack(spacing: 14) {
                    Text(category.icon)
                        .font(.title2)
                        .frame(width: 40, height: 40)
                        .background(AppTheme.background)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(category.name)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(AppTheme.primaryText)
                        Text(formatCurrency(category.monthlyBudget) + " / month")
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(AppTheme.tertiaryText)
                }
            }
            .glassCard()
            .contextMenu {
                Button(role: .destructive) {
                    deleteCategory(category)
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "list.bullet.rectangle.portrait")
                .font(.system(size: 40))
                .foregroundStyle(AppTheme.tertiaryText)
            Text("No Budget Categories")
                .font(.headline)
                .foregroundStyle(AppTheme.primaryText)
            Text("Add categories to track your spending against monthly budgets.")
                .font(.caption)
                .foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center)
            Button {
                showAddSheet = true
            } label: {
                Label("Add Category", systemImage: "plus")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .background(AppTheme.accentGradient)
                    .clipShape(Capsule())
            }
        }
        .padding(.vertical, 40)
        .frame(maxWidth: .infinity)
        .glassCard()
    }

    private func deleteCategory(_ category: BudgetCategory) {
        modelContext.delete(category)
        try? modelContext.save()
    }
}

// MARK: - Edit / Add sheet

enum CategoryEditMode {
    case add
    case edit(BudgetCategory)

    var isEdit: Bool {
        if case .edit = self { return true }
        return false
    }
}

struct CategoryEditView: View {
    @Environment(\.dismiss) private var dismiss
    let mode: CategoryEditMode
    let onSave: (String, String, Decimal) -> Void

    @State private var name: String
    @State private var icon: String
    @State private var budgetText: String
    @State private var selectedEmojiGroup: Int = 0

    private static let emojiGroups: [(String, [String])] = [
        ("Home", ["🏠", "🏡", "🛏️", "🪑", "🧹", "💡", "🔑", "🏗️"]),
        ("Food", ["🍔", "🍕", "🥗", "☕", "🍺", "🛒", "🧑‍🍳", "🍽️"]),
        ("Transport", ["🚗", "⛽", "🚌", "🚇", "✈️", "🛞", "🅿️", "🚲"]),
        ("Shopping", ["🛍️", "👕", "👟", "💄", "🎁", "📦", "🛒", "💎"]),
        ("Health", ["🏥", "💊", "🧘", "🏋️", "🦷", "👓", "🩺", "🧠"]),
        ("Fun", ["🎮", "🎬", "🎵", "📚", "🎨", "🎭", "🎯", "🎲"]),
        ("Finance", ["💼", "💰", "📈", "🏦", "💳", "🧾", "📊", "₿"]),
        ("Family", ["🐕", "🐈", "👶", "🎓", "📱", "🎒", "🧸", "👨‍👩‍👧‍👦"]),
        ("Other", ["⚡", "🔧", "🌐", "📮", "🗓️", "🔔", "🏷️", "❓"]),
    ]

    init(mode: CategoryEditMode, onSave: @escaping (String, String, Decimal) -> Void) {
        self.mode = mode
        self.onSave = onSave
        switch mode {
        case .add:
            _name = State(initialValue: "")
            _icon = State(initialValue: "📦")
            _budgetText = State(initialValue: "")
        case .edit(let cat):
            _name = State(initialValue: cat.name)
            _icon = State(initialValue: cat.icon)
            _budgetText = State(initialValue: "\(cat.monthlyBudget)")
        }
    }

    private var isValid: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty && Decimal(string: budgetText) != nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    previewCard
                    nameSection
                    emojiSection
                    budgetSection
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle(mode.isEdit ? "Edit Category" : "New Category")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let budget = Decimal(string: budgetText) else { return }
                        onSave(name.trimmingCharacters(in: .whitespaces), icon, budget)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .foregroundStyle(isValid ? AppTheme.accentColor : AppTheme.tertiaryText)
                    .disabled(!isValid)
                }
            }
        }
        .presentationDetents([.large])
        .preferredColorScheme(.dark)
    }

    private var previewCard: some View {
        HStack(spacing: 14) {
            Text(icon)
                .font(.system(size: 36))
                .frame(width: 56, height: 56)
                .background(AppTheme.background)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            VStack(alignment: .leading, spacing: 4) {
                Text(name.isEmpty ? "Category Name" : name)
                    .font(.headline)
                    .foregroundStyle(name.isEmpty ? AppTheme.tertiaryText : AppTheme.primaryText)
                Text(budgetText.isEmpty ? "$0 / month" : "\(formatCurrency(Decimal(string: budgetText) ?? 0)) / month")
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
            }
            Spacer()
        }
        .glassCard(highlight: true)
    }

    private var nameSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("NAME")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(AppTheme.secondaryText)
                .tracking(0.5)
            TextField("e.g. Groceries", text: $name)
                .font(.body)
                .foregroundStyle(AppTheme.primaryText)
                .padding(14)
                .background(AppTheme.cardBackground)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(Color.white.opacity(0.06), lineWidth: 1)
                )
        }
    }

    private var emojiSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ICON")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(AppTheme.secondaryText)
                .tracking(0.5)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(Self.emojiGroups.enumerated()), id: \.offset) { idx, group in
                        Button {
                            withAnimation(AppTheme.entryAnimation) { selectedEmojiGroup = idx }
                        } label: {
                            Text(group.0)
                                .font(.caption.weight(selectedEmojiGroup == idx ? .semibold : .regular))
                                .foregroundStyle(selectedEmojiGroup == idx ? AppTheme.primaryText : AppTheme.tertiaryText)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(selectedEmojiGroup == idx ? AppTheme.accentColor.opacity(0.2) : Color.clear)
                                .clipShape(Capsule())
                        }
                    }
                }
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 8), spacing: 10) {
                ForEach(Self.emojiGroups[selectedEmojiGroup].1, id: \.self) { emoji in
                    Button {
                        withAnimation(AppTheme.entryAnimation) { icon = emoji }
                    } label: {
                        Text(emoji)
                            .font(.title2)
                            .frame(width: 40, height: 40)
                            .background(icon == emoji ? AppTheme.accentColor.opacity(0.25) : AppTheme.cardBackground)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .strokeBorder(icon == emoji ? AppTheme.accentColor : Color.clear, lineWidth: 1.5)
                            )
                    }
                }
            }
            .padding(12)
            .background(AppTheme.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(Color.white.opacity(0.06), lineWidth: 1)
            )
        }
    }

    private var budgetSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("MONTHLY BUDGET")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(AppTheme.secondaryText)
                .tracking(0.5)
            HStack(spacing: 8) {
                Text("$")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(AppTheme.accentColor)
                TextField("0", text: $budgetText)
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(AppTheme.primaryText)
                    .keyboardType(.decimalPad)
            }
            .padding(14)
            .background(AppTheme.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.white.opacity(0.06), lineWidth: 1)
            )
        }
    }
}

#Preview("Management") {
    NavigationStack {
        CategoryManagementView()
    }
}

#Preview("Edit") {
    CategoryEditView(mode: .add) { _, _, _ in }
}
