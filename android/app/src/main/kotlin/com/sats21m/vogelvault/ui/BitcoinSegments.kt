package com.sats21m.vogelvault.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.sats21m.vogelvault.ui.theme.VaultSpace

/** In-tab segments for the Bitcoin primary destination. */
enum class BitcoinSegment(val label: String) {
    OVERVIEW("Overview"),
    NET_WORTH("Net Worth"),
    RETIREMENT("Retirement"),
}

internal const val BITCOIN_SEGMENT_SELECTOR_TEST_TAG = "bitcoin-segment-selector"

@Composable
internal fun BitcoinSegmentSelector(
    selected: BitcoinSegment,
    onSelect: (BitcoinSegment) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .horizontalScroll(rememberScrollState())
            .selectableGroup()
            .testTag(BITCOIN_SEGMENT_SELECTOR_TEST_TAG),
        horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
    ) {
        BitcoinSegment.entries.forEach { segment ->
            SelectionChip(
                label = segment.label,
                semanticLabel = segment.label,
                actionLabel = "Show ${segment.label}",
                selected = segment == selected,
                compact = true,
                onSelect = { onSelect(segment) },
            )
        }
    }
}
