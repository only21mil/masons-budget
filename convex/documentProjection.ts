// Typed projections for the five document-shaped legacy blobs.
//
// IMPORTANT: callers must supply JSON TEXT, not an already JSON-decoded value.
// JavaScript numbers are IEEE doubles. Once a money token has been decoded to a
// number, passing it through a number-to-decimal helper can round on the wrong
// side of a cent (the classic example is 1.005). This module quotes JSON number
// tokens before JSON.parse so money always reaches the integer parser in its
// lexical form.

export const DOCUMENT_SOURCE_FILES = [
  "budget",
  "mason-budget",
  "btc-balance-snapshot",
  "finances",
  "son-balances",
] as const;

export type DocumentSourceFile = (typeof DOCUMENT_SOURCE_FILES)[number];
export type BudgetSourceFile = "budget" | "mason-budget";
export type BtcBalanceSourceFile =
  | "btc-balance-snapshot"
  | "son-balances";
export type FamilyMember = "victor" | "rachel" | "mason" | "maddox";
export type Custody = "exchange" | "self_custody";

const FAMILY_MEMBERS: readonly FamilyMember[] = [
  "victor",
  "rachel",
  "mason",
  "maddox",
];

export interface BudgetDocumentRow {
  sourceFile: BudgetSourceFile;
  owner: FamilyMember;
  month: string;
  coinbaseOneBalanceCents: bigint;
  categories: Array<{
    name: string;
    icon?: string;
    budgetCents: bigint;
  }>;
  effectiveApr?: string;
  strategyNote?: string;
  income?: {
    weeklyGrossCents: bigint;
    weeklyStrikeCents: bigint;
    weeklyRiverCents: bigint;
    payFrequency?: string;
    monthlyGrossCents: bigint;
    mtdIncomeCents: bigint;
    ytdIncomeCents: bigint;
    paychecks: Array<{
      date: string;
      platform?: string;
      source?: string;
      amountCents: bigint;
      netCents: bigint;
      note?: string;
    }>;
  };
  mtdIncomeCents: bigint;
  ytdIncomeCents: bigint;
  monthlyHistory: Array<{
    month: string;
    incomeCents: bigint;
    expensesCents: bigint;
    savingsBps: bigint;
  }>;
  allowance?: {
    weeklyCents: bigint;
    source: string;
  };
  updatedAtMs: number;
}

export interface BtcBalanceDocumentRow {
  sourceFile: BtcBalanceSourceFile;
  owner: FamilyMember;
  schemaVersion: bigint;
  asOf: string;
  accounts: Array<{
    key: string;
    label: string;
    custody: Custody;
    sats: bigint;
    fiatCents: bigint;
  }>;
  totals: {
    sats: bigint;
    fiatCents: bigint;
    exchangeSats: bigint;
    selfCustodySats: bigint;
  };
  source?: string;
  basis?: string;
  confidence?: string;
  updatedAtMs: number;
}

export interface FinanceDocumentRow {
  sourceFile: "finances";
  lastUpdated: string;
  retirementTotalCents?: bigint;
  accounts: FinanceAccountRow[];
  updatedAtMs: number;
}

export interface FinanceAccountRow {
  key: string;
  owner: FamilyMember;
  provider: string;
  totalValueCents: bigint;
  weeklyContributionCents: bigint;
  weeklyContributionDay?: string;
  holdings: Array<{
    name: string;
    category: string;
    ticker?: string;
    valueCents: bigint;
    costBasisCents: bigint;
    gainBps: bigint;
    sharesDecimal: string;
    avgCostCents: bigint;
    currentPricePerShareCents: bigint;
    isProxy: boolean;
    proxyNote?: string;
    lots: Array<{
      date: string;
      type: string;
      pricePerShareCents: bigint;
      sharesDecimal: string;
      amountInvestedCents: bigint;
      note?: string;
    }>;
  }>;
}

export type ProjectedDocument =
  | { table: "budgetDocuments"; row: BudgetDocumentRow }
  | { table: "btcBalanceDocuments"; row: BtcBalanceDocumentRow }
  | { table: "financeDocuments"; row: FinanceDocumentRow };

/**
 * Dispatch helper intended for the migration lane. The closed switch is
 * deliberate: adding a source file requires choosing its typed table and owner.
 */
