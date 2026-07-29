package com.sats21m.vogelvault.ui.voice

import java.math.BigDecimal
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.Month

data class VoiceParseConfidence(
    val amount: Double = 0.0,
    val merchant: Double = 0.0,
    val category: Double = 0.0,
    val date: Double = 0.0,
    val card: Double = 0.0,
    val overall: Double = 0.0,
)

data class ParsedVoiceTransaction(
    /** Exact USD cents. Money never passes through Double. */
    val amountCents: Long? = null,
    val merchant: String? = null,
    val category: String? = null,
    val date: LocalDate? = null,
    val card: String? = null,
    val note: String? = null,
    val confidence: VoiceParseConfidence = VoiceParseConfidence(),
) {
    val hasMinimumFields: Boolean
        get() = amountCents != null && amountCents > 0L && !merchant.isNullOrBlank()
}

/**
 * Deterministic port of the Apple VoiceParser.
 *
 * Parsing produces a draft only. Callers must show the draft for review before
 * constructing or writing a transaction.
 *
 * There is deliberately no Android voice capture or write surface yet, so this
 * class has no production caller. The removed one requested RECORD_AUDIO, which
 * AndroidManifest.xml declares a review event rather than a convenience, and it
 * would have sent household audio to Google's recognition service — a privacy
 * change PRIVACY.md documents only for Apple's on-device framework. Shipping
 * Android voice entry therefore needs Victor's explicit permission and privacy
 * decision first, plus a capture surface and a writer built to the house write
 * pattern (its own client from VaultApplication, one distinct message per
 * ConvexResult cause, no suspend write callback threaded through the shell).
 * This parser and its tests are kept so that work starts from tested logic that
 * already matches the Apple client.
 */
class VoiceTransactionParser {
    fun parse(
        transcript: String,
        today: LocalDate,
    ): ParsedVoiceTransaction {
        val lower = transcript.lowercase()
        val amount = extractAmount(lower)
        val merchant = extractMerchant(transcript, lower)
        val card = extractCard(transcript, lower)
        val category = inferCategory(lower, merchant)
        val explicitDate = extractDate(lower, today)
        val components =
            listOf(
                if (amount != null) HIGH_CONFIDENCE else 0.0,
                if (merchant != null) HIGH_CONFIDENCE else 0.0,
                if (category != null) HIGH_CONFIDENCE else 0.0,
                if (explicitDate != null) DATE_CONFIDENCE else 0.0,
                if (card != null) HIGH_CONFIDENCE else 0.0,
            )
        val active = components.filter { it > 0.0 }
        val confidence =
            VoiceParseConfidence(
                amount = components[0],
                merchant = components[1],
                category = components[2],
                date = if (explicitDate != null) DATE_CONFIDENCE else DEFAULT_DATE_CONFIDENCE,
                card = components[4],
                overall = if (active.isEmpty()) EMPTY_CONFIDENCE else active.average(),
            )

        return ParsedVoiceTransaction(
            amountCents = amount,
            merchant = merchant,
            category = category,
            date = explicitDate ?: today,
            card = card,
            note = extractNote(transcript, lower),
            confidence = confidence,
        )
    }

    private fun extractAmount(lower: String): Long? {
        DOLLAR_SIGN.find(lower)?.groupValues?.get(1)?.replace(",", "")?.let(::toCents)?.let {
            return it
        }
        DOLLARS.find(lower)?.groupValues?.get(1)?.let(::toCents)?.let { return it }
        BUCKS.find(lower)?.groupValues?.get(1)?.let(::toCents)?.let { return it }
        SPEND_VERB.find(lower)?.groupValues?.get(1)?.let(::toCents)?.let { return it }
        extractWordAmount(lower)?.let { return Math.multiplyExact(it, CENTS_PER_DOLLAR) }
        PAYCHECK.find(lower)?.groupValues?.get(1)?.let(::toCents)?.let { return it }
        return null
    }

    private fun toCents(raw: String): Long? =
        runCatching {
            BigDecimal(raw)
                .movePointRight(2)
                .longValueExact()
        }.getOrNull()

