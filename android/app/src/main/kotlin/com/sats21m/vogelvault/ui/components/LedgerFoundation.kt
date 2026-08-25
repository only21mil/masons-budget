package com.sats21m.vogelvault.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.matchParentSize
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.ui.theme.LedgerRuleStyle
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme

/** Call sites must distinguish informative, actionable, and decorative glyphs. */
enum class LedgerGlyphRole(val composeRole: Role?) {
    DECORATIVE(null),
    IMAGE(Role.Image),
    BUTTON(Role.Button),
    CHECKBOX(Role.Checkbox),
}

/** Adds exactly one accessibility node, or no node for decorative artwork. */
@Composable
fun LedgerGlyph(
    imageVector: ImageVector,
    role: LedgerGlyphRole,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = LocalLedgerTheme.current.colors.bitcoin,
) {
    require(role == LedgerGlyphRole.DECORATIVE || !contentDescription.isNullOrBlank()) {
        "Informative ledger glyphs require a content description."
    }
    val semanticsModifier = if (role == LedgerGlyphRole.DECORATIVE) {
        Modifier.clearAndSetSemantics { }
    } else {
        Modifier.clearAndSetSemantics {
            this.contentDescription = contentDescription.orEmpty()
            role.composeRole?.let { this.role = it }
        }
    }
    Icon(
        imageVector = imageVector,
        contentDescription = null,
        modifier = modifier.then(semanticsModifier),
        tint = tint,
    )
}

/** Theme-aware solid Terminal Ledger or dashed Daylight Ledger hairline. */
@Composable
fun LedgerRule(
    modifier: Modifier = Modifier,
    subtle: Boolean = false,
) {
    val tokens = LocalLedgerTheme.current
    val color = if (subtle) tokens.colors.lineSubtle else tokens.colors.line
    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(1.dp)
            .clearAndSetSemantics { },
    ) {
        val dash = if (tokens.density.ruleStyle == LedgerRuleStyle.DASHED) {
            PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx()))
        } else {
            null
        }
        drawLine(
            color = color,
            start = Offset(0f, center.y),
            end = Offset(size.width, center.y),
            strokeWidth = 1.dp.toPx(),
            pathEffect = dash,
        )
    }
}

/** Draw-only layer for full-bleed texture. It cannot add input handlers or semantics. */
@Composable
fun LedgerDecorativeLayer(
    modifier: Modifier = Modifier,
    draw: DrawScope.() -> Unit,
) {
    Box(modifier.clearAndSetSemantics { }) {
        Canvas(Modifier.matchParentSize(), onDraw = draw)
    }
}

/** Exact 24-unit proposal paths from the inert handoff prototype. */
object LedgerCategoryGlyphs {
    val Car: ImageVector by lazy {
        strokedGlyph(
            name = "LedgerCar",
            paths = listOf(
                "M3 13.5 5 8h14l2 5.5v3.5h-2.6M3 13.5V17h2.6m0 0h11.8M5 13.5h14",
                "M5.6 17a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0M15 17a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0",
            ),
        )
    }

    val Paw: ImageVector by lazy {
        strokedGlyph(
            name = "LedgerPaw",
            paths = listOf(
                "M5.4 9.6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M10.4 7.6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M15.4 9.6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0",
                "M8.2 15.4c0-2.1 1.7-3.4 3.8-3.4s3.8 1.3 3.8 3.4c0 2.3-1.7 3.5-3.8 3.5s-3.8-1.2-3.8-3.5z",
            ),
        )
    }
}

private fun strokedGlyph(name: String, paths: List<String>): ImageVector =
    ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        paths.forEach { pathData ->
            addPath(
                pathData = PathParser().parsePathString(pathData).toNodes(),
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.6f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
    }.build()
