package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace

/** Shared dimensions and empty-detail prompt for the unfolded panes. */
const val LEDGER_SIDEBAR_WIDTH_DP = 296
internal const val LEDGER_SIDEBAR_TEST_TAG = "vault-ledger-sidebar"
internal val DETAIL_DESTINATIONS: Set<Destination> = setOf(Destination.ACTIVITY, Destination.BUDGET, Destination.TASKS)

@Composable
internal fun LedgerDetailPrompt(destination: Destination) {
    val noun = when (destination) {
        Destination.ACTIVITY -> "transaction"
        Destination.BUDGET -> "category"
        Destination.TASKS -> "task list"
        else -> "item"
    }
    Text("Select a $noun to see its details.", color = LocalLedgerTheme.current.colors.foregroundSecondary,
        modifier = Modifier.padding(VaultSpace.md).testTag(LEDGER_SIDEBAR_TEST_TAG))
}