    private fun extractWordAmount(lower: String): Long? {
        val words = lower.split(WHITESPACE).filter(String::isNotEmpty)
        val end = words.indexOfFirst { it == "dollars" || it == "bucks" }
        if (end <= 0) return null

        var total = 0L
        var subtotal = 0L
        words.subList(0, end).forEach { word ->
            val value = WORD_NUMBERS[word] ?: return null
            when (value) {
                100L -> subtotal = Math.multiplyExact(if (subtotal == 0L) 1L else subtotal, value)
                1_000L -> {
                    subtotal = Math.multiplyExact(if (subtotal == 0L) 1L else subtotal, value)
                    total = Math.addExact(total, subtotal)
                    subtotal = 0L
                }
                else -> subtotal = Math.addExact(subtotal, value)
            }
        }
        total = Math.addExact(total, subtotal)
        return total.takeIf { it > 0L }
    }

    private fun extractMerchant(
        original: String,
        lower: String,
    ): String? =
        matchWordsAfter(original, lower, " at ")
            ?: matchWordsAfter(original, lower, " from ")
            ?: matchWordsAfter(original, lower, " to ")
            ?: matchServiceMerchantAfterFor(original, lower)

    private fun matchWordsAfter(
        original: String,
        lower: String,
        marker: String,
    ): String? {
        val markerIndex = lower.indexOf(marker)
        if (markerIndex < 0) return null
        val words = original.substring(markerIndex + marker.length).split(WHITESPACE).filter(String::isNotEmpty)
        val merchantWords = mutableListOf<String>()
        for (word in words) {
            val normalized = word.lowercase()
            if (
                normalized in MERCHANT_STOP_WORDS ||
                normalized.startsWith("note:") ||
                isDateWord(normalized) ||
                ('/' in normalized && normalized.any(Char::isDigit))
            ) {
                break
            }
            merchantWords += word
        }
        return merchantWords.joinToString(" ").trimTrailingWords()
    }

    private fun matchServiceMerchantAfterFor(
        original: String,
        lower: String,
    ): String? {
        val marker = " for "
        val markerIndex = lower.indexOf(marker)
        if (markerIndex < 0) return null
        val start = markerIndex + marker.length
        val afterOriginal = original.substring(start)
        val afterLower = lower.substring(start)
        val containsServiceWord =
            afterLower
                .split(WHITESPACE)
                .map(::trimPunctuation)
                .any(SERVICE_WORDS::contains)
        if (!containsServiceWord) return null

        val merchantWords = mutableListOf<String>()
        for (word in afterOriginal.split(WHITESPACE).filter(String::isNotEmpty)) {
            val normalized = trimPunctuation(word.lowercase())
            if (normalized in SERVICE_SKIP_WORDS) continue
            if (
                normalized in SERVICE_STOP_WORDS ||
                normalized.startsWith("note:") ||
                isDateWord(normalized)
            ) {
                break
            }
            merchantWords += trimPunctuation(word)
        }
        return merchantWords.joinToString(" ").ifBlank { null }
    }

    private fun String.trimTrailingWords(): String? {
        val parts = split(WHITESPACE).filter(String::isNotEmpty).toMutableList()
        while (parts.lastOrNull()?.lowercase() in TRAILING_MERCHANT_WORDS) {
            // Not removeLast(): on API 35 that resolves to java.util.List#removeLast,
            // which does not exist below 35, and minSdk here is 29.
            parts.removeAt(parts.lastIndex)
        }
        return parts.joinToString(" ").ifBlank { null }
    }

    private fun inferCategory(
        transcript: String,
        merchant: String?,
    ): String? {
        inferExplicitCategory(transcript)?.let { return it }

        val merchantKey = merchant?.normalizeCategoryKey().orEmpty()
        if (merchantKey.isNotEmpty()) {
            MERCHANT_CATEGORIES[merchantKey]?.let { return it }
            MERCHANT_CATEGORIES.entries.firstOrNull { (key, _) ->
                merchantKey.contains(key) || key.contains(merchantKey)
            }?.value?.let { return it }
        }

        return KEYWORD_CATEGORIES.firstOrNull { (keyword, _) ->
            transcript.contains(keyword)
        }?.second
    }

