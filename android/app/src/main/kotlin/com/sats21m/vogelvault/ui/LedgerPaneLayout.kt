package com.sats21m.vogelvault.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.testTag
import androidx.compose.runtime.produceState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker

/** Window-relative hinge bounds, converted to dp exactly once at the shell. */
data class LedgerHinge(val start: Dp, val end: Dp, val horizontal: Boolean)

internal data class LedgerPanePlan(
    val listWidth: Dp,
    val detailWidth: Dp = 0.dp,
    val gap: Dp = 0.dp,
    val horizontalHinge: Boolean = false,
    val listHeight: Dp? = null,
    val detailHeight: Dp? = null,
    val railWidth: Dp = 0.dp,
    val leadingInset: Dp = 0.dp,
    val topInset: Dp = 0.dp,
) {
    val split: Boolean get() = detailWidth > 0.dp
}

internal val LocalLedgerPanePlan = staticCompositionLocalOf { LedgerPanePlan(0.dp) }

/** The audited inner display retains 72dp of rail plus a cover-width list. */
internal fun ledgerPanePlan(width: Dp, height: Dp, expanded: Boolean, hasDetail: Boolean, hinge: LedgerHinge?): LedgerPanePlan {
    val minimumList = 345.dp
    val minimumDetail = 320.dp
    if (hinge != null && hinge.horizontal) {
        val upper = hinge.start.coerceIn(0.dp, height)
        val lower = (height - hinge.end).coerceAtLeast(0.dp)
        val rail = if (expanded && width >= minimumList + 72.dp) 72.dp else 0.dp
        return if (hasDetail && upper >= 320.dp && lower >= 320.dp) {
            LedgerPanePlan(width - rail, width - rail, hinge.end - hinge.start, true, upper, lower, rail)
        } else {
            // A narrow tabletop region cannot host two readable panes. Keep all
            // content in the larger region and use ordinary detail navigation.
            if (upper >= lower) LedgerPanePlan(width - rail, listHeight = upper, railWidth = rail)
            else LedgerPanePlan(width - rail, listHeight = height, railWidth = rail, topInset = hinge.end)
        }
    }
    if (hinge != null) {
        val left = hinge.start.coerceIn(0.dp, width)
        val right = (width - hinge.end).coerceAtLeast(0.dp)
        val rail = if (expanded && left >= minimumList + 72.dp) 72.dp else 0.dp
        return if (hasDetail && left - rail >= minimumList && right >= minimumDetail) {
            LedgerPanePlan(left - rail, right, hinge.end - hinge.start, railWidth = rail)
        } else {
            if (left >= right) LedgerPanePlan(left - rail, railWidth = rail)
            else LedgerPanePlan(right, leadingInset = hinge.end)
        }
    }
    val rail = if (expanded && (!hasDetail || width >= minimumList + minimumDetail + 72.dp)) 72.dp else 0.dp
    val content = width - rail
    return if (hasDetail && expanded && content >= minimumList + minimumDetail) {
        LedgerPanePlan(content / 2, content / 2, railWidth = rail)
    } else LedgerPanePlan(content, railWidth = rail)
}

/**
 * Both children remain in the same composition slots when panes move or stack.
 * In compact detail navigation the hidden list is not placed, so its scroll,
 * search and draft state survive without exposing duplicate accessible content.
 */
@Composable
internal fun LedgerPanes(
    plan: LedgerPanePlan,
    showCompactDetail: Boolean,
    modifier: Modifier = Modifier,
    list: @Composable () -> Unit,
    detail: @Composable () -> Unit,
) {
    val density = LocalDensity.current
    var originY by remember { mutableStateOf(0.dp) }
    Layout(
        modifier = modifier.onGloballyPositioned { coordinates ->
            originY = with(density) { coordinates.positionInWindow().y.toDp() }
        },
        content = {
            Box(Modifier.fillMaxSize()
                .then(if (!plan.split && showCompactDetail) Modifier.clearAndSetSemantics { } else Modifier)
                .testTag("vault-list-pane")) { list() }
            Box(Modifier.fillMaxSize()
                .then(if (!plan.split && !showCompactDetail) Modifier.clearAndSetSemantics { } else Modifier)
                .testTag("vault-detail-pane")) { detail() }
        },
    ) { children, constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val listWidth = if (plan.listWidth > 0.dp) plan.listWidth.roundToPx().coerceIn(0, width) else width
        val listHeight = (plan.listHeight?.let { (it - originY).roundToPx() } ?: height).coerceIn(0, height)
        val detailWidth = if (plan.split) plan.detailWidth.roundToPx().coerceIn(0, width) else listWidth
        val detailHeight = when {
            !plan.split -> listHeight
            plan.horizontalHinge -> (height - listHeight - plan.gap.roundToPx()).coerceAtLeast(0)
            else -> height
        }
        val first = children[0].measure(Constraints.fixed(listWidth, listHeight))
        val second = children[1].measure(Constraints.fixed(detailWidth, detailHeight))
        layout(width, height) {
            if (plan.split || !showCompactDetail) first.placeRelative(0, 0)
            if (plan.split) {
                second.placeRelative(
                    if (plan.horizontalHinge) 0 else listWidth + plan.gap.roundToPx(),
                    if (plan.horizontalHinge) listHeight + plan.gap.roundToPx() else 0,
                )
            } else if (showCompactDetail) second.placeRelative(0, 0)
        }
    }
}

