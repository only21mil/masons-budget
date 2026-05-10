import SwiftUI
import SwiftData

struct ProjectTodoListView: View {
    @Environment(\.theme) var theme
    @Environment(\.modelContext) private var modelContext
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \TodoItem.dueDate) private var allTodos: [TodoItem]

    let projectName: String

    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }

    private var todos: [TodoItem] {
        allTodos.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) && $0.project == projectName }
    }

    private var pending: [TodoItem] { todos.filter { !$0.isDone } }
    private var done: [TodoItem] { todos.filter { $0.isDone } }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: projectName, eyebrow: "PROJECT")

                if pending.isEmpty && done.isEmpty {
                    Text("No tasks in this project")
                        .font(.system(size: 13))
                        .foregroundStyle(theme.textFaint)
                        .frame(maxWidth: .infinity)
                        .padding(20)
                } else {
                    VStack(spacing: 0) {
                        ForEach(pending) { todo in
                            todoRow(todo)
                            Hairline(indent: 46)
                        }
                        ForEach(done) { todo in
                            todoRow(todo)
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

    private func todoRow(_ todo: TodoItem) -> some View {
        Button {
            todo.isDone.toggle()
            try? modelContext.save()
            AppWriteSyncService.pushTodo(todo)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: todo.isDone ? AppIcon.checkDone : AppIcon.checkOpen)
                    .font(.system(size: 20))
                    .foregroundStyle(todo.isDone ? theme.accent : theme.borderStrong)

                VStack(alignment: .leading, spacing: 2) {
                    Text(todo.title)
                        .font(.system(size: 14))
                        .foregroundStyle(todo.isDone ? theme.textFaint : theme.text)
                        .strikethrough(todo.isDone)
                        .lineLimit(2)

                    if let due = todo.dueDate {
                        Text(due, style: .date)
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
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }
}