    private fun inferExplicitCategory(lower: String): String? {
        EXPLICIT_CATEGORY_PREFIXES.forEach { prefix ->
            CATEGORY_ALIASES.forEach { (alias, category) ->
                if (lower.contains("$prefix $alias")) return category
            }
        }
        return null
    }

    private fun String.normalizeCategoryKey(): String =
        lowercase().filter { it.isLetterOrDigit() }

    private fun extractDate(
        lower: String,
        today: LocalDate,
    ): LocalDate? {
        if ("the day before yesterday" in lower) return today.minusDays(2)
        if ("yesterday" in lower) return today.minusDays(1)
        if ("today" in lower) return today

        LAST_WEEKDAY.find(lower)?.groupValues?.get(1)?.let { weekday ->
            return previousWeekday(today, WEEKDAYS.getValue(weekday))
        }
        ON_WEEKDAY.find(lower)?.groupValues?.get(1)?.let { weekday ->
            return previousWeekday(today, WEEKDAYS.getValue(weekday))
        }
        ISO_DATE.find(lower)?.value?.let { raw ->
            runCatching { LocalDate.parse(raw) }.getOrNull()?.let { return it }
        }
        SLASH_DATE.find(lower)?.let { match ->
            val month = match.groupValues[1].toInt()
            val day = match.groupValues[2].toInt()
            runCatching { LocalDate.of(today.year, month, day) }.getOrNull()?.let { return it }
        }
        MONTH_NAME_DATE.find(lower)?.let { match ->
            val month = MONTHS.getValue(match.groupValues[1])
            val day = match.groupValues[2].toInt()
            val year = if (month.value > today.monthValue) today.year - 1 else today.year
            runCatching { LocalDate.of(year, month, day) }.getOrNull()?.let { return it }
        }
        return null
    }

    private fun previousWeekday(
        today: LocalDate,
        target: DayOfWeek,
    ): LocalDate {
        val difference = (today.dayOfWeek.value - target.value + 7) % 7
        return today.minusDays(if (difference == 0) 7 else difference.toLong())
    }

    private fun extractCard(
        original: String,
        lower: String,
    ): String? {
        val withIndex = lower.indexOf(" with ")
        if (withIndex >= 0) {
            val cardWords = mutableListOf<String>()
            for (word in original.substring(withIndex + 6).split(WHITESPACE).filter(String::isNotEmpty)) {
                val normalized = word.lowercase()
                if (normalized in CARD_SKIP_WORDS) continue
                if (
                    normalized in CARD_STOP_WORDS ||
                    normalized.startsWith("note:") ||
                    isDateWord(normalized)
                ) {
                    break
                }
                cardWords += word
            }
            return cardWords.joinToString(" ").ifBlank { null }
        }

        val onIndex = lower.indexOf(" on ")
        if (onIndex < 0) return null
        val words = original.substring(onIndex + 4).split(WHITESPACE).filter(String::isNotEmpty)
        val first = words.firstOrNull() ?: return null
        if ('/' in first || first.lowercase() in WEEKDAYS) return null
        val cardWords = mutableListOf(first)
        for (word in words.drop(1)) {
            val normalized = word.lowercase()
            if (normalized in CARD_STOP_WORDS || normalized.startsWith("note:")) break
            cardWords += word
        }
        return cardWords.joinToString(" ")
    }

    private fun extractNote(
        original: String,
        lower: String,
    ): String? {
        val index = lower.indexOf("note:")
        if (index < 0) return null
        return original.substring(index + 5).trim().ifBlank { null }
    }

    private fun isDateWord(word: String): Boolean =
        trimPunctuation(word) in MONTHS || trimPunctuation(word) in WEEKDAYS

    private fun trimPunctuation(value: String): String =
        value.trim { !it.isLetterOrDigit() }

