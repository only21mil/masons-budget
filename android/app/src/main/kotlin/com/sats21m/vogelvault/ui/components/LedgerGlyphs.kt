package com.sats21m.vogelvault.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * The stroke icon set from `Design/icons.jsx`, ported once.
 *
 * Every glyph is a 24-unit viewport, 1.6 stroke, round caps and joins, drawn in
 * black so `Icon(tint = ...)` recolours stroke and fill together. Paths are the
 * handoff's exact strings; circles and rounded rectangles are expanded to path
 * data here because [ImageVector] has no primitive for them.
 */
object LedgerGlyphs {
    val Bars: ImageVector by lazy { ledgerGlyph("LedgerBars", strokes = listOf("M5 19V11M10 19V6M15 19v-9M20 19v-13")) }

    val Stack: ImageVector by lazy { ledgerGlyph("LedgerStack", strokes = listOf("M3 6h18M5 10h14M7 14h10M9 18h6")) }

    val Wallet: ImageVector by lazy {
        ledgerGlyph(
            "LedgerWallet",
            strokes = listOf("M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H5a2 2 0 0 1 0-4h13"),
            fills = listOf(circle(17f, 14f, 1.3f)),
        )
    }

    /** The interface variant. The app-icon variant lives in the launcher drawables. */
    val Btc: ImageVector by lazy {
        ledgerGlyph(
            "LedgerBtc",
            strokes = listOf(
                "M9.4 6h4.2c1.7 0 3 1.1 3 2.7 0 1.4-1 2.4-2.4 2.7 1.7.2 2.9 1.3 2.9 2.9 0 1.7-1.4 2.9-3.3 2.9H9.4V6z",
                "M9.4 11.4h4.2M9.4 11.4h4.6",
                "M11.0 4.5v1.5M11.0 17.2v1.8M13.2 4.5v1.5M13.2 17.2v1.8",
            ),
        )
    }

    val Dots: ImageVector by lazy {
        ledgerGlyph(
            "LedgerDots",
            fills = listOf(circle(6f, 12f, 1.2f), circle(12f, 12f, 1.2f), circle(18f, 12f, 1.2f)),
        )
    }

    val Search: ImageVector by lazy {
        ledgerGlyph("LedgerSearch", strokes = listOf(circle(11f, 11f, 6.5f), "M16 16l4.5 4.5"))
    }

    val Plus: ImageVector by lazy { ledgerGlyph("LedgerPlus", strokes = listOf("M12 5v14M5 12h14"), strokeWidth = 1.8f) }

    val Calendar: ImageVector by lazy {
        ledgerGlyph("LedgerCalendar", strokes = listOf(roundedRect(3.5f, 5f, 17f, 15f, 2f), "M3.5 9h17M8 3v4M16 3v4"))
    }

    val Flag: ImageVector by lazy { ledgerGlyph("LedgerFlag", strokes = listOf("M5 21V4M5 4h11l-2 4 2 4H5")) }

    val Bolt: ImageVector by lazy { ledgerGlyph("LedgerBolt", strokes = listOf("M13 3 5 13h6l-1 8 8-10h-6l1-8z")) }

    val Chain: ImageVector by lazy {
        ledgerGlyph(
            "LedgerChain",
            strokes = listOf(roundedRect(3f, 8f, 7f, 8f, 1.5f), roundedRect(14f, 8f, 7f, 8f, 1.5f), "M10 12h4"),
        )
    }

    val Target: ImageVector by lazy {
        ledgerGlyph(
            "LedgerTarget",
            strokes = listOf(circle(12f, 12f, 8.5f), circle(12f, 12f, 4.5f)),
            fills = listOf(circle(12f, 12f, 1.2f)),
        )
    }

    val Cog: ImageVector by lazy {
        ledgerGlyph(
            "LedgerCog",
            strokes = listOf(
                circle(12f, 12f, 3f),
                "M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5" +
                    "A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5" +
                    "c.1-.4.1-.8.1-1.2z",
            ),
        )
    }

    val CheckCircle: ImageVector by lazy { ledgerGlyph("LedgerCheckCircle", strokes = listOf(circle(12f, 12f, 10f))) }

