import SwiftData
import SwiftUI

struct TaskUndoBanner: View {
    @Environment(\.theme) private var theme
    @Environment(\.modelContext) private var modelContext
    @EnvironmentObject private var undoStore: TaskUndoStore
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    var body: some View {
        if let todo = undoStore.pending,
           let owner = todo.ownerMember,
           activeMember.canAccessTodo(ownedBy: owner)
        {
            HStack(spacing: 10) {
                Image(systemName: "trash")
                    .font(AppFont.labelLargeStrong)
                    .foregroundStyle(theme.danger)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Task deleted")
                        .font(AppFont.labelStrong)
                        .foregroundStyle(theme.text)
                    Text(todo.title)
                        .font(AppFont.smallRegular)
                        .foregroundStyle(theme.textMuted)
                        .lineLimit(1)
                }

                Spacer()

                Button("Undo") {
                    undoStore.restore(in: modelContext)
                }
                .font(AppFont.labelSmallStrong)
                .foregroundStyle(theme.accent)
                .buttonStyle(.plain)

                Button {
                    undoStore.dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(AppFont.sectionHeader)
                        .foregroundStyle(theme.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss undo")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(theme.danger.opacity(0.35), lineWidth: 1),
            )
            .shadow(color: Color.black.opacity(0.12), radius: 8, y: 4)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .animation(.easeOut(duration: 0.2), value: todo.id)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Task deleted, undo")
        }
    }
}
