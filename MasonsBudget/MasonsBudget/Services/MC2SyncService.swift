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

    private var currentMember: FamilyMember {
        let raw = UserDefaults.standard.string(forKey: Self.selectedMemberKey) ?? "victor"
        return FamilyMember(rawValue: raw) ?? .victor
    }

    init(reader: MC2Reader, context: ModelContext) {
        self.reader = reader
        self.context = context
    }

    func syncAll() async {
        log.info("Starting MC2 sync")
        var errors: [String] = []
        var totalEntities = 0

        // Always sync Mason's BTC from son-balances.json
        totalEntities += await syncSonBalances(&errors)

        if currentMember == .mason {
            // Mason: sync his own budget & transactions
            totalEntities += await syncMasonBudget(&errors)
            totalEntities += await syncMasonTransactions(&errors)
        } else {
            // Adults: full MC2 sync
            totalEntities += await syncTransactions(&errors)
            totalEntities += await syncBudget(&errors)
            totalEntities += await syncBTCAccounts(&errors)
            totalEntities += await syncBTCBuys(&errors)
            totalEntities += await syncBTCBillPays(&errors)
            totalEntities += await syncFinances(&errors)
        }

        recordNetWorthSnapshot()

        do {
            try context.save()
            log.info("MC2 sync complete: \(totalEntities) entities")
        } catch {
            log.error("Failed to save context: \(error.localizedDescription)")
            errors.append("Save failed: \(error.localizedDescription)")
        }

        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.lastSyncKey)
        UserDefaults.standard.set(totalEntities, forKey: Self.syncCountKey)
        if errors.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.lastSyncErrorKey)
        } else {
            UserDefaults.standard.set(errors.joined(separator: "; "), forKey: Self.lastSyncErrorKey)
            log.warning("Sync completed with errors: \(errors.joined(separator: "; "))")
        }
    }

    private func syncTransactions(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readTransactions()
            let models = MC2Mapper.mapTransactions(dtos)
            replaceAll(Transaction.self, with: models)
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
            let accounts = MC2Mapper.mapBTCAccounts(dto, owner: currentMember)
            replaceAll(BTCAccount.self, with: accounts)
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
            replaceAll(BTCBuy.self, with: models)
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
            replaceAll(BTCBillPay.self, with: models)
            return models.count
        } catch {
            log.error("BTC bill pays sync failed: \(error.localizedDescription)")
            errors.append("BTC bill pays: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncFinances(_ errors: inout [String]) async -> Int {
        do {
            let dto = try await reader.readFinances()
            let accounts = MC2Mapper.mapFinances(dto, owner: currentMember)
            deleteAll(HoldingLot.self)
            deleteAll(Holding.self)
            deleteAll(HoldingAccount.self)
            for account in accounts {
                context.insert(account)
            }
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
            for account in accounts {
                context.insert(account)
            }
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

            let weeklyAllowance = dto.allowance?.weekly ?? 0
            let snapshot = MonthlyBudgetSnapshot(
                monthKey: dto.month,
                weeklyGross: weeklyAllowance,
                monthlyGross: weeklyAllowance * 4,
                strategyNote: "Allowance: $\(weeklyAllowance)/week from \(dto.allowance?.source ?? "Parents")"
            )

            replaceAll(MonthlyBudgetSnapshot.self, with: [snapshot])
            replaceAll(BudgetCategory.self, with: categories)
            return 1 + categories.count
        } catch {
            log.error("Mason budget sync failed: \(error.localizedDescription)")
            errors.append("Mason budget: \(error.localizedDescription)")
            return 0
        }
    }

    private func syncMasonTransactions(_ errors: inout [String]) async -> Int {
        do {
            let dtos = try await reader.readMasonTransactions()
            let models = MC2Mapper.mapTransactions(dtos, owner: .mason)
            replaceAll(Transaction.self, with: models)
            return models.count
        } catch {
            log.error("Mason transactions sync failed: \(error.localizedDescription)")
            errors.append("Mason transactions: \(error.localizedDescription)")
            return 0
        }
    }

    private func recordNetWorthSnapshot() {
        do {
            let btcAccounts = try context.fetch(FetchDescriptor<BTCAccount>())
            let holdingAccounts = try context.fetch(FetchDescriptor<HoldingAccount>())

            let btcValue = btcAccounts
                .filter { $0.owner == currentMember }
                .reduce(Decimal(0)) { $0 + $1.btc } * AppTheme.assumedBTCPrice
            let holdingsValue = holdingAccounts
                .filter { $0.owner == currentMember }
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