    private companion object {
        const val CENTS_PER_DOLLAR = 100L
        const val HIGH_CONFIDENCE = 0.9
        const val DATE_CONFIDENCE = 0.95
        const val DEFAULT_DATE_CONFIDENCE = 0.5
        const val EMPTY_CONFIDENCE = 0.3

        val WHITESPACE = Regex("\\s+")
        val DOLLAR_SIGN = Regex("\\$(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?)")
        val DOLLARS = Regex("(\\d+(?:\\.\\d+)?)\\s*dollars")
        val BUCKS = Regex("(\\d+(?:\\.\\d+)?)\\s*bucks")
        val SPEND_VERB =
            Regex("(?:spent|paid|spend|pay)(?:\\s+(?:about|roughly|around))?\\s+(\\d+(?:\\.\\d+)?)")
        val PAYCHECK = Regex("paycheck\\s+(\\d+(?:\\.\\d+)?)")
        val LAST_WEEKDAY =
            Regex("last\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)")
        val ON_WEEKDAY =
            Regex("on\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)")
        val ISO_DATE = Regex("\\b20\\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])\\b")
        val SLASH_DATE = Regex("\\b(\\d{1,2})/(\\d{1,2})\\b")
        val MONTH_NAME_DATE =
            Regex(
                "(january|february|march|april|may|june|july|august|" +
                    "september|october|november|december)\\s+(\\d{1,2})",
            )

        val WORD_NUMBERS =
            mapOf(
                "zero" to 0L,
                "one" to 1L,
                "two" to 2L,
                "three" to 3L,
                "four" to 4L,
                "five" to 5L,
                "six" to 6L,
                "seven" to 7L,
                "eight" to 8L,
                "nine" to 9L,
                "ten" to 10L,
                "eleven" to 11L,
                "twelve" to 12L,
                "thirteen" to 13L,
                "fourteen" to 14L,
                "fifteen" to 15L,
                "sixteen" to 16L,
                "seventeen" to 17L,
                "eighteen" to 18L,
                "nineteen" to 19L,
                "twenty" to 20L,
                "thirty" to 30L,
                "forty" to 40L,
                "fifty" to 50L,
                "sixty" to 60L,
                "seventy" to 70L,
                "eighty" to 80L,
                "ninety" to 90L,
                "hundred" to 100L,
                "thousand" to 1_000L,
            )

        val MERCHANT_CATEGORIES =
            mapOf(
                "aldi" to "Groceries",
                "costco" to "Groceries",
                "kroger" to "Groceries",
                "publix" to "Groceries",
                "samsclub" to "Groceries",
                "traderjoes" to "Groceries",
                "chickfila" to "Dining & Drinks",
                "chipotle" to "Dining & Drinks",
                "dunkin" to "Dining & Drinks",
                "mcdonalds" to "Dining & Drinks",
                "starbucks" to "Dining & Drinks",
                "tacobell" to "Dining & Drinks",
                "chevron" to "Auto & Transport",
                "loves" to "Auto & Transport",
                "racetrac" to "Auto & Transport",
                "shell" to "Auto & Transport",
                "amazon" to "Shopping",
                "homedepot" to "Shopping",
                "lowes" to "Shopping",
                "target" to "Shopping",
                "walmart" to "Shopping",
                "apple" to "Bills & Utilities",
                "appleicloud" to "Bills & Utilities",
                "att" to "Bills & Utilities",
                "comcast" to "Bills & Utilities",
                "netflix" to "Bills & Utilities",
                "pennymac" to "Bills & Utilities",
                "verizon" to "Bills & Utilities",
                "xfinity" to "Bills & Utilities",
                "zapier" to "Bills & Utilities",
                "cvs" to "Medical",
                "walgreens" to "Medical",
                "chewy" to "Pets",
                "petsmart" to "Pets",
                "petco" to "Pets",
            )

        val CATEGORY_ALIASES =
            listOf(
                "bills and utilities" to "Bills & Utilities",
                "bills utilities" to "Bills & Utilities",
                "utilities" to "Bills & Utilities",
                "bills" to "Bills & Utilities",
                "dining and drinks" to "Dining & Drinks",
                "dining drinks" to "Dining & Drinks",
                "dining" to "Dining & Drinks",
                "restaurants" to "Dining & Drinks",
                "restaurant" to "Dining & Drinks",
                "groceries" to "Groceries",
                "grocery" to "Groceries",
                "auto and transport" to "Auto & Transport",
                "auto transport" to "Auto & Transport",
                "transportation" to "Auto & Transport",
                "auto" to "Auto & Transport",
                "shopping" to "Shopping",
                "health and wellness" to "Health & Wellness",
                "health wellness" to "Health & Wellness",
                "wellness" to "Health & Wellness",
                "medical" to "Medical",
                "pets" to "Pets",
                "pet" to "Pets",
                "income" to "Income",
            )

        val KEYWORD_CATEGORIES =
            listOf(
                "paycheck" to "Income",
                "direct deposit" to "Income",
                "groceries" to "Groceries",
                "grocery" to "Groceries",
                "lunch" to "Dining & Drinks",
                "dinner" to "Dining & Drinks",
                "breakfast" to "Dining & Drinks",
                "coffee" to "Dining & Drinks",
                "restaurant" to "Dining & Drinks",
                "eating out" to "Dining & Drinks",
                "takeout" to "Dining & Drinks",
                "fast food" to "Dining & Drinks",
                "gas station" to "Auto & Transport",
                "gasoline" to "Auto & Transport",
                "gas" to "Auto & Transport",
                "fuel" to "Auto & Transport",
                "oil change" to "Auto & Transport",
                "car wash" to "Auto & Transport",
                "parking" to "Auto & Transport",
                "shopping" to "Shopping",
                "clothes" to "Shopping",
                "clothing" to "Shopping",
                "home improvement" to "Shopping",
                "medical" to "Medical",
                "doctor" to "Medical",
                "dentist" to "Medical",
                "prescription" to "Medical",
                "pharmacy" to "Medical",
                "gym" to "Health & Wellness",
                "fitness" to "Health & Wellness",
                "subscription" to "Bills & Utilities",
                "icloud" to "Bills & Utilities",
                "electric" to "Bills & Utilities",
                "internet" to "Bills & Utilities",
                "phone bill" to "Bills & Utilities",
                "mortgage" to "Bills & Utilities",
                "insurance" to "Bills & Utilities",
                "pets" to "Pets",
                "pet food" to "Pets",
                "dog" to "Pets",
                "cat" to "Pets",
                "vet" to "Pets",
                "veterinary" to "Pets",
            )

        val EXPLICIT_CATEGORY_PREFIXES =
            listOf("category", "categorize as", "categorized as", "under", "as")
        val MONTHS =
            mapOf(
                "january" to Month.JANUARY,
                "february" to Month.FEBRUARY,
                "march" to Month.MARCH,
                "april" to Month.APRIL,
                "may" to Month.MAY,
                "june" to Month.JUNE,
                "july" to Month.JULY,
                "august" to Month.AUGUST,
                "september" to Month.SEPTEMBER,
                "october" to Month.OCTOBER,
                "november" to Month.NOVEMBER,
                "december" to Month.DECEMBER,
            )
        val WEEKDAYS =
            mapOf(
                "monday" to DayOfWeek.MONDAY,
                "tuesday" to DayOfWeek.TUESDAY,
                "wednesday" to DayOfWeek.WEDNESDAY,
                "thursday" to DayOfWeek.THURSDAY,
                "friday" to DayOfWeek.FRIDAY,
                "saturday" to DayOfWeek.SATURDAY,
                "sunday" to DayOfWeek.SUNDAY,
            )
        val MERCHANT_STOP_WORDS = setOf("for", "yesterday", "today", "on", "with", "last", "the")
        val TRAILING_MERCHANT_WORDS = setOf("for", "yesterday", "today", "on", "with", "last")
        val SERVICE_WORDS = setOf("subscription", "subscriptions", "service", "membership", "icloud")
        val SERVICE_SKIP_WORDS = setOf("a", "an", "the")
        val SERVICE_STOP_WORDS =
            setOf("subscription", "subscriptions", "service", "membership", "yesterday", "today", "on", "with", "last")
        val CARD_SKIP_WORDS = setOf("my")
        val CARD_STOP_WORDS = setOf("on", "at", "for", "yesterday", "today", "last")
    }
}
