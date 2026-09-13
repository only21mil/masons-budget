package com.sats21m.vogelvault.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.notifications.BudgetNotificationController
import com.sats21m.vogelvault.ui.components.LedgerToggle
import com.sats21m.vogelvault.ui.components.Panel
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace

@Composable
internal fun BudgetNotificationSettings(state: VaultUiState) {
    val colors = LocalLedgerTheme.current.colors
    val context = LocalContext.current
    val appContext = context.applicationContext
    val notifications = remember(appContext) { BudgetNotificationController(appContext) }
    val profile = state.activeProfile
    var enabled by rememberSaveable(profile) {
        mutableStateOf(notifications.isEnabled(profile))
    }
    var rejectionMessage by rememberSaveable(profile) { mutableStateOf<String?>(null) }
    val permissionDeniedMessage =
        stringResource(R.string.budget_notifications_permission_denied)
    val setEnabled: (Boolean) -> Unit = { next ->
        notifications.setEnabled(profile, next)
        enabled = next
        rejectionMessage = null
        if (next) notifications.evaluateAndNotify(state)
    }
    val permissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                setEnabled(true)
            } else {
                rejectionMessage = permissionDeniedMessage
            }
        }

    val onToggle: (Boolean) -> Unit = { next ->
        when {
            !next -> setEnabled(false)
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU -> setEnabled(true)
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED -> setEnabled(true)
            else -> permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Panel(stringResource(R.string.budget_notifications_setting_title)) {
        Row(
            modifier = Modifier.fillMaxWidth()
                .heightIn(min = 48.dp)
                .toggleable(value = enabled, role = androidx.compose.ui.semantics.Role.Switch, onValueChange = onToggle)
                .semantics { contentDescription = context.getString(R.string.budget_notifications_setting_title) }
                .padding(vertical = VaultSpace.md),
            horizontalArrangement = Arrangement.spacedBy(VaultSpace.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.budget_notifications_setting_detail))
                Text(
                    stringResource(
                        if (enabled) {
                            R.string.budget_notifications_enabled
                        } else {
                            R.string.budget_notifications_disabled
                        },
                    ),
                    color = colors.foregroundSecondary,
                )
                rejectionMessage?.let { message ->
                    Text(message, color = colors.loss)
                }
            }
            LedgerToggle(
                checked = enabled,
                contentDescription = stringResource(R.string.budget_notifications_setting_title),
                onCheckedChange = null,
            )
        }
    }
}
