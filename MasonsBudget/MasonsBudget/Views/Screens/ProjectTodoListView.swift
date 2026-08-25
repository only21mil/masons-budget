import SwiftData
import SwiftUI

struct ProjectTodoListView: View {
    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \TodoItem.dueDate) private var allTodos: [TodoItem]

    let projectName: String
    var owner: FamilyMember = .victor

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var normalizedProjectName: String {
        projectName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func projectName(for todo: TodoItem) -> String? {
        let trimmed = todo.project?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private var todos: [TodoItem] {
        allTodos.filter {
            activeMember.canAccessTodo(ownedBy: $0.ownerMember) &&
                $0.ownerMember == owner &&
                projectName(for: $0) == normalizedProjectName
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
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: normalizedProjectName, eyebrow: "PROJECT")

                if pending.isEmpty, done.isEmpty {
                    Text("No tasks in this project")
                        .font(AppFont.labelRegular)
                        .foregroundStyle(theme.textMuted)
                        .frame(maxWidth: .infinity)
                        .padding(20)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(listedTodos.enumerated()), id: \.element.id) { idx, todo in
                            TaskRowView(todo: todo)
                            if idx < listedTodos.count - 1 {
                                Hairline(indent: 46)
                            }
                        }
                    }
                    .glassCard(padding: 0)
                    .padding(.horizontal, AppLayout.sectionPadding)
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }
}