export function projectDocumentFile(
  sourceFile: DocumentSourceFile,
  rawJson: string,
  updatedAtMs: number,
): ProjectedDocument {
  switch (sourceFile) {
    case "budget":
    case "mason-budget":
      return {
        table: "budgetDocuments",
        row: projectBudgetDocument(rawJson, sourceFile, updatedAtMs),
      };
    case "btc-balance-snapshot":
    case "son-balances":
      return {
        table: "btcBalanceDocuments",
        row: projectBtcBalanceDocument(rawJson, sourceFile, updatedAtMs),
      };
    case "finances":
      return {
        table: "financeDocuments",
        row: projectFinanceDocument(rawJson, updatedAtMs),
      };
    default:
      throw new RangeError(`Unknown document source file: ${String(sourceFile)}`);
  }
}

export function projectBudgetDocument(
  rawJson: string,
  sourceFile: BudgetSourceFile,
  updatedAtMs: number,
): BudgetDocumentRow {
  const raw = parseLexicalJsonObject(rawJson, sourceFile);
  const owner: FamilyMember = sourceFile === "budget" ? "victor" : "mason";
  requireMatchingOwner(raw.owner, owner, `${sourceFile}.owner`);

  const strategy = asRecord(raw.strategy);
  const income = asRecord(raw.income);
  const allowance = asRecord(raw.allowance);

  return {
    sourceFile,
    owner,
    month: text(raw.month),
    coinbaseOneBalanceCents: parseMinorUnits(
      raw.coinbase_one_balance,
      2,
      `${sourceFile}.coinbase_one_balance`,
    ),
    // `spent` is intentionally not projected. Budget spend is derived from
    // transactions in this document's month.
    categories: asRecordArray(raw.categories).map((entry, index) => ({
      name: text(entry.name),
      icon: optionalText(entry.icon),
      budgetCents: parseMinorUnits(
        entry.budget,
        2,
        `${sourceFile}.categories[${index}].budget`,
      ),
    })),
    effectiveApr: strategy ? optionalText(strategy.effective_apr) : undefined,
    strategyNote: strategy
      ? optionalText(strategy.strategy_note)
      : undefined,
    income: income
      ? {
          weeklyGrossCents: parseMinorUnits(
            income.weekly_gross,
            2,
            `${sourceFile}.income.weekly_gross`,
          ),
          weeklyStrikeCents: parseMinorUnits(
            income.weekly_strike,
            2,
            `${sourceFile}.income.weekly_strike`,
          ),
          weeklyRiverCents: parseMinorUnits(
            income.weekly_river,
            2,
            `${sourceFile}.income.weekly_river`,
          ),
          payFrequency: optionalText(income.pay_frequency),
          monthlyGrossCents: parseMinorUnits(
            income.monthly_gross,
            2,
            `${sourceFile}.income.monthly_gross`,
          ),
          mtdIncomeCents: parseMinorUnits(
            income.mtd_income,
            2,
            `${sourceFile}.income.mtd_income`,
          ),
          ytdIncomeCents: parseMinorUnits(
            income.ytd_income,
            2,
            `${sourceFile}.income.ytd_income`,
          ),
          paychecks: asRecordArray(income.paychecks).map((entry, index) => ({
            date: text(entry.date),
            platform: optionalText(entry.platform),
            source: optionalText(entry.source),
            amountCents: parseMinorUnits(
              entry.amount,
              2,
              `${sourceFile}.income.paychecks[${index}].amount`,
            ),
            netCents: parseMinorUnits(
              entry.net,
              2,
              `${sourceFile}.income.paychecks[${index}].net`,
            ),
            note: optionalText(entry.note),
          })),
        }
      : undefined,
    mtdIncomeCents: parseMinorUnits(
      raw.mtd_income,
      2,
      `${sourceFile}.mtd_income`,
    ),
    ytdIncomeCents: parseMinorUnits(
      raw.ytd_income,
      2,
      `${sourceFile}.ytd_income`,
    ),
    monthlyHistory: asRecordArray(raw.monthly_history).map((entry, index) => ({
      month: text(entry.month),
      incomeCents: parseMinorUnits(
        entry.income,
        2,
        `${sourceFile}.monthly_history[${index}].income`,
      ),
      expensesCents: parseMinorUnits(
        entry.expenses,
        2,
        `${sourceFile}.monthly_history[${index}].expenses`,
      ),
      // A percentage with two decimal places maps exactly to basis points.
      savingsBps: parseMinorUnits(
        entry.savings_pct,
        2,
        `${sourceFile}.monthly_history[${index}].savings_pct`,
      ),
    })),
    allowance: allowance
      ? {
          weeklyCents: parseMinorUnits(
            allowance.weekly,
            2,
            `${sourceFile}.allowance.weekly`,
          ),
          source: text(allowance.source),
        }
      : undefined,
    updatedAtMs,
  };
}

