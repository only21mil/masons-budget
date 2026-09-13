import SwiftData
import SwiftUI

struct AreaTodoListView: View {
    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \TodoItem.dueDate) private var allTodos: [TodoItem]

    let areaName: String
    var owner: FamilyMember = .victor

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var normalizedAreaName: String {
        areaName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func areaName(for todo: TodoItem) -> String? {
        let trimmed = todo.area?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private var todos: [TodoItem] {
        allTodos.filter {
            activeMember.canAccessTodo(ownedBy: $0.ownerMember) &&
                $0.ownerMember == owner &&
                areaName(for: $0) == normalizedAreaName
        }
    }

    private var pending: [TodoItem] {
        todos.filter { !$0.isDone }
    }

    private var done: [TodoItem] {
        todos.filter(\.isDone)
    }

    private var listedTodos: [TodoItem] {
        pending + done
    }

    var body: some View {
        List {
            ScreenHeader(title: normalizedAreaName, eyebrow: "AREA")
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)

            if listedTodos.isEmpty {
                Text("No tasks in this area")
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.textMuted)
                    .frame(maxWidth: .infinity)
                    .padding(20)
                    .listRowSeparator(.hidden)
            } else {
                ForEach(listedTodos) { todo in
                    TaskRowView(todo: todo)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(theme.surface)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(theme.bg)
        .modifier(LedgerListRefresh())
    }
}
