// Source-compatibility aliases for the surviving legacy blob schema.
//
// New code uses the explicit `Legacy…DTO` names. These aliases preserve the
// historical Swift boundary while shipped clients still decode `dataFiles`;
// they do not represent a live service or upstream system.

typealias MC2Transaction = LegacyTransactionDTO
typealias MC2BudgetCategory = LegacyBudgetCategoryDTO
typealias MC2BudgetStrategy = LegacyBudgetStrategyDTO
typealias MC2Paycheck = LegacyPaycheckDTO
typealias MC2BudgetIncome = LegacyBudgetIncomeDTO
typealias MC2MonthlyHistoryEntry = LegacyMonthlyHistoryEntryDTO
typealias MC2Budget = LegacyBudgetDTO
typealias MC2BTCBuy = LegacyBTCBuyDTO
typealias MC2BTCAccountEntry = LegacyBTCAccountEntryDTO
typealias MC2BTCTotals = LegacyBTCTotalsDTO
typealias MC2BTCSnapshot = LegacyBTCSnapshotDTO
typealias MC2BTCMetadata = LegacyBTCMetadataDTO
typealias MC2BTCBillPay = LegacyBTCBillPayDTO
typealias MC2BillPaysWrapper = LegacyBillPaysWrapperDTO
typealias MC2FinancesRetirement = LegacyFinancesRetirementDTO
typealias MC2FinanceAccount = LegacyFinanceAccountDTO
typealias MC2FinanceHolding = LegacyFinanceHoldingDTO
typealias MC2FinanceLot = LegacyFinanceLotDTO
typealias MC2Finances = LegacyFinancesDTO
typealias MC2SonBalances = LegacySonBalancesDTO
typealias MC2MasonAllowance = LegacyMasonAllowanceDTO
typealias MC2MasonBudget = LegacyMasonBudgetDTO
typealias MC2TodoItem = LegacyTodoDTO
typealias MC2TodosWrapper = LegacyTodosWrapperDTO
