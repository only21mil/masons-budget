package com.sats21m.vogelvault.ui.components

import android.os.SystemClock
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.theme.LedgerMotion
import com.sats21m.vogelvault.ui.theme.LedgerRadii
import com.sats21m.vogelvault.ui.theme.LedgerReveal
import com.sats21m.vogelvault.ui.theme.LedgerSkeleton
import com.sats21m.vogelvault.ui.theme.LocalLedgerEffects
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.ledgerTween
import com.sats21m.vogelvault.ui.theme.revealDelayMillis

// ── Skeleton ────────────────────────────────────────────────────────────────

/**
 * Three ghost rows standing in for a list that is still reading. The whole
 * block breathes rather than shimmering: a slow breathe is a display waiting
 * on a line, a sweep is every shopping app. Reduce motion holds it still.
 */
@Composable
fun LedgerSkeletonRows(
    modifier: Modifier = Modifier,
    rows: Int = LedgerSkeleton.ghostRows,
) {
    val tokens = LocalLedgerTheme.current
    val alpha = if (LocalLedgerEffects.current.animate) {
        rememberInfiniteTransition(label = "ledger-skeleton").animateFloat(
            initialValue = LedgerSkeleton.breatheMinAlpha,
            targetValue = LedgerSkeleton.breatheMaxAlpha,
            animationSpec = infiniteRepeatable(
                animation = tween(LedgerMotion.onboardingCursorBlinkMillis, easing = FastOutSlowInEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "breathe",
        ).value
    } else {
        LedgerSkeleton.staticAlpha
    }
    val loadingTitle = stringResource(R.string.convex_read_loading_title)
    // Ink tiers are opaque now, so the ghosts take the tertiary ink at a low
    // base alpha; the hairline colours are too faint to show a breathe.
    val primaryInk = tokens.colors.foregroundTertiary.copy(alpha = 0.35f)
    val metaInk = tokens.colors.foregroundTertiary.copy(alpha = 0.20f)
    val shape = RoundedCornerShape(LedgerRadii.control)
    Column(
        modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                contentDescription = loadingTitle
                liveRegion = LiveRegionMode.Polite
            }
            .graphicsLayer { this.alpha = alpha },
    ) {
        repeat(rows) { index ->
            if (index > 0) HorizontalHairline()
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(
                        horizontal = tokens.density.cardPadding,
                        vertical = tokens.density.rowVerticalPadding,
                    ),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Box(Modifier.fillMaxWidth(0.45f).height(12.dp).background(primaryInk, shape))
                    Box(Modifier.fillMaxWidth(0.25f).height(9.dp).background(metaInk, shape))
                }
                Box(Modifier.width(72.dp).height(12.dp).background(primaryInk, shape))
            }
        }
    }
}

// ── Row reveal ──────────────────────────────────────────────────────────────

/** True when a row composing at [nowMillis] belongs to the arrival that began at [firstSeenMillis]. */
fun revealWithinWindow(
    firstSeenMillis: Long,
    nowMillis: Long,
    windowMillis: Long = LedgerReveal.arrivalWindowMillis,
): Boolean = nowMillis - firstSeenMillis in 0..windowMillis

/**
 * Remembers when each arrival key was first composed, so rows that scroll into
 * view later print cold instead of fading in. Lazy rows have no shared parent
 * to remember this in, hence the small process-wide table.
 */
internal object LedgerRevealMarks {
    private val firstSeen = mutableMapOf<Any, Long>()

    fun staggers(key: Any, nowMillis: Long): Boolean =
        revealWithinWindow(firstSeen.getOrPut(key) { nowMillis }, nowMillis)
}

/**
 * Fades a freshly arrived row in over 160ms, staggered 20ms per [index] and
 * capped at index seven; later rows arrive with the eighth. A null [revealKey]
 * disables the reveal. Reduce motion prints every row at once.
 */
@Composable
fun Modifier.ledgerRowReveal(index: Int, revealKey: Any?): Modifier {
    if (revealKey == null) return this
    val animate = LocalLedgerEffects.current.animate
    val arrivalKey = LocalLedgerRevealProfile.current to revealKey
    val spec = ledgerTween<Float>(LedgerReveal.rowMillis, delayMillis = revealDelayMillis(index))
    val alpha = remember(arrivalKey) {
        val staggers = LedgerRevealMarks.staggers(arrivalKey, SystemClock.uptimeMillis()) && animate
        Animatable(if (staggers) 0f else 1f)
    }
    LaunchedEffect(arrivalKey, animate) {
        if (!animate) alpha.snapTo(1f)
        else if (alpha.value < 1f) alpha.animateTo(1f, spec)
    }
    return graphicsLayer { this.alpha = alpha.value }
}

internal val LocalLedgerRevealProfile = androidx.compose.runtime.staticCompositionLocalOf { "preview" }