    val People: ImageVector by lazy {
        ledgerGlyph(
            "LedgerPeople",
            strokes = listOf(
                circle(9f, 8f, 3f),
                "M3 21c0-3 3-5 6-5s6 2 6 5",
                circle(17f, 9f, 2.5f),
                "M14 21c0-2 2-4 4.5-4S22 18 22 21",
            ),
        )
    }

    val Inbox: ImageVector by lazy {
        ledgerGlyph(
            "LedgerInbox",
            strokes = listOf(
                "M3 13l3-8h12l3 8v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z",
                "M3 13h5l1 2h6l1-2h5",
            ),
        )
    }

    // Accepted category glyphs. Car and paw stay out until design review accepts them.
    val Fork: ImageVector by lazy {
        ledgerGlyph(
            "LedgerFork",
            strokes = listOf(
                "M7 3v8a2 2 0 0 0 2 2v8M7 3v6a2 2 0 0 1-2 2M9 3v6a2 2 0 0 0 2 2",
                "M17 3c-2 0-3 2-3 5s1 5 3 5v8",
            ),
        )
    }

    val Home: ImageVector by lazy {
        ledgerGlyph("LedgerHome", strokes = listOf("M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-7H10v7H4a1 1 0 0 1-1-1v-9z"))
    }

    val Heart: ImageVector by lazy {
        ledgerGlyph(
            "LedgerHeart",
            strokes = listOf("M12 21s-7.5-4.5-9-9.5C2 7 5 4 8 4c2 0 3 1 4 2.5C13 5 14 4 16 4c3 0 6 3 5 7.5-1.5 5-9 9.5-9 9.5z"),
        )
    }

    val Gift: ImageVector by lazy {
        ledgerGlyph(
            "LedgerGift",
            strokes = listOf(
                roundedRect(3f, 8f, 18f, 5f, 1f),
                "M5 13v8h14v-8M12 8v13M8 8a2 2 0 1 1 0-4c2 0 4 4 4 4H8zM16 8a2 2 0 1 0 0-4c-2 0-4 4-4 4h4z",
            ),
        )
    }

    val Box: ImageVector by lazy {
        ledgerGlyph("LedgerBox", strokes = listOf("M21 8l-9 4-9-4 9-4 9 4z", "M3 8v9l9 4 9-4V8M12 12v9"))
    }

    val Doc: ImageVector by lazy {
        ledgerGlyph(
            "LedgerDoc",
            strokes = listOf("M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z", "M14 3v6h6M8 14h8M8 18h5"),
        )
    }

    /** Accepted budget category glyphs keyed by category name; unmapped categories carry no icon. */
    fun forCategory(name: String): ImageVector? = when (name.trim().lowercase()) {
        "bills & utilities" -> Home
        "dining & drinks" -> Fork
        "shopping" -> Gift
        "groceries" -> Box
        "health & wellness" -> Heart
        "medical" -> Doc
        else -> null
    }
}

internal fun ledgerGlyph(
    name: String,
    strokes: List<String> = emptyList(),
    fills: List<String> = emptyList(),
    strokeWidth: Float = 1.6f,
): ImageVector =
    ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        strokes.forEach { pathData ->
            addPath(
                pathData = PathParser().parsePathString(pathData).toNodes(),
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = strokeWidth,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
        fills.forEach { pathData ->
            addPath(
                pathData = PathParser().parsePathString(pathData).toNodes(),
                fill = SolidColor(Color.Black),
                stroke = null,
            )
        }
    }.build()

private fun circle(cx: Float, cy: Float, r: Float): String =
    "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 ${-2 * r} 0"

private fun roundedRect(x: Float, y: Float, w: Float, h: Float, rx: Float): String =
    "M${x + rx} ${y}h${w - 2 * rx}a$rx $rx 0 0 1 $rx ${rx}v${h - 2 * rx}a$rx $rx 0 0 1 ${-rx} ${rx}" +
        "h${-(w - 2 * rx)}a$rx $rx 0 0 1 ${-rx} ${-rx}v${-(h - 2 * rx)}a$rx $rx 0 0 1 $rx ${-rx}z"
