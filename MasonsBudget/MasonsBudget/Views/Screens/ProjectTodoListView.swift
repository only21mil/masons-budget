import SwiftData
import SwiftUI

struct ProjectTodoListView: View {
    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \TodoItem.dueDate) private var allTodos: [TodoItem]

    let projectName: String

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var todos: [TodoItem] {
        allTodos.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) && $0.project == projectName }
    }

    private var pending: [TodoItem] {
        todos.filter { !$0.isDone }
    }

    private var done: [TodoItem] {
        todos.filter(\.isDone)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: projectName, eyebrow: "PROJECT")

                if pending.isEmpty, done.isEmpty {
                    Text("No tasks in this project")
                        .font(AppFont.labelRegular)
                        .foregroundStyle(theme.textMuted)
                        .frame(maxWidth: .infinity)
                        .padding(20)
                } else {
                    VStack(spacing: 0) {
                        ForEach(pending) { todo in
                            TaskRowView(todo: todo)
                            Hairline(indent: 46)
                        }
                        ForEach(done) { todo in
                            TaskRowView(todo: todo)
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
