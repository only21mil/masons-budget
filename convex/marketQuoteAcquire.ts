// Fixed upstream acquisition for the shared BTC/VOO/IBIT quote snapshot.
//
// This module intentionally accepts no URL, host, ticker, or redirect target
// from a caller. The internal Convex action invokes acquireFixedMarketQuotes()
// with the platform fetch implementation; the fetch argument exists only so
// the boundary can be unit-tested without touching the network.

export const MARKET_SYMBOLS = ["BTC", "VOO", "IBIT"] as const;
export type MarketSymbol = (typeof MARKET_SYMBOLS)[number];
export type MarketQuoteErrorCode =
  | "timeout"
  | "http_error"
  | "invalid_response"
  | "network_error";

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
      errorCode: MarketQuoteErrorCode;
    };

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const SOURCE = "Vogel Vault";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_INT64 = 9_223_372_036_854_775_807n;

class AcquisitionError extends Error {
  constructor(
    readonly code: Exclude<
      MarketQuoteErrorCode,
      "timeout" | "network_error"
    >,
  ) {
    super(code);
  }
}

// Reviewed endpoints from the existing Apple price services. Each endpoint is
// a literal HTTPS URL under the Vogel Vault domain. Keep this record closed.
const ENDPOINTS: Readonly<Record<MarketSymbol, string>> = Object.freeze({
  BTC: "https://sats21m.com/api/price/btc",
  VOO: "https://sats21m.com/api/price/voo",
  IBIT: "https://sats21m.com/api/price/ibit",
});

class QuoteJsonScanner {
  private index = 0;

  constructor(private readonly text: string) {}

  extractRootPriceDecimal(): string {
    this.skipWhitespace();
    if (this.take() !== "{") this.invalid();

    let foundPrice = false;
    let price = "";
    this.skipWhitespace();
    if (this.peek() !== "}") {
      while (true) {
        const key = this.parseString();
        this.skipWhitespace();
        if (this.take() !== ":") this.invalid();
        this.skipWhitespace();

        if (key === "price") {
          if (foundPrice) throw new Error("Quote response price is ambiguous");
          foundPrice = true;
          price = this.parsePrice();
        } else {
          this.parseValue(1);
        }

        this.skipWhitespace();
        const delimiter = this.take();
        if (delimiter === "}") break;
        if (delimiter !== ",") this.invalid();
        this.skipWhitespace();
      }
    } else {
      this.take();
    }

    this.skipWhitespace();
    if (this.index !== this.text.length) this.invalid();
    if (!foundPrice) throw new Error("Quote response is missing a price");
    return price;
  }

  private parsePrice(): string {
    const next = this.peek();
    if (next === '"') return this.parseString();
    if (next === "-" || this.isDigit(next)) return this.parseNumber();
    this.parseValue(1);
    throw new Error("Quote response price is not a decimal");
  }

  private parseValue(depth: number): void {
    if (depth > MAX_JSON_DEPTH) this.invalid();
    this.skipWhitespace();
    const next = this.peek();
    if (next === "{") {
      this.parseObject(depth);
    } else if (next === "[") {
      this.parseArray(depth);
    } else if (next === '"') {
      this.parseString();
    } else if (next === "t") {
      this.parseLiteral("true");
    } else if (next === "f") {
      this.parseLiteral("false");
    } else if (next === "n") {
      this.parseLiteral("null");
    } else if (next === "-" || this.isDigit(next)) {
      this.parseNumber();
    } else {
      this.invalid();
    }
  }

  private parseObject(depth: number): void {
    if (this.take() !== "{") this.invalid();
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.take();
      return;
    }
    while (true) {
      this.parseString();
      this.skipWhitespace();
      if (this.take() !== ":") this.invalid();
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const delimiter = this.take();
      if (delimiter === "}") return;
      if (delimiter !== ",") this.invalid();
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): void {
    if (this.take() !== "[") this.invalid();
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.take();
      return;
    }
    while (true) {
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const delimiter = this.take();
      if (delimiter === "]") return;
      if (delimiter !== ",") this.invalid();
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    if (this.take() !== '"') this.invalid();
    let decoded = "";
    while (this.index < this.text.length) {
      const character = this.take();
      if (character === '"') return decoded;
      if (character === "\\") {
        const escape = this.take();
        const simpleEscapes: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (escape === "u") {
          const hex = this.text.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.invalid();
          decoded += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
        } else if (Object.prototype.hasOwnProperty.call(simpleEscapes, escape)) {
          decoded += simpleEscapes[escape];
        } else {
          this.invalid();
        }
      } else {
        if (character.charCodeAt(0) <= 0x1f) this.invalid();
        decoded += character;
      }
    }
    this.invalid();
  }

  private parseNumber(): string {
    const start = this.index;
    if (this.peek() === "-") this.take();

    if (this.peek() === "0") {
      this.take();
    } else {
      if (!this.isDigitOneToNine(this.peek())) this.invalid();
      while (this.isDigit(this.peek())) this.take();
    }

    if (this.peek() === ".") {
      this.take();
      if (!this.isDigit(this.peek())) this.invalid();
      while (this.isDigit(this.peek())) this.take();
    }

    if (this.peek() === "e" || this.peek() === "E") {
      this.take();
      if (this.peek() === "+" || this.peek() === "-") this.take();
      if (!this.isDigit(this.peek())) this.invalid();
      while (this.isDigit(this.peek())) this.take();
    }
    return this.text.slice(start, this.index);
  }

  private parseLiteral(literal: string): void {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      this.invalid();
    }
    this.index += literal.length;
  }

  private skipWhitespace(): void {
    while (
      this.peek() === " " ||
      this.peek() === "\t" ||
      this.peek() === "\n" ||
      this.peek() === "\r"
    ) {
      this.index += 1;
    }
  }

  private peek(): string {
    return this.text[this.index] ?? "";
  }

  private take(): string {
    const character = this.peek();
    this.index += 1;
    return character;
  }

  private isDigit(character: string): boolean {
    return character >= "0" && character <= "9";
  }

  private isDigitOneToNine(character: string): boolean {
    return character >= "1" && character <= "9";
  }

  private invalid(): never {
    throw new Error("Quote response is not valid JSON");
  }
}

/** Validate one bounded JSON object and retain its exact root price token. */
export function extractRootPriceDecimal(text: string): string {
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Quote response is too large");
  }
  return new QuoteJsonScanner(text).extractRootPriceDecimal();
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
  let receivedResponse = false;
  try {
    const response = await fetchImplementation(ENDPOINTS[symbol], {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    receivedResponse = true;
    if (!response.ok) {
      throw new AcquisitionError("http_error");
    }
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new AcquisitionError("invalid_response");
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
  } catch (error) {
    const errorCode: MarketQuoteErrorCode = controller.signal.aborted
      ? "timeout"
      : error instanceof AcquisitionError
        ? error.code
        : receivedResponse
          ? "invalid_response"
          : "network_error";
    return { symbol, ok: false, attemptedAt, errorCode };
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
