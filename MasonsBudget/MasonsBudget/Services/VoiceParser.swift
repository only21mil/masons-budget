import Foundation

struct ParsedTransaction: Equatable {
    var amount: Decimal?
    var merchant: String?
    var category: String?
    var date: Date?
    var card: String?
    var note: String?
    var confidence: Confidence

    init(amount: Decimal? = nil, merchant: String? = nil, category: String? = nil, date: Date? = nil, card: String? = nil, note: String? = nil, confidence: Confidence = .neutral) {
        self.amount = amount
        self.merchant = merchant
        self.category = category
        self.date = date
        self.card = card
        self.note = note
        self.confidence = confidence
    }

    var hasMinimumFields: Bool {
        amount != nil && merchant != nil
    }
}

struct Confidence: Equatable {
    var amount: Double
    var merchant: Double
    var category: Double
    var date: Double
    var card: Double
    var overall: Double

    static var neutral: Confidence {
        Confidence(amount: 0, merchant: 0, category: 0, date: 0, card: 0, overall: 0)
    }

    static func average(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        return values.reduce(0, +) / Double(values.count)
    }
}

protocol VoiceParserLLMFallback: AnyObject, Sendable {
    func refine(transcript: String, partial: ParsedTransaction) async -> ParsedTransaction
}

final class NoOpLLMFallback: VoiceParserLLMFallback, @unchecked Sendable {
    func refine(transcript: String, partial: ParsedTransaction) async -> ParsedTransaction {
        partial
    }
}

final class VoiceParser {
    private let llmFallback: VoiceParserLLMFallback?
    private let confidenceThreshold: Double

    init(llmFallback: VoiceParserLLMFallback? = nil, confidenceThreshold: Double = 0.5) {
        self.llmFallback = llmFallback
        self.confidenceThreshold = confidenceThreshold
    }

    func parse(_ transcript: String, today: Date) -> ParsedTransaction {
        let lower = transcript.lowercased()
        var hasExplicitDate = false
        var result = ParsedTransaction(confidence: .neutral)

        result.amount = extractAmount(from: lower)
        result.confidence.amount = result.amount != nil ? 0.9 : 0
        result.merchant = extractMerchant(from: transcript, lower: lower)
        result.confidence.merchant = result.merchant != nil ? 0.9 : 0
        result.card = extractCard(from: transcript, lower: lower)
        result.confidence.card = result.card != nil ? 0.9 : 0
        result.note = extractNote(from: transcript, lower: lower)
        result.category = inferCategory(transcript: lower, merchant: result.merchant)
        result.confidence.category = result.category != nil ? 0.9 : 0

        if let parsed = extractDate(from: lower, today: today) {
            result.date = parsed
            result.confidence.date = 0.95
            hasExplicitDate = true
        } else {
            result.date = today
            result.confidence.date = 0.5
        }

        let components: [Double] = [
            result.confidence.amount,
            result.confidence.merchant,
            result.confidence.category,
            hasExplicitDate ? result.confidence.date : 0,
            result.confidence.card,
        ]
        let active = components.filter { $0 > 0 }
        result.confidence.overall = active.isEmpty ? 0.3 : Confidence.average(active)

        return result
    }

    func parseWithFallback(_ transcript: String, today: Date) async -> ParsedTransaction {
        let result = parse(transcript, today: today)
        guard let fallback = llmFallback,
              result.confidence.overall < confidenceThreshold else {
            return result
        }
        return await fallback.refine(transcript: transcript, partial: result)
    }

    // MARK: - Amount extraction

    private let wordNumbers: [String: Decimal] = [
        "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4,
        "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
        "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
        "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
        "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30,
        "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
        "eighty": 80, "ninety": 90, "hundred": 100, "thousand": 1000,
    ]

