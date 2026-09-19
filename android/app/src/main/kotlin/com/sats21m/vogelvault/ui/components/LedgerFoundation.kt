package com.sats21m.vogelvault.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.vector.ImageVector
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