export function projectBtcBalanceDocument(
  rawJson: string,
  sourceFile: BtcBalanceSourceFile,
  updatedAtMs: number,
): BtcBalanceDocumentRow {
  const raw = parseLexicalJsonObject(rawJson, sourceFile);
  const owner: FamilyMember =
    sourceFile === "btc-balance-snapshot" ? "victor" : "mason";
  requireMatchingOwner(raw.owner, owner, `${sourceFile}.owner`);

  if (sourceFile === "son-balances") {
    const accounts = [
      childBtcAccount(raw, "strike", "Strike", "exchange"),
      childBtcAccount(raw, "river", "River", "exchange"),
      childBtcAccount(raw, "coldcard", "Coldcard", "self_custody"),
    ];
    const exchangeSats = accounts
      .filter((account) => account.custody === "exchange")
      .reduce((sum, account) => sum + account.sats, 0n);
    const selfCustodySats = accounts
      .filter((account) => account.custody === "self_custody")
      .reduce((sum, account) => sum + account.sats, 0n);

    return {
      sourceFile,
      owner,
      schemaVersion: 0n,
      asOf: text(raw.lastUpdated ?? raw.last_updated),
      accounts,
      totals: {
        sats: parseMinorUnits(raw.total, 8, "son-balances.total"),
        fiatCents: 0n,
        exchangeSats,
        selfCustodySats,
      },
      updatedAtMs,
    };
  }

  const accountsRaw = asRecord(raw.accounts) ?? {};
  const totals = asRecord(raw.totals) ?? {};
  const metadata = asRecord(raw.metadata);
  const accounts = Object.entries(accountsRaw).map(([key, value]) => {
    const entry = requireRecord(
      value,
      `btc-balance-snapshot.accounts.${key}`,
    );
    const custody = requireCustody(
      entry.custody,
      `btc-balance-snapshot.accounts.${key}.custody`,
    );
    return {
      key,
      label: text(entry.label ?? key),
      custody,
      sats: parseMinorUnits(
        entry.btc,
        8,
        `btc-balance-snapshot.accounts.${key}.btc`,
      ),
      fiatCents: parseMinorUnits(
        entry.fiat,
        2,
        `btc-balance-snapshot.accounts.${key}.fiat`,
      ),
    };
  });
  const accountSats = accounts.reduce((sum, account) => sum + account.sats, 0n);
  const accountFiatCents = accounts.reduce(
    (sum, account) => sum + account.fiatCents,
    0n,
  );
  const exchangeSats = accounts
    .filter((account) => account.custody === "exchange")
    .reduce((sum, account) => sum + account.sats, 0n);
  const selfCustodySats = accounts
    .filter((account) => account.custody === "self_custody")
    .reduce((sum, account) => sum + account.sats, 0n);

  return {
    sourceFile,
    owner,
    schemaVersion: parseExactInteger(
      raw.schemaVersion ?? raw.schema_version,
      "btc-balance-snapshot.schemaVersion",
    ),
    asOf: text(raw.asOf ?? raw.as_of),
    accounts,
    totals: {
      sats:
        totals.btc === undefined
          ? accountSats
          : parseMinorUnits(
              totals.btc,
              8,
              "btc-balance-snapshot.totals.btc",
            ),
      fiatCents:
        totals.fiat === undefined
          ? accountFiatCents
          : parseMinorUnits(
              totals.fiat,
              2,
              "btc-balance-snapshot.totals.fiat",
            ),
      exchangeSats:
        totals.exchange_btc === undefined
          ? exchangeSats
          : parseMinorUnits(
              totals.exchange_btc,
              8,
              "btc-balance-snapshot.totals.exchange_btc",
            ),
      selfCustodySats:
        totals.self_custody_btc === undefined
          ? selfCustodySats
          : parseMinorUnits(
              totals.self_custody_btc,
              8,
              "btc-balance-snapshot.totals.self_custody_btc",
            ),
    },
    source: metadata ? optionalText(metadata.source) : undefined,
    basis: metadata ? optionalText(metadata.basis) : undefined,
    confidence: metadata ? optionalText(metadata.confidence) : undefined,
    updatedAtMs,
  };
}

