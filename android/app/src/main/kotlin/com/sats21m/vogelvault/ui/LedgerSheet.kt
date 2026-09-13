package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace

/** The form scrolls independently so its actions stay available above the keyboard. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LedgerSheet(
    title: String,
    onDismissRequest: () -> Unit,
    actions: @Composable () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismissRequest,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().imePadding().padding(horizontal = VaultSpace.md)) {
            Text(title, style = LocalLedgerTheme.current.type.drilldownTitle,
                modifier = Modifier.padding(bottom = VaultSpace.md))
            Column(
                Modifier.weight(1f, fill = false).fillMaxWidth()
                    .verticalScroll(rememberScrollState()).testTag("ledger-sheet-body"),
                verticalArrangement = Arrangement.spacedBy(VaultSpace.md),
                content = content,
            )
            Column(Modifier.fillMaxWidth().padding(vertical = VaultSpace.md).testTag("ledger-sheet-actions")) {
                actions()
            }
        }
    }
}