@Composable
internal fun rememberLedgerHinge(): LedgerHinge? {
    val context = LocalContext.current
    val density = LocalDensity.current
    val hinge by produceState<LedgerHinge?>(null, context, density) {
        val activity = context.activity() ?: return@produceState
        WindowInfoTracker.getOrCreate(context).windowLayoutInfo(activity).collect { info ->
            val feature = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull { it.isSeparating }
            value = feature?.let {
                with(density) {
                    if (it.orientation == FoldingFeature.Orientation.HORIZONTAL) {
                        LedgerHinge(it.bounds.top.toDp(), it.bounds.bottom.toDp(), true)
                    } else LedgerHinge(it.bounds.left.toDp(), it.bounds.right.toDp(), false)
                }
            }
        }
    }
    return hinge
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/** Bounds for an editor surface in the window that owns a separating hinge. */
internal data class LedgerSheetRegion(val left: Dp, val top: Dp, val right: Dp, val bottom: Dp) {
    val width: Dp get() = right - left
    val height: Dp get() = bottom - top
}
internal val LocalLedgerSheetRegion = staticCompositionLocalOf<LedgerSheetRegion?> { null }

internal fun ledgerSheetRegion(width: Dp, height: Dp, hinge: LedgerHinge?): LedgerSheetRegion? {
    if (hinge == null) return null
    return if (hinge.horizontal) {
        if (hinge.start >= height - hinge.end) LedgerSheetRegion(0.dp, 0.dp, width, hinge.start)
        else LedgerSheetRegion(0.dp, hinge.end, width, height)
    } else {
        if (hinge.start >= 345.dp || hinge.start >= width - hinge.end) LedgerSheetRegion(0.dp, 0.dp, hinge.start, height)
        else LedgerSheetRegion(hinge.end, 0.dp, width, height)
    }
}

/**
 * Android's dialog owns a window separate from the activity. Give that window
 * the usable region, so Material computes its sheet anchors and clipping there.
 * Changing bounds keeps the same window and composition, including editor input.
 */
@Composable
internal fun ConstrainLedgerDialogWindow() {
    val region = LocalLedgerSheetRegion.current
    val view = androidx.compose.ui.platform.LocalView.current
    val density = LocalDensity.current
    val window = (view.parent as? androidx.compose.ui.window.DialogWindowProvider)?.window
    val controller = remember(window) { LedgerDialogWindowController(window) }
    val bounds = region?.let {
        with(density) { android.graphics.Rect(it.left.roundToPx(), it.top.roundToPx(), it.right.roundToPx(), it.bottom.roundToPx()) }
    }
    androidx.compose.runtime.SideEffect {
        // Material applies its full-window parameters in the parent's side
        // effect. Post our region after that update on every recomposition.
        view.post { controller.apply(bounds) }
    }
    androidx.compose.runtime.DisposableEffect(controller) {
        onDispose { controller.close() }
    }
}

private class LedgerDialogWindowController(private val window: android.view.Window?) {
    private var original: android.view.WindowManager.LayoutParams? = null
    private var closed = false

    fun apply(bounds: android.graphics.Rect?) {
        val window = window ?: return
        if (closed) return
        if (bounds == null) {
            restoreGeometry()
            original = null
            return
        }
        if (original == null) original = android.view.WindowManager.LayoutParams().apply { copyFrom(window.attributes) }
        val gravity = android.view.Gravity.TOP or android.view.Gravity.LEFT
        val current = window.attributes
        if (current.width == bounds.width() && current.height == bounds.height() &&
            current.x == bounds.left && current.y == bounds.top && current.gravity == gravity) return
        window.attributes = android.view.WindowManager.LayoutParams().apply {
            copyFrom(current)
            this.gravity = gravity
            x = bounds.left
            y = bounds.top
            width = bounds.width()
            height = bounds.height()
        }
    }

    private fun restoreGeometry() {
        val window = window ?: return
        val saved = original ?: return
        window.attributes = android.view.WindowManager.LayoutParams().apply {
            copyFrom(window.attributes)
            width = saved.width
            height = saved.height
            x = saved.x
            y = saved.y
            gravity = saved.gravity
        }
    }

    fun close() {
        closed = true
        restoreGeometry()
    }
}