export function projectFinanceDocument(
  rawJson: string,
  updatedAtMs: number,
): FinanceDocumentRow {
  const raw = parseLexicalJsonObject(rawJson, "finances");
  const retirement = asRecord(raw.retirement) ?? {};
  const retirementAccounts =
    asRecord(retirement.accounts) ?? retirement;

  const accounts = Object.entries(retirementAccounts)
    .filter(([, value]) => asRecord(value) !== null)
    .map(([key, value]) =>
      projectFinanceAccount(
        key,
        requireRecord(value, `finances.retirement.${key}`),
        undefined,
      ),
    );

  if (raw.mason_401k !== undefined && raw.mason_401k !== null) {
    accounts.push(
      projectFinanceAccount(
        "mason_401k",
        requireRecord(raw.mason_401k, "finances.mason_401k"),
        "mason",
      ),
    );
  }

  return {
    sourceFile: "finances",
    lastUpdated: text(raw.last_updated ?? raw.lastUpdated),
    retirementTotalCents:
      retirement.total === undefined
        ? undefined
        : parseMinorUnits(
            retirement.total,
            2,
            "finances.retirement.total",
          ),
    accounts,
    updatedAtMs,
  };
}

function projectFinanceAccount(
  key: string,
  raw: Record<string, unknown>,
  structuralOwner: FamilyMember | undefined,
): FinanceAccountRow {
  const owner = structuralOwner ?? ownerOrDefault(raw.owner, "victor", key);
  if (structuralOwner !== undefined) {
    requireMatchingOwner(raw.owner, structuralOwner, `finances.${key}.owner`);
  }

  return {
    key,
    owner,
    provider: text(raw.provider ?? key),
    totalValueCents: parseMinorUnits(
      raw.total,
      2,
      `finances.${key}.total`,
    ),
    weeklyContributionCents: parseMinorUnits(
      raw.weeklyContribution ?? raw.weekly_contribution,
      2,
      `finances.${key}.weeklyContribution`,
    ),
    weeklyContributionDay: optionalText(
      raw.weeklyContributionDay ?? raw.weekly_contribution_day,
    ),
    holdings: asRecordArray(raw.holdings).map((holding, holdingIndex) => ({
      name: text(holding.name),
      category: text(holding.category ?? "Uncategorized"),
      ticker: optionalText(holding.ticker),
      valueCents: parseMinorUnits(
        holding.value,
        2,
        `finances.${key}.holdings[${holdingIndex}].value`,
      ),
      costBasisCents: parseMinorUnits(
        holding.costBasis ?? holding.cost_basis ?? holding.value,
        2,
        `finances.${key}.holdings[${holdingIndex}].costBasis`,
      ),
      gainBps: parseMinorUnits(
        holding.gainPct ?? holding.gain_pct,
        2,
        `finances.${key}.holdings[${holdingIndex}].gainPct`,
      ),
      sharesDecimal: decimalText(
        holding.shares,
        `finances.${key}.holdings[${holdingIndex}].shares`,
      ),
      avgCostCents: parseMinorUnits(
        holding.avgCost ?? holding.avg_cost,
        2,
        `finances.${key}.holdings[${holdingIndex}].avgCost`,
      ),
      currentPricePerShareCents: parseMinorUnits(
        holding.currentPricePerShare ?? holding.current_price_per_share,
        2,
        `finances.${key}.holdings[${holdingIndex}].currentPricePerShare`,
      ),
      isProxy: Boolean(holding.proxy),
      proxyNote: optionalText(holding.proxyNote ?? holding.proxy_note),
      lots: asRecordArray(holding.lots).map((lot, lotIndex) => ({
        date: text(lot.date),
        type: text(lot.type),
        pricePerShareCents: parseMinorUnits(
          lot.pricePerShare ?? lot.price_per_share,
          2,
          `finances.${key}.holdings[${holdingIndex}].lots[${lotIndex}].pricePerShare`,
        ),
        sharesDecimal: decimalText(
          lot.shares,
          `finances.${key}.holdings[${holdingIndex}].lots[${lotIndex}].shares`,
        ),
        amountInvestedCents: parseMinorUnits(
          lot.amountInvested ?? lot.amount_invested,
          2,
          `finances.${key}.holdings[${holdingIndex}].lots[${lotIndex}].amountInvested`,
        ),
        note: optionalText(lot.note),
      })),
    })),
  };
}

function childBtcAccount(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  custody: Custody,
) {
  return {
    key,
    label,
    custody,
    sats: parseMinorUnits(raw[key], 8, `son-balances.${key}`),
    fiatCents: 0n,
  };
}

