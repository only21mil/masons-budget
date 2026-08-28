package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.components.Badge
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme

/**
 * A profile switch held at the authentication boundary.
 *
 * WC1 owns the biometric prompt. Its integration receives this request and calls
 * [authorize] only after successful re-authentication. Until then, the active
 * profile and its financial data do not change.
 */
class ProfileSwitchRequest internal constructor(
    val current: FamilyMember,
    val target: FamilyMember,
    val requiresAuthentication: Boolean,
    private val onAuthorized: () -> Unit,
) {
    fun authorize() = onAuthorized()
}

internal fun profileSwitchRequest(
    current: FamilyMember,
    target: FamilyMember,
    onAuthorized: () -> Unit,
): ProfileSwitchRequest? {
    if (target == current || target !in current.allowedSwitchTargets) return null
    return ProfileSwitchRequest(
        current = current,
        target = target,
        requiresAuthentication = current.requiresAuthToSwitch,
        onAuthorized = onAuthorized,
    )
}

@Composable
fun ProfileSwitcher(
    activeProfile: FamilyMember,
    onAuthenticationRequired: (ProfileSwitchRequest) -> Unit,
    onAuthorizedSwitch: (FamilyMember) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalLedgerTheme.current.colors
    if (!activeProfile.isAdult) {
        Row(modifier, verticalAlignment = Alignment.CenterVertically) {
            Text(activeProfile.displayName, color = colors.foreground)
            Spacer(Modifier.width(8.dp))
            Badge(stringResource(R.string.profile_switcher_child_profile))
        }
        return
    }

    var expanded by remember(activeProfile) { mutableStateOf(false) }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = { expanded = true }) {
            Text(activeProfile.displayName, color = colors.foreground)
            Icon(
                Icons.Filled.ExpandMore,
                contentDescription = stringResource(R.string.profile_switcher_open),
                tint = colors.bitcoin,
            )
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            activeProfile.allowedSwitchTargets.forEach { target ->
                DropdownMenuItem(
                    text = {
                        Text(
                            target.displayName,
                            color = if (target == activeProfile) colors.foregroundTertiary else colors.foreground,
                        )
                    },
                    enabled = target != activeProfile,
                    onClick = {
                        expanded = false
                        profileSwitchRequest(
                            current = activeProfile,
                            target = target,
                            onAuthorized = { onAuthorizedSwitch(target) },
                        )?.let(onAuthenticationRequired)
                    },
                )
            }
        }
    }
}
