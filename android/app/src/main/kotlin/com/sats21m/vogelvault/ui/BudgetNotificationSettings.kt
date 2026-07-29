package com.sats21m.vogelvault.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.components.Panel
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultTextMuted

@Composable
internal fun BudgetNotificationSettings(
    enabled: Boolean,
    onEnabledChange: (Boolean) -> Unit,
) {
    val context = LocalContext.current
    val permissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) onEnabledChange(true)
        }

    Panel(stringResource(R.string.budget_notifications_setting_title)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(VaultSpace.md),
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
                    color = VaultTextMuted,
                )
            }
            Switch(
                checked = enabled,
                onCheckedChange = { next ->
                    when {
                        !next -> onEnabledChange(false)
                        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ->
                            onEnabledChange(true)
                        ContextCompat.checkSelfPermission(
                            context,
                            Manifest.permission.POST_NOTIFICATIONS,
                        ) == PackageManager.PERMISSION_GRANTED ->
                            onEnabledChange(true)
                        else -> permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                },
            )
        }
    }
}