function ownerOrDefault(
  value: unknown,
  fallback: FamilyMember,
  context: string,
): FamilyMember {
  if (value === undefined || value === null || value === "") return fallback;
  return requireFamilyMember(value, `finances.${context}.owner`);
}

function requireMatchingOwner(
  value: unknown,
  expected: FamilyMember,
  context: string,
) {
  if (value === undefined || value === null || value === "") return;
  const actual = requireFamilyMember(value, context);
  if (actual !== expected) {
    throw new RangeError(
      `${context} must be ${expected} for this source file, got ${actual}`,
    );
  }
}

function requireFamilyMember(value: unknown, context: string): FamilyMember {
  if (
    typeof value === "string" &&
    (FAMILY_MEMBERS as readonly string[]).includes(value)
  ) {
    return value as FamilyMember;
  }
  throw new RangeError(
    `${context} must be one of ${FAMILY_MEMBERS.join(", ")}, got ${JSON.stringify(value)}`,
  );
}

function requireCustody(value: unknown, context: string): Custody {
  if (value === "exchange" || value === "self_custody") return value;
  throw new RangeError(
    `${context} must be exchange or self_custody, got ${JSON.stringify(value)}`,
  );
}

/**
 * Parse JSON while preserving every numeric token as a string.
 *
 * This is a small JSON lexer, not a regex replacement over arbitrary text:
 * quoted strings (including escapes) are copied byte-for-byte and only number
 * tokens outside strings are quoted before the platform JSON parser runs.
 */
export function parseLexicalJson(rawJson: string): unknown {
  if (typeof rawJson !== "string") {
    throw new TypeError("Document projection requires raw JSON text");
  }

  let quoted = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < rawJson.length; index += 1) {
    const character = rawJson[index];
    if (inString) {
      quoted += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      quoted += character;
      continue;
    }

    if (character === "-" || (character >= "0" && character <= "9")) {
      const match =
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
          rawJson.slice(index),
        );
      if (!match) {
        throw new SyntaxError(`Invalid JSON number at offset ${index}`);
      }
      quoted += JSON.stringify(match[0]);
      index += match[0].length - 1;
      continue;
    }

    quoted += character;
  }

  return JSON.parse(quoted);
}

function parseLexicalJsonObject(
  rawJson: string,
  context: string,
): Record<string, unknown> {
  return requireRecord(parseLexicalJson(rawJson), context);
}

function requireRecord(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new TypeError(`${context} must be a JSON object`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) =>
    requireRecord(entry, `array entry ${index}`),
  );
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function optionalText(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText === "" ? undefined : valueText;
}

function decimalText(value: unknown, context: string): string {
  if (value === undefined || value === null || value === "") return "0";
  const raw = String(value).trim();
  if (!DECIMAL_PATTERN.test(raw)) {
    throw new RangeError(`${context} is not a decimal value: ${JSON.stringify(value)}`);
  }
  return raw;
}

const DECIMAL_PATTERN =
  /^[+-]?(?:(?:\d+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Decimal text to integer minor units, rounded half away from zero without
 * ever constructing a JavaScript number.
 */
export function parseMinorUnits(
  value: unknown,
  scale: number,
  context = "value",
): bigint {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new RangeError(`Invalid minor-unit scale: ${scale}`);
  }
  if (value === undefined || value === null || value === "") return 0n;

  const raw = String(value).trim();
  const match =
    /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(
      raw,
    );
  if (!match) {
    throw new RangeError(
      `${context} is not a decimal value: ${JSON.stringify(value)}`,
    );
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? "0");
  if (!Number.isSafeInteger(exponent)) {
    throw new RangeError(`${context} has an unsupported exponent: ${raw}`);
  }

  const digits = (whole + fraction).replace(/^0+(?=\d)/, "");
  let magnitude = BigInt(digits || "0");
  const shift = scale + exponent - fraction.length;

  if (shift >= 0) {
    magnitude *= 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    const quotient = magnitude / divisor;
    const remainder = magnitude % divisor;
    magnitude = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }

  return sign * magnitude;
}

function parseExactInteger(value: unknown, context: string): bigint {
  if (value === undefined || value === null || value === "") return 0n;
  const raw = String(value).trim();
  const parsed = parseMinorUnits(raw, 0, context);
  const decimal = /^([+-]?)(\d+)$/.exec(raw);
  if (!decimal || BigInt(raw) !== parsed) {
    throw new RangeError(`${context} must be an integer, got ${raw}`);
  }
  return parsed;
}
