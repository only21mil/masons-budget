package com.sats21m.vogelvault.ui.voice

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class VoiceTransactionParserTest {
    private val today = LocalDate.of(2026, 4, 30)
    private val parser = VoiceTransactionParser()

    @Test
    fun `dollar sign amounts become exact cents`() {
        assertEquals(4_500L, parse("$45 at Costco").amountCents)
        assertEquals(1_250L, parse("spent $12.50 on lunch").amountCents)
        assertEquals(123_456L, parse("paid $1,234.56").amountCents)
    }

    @Test
    fun `dollars and bucks amounts become exact cents`() {
        assertEquals(4_500L, parse("45 dollars at Kroger").amountCents)
        assertEquals(1_230L, parse("12.30 dollars").amountCents)
        assertEquals(500L, parse("5 bucks").amountCents)
    }

    @Test
    fun `spend verbs identify amounts`() {
        assertEquals(4_500L, parse("spent 45 at Kroger").amountCents)
        assertEquals(10_000L, parse("paid about 100 at Costco").amountCents)
    }

    @Test
    fun `word number amounts become exact cents`() {
        assertEquals(500L, parse("five dollars at Starbucks").amountCents)
        assertEquals(4_500L, parse("forty five dollars at Kroger").amountCents)
        assertEquals(20_000L, parse("two hundred dollars").amountCents)
        assertEquals(100_000L, parse("one thousand dollars").amountCents)
    }

    @Test
    fun `missing amount remains missing with zero confidence`() {
        val result = parse("at Costco yesterday")
        assertNull(result.amountCents)
        assertEquals(0.0, result.confidence.amount)
    }

    @Test
    fun `identified amount has high confidence`() {
        assertTrue(parse("$45").confidence.amount >= 0.9)
    }

    @Test
    fun `at preposition identifies merchant`() {
        assertEquals("Costco", parse("$45 at Costco").merchant)
        assertEquals("Trader Joe's", parse("12 at Trader Joe's").merchant)
    }

    @Test
    fun `from preposition identifies merchant`() {
        assertEquals("Amazon", parse("$30 from Amazon").merchant)
    }

    @Test
    fun `service subscription identifies merchant`() {
        assertEquals("Apple iCloud", parse("I spent $9.99 for an Apple iCloud subscription").merchant)
        assertEquals("Apple iCloud", parse("paid 9.99 for Apple iCloud subscription").merchant)
    }

    @Test
    fun `merchant excludes trailing follow on words`() {
        assertEquals("Costco", parse("$45 at Costco For").merchant)
        assertEquals("Costco", parse("$45 at Costco Yesterday").merchant)
    }

    @Test
    fun `missing merchant remains missing`() {
        assertNull(parse("spent 5 dollars yesterday").merchant)
    }

    @Test
    fun `known merchants infer canonical categories`() {
        assertEquals("Groceries", parse("$45 at Costco").category)
        assertEquals("Dining & Drinks", parse("$12 at Chick-fil-A").category)
        assertEquals("Auto & Transport", parse("$60 at Shell").category)
        assertEquals("Shopping", parse("$35 at Target").category)
        assertEquals("Bills & Utilities", parse("$20 at Netflix").category)
    }

    @Test
    fun `category keyword is used when merchant is unknown`() {
        assertEquals("Groceries", parse("$45 for groceries").category)
    }

    @Test
    fun `service subscription infers utilities`() {
        assertEquals(
            "Bills & Utilities",
            parse("I spent $9.99 for an Apple iCloud subscription").category,
        )
        assertEquals(
            "Bills & Utilities",
            parse("paid 9.99 for Apple iCloud subscription").category,
        )
    }

    @Test
    fun `microphone cues use canonical categories`() {
        assertEquals("Dining & Drinks", parse("log 18 dollars at Starbucks for coffee").category)
        assertEquals("Auto & Transport", parse("spent 42 dollars at Shell gas station").category)
        assertEquals("Medical", parse("paid 120 dollars at CVS pharmacy").category)
        assertEquals("Pets", parse("spent 64 dollars at Chewy for dog food").category)
        assertEquals(
            "Health & Wellness",
            parse("paid 80 dollars under health and wellness").category,
        )
    }

    @Test
    fun `explicit category alias wins`() {
        assertEquals(
            "Bills & Utilities",
            parse("spent 22 dollars at Unknown category bills").category,
        )
        assertEquals(
            "Dining & Drinks",
            parse("spent 30 dollars at Food Truck under dining").category,
        )
    }

    @Test
    fun `lunch keyword infers dining`() {
        assertEquals("Dining & Drinks", parse("spent 12 on lunch yesterday").category)
    }

    @Test
    fun `paycheck infers income`() {
        assertEquals("Income", parse("paycheck 1500").category)
    }

    @Test
    fun `unknown category remains missing`() {
        assertNull(parse("$5 at SomethingObscure").category)
    }

    @Test
    fun `today phrase uses today`() {
        assertEquals(today, parse("$5 at Costco today").date)
    }

    @Test
    fun `yesterday phrase uses prior day`() {
        assertEquals(LocalDate.of(2026, 4, 29), parse("$5 at Costco yesterday").date)
    }

    @Test
    fun `day before yesterday phrase uses two days prior`() {
        assertEquals(
            LocalDate.of(2026, 4, 28),
            parse("$5 at Costco the day before yesterday").date,
        )
    }

    @Test
    fun `last weekday prefers the prior occurrence`() {
        assertEquals(LocalDate.of(2026, 4, 24), parse("$5 at Costco last Friday").date)
    }

    @Test
    fun `bare weekday prefers the prior occurrence`() {
        assertEquals(LocalDate.of(2026, 4, 28), parse("$5 at Costco on Tuesday").date)
    }

    @Test
    fun `ISO date is parsed`() {
        assertEquals(LocalDate.of(2026, 4, 15), parse("$5 at Costco 2026-04-15").date)
    }

    @Test
    fun `slash date is parsed in the current year`() {
        assertEquals(LocalDate.of(2026, 4, 15), parse("$5 at Costco 4/15").date)
    }

    @Test
    fun `month name date is parsed`() {
        assertEquals(LocalDate.of(2026, 4, 15), parse("$5 at Costco April 15").date)
    }

    @Test
    fun `future month name rolls to prior year`() {
        assertEquals(LocalDate.of(2025, 12, 1), parse("$5 at Costco December 1").date)
    }

    @Test
    fun `missing date defaults to today with lower confidence`() {
        val result = parse("$5 at Costco")
        assertEquals(today, result.date)
        assertEquals(0.5, result.confidence.date, 0.001)
    }

    @Test
    fun `on preposition identifies card`() {
        assertEquals("Strike", parse("$45 at Costco on Strike").card)
    }

    @Test
    fun `with my identifies card`() {
        assertEquals("Strike", parse("$45 at Costco with my Strike").card)
    }

    @Test
    fun `multiword card is retained`() {
        assertEquals("Apple Card", parse("$45 at Costco with Apple Card").card)
    }

    @Test
    fun `missing card remains missing`() {
        assertNull(parse("$45 at Costco").card)
    }

    @Test
    fun `note prefix captures the remainder`() {
        assertEquals("birthday cake", parse("$45 at Costco note: birthday cake").note)
    }

    @Test
    fun `missing note remains missing`() {
        assertNull(parse("$45 at Costco").note)
    }

    @Test
    fun `minimum fields require positive amount and merchant`() {
        assertTrue(parse("$45 at Costco").hasMinimumFields)
        assertFalse(parse("$45").hasMinimumFields)
        assertFalse(parse("at Costco").hasMinimumFields)
        assertFalse(parse("$0 at Costco").hasMinimumFields)
    }

    @Test
    fun `complete transcript has high overall confidence`() {
        assertTrue(parse("$45 at Costco yesterday").confidence.overall > 0.7)
    }

    @Test
    fun `unparsed transcript has low overall confidence`() {
        assertTrue(parse("spent some money").confidence.overall < 0.5)
    }

    @Test
    fun `realistic transcript parses all supplied fields`() {
        val result = parse("Spent $76.81 at Kroger yesterday with Strike")
        assertEquals(7_681L, result.amountCents)
        assertEquals("Kroger", result.merchant)
        assertEquals("Groceries", result.category)
        assertEquals("Strike", result.card)
        assertEquals(LocalDate.of(2026, 4, 29), result.date)
        assertTrue(result.confidence.overall > 0.8)
    }

    @Test
    fun `mortgage transcript parses all supplied fields`() {
        val result = parse("Paid $3,613.79 to PennyMac on Strike note: monthly mortgage")
        assertEquals(361_379L, result.amountCents)
        assertEquals("PennyMac", result.merchant)
        assertEquals("Bills & Utilities", result.category)
        assertEquals("Strike", result.card)
        assertEquals("monthly mortgage", result.note)
    }

    @Test
    fun `sub-cent and overflowing amounts are rejected rather than rounded`() {
        assertNull(parse("spent 12.345 dollars at Costco").amountCents)
        assertNull(parse("spent 999999999999999999 dollars at Costco").amountCents)
    }

    private fun parse(transcript: String): ParsedVoiceTransaction = parser.parse(transcript, today)
}