    private func extractAmount(from lower: String) -> Decimal? {
        if let pattern = try? NSRegularExpression(pattern: "\\$(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?)"),
           let match = pattern.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)),
           let range = Range(match.range(at: 1), in: lower) {
            let raw = String(lower[range]).replacingOccurrences(of: ",", with: "")
            return Decimal(string: raw)
        }

        if let pattern = try? NSRegularExpression(pattern: "(\\d+(?:\\.\\d+)?)\\s*dollars"),
           let match = pattern.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)),
           let range = Range(match.range(at: 1), in: lower) {
            return Decimal(string: String(lower[range]))
        }

        if let pattern = try? NSRegularExpression(pattern: "(\\d+(?:\\.\\d+)?)\\s*bucks"),
           let match = pattern.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)),
           let range = Range(match.range(at: 1), in: lower) {
            return Decimal(string: String(lower[range]))
        }

        if let pattern = try? NSRegularExpression(pattern: "(?:spent|paid|spend|pay)(?:\\s+(?:about|roughly|around))?\\s+(\\d+(?:\\.\\d+)?)"),
           let match = pattern.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)),
           let range = Range(match.range(at: 1), in: lower) {
            return Decimal(string: String(lower[range]))
        }

        if let wordAmount = extractWordAmount(from: lower) {
            return wordAmount
        }

        if let pattern = try? NSRegularExpression(pattern: "paycheck\\s+(\\d+(?:\\.\\d+)?)"),
           let match = pattern.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)),
           let range = Range(match.range(at: 1), in: lower) {
            return Decimal(string: String(lower[range]))
        }

        return nil
    }

    private func extractWordAmount(from lower: String) -> Decimal? {
        let words = lower.split(separator: " ").map(String.init)
        guard let endIdx = words.firstIndex(where: { $0 == "dollars" || $0 == "bucks" }),
              endIdx > 0 else { return nil }

        var total: Decimal = 0
        var subtotal: Decimal = 0
        for w in words[0..<endIdx] {
            guard let value = wordNumbers[w] else { return nil }
            if value == 100 {
                subtotal = (subtotal == 0 ? 1 : subtotal) * 100
            } else if value == 1000 {
                subtotal = (subtotal == 0 ? 1 : subtotal) * 1000
                total += subtotal
                subtotal = 0
            } else {
                subtotal += value
            }
        }
        total += subtotal
        return total > 0 ? total : nil
    }

    // MARK: - Merchant extraction

    private func extractMerchant(from transcript: String, lower: String) -> String? {
        if let match = matchWordAfter(transcript, lower: lower, after: " at ") ?? matchWordAfter(transcript, lower: lower, after: " from ") ?? matchWordAfter(transcript, lower: lower, after: " to ") {
            return trimTrailingWords(match)
        }
        return matchServiceMerchantAfterFor(transcript, lower: lower)
    }

    private func matchWordAfter(_ original: String, lower: String, after word: String) -> String? {
        guard let range = lower.range(of: word) else { return nil }
        let afterOriginal = String(original[range.upperBound...])
        let words = afterOriginal.split(separator: " ").map(String.init)
        guard !words.isEmpty else { return nil }

        let stopWords: Set<String> = ["for", "yesterday", "today", "on", "with", "last", "the"]
        var merchWords: [String] = []
        for w in words {
            let lowerW = w.lowercased()
            if stopWords.contains(lowerW) { break }
            if lowerW.hasPrefix("note:") { break }
            if isDateWord(lowerW) { break }
            if lowerW.contains("/") && lowerW.rangeOfCharacter(from: CharacterSet.decimalDigits) != nil { break }
            merchWords.append(w)
        }
        guard !merchWords.isEmpty else { return nil }
        return merchWords.joined(separator: " ")
    }

    private func matchServiceMerchantAfterFor(_ original: String, lower: String) -> String? {
        guard let range = lower.range(of: " for ") else { return nil }
        let afterOriginal = String(original[range.upperBound...])
        let afterLower = String(lower[range.upperBound...])
        let serviceWords: Set<String> = ["subscription", "subscriptions", "service", "membership", "icloud"]
        guard afterLower.split(separator: " ").contains(where: { serviceWords.contains(String($0).trimmingCharacters(in: .punctuationCharacters)) }) else { return nil }

        var merchWords: [String] = []
        let skipWords: Set<String> = ["a", "an", "the"]
        let stopWords: Set<String> = ["subscription", "subscriptions", "service", "membership", "yesterday", "today", "on", "with", "last"]
        for w in afterOriginal.split(separator: " ").map(String.init) {
            let lowerW = w.lowercased().trimmingCharacters(in: .punctuationCharacters)
            if skipWords.contains(lowerW) { continue }
            if stopWords.contains(lowerW) { break }
            if lowerW.hasPrefix("note:") { break }
            if isDateWord(lowerW) { break }
            merchWords.append(w.trimmingCharacters(in: .punctuationCharacters))
        }
        return merchWords.isEmpty ? nil : merchWords.joined(separator: " ")
    }

    private func trimTrailingWords(_ input: String) -> String? {
        let stopWords: Set<String> = ["for", "yesterday", "today", "on", "with", "last"]
        var parts = input.split(separator: " ").map(String.init)
        while let last = parts.last?.lowercased(), stopWords.contains(last) {
            parts.removeLast()
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    private func isDateWord(_ word: String) -> Bool {
        let months: Set<String> = ["january", "february", "march", "april", "may", "june",
                                   "july", "august", "september", "october", "november", "december"]
        let days: Set<String> = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        return months.contains(word) || days.contains(word)
    }

    // MARK: - Category inference

    private let merchantCategories: [String: String] = [
        "aldi": "Groceries", "costco": "Groceries", "kroger": "Groceries",
        "publix": "Groceries", "samsclub": "Groceries", "traderjoes": "Groceries",
        "chickfila": "Dining & Drinks", "chipotle": "Dining & Drinks",
        "dunkin": "Dining & Drinks", "mcdonalds": "Dining & Drinks",
        "starbucks": "Dining & Drinks", "tacobell": "Dining & Drinks",
        "chevron": "Auto & Transport", "loves": "Auto & Transport",
        "racetrac": "Auto & Transport", "shell": "Auto & Transport",
        "amazon": "Shopping", "homedepot": "Shopping", "lowes": "Shopping",
        "target": "Shopping", "walmart": "Shopping",
        "apple": "Bills & Utilities", "appleicloud": "Bills & Utilities",
        "att": "Bills & Utilities", "comcast": "Bills & Utilities",
        "netflix": "Bills & Utilities", "pennymac": "Bills & Utilities",
        "verizon": "Bills & Utilities", "xfinity": "Bills & Utilities",
        "zapier": "Bills & Utilities",
        "cvs": "Medical", "walgreens": "Medical",
        "chewy": "Pets", "petsmart": "Pets", "petco": "Pets",
    ]

    private let categoryAliases: [(String, String)] = [
        ("bills and utilities", "Bills & Utilities"), ("bills utilities", "Bills & Utilities"),
        ("utilities", "Bills & Utilities"), ("bills", "Bills & Utilities"),
        ("dining and drinks", "Dining & Drinks"), ("dining drinks", "Dining & Drinks"),
        ("dining", "Dining & Drinks"), ("restaurants", "Dining & Drinks"),
        ("restaurant", "Dining & Drinks"), ("groceries", "Groceries"),
        ("grocery", "Groceries"), ("auto and transport", "Auto & Transport"),
        ("auto transport", "Auto & Transport"), ("transportation", "Auto & Transport"),
        ("auto", "Auto & Transport"), ("shopping", "Shopping"),
        ("health and wellness", "Health & Wellness"), ("health wellness", "Health & Wellness"),
        ("wellness", "Health & Wellness"), ("medical", "Medical"),
        ("pets", "Pets"), ("pet", "Pets"), ("income", "Income"),
    ]

    private let keywordCategories: [(String, String)] = [
        ("paycheck", "Income"), ("direct deposit", "Income"),
        ("groceries", "Groceries"), ("grocery", "Groceries"),
        ("lunch", "Dining & Drinks"), ("dinner", "Dining & Drinks"),
        ("breakfast", "Dining & Drinks"), ("coffee", "Dining & Drinks"),
        ("restaurant", "Dining & Drinks"), ("eating out", "Dining & Drinks"),
        ("takeout", "Dining & Drinks"), ("fast food", "Dining & Drinks"),
        ("gas station", "Auto & Transport"), ("gasoline", "Auto & Transport"),
        ("gas", "Auto & Transport"), ("fuel", "Auto & Transport"),
        ("oil change", "Auto & Transport"), ("car wash", "Auto & Transport"),
        ("parking", "Auto & Transport"), ("shopping", "Shopping"),
        ("clothes", "Shopping"), ("clothing", "Shopping"),
        ("home improvement", "Shopping"), ("medical", "Medical"),
        ("doctor", "Medical"), ("dentist", "Medical"),
        ("prescription", "Medical"), ("pharmacy", "Medical"),
        ("gym", "Health & Wellness"), ("fitness", "Health & Wellness"),
        ("subscription", "Bills & Utilities"), ("icloud", "Bills & Utilities"),
        ("electric", "Bills & Utilities"), ("internet", "Bills & Utilities"),
        ("phone bill", "Bills & Utilities"), ("mortgage", "Bills & Utilities"),
        ("insurance", "Bills & Utilities"), ("pets", "Pets"),
        ("pet food", "Pets"), ("dog", "Pets"), ("cat", "Pets"),
        ("vet", "Pets"), ("veterinary", "Pets"),
    ]

    private func inferCategory(transcript: String, merchant: String?) -> String? {
        let lower = transcript.lowercased()

        if let explicit = inferExplicitCategory(from: lower) {
            return explicit
        }

        if let merchantKey = merchant.map(normalizeCategoryKey), !merchantKey.isEmpty {
            if let exact = merchantCategories[merchantKey] {
                return exact
            }
            if let fuzzy = merchantCategories.first(where: { merchantKey.contains($0.key) || $0.key.contains(merchantKey) })?.value {
                return fuzzy
            }
        }

        for (keyword, category) in keywordCategories {
            if lower.contains(keyword) { return category }
        }

        return nil
    }

    private func inferExplicitCategory(from lower: String) -> String? {
        let prefixes = ["category", "categorize as", "categorized as", "under", "as"]
        for prefix in prefixes {
            for (alias, category) in categoryAliases {
                if lower.contains("\(prefix) \(alias)") { return category }
            }
        }
        return nil
    }

    private func normalizeCategoryKey(_ value: String) -> String {
        value.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    // MARK: - Date extraction

    private let weekdays: [String: Int] = [
        "sunday": 1, "monday": 2, "tuesday": 3, "wednesday": 4,
        "thursday": 5, "friday": 6, "saturday": 7,
    ]

    private let monthNames: [String: Int] = [
        "january": 1, "february": 2, "march": 3, "april": 4,
        "may": 5, "june": 6, "july": 7, "august": 8,
        "september": 9, "october": 10, "november": 11, "december": 12,
    ]

    private func extractDate(from lower: String, today: Date) -> Date? {
        let cal = Calendar(identifier: .gregorian)

        if lower.contains("the day before yesterday") {
            return cal.date(byAdding: .day, value: -2, to: cal.startOfDay(for: today))
        }
        if lower.contains("yesterday") {
            return cal.date(byAdding: .day, value: -1, to: cal.startOfDay(for: today))
        }
        if lower.contains("today") {
            return cal.startOfDay(for: today)
        }

        if let pattern = try? NSRegularExpression(pattern: "last\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)"),
           let match = pattern.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)),
           let range = Range(match.range(at: 1), in: lower),
           let target = weekdays[String(lower[range])] {
            return cal.nextDate(after: today, matching: DateComponents(weekday: target), matchingPolicy: .previousTimePreservingSmallerComponents, direction: .backward)
        }

        if let pattern = try? NSRegularExpression(pattern: "on\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)"),
           let match = pattern.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)),
           let range = Range(match.range(at: 1), in: lower),
           let target = weekdays[String(lower[range])] {
            return cal.nextDate(after: today, matching: DateComponents(weekday: target), matchingPolicy: .previousTimePreservingSmallerComponents, direction: .backward)
        }

        if let pattern = try? NSRegularExpression(pattern: "\\b(20\\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])\\b"),
           let match = pattern.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)),
           let range = Range(match.range(at: 0), in: lower) {
            let ymd = DateFormatter()
            ymd.dateFormat = "yyyy-MM-dd"
            ymd.locale = Locale(identifier: "en_US_POSIX")
            ymd.timeZone = cal.timeZone
            if let d = ymd.date(from: String(lower[range])) {
                return cal.startOfDay(for: d)
            }
        }

        if let pattern = try? NSRegularExpression(pattern: "\\b(\\d{1,2})/(\\d{1,2})\\b"),
           let match = pattern.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)),
           let mRange = Range(match.range(at: 1), in: lower),
           let dRange = Range(match.range(at: 2), in: lower),
           let month = Int(lower[mRange]),
           let day = Int(lower[dRange]),
           (1...12).contains(month), (1...31).contains(day) {
            var comps = cal.dateComponents([.year], from: today)
            comps.month = month
            comps.day = day
            return cal.date(from: comps)
        }

        if let pattern = try? NSRegularExpression(pattern: "(january|february|march|april|may|june|july|august|september|october|november|december)\\s+(\\d{1,2})"),
           let match = pattern.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)),
           let mRange = Range(match.range(at: 1), in: lower),
           let dRange = Range(match.range(at: 2), in: lower),
           let monthNum = monthNames[String(lower[mRange])],
           let day = Int(lower[dRange]) {
            var comps = cal.dateComponents([.year], from: today)
            comps.month = monthNum
            comps.day = day
            if monthNum > (cal.component(.month, from: today)) {
                comps.year = (comps.year ?? 2026) - 1
            }
            return cal.date(from: comps)
        }

        return nil
    }

    // MARK: - Card extraction

    private func extractCard(from original: String, lower: String) -> String? {
        if let range = lower.range(of: " with ") {
            let after = String(original[range.upperBound...])
            let words = after.split(separator: " ").map(String.init)
            var cardWords: [String] = []
            let skipWords: Set<String> = ["my"]
            let stopWords: Set<String> = ["on", "at", "for", "yesterday", "today", "last"]
            for w in words {
                if skipWords.contains(w.lowercased()) { continue }
                if stopWords.contains(w.lowercased()) { break }
                if w.lowercased().hasPrefix("note:") { break }
                if isDateWord(w.lowercased()) { break }
                cardWords.append(w)
            }
            return cardWords.isEmpty ? nil : cardWords.joined(separator: " ")
        }

        if let range = lower.range(of: " on ") {
            let after = String(original[range.upperBound...])
            let words = after.split(separator: " ").map(String.init)
            guard let first = words.first, !first.contains("/"),
                  !weekdays.keys.contains(first.lowercased()) else { return nil }
            var cardWords: [String] = [first]
            let stopWords: Set<String> = ["on", "at", "for", "yesterday", "today", "last"]
            for w in words.dropFirst() {
                if stopWords.contains(w.lowercased()) { break }
                if w.lowercased().hasPrefix("note:") { break }
                cardWords.append(w)
            }
            return cardWords.joined(separator: " ")
        }

        return nil
    }

    private func extractNote(from original: String, lower: String) -> String? {
        guard let range = lower.range(of: "note:") else { return nil }
        let after = String(original[range.upperBound...]).trimmingCharacters(in: .whitespaces)
        return after.isEmpty ? nil : after
    }
}

