package com.sats21m.vogelvault

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.ui.VaultApp
import com.sats21m.vogelvault.ui.VaultViewModel
import com.sats21m.vogelvault.ui.WriteSubmissionResult
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as VaultApplication
        val displayPreferences =
            getSharedPreferences(DISPLAY_PREFERENCES, MODE_PRIVATE)
        setContent {
            VogelVaultTheme {
                val model: VaultViewModel = viewModel(factory = app.viewModelFactory)
                val state by model.state.collectAsStateWithLifecycle()
                var displayUnit by remember {
                    mutableStateOf(
                        DisplayUnit.fromStorageKey(
                            displayPreferences.getString(DISPLAY_UNIT_KEY, null),
                        ),
                    )
                }
                var writeCredentialConfigured by remember {
                    mutableStateOf(app.writeCredentialConfigured)
                }
                VaultApp(
                    state = state,
                    onNavigate = model::navigate,
                    onSwitchProfile = model::switchProfile,
                    onEnableRemoteRows = model::enableRemoteRows,
                    writeCredentialConfigured = writeCredentialConfigured,
                    onSaveWriteCredential = { token ->
                        app.saveWriteCredential(token).also { saved ->
                            if (saved) writeCredentialConfigured = true
                        }
                    },
                    onRemoveWriteCredential = {
                        app.removeWriteCredential().also { removed ->
                            if (removed) writeCredentialConfigured = false
                        }
                    },
                    onWriteBudgetCategory = { request ->
                        app.writeBudgetCategory(request).toWriteSubmissionResult().also { result ->
                            if (result == WriteSubmissionResult.Saved) {
                                model.switchProfile(model.state.value.activeProfile)
                            }
                        }
                    },
                    onWriteBtcBuy = { request ->
                        app.writeBtcBuy(request).toWriteSubmissionResult().also { result ->
                            if (result == WriteSubmissionResult.Saved) {
                                model.switchProfile(model.state.value.activeProfile)
                            }
                        }
                    },
                    displayUnit = displayUnit,
                    onDisplayUnitChange = { next ->
                        displayUnit = next
                        displayPreferences.edit()
                            .putString(DISPLAY_UNIT_KEY, next.storageKey)
                            .apply()
                    },
                )
            }
        }
    }

    private companion object {
        const val DISPLAY_PREFERENCES = "display_preferences"
        const val DISPLAY_UNIT_KEY = "display_unit"
    }
}

internal fun ConvexResult<*>.toWriteSubmissionResult(): WriteSubmissionResult =
    when (this) {
        is ConvexResult.Ok -> WriteSubmissionResult.Saved
        ConvexResult.NotConfigured, ConvexResult.Disabled, ConvexResult.Missing ->
            WriteSubmissionResult.NotConfigured
        ConvexResult.Unauthorized -> WriteSubmissionResult.Unauthorized
        is ConvexResult.Failed -> WriteSubmissionResult.Failed("The write did not complete. ${reason}.")
    }
