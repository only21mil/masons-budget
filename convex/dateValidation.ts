// Canonical Convex validation for ledger date-only fields.
//
// Both the legacy blob writeback and row-table mutations derive month-scoped
// data from the first seven characters of these values. A malformed date must
// therefore be rejected before either path persists it.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const EARLIEST_YEAR = 2000;
const DAY_MS = 86_400_000;

export type DateReject = (
  code: string,
  field: string,
  message: string,
) => never;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * A real calendar date, not a Date.UTC round-trip: `new Date("2026-02-30")`
 * rolls forward to March 2nd, which would file a mistyped February row under
 * the wrong month and quietly move budget spend between two months.
 */
export function isRealIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const length =
    (DAYS_IN_MONTH[month - 1] as number) +
    (month === 2 && isLeapYear(year) ? 1 : 0);
  return day <= length;
}

/**
 * Require a date-only `yyyy-MM-dd`, a real calendar day, inside a plausible
 * window. Callers provide their own structured rejection function so both
 * Convex write APIs keep their established error envelope.
 */
export function requireIsoDate(
  value: string,
  field: string,
  now: number,
  forwardDays: number,
  reject: DateReject,
): string {
  if (value !== value.trim()) {
    reject("invalid_date", field, `${field} has surrounding whitespace`);
  }
  if (!ISO_DATE.test(value)) {
    reject(
      "invalid_date",
      field,
      `${field} must be an ISO calendar date (yyyy-MM-dd), got ` +
        `${JSON.stringify(value)}`,
    );
  }
  if (!isRealIsoDate(value)) {
    reject(
      "invalid_date",
      field,
      `${field} is not a real calendar date: ${value}`,
    );
  }
  const year = Number(value.slice(0, 4));
  if (year < EARLIEST_YEAR) {
    reject(
      "date_out_of_range",
      field,
      `${field} of ${value} is before ${EARLIEST_YEAR}; that is a typo, not a ` +
        "transaction",
    );
  }
  const latest = new Date(now + forwardDays * DAY_MS).toISOString().slice(0, 10);
  if (value > latest) {
    reject(
      "date_out_of_range",
      field,
      `${field} of ${value} is more than ${forwardDays} days in the future ` +
        `(limit ${latest})`,
    );
  }
  return value;
}
