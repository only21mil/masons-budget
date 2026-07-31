// Fixed upstream acquisition for the shared BTC/VOO/IBIT quote snapshot.
//
// This module intentionally accepts no URL, host, ticker, or redirect target
// from a caller. The internal Convex action invokes acquireFixedMarketQuotes()
// with the platform fetch implementation; the fetch argument exists only so
// the boundary can be unit-tested without touching the network.

export const MARKET_SYMBOLS = ["BTC", "VOO", "IBIT"] as const;
export type MarketSymbol = (typeof MARKET_SYMBOLS)[number];

export type MarketQuoteAcquisition =
  | {
      symbol: MarketSymbol;
      ok: true;
      priceCents: bigint;
      source: string;
      fetchedAt: string;
    }
  | {
      symbol: MarketSymbol;
      ok: false;
      attemptedAt: string;
    };

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const SOURCE = "Vogel Vault";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_INT64 = 9_223_372_036_854_775_807n;

// Reviewed endpoints from the existing Apple price services. Each endpoint is
// a literal HTTPS URL under the Vogel Vault domain. Keep this record closed.
const ENDPOINTS: Readonly<Record<MarketSymbol, string>> = Object.freeze({
  BTC: "https://sats21m.com/api/price/btc",
  VOO: "https://sats21m.com/api/price/voo",
  IBIT: "https://sats21m.com/api/price/ibit",
});

/**
 * Extract the exact lexical value of the root `price` property.
 *
 * JSON.parse turns a JSON number into an IEEE-754 number before callers can
 * inspect it. We use JSON.parse only to validate the object shape, then retain
 * the one unambiguous source lexeme. Nested, escaped, or duplicate `price` keys
 * are refused rather than ambiguously selected.
 */
export function extractRootPriceDecimal(text: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error("Quote response is not valid JSON");
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded) ||
    !Object.prototype.hasOwnProperty.call(decoded, "price")
  ) {
    throw new Error("Quote response is missing a price");
  }

  const priceType = typeof (decoded as { price?: unknown }).price;
  if (priceType !== "number" && priceType !== "string") {
    throw new Error("Quote response price is not a decimal");
  }

  const matches = [
    ...text.matchAll(
      /"price"\s*:\s*(?:"([^"\\]*)"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?))/g,
    ),
  ];
  if (matches.length !== 1) {
    throw new Error("Quote response price is ambiguous");
  }
  const price = matches[0]?.[1] ?? matches[0]?.[2];
  if (price === undefined) {
    throw new Error("Quote response price is not a decimal");
  }
  return price;
}

/**
 * Convert a positive decimal USD price to exact signed-64-bit cents.
 *
 * Fractional cents round half away from zero, matching the shared domain money
 * contract. The accepted lexical size is intentionally small so an upstream
 * response cannot force unbounded BigInt exponentiation.
 */
export function decimalUsdToCents(value: string): bigint {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new Error("Quote price is not a supported decimal");
  }
  const match = trimmed.match(/^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new Error("Quote price is not a supported decimal");

  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 18) {
    throw new Error("Quote price exponent is out of range");
  }
  const digitsText = `${whole}${fraction}`.replace(/^0+/, "") || "0";
  if (digitsText.length > 24) {
    throw new Error("Quote price is out of range");
  }

  const digits = BigInt(digitsText);
  const centShift = 2 + exponent - fraction.length;
  let cents: bigint;
  if (centShift >= 0) {
    cents = digits * 10n ** BigInt(centShift);
  } else {
    const divisor = 10n ** BigInt(-centShift);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    cents = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }

  if (cents <= 0n) throw new Error("Quote price must be positive");
  if (cents > MAX_INT64) throw new Error("Quote price is out of range");
  return cents;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > MAX_RESPONSE_BYTES
    ) {
      throw new Error("Quote response is too large");
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("Quote response is too large");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Quote response is too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function acquireOne(
  symbol: MarketSymbol,
  fetchImplementation: FetchImplementation,
  now: () => Date,
): Promise<MarketQuoteAcquisition> {
  const attemptedAt = now().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(ENDPOINTS[symbol], {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Quote endpoint returned HTTP ${response.status}`);
    }
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new Error("Quote endpoint did not return JSON");
    }
    const priceCents = decimalUsdToCents(
      extractRootPriceDecimal(await readBoundedResponse(response)),
    );
    return {
      symbol,
      ok: true,
      priceCents,
      source: SOURCE,
      fetchedAt: now().toISOString(),
    };
  } catch {
    return { symbol, ok: false, attemptedAt };
  } finally {
    clearTimeout(timeout);
  }
}

/** Acquire all fixed symbols concurrently and retain a result for every one. */
export async function acquireFixedMarketQuotes(
  fetchImplementation: FetchImplementation = fetch,
  now: () => Date = () => new Date(),
): Promise<MarketQuoteAcquisition[]> {
  return Promise.all(
    MARKET_SYMBOLS.map((symbol) =>
      acquireOne(symbol, fetchImplementation, now),
    ),
  );
}
