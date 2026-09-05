package com.sats21m.vogelvault.ui.theme

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.KeyframesSpec
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import kotlin.math.roundToLong

// ── Motion gate ─────────────────────────────────────────────────────────────

/**
 * Pure form of [ledgerTween] so a plain unit test can check both flag states.
 * `snap()` ignores [delayMillis] on purpose: under reduce motion every value
 * lands at once, staggered reveals included.
 */
fun <T> ledgerMotionSpec(
    animate: Boolean,
    durationMillis: Int,
    easing: Easing = FastOutSlowInEasing,
    delayMillis: Int = 0,
): FiniteAnimationSpec<T> =
    if (animate) tween(durationMillis, delayMillis, easing) else snap()

/** The one reduce-motion gate every animated call site goes through. */
@Composable
fun <T> ledgerTween(
    durationMillis: Int,
    easing: Easing = FastOutSlowInEasing,
    delayMillis: Int = 0,
): FiniteAnimationSpec<T> =
    ledgerMotionSpec(LocalLedgerEffects.current.animate, durationMillis, easing, delayMillis)

// ── Haptics ─────────────────────────────────────────────────────────────────

/**
 * Commit haptics. These are not motion, so reduce motion does not gate them;
 * the system haptic setting does. Fire after a write is accepted or refused,
 * never on button down.
 */
@Stable
class LedgerHaptics(private val feedback: HapticFeedback) {
    fun confirm() = feedback.performHapticFeedback(HapticFeedbackType.Confirm)
    fun reject() = feedback.performHapticFeedback(HapticFeedbackType.Reject)
    fun toggleOn() = feedback.performHapticFeedback(HapticFeedbackType.ToggleOn)
    fun toggleOff() = feedback.performHapticFeedback(HapticFeedbackType.ToggleOff)
    fun toggle(on: Boolean) = if (on) toggleOn() else toggleOff()
}

@Composable
fun rememberLedgerHaptics(): LedgerHaptics {
    val feedback = LocalHapticFeedback.current
    return remember(feedback) { LedgerHaptics(feedback) }
}

// ── Hero numeral settle ─────────────────────────────────────────────────────

/** Whole cents shown at [fraction] of a settle from [from] to [to]; clamps outside 0..1. */
fun settleCents(from: Long, to: Long, fraction: Float): Long {
    val f = fraction.coerceIn(0f, 1f).toDouble()
    return from + ((to - from) * f).roundToLong()
}

private class CentsSettle(initial: Long?) {
    var from by mutableStateOf(initial)
    var to by mutableStateOf(initial)
    val fraction = Animatable(1f)

    val displayed: Long?
        get() {
            val target = to ?: return null
            val start = from ?: return target
            return settleCents(start, target, fraction.value)
        }
}

/**
 * The value a hero figure should print this frame. The first reading prints
 * cold; each later change settles over [LedgerMotion.progressAndThemeMillis]
 * from whatever was on screen, so a change mid-settle does not jump. A null
 * (unavailable) reading on either side snaps, since there is nothing to count
 * from or to.
 */
@Composable
fun rememberSettledCents(target: Long?): Long? {
    val spec = ledgerTween<Float>(LedgerMotion.progressAndThemeMillis)
    val settle = remember { CentsSettle(target) }
    LaunchedEffect(target) {
        if (target == settle.to) return@LaunchedEffect
        val current = settle.displayed
        settle.from = current
        settle.to = target
        if (target == null || current == null) {
            settle.fraction.snapTo(1f)
            return@LaunchedEffect
        }
        settle.fraction.snapTo(0f)
        settle.fraction.animateTo(1f, spec)
    }
    return settle.displayed
}

// ── Price pulse ─────────────────────────────────────────────────────────────

object LedgerPhosphorGlow {
    /** Exactly what [withLedgerPhosphorGlow] draws at rest. */
    const val restingBlurPx = 18f
    const val pulseBlurPx = 32f
    const val pulseRiseMillis = 200
}

/** Rise 18 to 32 over 200ms, fall back over the remaining 400ms. One breath, no loop. */
fun phosphorPulseSpec(): KeyframesSpec<Float> = keyframes {
    durationMillis = LedgerMotion.pulseMillis
    LedgerPhosphorGlow.restingBlurPx at 0 using FastOutSlowInEasing
    LedgerPhosphorGlow.pulseBlurPx at LedgerPhosphorGlow.pulseRiseMillis using LinearOutSlowInEasing
    LedgerPhosphorGlow.restingBlurPx at LedgerMotion.pulseMillis
}

private class PulseTrigger(var last: Any?)

/**
 * Glow blur for the price hero. Pulses once each time [trigger] changes after
 * first composition, and only while [enabled] (glow on, dark treatment) and
 * motion is allowed. Otherwise it holds the resting blur.
 */
@Composable
fun rememberPhosphorPulseBlur(trigger: Any?, enabled: Boolean): Float {
    val animate = LocalLedgerEffects.current.animate
    val blur = remember { Animatable(LedgerPhosphorGlow.restingBlurPx) }
    val seen = remember { PulseTrigger(trigger) }
    LaunchedEffect(trigger) {
        if (trigger == seen.last) return@LaunchedEffect
        seen.last = trigger
        if (trigger == null || !enabled || !animate) {
            blur.snapTo(LedgerPhosphorGlow.restingBlurPx)
            return@LaunchedEffect
        }
        blur.snapTo(LedgerPhosphorGlow.restingBlurPx)
        blur.animateTo(LedgerPhosphorGlow.restingBlurPx, phosphorPulseSpec())
    }
    return if (enabled) blur.value else LedgerPhosphorGlow.restingBlurPx
}

// ── Skeleton and row reveal ─────────────────────────────────────────────────

object LedgerSkeleton {
    const val breatheMinAlpha = 0.45f
    const val breatheMaxAlpha = 0.8f
    const val staticAlpha = 0.6f
    const val ghostRows = 3
}

object LedgerReveal {
    const val rowMillis = LedgerMotion.chipAndNavigationMillis
    const val staggerMillis = 20
    const val lastStaggeredIndex = 7
    /** Rows composing later than this after an arrival are scroll-ins and print cold. */
    const val arrivalWindowMillis = 400L
}

/** Stagger for row [index]; rows past the cap arrive with the last staggered one. */
fun revealDelayMillis(index: Int): Int =
    index.coerceIn(0, LedgerReveal.lastStaggeredIndex) * LedgerReveal.staggerMillis
