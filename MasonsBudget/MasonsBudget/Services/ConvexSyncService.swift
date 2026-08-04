import Foundation
import os
import SwiftData

protocol SyncMetadataStoring: AnyObject {
    func object(forKey defaultName: String) -> Any?
    func string(forKey defaultName: String) -> String?
    func dictionary(forKey defaultName: String) -> [String: Any]?
    func set(_ value: Any?, forKey defaultName: String)
    func removeObject(forKey defaultName: String)
}

extension UserDefaults: SyncMetadataStoring {}

@MainActor
final class ConvexSyncService {
    private let reader: ConvexDataReader
    private let context: ModelContext
    private let metadataStore: any SyncMetadataStoring
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "ConvexSync")

    static let lastSyncKey = "mc2_last_sync"
    static let lastSyncErrorKey = "mc2_last_sync_error"
    static let syncCountKey = "mc2_sync_entity_count"
    static let selectedMemberKey = "selected_family_member"
    static let dataVersionsKey = "mc2_data_versions"

    private var currentMember: FamilyMember {
        let raw = metadataStore.string(forKey: Self.selectedMemberKey) ?? "victor"
        return FamilyMember(rawValue: raw) ?? .victor
    }

    init(
        reader: ConvexDataReader,
        context: ModelContext,
        metadataStore: any SyncMetadataStoring = UserDefaults.standard
    ) {
        self.reader = reader
        self.context = context
        self.metadataStore = metadataStore
    }

    /// Convenience init using the default Convex client.
    init(
        context: ModelContext,
        metadataStore: any SyncMetadataStoring = UserDefaults.standard
    ) {
        reader = ConvexDataReader()
        self.context = context
        self.metadataStore = metadataStore
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
        } else if currentMember.hasDedicatedChildFinanceFiles {
            // Mason: sync his own budget, transactions, BTC buys, and finances.
            totalEntities += await syncSonBalances(&errors)
            totalEntities += await syncMasonBudget(&errors)
            totalEntities += await syncMasonTransactions(&errors)
            totalEntities += await syncMasonBTCBuys(&errors)
            totalEntities += await syncFinances(&errors)
        } else {
            // Maddox does not have dedicated finance data yet. Keep his sync
            // limited to shared todos until a dedicated row scope exists.
            let member = currentMember
            log.info("No dedicated finance sync path for \(member.rawValue, privacy: .public)")
        }

        do {
            try recordNetWorthSnapshot()
        } catch {
            errors.append("Net worth snapshot")
            log.error("Failed to record net worth snapshot")
        }

        do {
            try context.save()
            log.info("Convex sync complete: \(totalEntities) entities")
        } catch {
            log.error("Failed to save context: \(error.localizedDescription)")
            errors.append("Save failed: \(error.localizedDescription)")
        }

        if errors.isEmpty {
            do {
                // Fetch first, then publish the versions LAST. The version map is
                // the completion marker: if the process stops during metadata
                // publication, the old versions remain and polling retries.
                let versions = try await reader.checkVersions()
                Self.publishSuccessfulSync(
                    versions: versions,
                    totalEntities: totalEntities,
                    timestamp: Date().timeIntervalSince1970,
                    to: metadataStore,
                )
            } catch {
                errors.append("Versions")
                metadataStore.set("Versions", forKey: Self.lastSyncErrorKey)
                log.error("Failed to save sync versions")
            }
        } else {
            metadataStore.set(errors.joined(separator: "; "), forKey: Self.lastSyncErrorKey)
            log.warning("Sync completed with errors: \(errors.joined(separator: "; "))")
        }
    }

    /// Lightweight version check — returns true if any data has changed since last sync.
    /// Note: versions are stored AFTER syncAll() completes (in syncAll), not here,
    /// so a failed sync will retry on the next poll.
    func hasUpdates() async -> Bool {
        do {
            let remoteVersions = try await reader.checkVersions()
            let savedData = metadataStore.dictionary(forKey: Self.dataVersionsKey) as? [String: Double] ?? [:]
            return remoteVersions != savedData
        } catch {
            log.error("Version check failed: \(error.localizedDescription)")
            return true // Assume updates if check fails
        }
    }

    static func publishSuccessfulSync(
        versions: [String: Double],
        totalEntities: Int,
        timestamp: TimeInterval,
        to store: any SyncMetadataStoring,
    ) {
        store.set(timestamp, forKey: lastSyncKey)
        store.set(totalEntities, forKey: syncCountKey)
        store.removeObject(forKey: lastSyncErrorKey)
        // Completion marker. Do not add writes after this line.
        store.set(versions, forKey: dataVersionsKey)
    }

    // MARK: - Individual sync methods

    private func syncTransactions(_ errors: inout [String]) async -> Int {
        do {
            let batch = try await reader.readTransactions(viewer: currentMember)
            let models = LedgerMapper.mapTransactions(batch.value)
            let owners = batch.replacementOwners.map { Array($0) } ?? [.victor, .rachel]
            try replaceTransactions(ownedBy: owners, with: models)
            return models.count
        } catch {
            log.error("Transactions sync failed: \(error.localizedDescription)")
            errors.append("Transactions: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncBudget(_ errors: inout [String]) async -> Int {
        do {
            let dto = try await reader.readBudget(viewer: currentMember)
            let currentSnapshot = LedgerMapper.mapBudgetSnapshot(dto)
            let historicalSnapshots = LedgerMapper.mapMonthlyHistory(dto.monthlyHistory)
            let categories = LedgerMapper.mapBudgetCategories(dto.categories)
            try replaceBudgetData(forOwner: .victor, snapshots: [currentSnapshot] + historicalSnapshots, categories: categories)

            let incomeTransactions = LedgerMapper.mapPaychecksToTransactions(dto.income?.paychecks)
            try replaceIncomeTransactions(forOwner: .victor, with: incomeTransactions)

            return 1 + historicalSnapshots.count + categories.count + incomeTransactions.count
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
            let accounts = LedgerMapper.mapBTCAccounts(dto, owner: owner)
            try replaceBTCAccounts(ownedBy: [.victor, .rachel], with: accounts)
            return accounts.count
        } catch {
            log.error("BTC accounts sync failed: \(error.localizedDescription)")
            errors.append("BTC accounts: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncBTCBuys(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readBTCBuys(viewer: currentMember)
            let models = dtos.map { LedgerMapper.mapBTCBuy($0) }
            try replaceBTCBuys(ownedBy: [.victor, .rachel], with: models)
            return models.count
        } catch {
            log.error("BTC buys sync failed: \(error.localizedDescription)")
            errors.append("BTC buys: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncBTCBillPays(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readBTCBillPays(viewer: currentMember)
            let models = dtos.map { LedgerMapper.mapBTCBillPay($0) }
            try replaceBTCBillPays(ownedBy: [.victor, .rachel], with: models)
            return models.count
        } catch {
            log.error("BTC bill pays sync failed: \(error.localizedDescription)")
            errors.append("BTC bill pays: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncTodos(_ errors: inout [String]) async -> Int {
        do {
            let batch = try await reader.readTodos(viewer: currentMember)
            let models = LedgerMapper.mapTodos(batch.value, viewer: currentMember)
            try replaceTodos(
                visibleTo: currentMember,
                with: models,
                replacementOwners: batch.replacementOwners,
            )
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
            let accounts = LedgerMapper.mapFinances(dto, owner: currentMember)
            try replaceHoldingAccounts(visibleTo: currentMember, with: accounts)
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
            let accounts = LedgerMapper.mapSonBalances(dto)
            try replaceBTCAccounts(ownedBy: [.mason], with: accounts)
            return accounts.count
        } catch {
            log.error("Son balances sync failed: \(error.localizedDescription)")
            errors.append("Son balances: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncMasonBudget(_ errors: inout [String]) async -> Int {
        do {
            let dto = try await reader.readMasonBudget(viewer: currentMember)
            let categories = LedgerMapper.mapBudgetCategories(dto.categories, owner: .mason)
            let snapshot = makeMasonSnapshot(from: dto)

            try replaceBudgetData(forOwner: .mason, snapshots: [snapshot], categories: categories)
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
    private func makeMasonSnapshot(from dto: LegacyMasonBudgetDTO) -> MonthlyBudgetSnapshot {
        let masonKey = "mason:\(dto.month)"
        if let income = dto.income, let weeklyGross = income.weeklyGross, weeklyGross > 0 {
            let monthly = income.monthlyGross ?? (weeklyGross * Decimal(52) / Decimal(12))
            let actualIncome = LedgerMapper.actualIncomeTotals(income: income, budgetMonth: dto.month)
            return MonthlyBudgetSnapshot(
                monthKey: masonKey,
                weeklyGross: weeklyGross,
                weeklyStrike: income.weeklyStrike ?? 0,
                weeklyRiver: income.weeklyRiver ?? 0,
                monthlyGross: monthly,
                mtdIncome: actualIncome.mtd,
                ytdIncome: actualIncome.ytd,
                payFrequency: income.payFrequency ?? "weekly",
                strategyNote: nil,
            )
        }

        let weeklyAllowance = dto.allowance?.weekly ?? 0
        return MonthlyBudgetSnapshot(
            monthKey: masonKey,
            weeklyGross: weeklyAllowance,
            monthlyGross: weeklyAllowance * 4,
            mtdIncome: weeklyAllowance * 4,
            ytdIncome: weeklyAllowance * 4,
            strategyNote: "Allowance: $\(weeklyAllowance)/week from \(dto.allowance?.source ?? "Parents")",
        )
    }

    private func syncMasonTransactions(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readMasonTransactions(viewer: currentMember)
            let models = LedgerMapper.mapTransactions(dtos, owner: .mason)
            try replaceTransactions(ownedBy: [.mason], with: models)
            return models.count
        } catch {
            log.error("Mason transactions sync failed: \(error.localizedDescription)")
            errors.append("Mason transactions: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncMasonBTCBuys(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readMasonBTCBuys(viewer: currentMember)
            let models = dtos.map { LedgerMapper.mapBTCBuy($0, owner: .mason) }
            try replaceBTCBuys(ownedBy: [.mason], with: models)
            return models.count
        } catch {
            log.error("Mason BTC buys sync failed: \(error.localizedDescription)")
            errors.append("Mason BTC buys: \(error.localizedDescription)")
            return 0
        }
    }

    func recordNetWorthSnapshot() throws {
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
                .filter { currentMember.sharesNetWorth(with: $0.ownerMember) }
                .reduce(Decimal(0)) { $0 + $1.usdValue() }
            let vooPrice = StockPriceService.vooPrice
            let ibitPrice = StockPriceService.ibitPrice
            let holdingsValue = holdingAccounts
                .filter { currentMember.sharesNetWorth(with: $0.ownerMember) }
                .reduce(Decimal(0)) { $0 + $1.liveValue(vooPrice: vooPrice, ibitPrice: ibitPrice) }

            let snapshot = NetWorthSnapshot(
                totalValue: btcValue + holdingsValue,
                btcValue: btcValue,
                holdingsValue: holdingsValue,
                owner: currentMember,
            )
            context.insert(snapshot)
    }

    private func replaceBudgetData(forOwner owner: FamilyMember, snapshots: [MonthlyBudgetSnapshot], categories: [BudgetCategory]) throws {
        let existingSnapshots = try context.fetch(FetchDescriptor<MonthlyBudgetSnapshot>())
        let existingCats = try context.fetch(FetchDescriptor<BudgetCategory>())

        // Snapshots: keyed by unique monthKey. Index ALL existing rows so an insert
        // can never collide with an out-of-scope monthKey.
        let prefix = owner == .victor ? "" : "\(owner.rawValue):"
        let remoteSnapshotKeys = Set(snapshots.map(\.monthKey))
        var existingSnapshotByKey: [String: MonthlyBudgetSnapshot] = [:]
        for s in existingSnapshots {
            existingSnapshotByKey[s.monthKey] = s
        }
        for s in existingSnapshots {
            let isOwned = owner == .victor ? !s.monthKey.contains(":") : s.monthKey.hasPrefix(prefix)
            guard isOwned else { continue }
            guard !remoteSnapshotKeys.contains(s.monthKey) else { continue }
            context.delete(s)
        }
        for snapshot in snapshots {
            if let local = existingSnapshotByKey[snapshot.monthKey] {
                updateMonthlyBudgetSnapshot(local, from: snapshot)
            } else {
                context.insert(snapshot)
            }
        }

        // Categories: keyed by unique name. Index ALL existing rows so an insert
        // can never collide with an out-of-scope name.
        let remoteCatKeys = Set(categories.map(\.name))
        var existingCatByKey: [String: BudgetCategory] = [:]
        for cat in existingCats {
            existingCatByKey[cat.name] = cat
        }
        for cat in existingCats where cat.owner == owner.rawValue {
            guard !remoteCatKeys.contains(cat.name) else { continue }
            context.delete(cat)
        }
        for cat in categories {
            if let local = existingCatByKey[cat.name] {
                updateBudgetCategory(local, from: cat)
            } else {
                context.insert(cat)
            }
        }
    }

    private func updateMonthlyBudgetSnapshot(_ local: MonthlyBudgetSnapshot, from remote: MonthlyBudgetSnapshot) {
        local.coinbaseOneBalance = remote.coinbaseOneBalance
        local.weeklyGross = remote.weeklyGross
        local.weeklyStrike = remote.weeklyStrike
        local.weeklyRiver = remote.weeklyRiver
        local.monthlyGross = remote.monthlyGross
        local.mtdIncome = remote.mtdIncome
        local.ytdIncome = remote.ytdIncome
        local.payFrequency = remote.payFrequency
        local.strategyNote = remote.strategyNote
        local.lastUpdated = remote.lastUpdated
    }

    private func updateBudgetCategory(_ local: BudgetCategory, from remote: BudgetCategory) {
        local.icon = remote.icon
        local.monthlyBudget = remote.monthlyBudget
        local.sortOrder = remote.sortOrder
        local.isIncome = remote.isIncome
        local.owner = remote.owner
    }

    private func replaceBTCAccounts(ownedBy owners: [FamilyMember], with accounts: [BTCAccount]) throws {
        let existing = try context.fetch(FetchDescriptor<BTCAccount>())

        let remoteKeys = Set(accounts.map(\.key))
        var existingByKey: [String: BTCAccount] = [:]
        for account in existing {
            existingByKey[account.key] = account
        }

        for account in existing where owners.contains(account.ownerMember) {
            guard !remoteKeys.contains(account.key) else { continue }
            context.delete(account)
        }

        for account in accounts {
            if let local = existingByKey[account.key] {
                updateBTCAccount(local, from: account)
            } else {
                context.insert(account)
            }
        }
    }

    private func updateBTCAccount(_ local: BTCAccount, from remote: BTCAccount) {
        local.label = remote.label
        local.custody = remote.custody
        local.btc = remote.btc
        local.fiat = remote.fiat
        local.owner = remote.owner
        local.lastUpdated = remote.lastUpdated
    }

    func replaceTransactions(ownedBy owners: [FamilyMember], with transactions: [Transaction]) throws {
        let existing = try context.fetch(FetchDescriptor<Transaction>())

        let remoteIds = Set(transactions.map(\.id))
        var existingById: [String: Transaction] = [:]
        for transaction in existing {
            existingById[transaction.id] = transaction
        }

        for transaction in existing where owners.contains(transaction.ownerMember) && transaction.createdBy == "mc2" {
            guard !remoteIds.contains(transaction.id) else { continue }
            context.delete(transaction)
        }

        // Retry actions are intentionally in-memory. The source marker makes
        // their failure durable: after a complete successful row read, remove
        // only retry-pending app rows the server still does not contain. Active
        // attempts clear the marker before network I/O, so sync cannot reap an
        // in-flight optimistic row.
        for transaction in existing where owners.contains(transaction.ownerMember)
            && transaction.createdBy == "app"
            && transaction.sourceFile == Transaction.pendingRowWriteSource
        {
            guard !remoteIds.contains(transaction.id) else { continue }
            context.delete(transaction)
        }

        for transaction in transactions {
            if let local = existingById[transaction.id] {
                updateTransaction(local, from: transaction)
            } else {
                context.insert(transaction)
            }
        }
    }

    private func updateTransaction(_ local: Transaction, from remote: Transaction) {
        local.date = remote.date
        local.merchant = remote.merchant
        local.amount = remote.amount
        local.category = remote.category
        local.amountSats = remote.amountSats
        local.enteredInBitcoin = remote.enteredInBitcoin
        local.card = remote.card
        local.note = remote.note
        local.owner = remote.owner
        local.createdBy = remote.createdBy
        local.createdAt = remote.createdAt
        local.sourceFile = remote.sourceFile
        local.updatedAtMs = remote.updatedAtMs
    }

    private func replaceBTCBuys(ownedBy owners: [FamilyMember], with buys: [BTCBuy]) throws {
        let existing = try context.fetch(FetchDescriptor<BTCBuy>())

        let remoteIds = Set(buys.map(\.id))
        var existingById: [String: BTCBuy] = [:]
        for buy in existing {
            existingById[buy.id] = buy
        }

        for buy in existing {
            guard let member = buy.ownerMember, owners.contains(member) else { continue }
            guard !remoteIds.contains(buy.id) else { continue }
            guard buy.loggedBy != "app" else { continue }
            context.delete(buy)
        }

        for buy in buys {
            if let local = existingById[buy.id] {
                updateBTCBuy(local, from: buy)
            } else {
                context.insert(buy)
            }
        }
    }

    private func updateBTCBuy(_ local: BTCBuy, from remote: BTCBuy) {
        local.date = remote.date
        local.source = remote.source
        local.amountBTC = remote.amountBTC
        local.amountSats = remote.amountSats
        local.priceUSD = remote.priceUSD
        local.usd = remote.usd
        local.note = remote.note
        local.status = remote.status
        local.costBasisStatus = remote.costBasisStatus
        local.loggedBy = remote.loggedBy
        local.archimedesRequestId = remote.archimedesRequestId
        local.owner = remote.owner
    }

    private func replaceBTCBillPays(ownedBy owners: [FamilyMember], with billPays: [BTCBillPay]) throws {
        let existing = try context.fetch(FetchDescriptor<BTCBillPay>())

        let remoteIds = Set(billPays.map(\.id))
        var existingById: [String: BTCBillPay] = [:]
        for billPay in existing {
            existingById[billPay.id] = billPay
        }

        for billPay in existing where owners.contains(billPay.ownerMember) {
            guard !remoteIds.contains(billPay.id) else { continue }
            context.delete(billPay)
        }

        for billPay in billPays {
            if let local = existingById[billPay.id] {
                updateBTCBillPay(local, from: billPay)
            } else {
                context.insert(billPay)
            }
        }
    }

    private func updateBTCBillPay(_ local: BTCBillPay, from remote: BTCBillPay) {
        local.date = remote.date
        local.merchant = remote.merchant
        local.category = remote.category
        local.amountUSD = remote.amountUSD
        local.btcSpent = remote.btcSpent
        local.btcPrice = remote.btcPrice
        local.feeUSD = remote.feeUSD
        local.platform = remote.platform
        local.note = remote.note
        local.reference = remote.reference
        local.owner = remote.owner
    }

    func replaceTodos(
        visibleTo _: FamilyMember,
        with remoteTodos: [TodoItem],
        replacementOwners: Set<FamilyMember>? = nil,
    ) throws {
        let existing = try context.fetch(FetchDescriptor<TodoItem>())

        // A complete row snapshot explicitly names its replacement scope, even
        // when one owner currently has zero rows. Legacy payloads can only prove
        // absence for owners actually present in the payload. App-only todos are
        // untouched in either mode.
        let remoteOwners = replacementOwners ?? Set(remoteTodos.map(\.ownerMember))
        // `mc2` is persisted provenance from the legacy import, not a live system name.
        let scopedLegacyImports = existing.filter {
            $0.createdBy == "mc2" && remoteOwners.contains($0.ownerMember)
        }
        // Full id index across ALL existing rows so an insert can never collide with an
        // existing @Attribute(.unique) id (app-created or out-of-scope owner).
        let existingById = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let remoteById = Dictionary(remoteTodos.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // A todo the user just deleted is removed locally immediately and its
        // remote delete starts immediately. Do not resurrect it if a sync lands
        // while that delete is still in flight. Same-actor (@MainActor) read.
        let pendingDeleteID = TaskUndoStore.shared.pending?.id

        for remote in remoteTodos {
            if let local = existingById[remote.id] {
                // An app-created row owns this id: never overwrite user-entered data and never
                // insert a duplicate of the unique id.
                if local.createdBy == "app" {
                    log.warning("Skipping imported todo \(remote.id): id already owned by app-created row")
                    continue
                }
                guard local.createdBy == "mc2" else {
                    log.warning("Skipping imported todo \(remote.id): id already owned by another source")
                    continue
                }
                if remote.updatedAt > local.updatedAt {
                    local.title = remote.title
                    local.project = remote.project
                    local.area = remote.area
                    local.dueDate = remote.dueDate
                    local.priority = remote.priority
                    local.isFlagged = remote.isFlagged
                    local.isDone = remote.isDone
                    local.owner = remote.owner
                    local.updatedAt = remote.updatedAt
                    local.sourceFile = remote.sourceFile
                    local.createdBy = "mc2"
                }
            } else if remote.id != pendingDeleteID {
                context.insert(remote)
            }
        }

        for local in scopedLegacyImports {
            if remoteById[local.id] == nil {
                context.delete(local)
            }
        }
    }

    func replaceIncomeTransactions(forOwner owner: FamilyMember, with transactions: [Transaction]) throws {
        let existing = try context.fetch(FetchDescriptor<Transaction>())

        let remoteIds = Set(transactions.map(\.id))
        var existingById: [String: Transaction] = [:]
        for tx in existing {
            existingById[tx.id] = tx
        }

        // Budget sync owns only paycheck-derived rows. Row-API transactions
        // also arrive as createdBy=mc2, but belong to transactions.json and
        // must survive the syncTransactions -> syncBudget sequence.
        for tx in existing where tx.ownerMember == owner
            && tx.category == "Income"
            && tx.createdBy == "mc2"
            && tx.sourceFile == "budget.json"
        {
            guard !remoteIds.contains(tx.id) else { continue }
            context.delete(tx)
        }

        for tx in transactions {
            if let local = existingById[tx.id] {
                updateTransaction(local, from: tx)
            } else {
                context.insert(tx)
            }
        }
    }

    private func replaceHoldingAccounts(visibleTo viewer: FamilyMember, with accounts: [HoldingAccount]) throws {
        let existing = try context.fetch(FetchDescriptor<HoldingAccount>())

        let remoteNames = Set(accounts.map(\.name))
        var existingByName: [String: HoldingAccount] = [:]
        for account in existing {
            existingByName[account.name] = account
        }

        for account in existing where viewer.canSee(dataOwnedBy: account.ownerMember) {
            guard !remoteNames.contains(account.name) else { continue }
            context.delete(account)
        }

        for account in accounts {
            if let local = existingByName[account.name] {
                // Update the existing (uniquely-named) parent in place. The remote
                // parent object is discarded; only its freshly-built cascade children
                // are reparented onto the local row. Holding / HoldingLot carry no
                // unique attribute, so delete+reinsert of children is collision-safe.
                updateHoldingAccount(local, from: account)
            } else {
                // Brand-new account: its cascade children come with it.
                context.insert(account)
            }
        }
    }

    private func updateHoldingAccount(_ local: HoldingAccount, from remote: HoldingAccount) {
        local.provider = remote.provider
        local.owner = remote.owner
        local.totalValue = remote.totalValue
        local.weeklyContribution = remote.weeklyContribution
        local.lastUpdated = remote.lastUpdated
        for h in local.holdings {
            context.delete(h)
        }
        local.holdings = remote.holdings
    }
}
