import Foundation

enum SearchMatcher {
    static func normalized(_ value: String) -> String {
        value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func matches(query: String, fields: [String?]) -> Bool {
        let normalizedQuery = normalized(query)
        guard !normalizedQuery.isEmpty else { return true }

        return fields.contains { field in
            guard let field else { return false }
            return normalized(field).contains(normalizedQuery)
        }
    }

    static func matches(transaction: Transaction, query: String) -> Bool {
        matches(query: query, fields: [
            transaction.merchant,
            transaction.note,
            transaction.amount.description,
            transaction.amountSats.map { String($0) },
            transaction.category,
            transaction.card,
        ])
    }

    static func matches(todo: TodoItem, query: String) -> Bool {
        matches(query: query, fields: [
            todo.title,
            todo.project,
            todo.area,
        ])
    }
}
