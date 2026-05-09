import Foundation
import SwiftData
import os

@MainActor
final class MC2SyncService {
    private let reader: MC2Reader
    private let context: ModelContext
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "MC2Sync")

    static let lastSyncKey = "mc2_last_sync"
    static let lastSyncErrorKey = "mc2_last_sync_error"
    static let syncCountKey = "mc2_sync_entity_count"
    static let selectedMemberKey = "selected_family_member"
    static let dataVersionsKey = "mc2_data_versions"

    private var currentMember: FamilyMember {
        let raw = UserDefaults.standard.string(forKey: Self.selectedMemberKey) ?? "victor"
        return FamilyMember(rawValue: raw) ?? .victor
    }

    init(reader: MC2Reader, context: ModelContext) {
        self.reader = reader
        self.context = context
    }

    /// Convenience init using the default Convex client.
    init(context: ModelContext) {
        self.reader = MC2Reader()
        self.context = context
    }

    func syncAll() async {
        log.info("Starting Convex sync")
        var errors: [String] = []
        var totalEntities = 0

        totalEntities += await syncTodos(&errors)

        if currentMember.isAdult {
            // Adults: full household sync
            totalEntities += await syncTransactions(&errors)
            totalEntities += await syncBudget(&errors)
            totalEntities += await syncBTCAccounts(&errors)
            totalEntities += await syncSonBalances(&errors)
            totalEntities += await syncBTCBuys(&errors)
            totalEntities += await syncBTCBillPays(&errors)
            totalEntities += await syncFinances(&errors)
        } else if currentMember.hasDedicatedMC2ChildFinanceFiles {
            // Mason: sync his own budget, transactions, BTC buys, and finances.
            totalEntities += await syncSonBalances(&errors)
            totalEntities += await syncMasonBudget(&errors)
            totalEntities += await syncMasonTransactions(&errors)
            totalEntities += await syncMasonBTCBuys(&errors)
            totalEntities += await syncFinances(&errors)
        } else {
            // Maddox does not have dedicated MC2 finance files yet. Keep his sync
            // limited to shared todos until those data files exist.
            log.info("No dedicated MC2 finance sync path for \(self.currentMember.rawValue, privacy: .public)")
        }

        recordNetWorthSnapshot()

        do {
            try context.save()
            log.info("Convex sync complete: \(totalEntities) entities")
        } catch {
            log.error("Failed to save context: \(error.localizedDescription)")
            errors.append("Save failed: \(error.localizedDescription)")
        }

        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.lastSyncKey)
        UserDefaults.standard.set(totalEntities, forKey: Self.syncCountKey)
        if errors.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.lastSyncErrorKey)
            // Only mark versions as synced when sync fully succeeds
            await saveCurrentVersions()
        } else {
            UserDefaults.standard.set(errors.joined(separator: "; "), forKey: Self.lastSyncErrorKey)
            log.warning("Sync completed with errors: \(errors.joined(separator: "; "))")
        }
    }

    /// Lightweight version check — returns true if any data has changed since last sync.
    /// Note: versions are stored AFTER syncAll() completes (in syncAll), not here,
    /// so a failed sync will retry on the next poll.
    func hasUpdates() async -> Bool {
        do {
            let remoteVersions = try await reader.checkVersions()
            let savedData = UserDefaults.standard.dictionary(forKey: Self.dataVersionsKey) as? [String: Double] ?? [:]
            return remoteVersions != savedData
        } catch {
            log.error("Version check failed: \(error.localizedDescription)")
            return true // Assume updates if check fails
        }
    }

    /// Save current remote versions to UserDefaults (call after successful sync).
    func saveCurrentVersions() async {
        do {
            let versions = try await reader.checkVersions()
            UserDefaults.standard.set(versions, forKey: Self.dataVersionsKey)
        } catch {
            log.error("Failed to save versions: \(error.localizedDescription)")
        }
    }

    // MARK: - Individual sync methods

    private func syncTransactions(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readTransactions()
            let models = MC2Mapper.mapTransactions(dtos)
            replaceTransactions(ownedBy: [.victor, .rachel], with: models)
            return models.count
        } catch {
            log.error("Transactions sync failed: \(error.localizedDescription)")
            errors.append("Transactions: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncBudget(_ errors: inout [String]) async -> Int {
        do {
            let dto = try await reader.readBudget()
            let snapshot = MC2Mapper.mapBudgetSnapshot(dto)
            let categories = MC2Mapper.mapBudgetCategories(dto.categories)
            replaceAll(MonthlyBudgetSnapshot.self, with: [snapshot])
            replaceAll(BudgetCategory.self, with: categories)
            return 1 + categories.count
        } catch {
            log.error("Budget sync failed: \(error.localizedDescription)")
            errors.append("Budget: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncBTCAccounts(_ errors: inout [String]) async -> Int {
        do {
            let dto = try await reader.readBTCSnapshot()
            let owner: FamilyMember = currentMember.isAdult ? .victor : currentMember
            let accounts = MC2Mapper.mapBTCAccounts(dto, owner: owner)
            replaceBTCAccounts(ownedBy: [.victor, .rachel], with: accounts)
            return accounts.count
        } catch {
            log.error("BTC accounts sync failed: \(error.localizedDescription)")
            errors.append("BTC accounts: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncBTCBuys(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readBTCBuys()
            let models = dtos.map { MC2Mapper.mapBTCBuy($0) }
            replaceBTCBuys(ownedBy: [.victor, .rachel], with: models)
            return models.count
        } catch {
            log.error("BTC buys sync failed: \(error.localizedDescription)")
            errors.append("BTC buys: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncBTCBillPays(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readBTCBillPays()
            let models = dtos.map { MC2Mapper.mapBTCBillPay($0) }
            replaceBTCBillPays(ownedBy: [.victor, .rachel], with: models)
            return models.count
        } catch {
            log.error("BTC bill pays sync failed: \(error.localizedDescription)")
            errors.append("BTC bill pays: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncTodos(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readTodos()
            let models = MC2Mapper.mapTodos(dtos, viewer: currentMember)
            replaceTodos(visibleTo: currentMember, with: models)
            return models.count
        } catch {
            log.error("Todos sync failed: \(error.localizedDescription)")
            errors.append("Todos: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncFinances(_ errors: inout [String]) async -> Int {
        do {
            let dto = try await reader.readFinances()
            let accounts = MC2Mapper.mapFinances(dto, owner: currentMember)
            replaceHoldingAccounts(visibleTo: currentMember, with: accounts)
            return accounts.count
        } catch {
            log.error("Finances sync failed: \(error.localizedDescription)")
            errors.append("Finances: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncSonBalances(_ errors: inout [String]) async -> Int {
        do {
            let dto = try await reader.readSonBalances()
            let accounts = MC2Mapper.mapSonBalances(dto)
            replaceBTCAccounts(ownedBy: [.mason], with: accounts)
            return accounts.count
        } catch {
            log.error("Son balances sync failed: \(error.localizedDescription)")
            errors.append("Son balances: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncMasonBudget(_ errors: inout [String]) async -> Int {
        do {
            let dto = try await reader.readMasonBudget()
            let categories = MC2Mapper.mapBudgetCategories(dto.categories)
            let snapshot = makeMasonSnapshot(from: dto)

            replaceAll(MonthlyBudgetSnapshot.self, with: [snapshot])
            replaceAll(BudgetCategory.self, with: categories)
            return 1 + categories.count
        } catch {
            log.error("Mason budget sync failed: \(error.localizedDescription)")
            errors.append("Mason budget: \(error.localizedDescription)")
            return 0
        }
    }

    /// Build Mason's monthly snapshot. Prefers a real `income` block (e.g., River
    /// direct-deposit paychecks) when present; falls back to the legacy
    /// `allowance` field for kids who don't have real income yet.
    private func makeMasonSnapshot(from dto: MC2MasonBudget) -> MonthlyBudgetSnapshot {
        if let income = dto.income, let weeklyGross = income.weeklyGross, weeklyGross > 0 {
            let monthly = income.monthlyGross ?? (weeklyGross * Decimal(52) / Decimal(12))
            let actualIncome = MC2Mapper.actualIncomeTotals(income: income, budgetMonth: dto.month)
            return MonthlyBudgetSnapshot(
                monthKey: dto.month,
                weeklyGross: weeklyGross,
                weeklyStrike: income.weeklyStrike ?? 0,
                weeklyRiver: income.weeklyRiver ?? 0,
                monthlyGross: monthly,
                mtdIncome: actualIncome.mtd,
                ytdIncome: actualIncome.ytd,
                payFrequency: income.payFrequency ?? "weekly",
                strategyNote: nil
            )
        }

        let weeklyAllowance = dto.allowance?.weekly ?? 0
        return MonthlyBudgetSnapshot(
            monthKey: dto.month,
            weeklyGross: weeklyAllowance,
            monthlyGross: weeklyAllowance * 4,
            mtdIncome: weeklyAllowance * 4,
            ytdIncome: weeklyAllowance * 4,
            strategyNote: "Allowance: $\(weeklyAllowance)/week from \(dto.allowance?.source ?? "Parents")"
        )
    }

    private func syncMasonTransactions(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readMasonTransactions()
            let models = MC2Mapper.mapTransactions(dtos, owner: .mason)
            replaceTransactions(ownedBy: [.mason], with: models)
            return models.count
        } catch {
            log.error("Mason transactions sync failed: \(error.localizedDescription)")
            errors.append("Mason transactions: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncMasonBTCBuys(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readMasonBTCBuys()
            let models = dtos.map { MC2Mapper.mapBTCBuy($0, owner: .mason) }
            replaceBTCBuys(ownedBy: [.mason], with: models)
            return models.count
        } catch {
            log.error("Mason BTC buys sync failed: \(error.localizedDescription)")
            errors.append("Mason BTC buys: \(error.localizedDescription)")
            return 0
        }
    }

    private func recordNetWorthSnapshot() {
        do {
            // Only record one snapshot per day per member to avoid unbounded growth
            let cal = Calendar.current
            let existing = try context.fetch(FetchDescriptor<NetWorthSnapshot>())
            let todaySnapshots = existing.filter {
                $0.ownerMember == currentMember && cal.isDateInToday($0.date)
            }
            // Remove today's stale snapshots — we'll replace with fresh data
            for old in todaySnapshots {
                context.delete(old)
            }

            // Prune snapshots older than 90 days to keep storage bounded
            let cutoff = cal.date(byAdding: .day, value: -90, to: Date()) ?? Date()
            for old in existing.filter({ $0.date < cutoff }) {
                context.delete(old)
            }

            let btcAccounts = try context.fetch(FetchDescriptor<BTCAccount>())
            let holdingAccounts = try context.fetch(FetchDescriptor<HoldingAccount>())

            let btcValue = btcAccounts
                .filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
                .reduce(Decimal(0)) { $0 + $1.usdValue() }
            let holdingsValue = holdingAccounts
                .filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
                .reduce(Decimal(0)) { $0 + $1.totalValue }

            let snapshot = NetWorthSnapshot(
                totalValue: btcValue + holdingsValue,
                btcValue: btcValue,
                holdingsValue: holdingsValue,
                owner: currentMember
            )
            context.insert(snapshot)
        } catch {
            log.error("Failed to record net worth snapshot: \(error.localizedDescription)")
        }
    }

    private func replaceAll<T: PersistentModel>(_ type: T.Type, with models: [T]) {
        deleteAll(type)
        for model in models {
            context.insert(model)
        }
    }

    private func replaceBTCAccounts(ownedBy owners: [FamilyMember], with accounts: [BTCAccount]) {
        do {
            let existing = try context.fetch(FetchDescriptor<BTCAccount>())
            for account in existing where owners.contains(account.ownerMember) {
                context.delete(account)
            }
        } catch {
            log.error("Failed to delete BTCAccount slice: \(error.localizedDescription)")
        }

        for account in accounts {
            context.insert(account)
        }
    }

    private func replaceTransactions(ownedBy owners: [FamilyMember], with transactions: [Transaction]) {
        do {
            let existing = try context.fetch(FetchDescriptor<Transaction>())
            for transaction in existing where owners.contains(transaction.ownerMember) {
                context.delete(transaction)
            }
        } catch {
            log.error("Failed to delete Transaction slice: \(error.localizedDescription)")
        }

        for transaction in transactions {
            context.insert(transaction)
        }
    }

    private func replaceBTCBuys(ownedBy owners: [FamilyMember], with buys: [BTCBuy]) {
        do {
            let existing = try context.fetch(FetchDescriptor<BTCBuy>())
            for buy in existing where owners.contains(buy.ownerMember ?? .victor) {
                context.delete(buy)
            }
        } catch {
            log.error("Failed to delete BTCBuy slice: \(error.localizedDescription)")
        }

        for buy in buys {
            context.insert(buy)
        }
    }

    private func replaceBTCBillPays(ownedBy owners: [FamilyMember], with billPays: [BTCBillPay]) {
        do {
            let existing = try context.fetch(FetchDescriptor<BTCBillPay>())
            for billPay in existing where owners.contains(billPay.ownerMember) {
                context.delete(billPay)
            }
        } catch {
            log.error("Failed to delete BTCBillPay slice: \(error.localizedDescription)")
        }

        for billPay in billPays {
            context.insert(billPay)
        }
    }

    private func replaceTodos(visibleTo viewer: FamilyMember, with todos: [TodoItem]) {
        do {
            let existing = try context.fetch(FetchDescriptor<TodoItem>())
            for todo in existing where viewer.canSee(dataOwnedBy: todo.ownerMember) {
                context.delete(todo)
            }
        } catch {
            log.error("Failed to delete TodoItem slice: \(error.localizedDescription)")
        }

        for todo in todos {
            context.insert(todo)
        }
    }

    private func replaceHoldingAccounts(visibleTo viewer: FamilyMember, with accounts: [HoldingAccount]) {
        do {
            let existing = try context.fetch(FetchDescriptor<HoldingAccount>())
            for account in existing where viewer.canSee(dataOwnedBy: account.ownerMember) {
                context.delete(account)
            }
        } catch {
            log.error("Failed to delete HoldingAccount slice: \(error.localizedDescription)")
        }

        for account in accounts {
            context.insert(account)
        }
    }

    private func deleteAll<T: PersistentModel>(_ type: T.Type) {
        do {
            let existing = try context.fetch(FetchDescriptor<T>())
            for item in existing {
                context.delete(item)
            }
        } catch {
            log.error("Failed to delete \(String(describing: type)): \(error.localizedDescription)")
        }
    }
}
