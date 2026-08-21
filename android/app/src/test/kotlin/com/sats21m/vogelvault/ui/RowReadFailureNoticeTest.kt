package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.data.RowReadDiagnostic
import com.sats21m.vogelvault.data.RowReadFailure
import com.sats21m.vogelvault.data.RowReadProjection
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RowReadFailureNoticeTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>

    @Before
    fun startComposeHost() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun stopComposeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `shell renders the actionable diagnosis for every row read failure`() {
        val cases =
            listOf(
                RowReadFailure.UNAUTHORIZED to
                    Pair(
                        R.string.convex_row_failure_unauthorized_title,
                        R.string.convex_row_failure_unauthorized_detail,
                    ),
                RowReadFailure.DISABLED to
                    Pair(
                        R.string.convex_row_failure_disabled_title,
                        R.string.convex_row_failure_disabled_detail,
                    ),
                RowReadFailure.NOT_CONFIGURED to
                    Pair(
                        R.string.convex_row_failure_not_configured_title,
                        R.string.convex_row_failure_not_configured_detail,
                    ),
                RowReadFailure.TRANSPORT to
                    Pair(
                        R.string.convex_row_failure_transport_title,
                        R.string.convex_row_failure_transport_detail,
                    ),
                RowReadFailure.HTTP to
                    Pair(
                        R.string.convex_row_failure_http_title,
                        R.string.convex_row_failure_http_detail,
                    ),
                RowReadFailure.DEPLOYMENT_MISCONFIGURED to
                    Pair(
                        R.string.convex_row_failure_deployment_misconfigured_title,
                        R.string.convex_row_failure_deployment_misconfigured_detail,
                    ),
                RowReadFailure.SERVER_REJECTED to
                    Pair(
                        R.string.convex_row_failure_server_rejected_title,
                        R.string.convex_row_failure_server_rejected_detail,
                    ),
                RowReadFailure.MALFORMED_PAYLOAD to
                    Pair(
                        R.string.convex_row_failure_malformed_payload_title,
                        R.string.convex_row_failure_malformed_payload_detail,
                    ),
            )
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()

        cases.forEach { (failure, resources) ->
            val state =
                VaultUiState.of(
                    profile = FamilyMember.VICTOR,
                    status = Freshness.ERROR,
                ).copy(
                    staleAuthorization = failure == RowReadFailure.UNAUTHORIZED,
                    rowReadDiagnostics =
                        setOf(RowReadDiagnostic(RowReadProjection.TRANSACTIONS, failure)),
                )

            compose.runOnUiThread {
                activityController.get().setContent {
                    VogelVaultTheme {
                        Box(Modifier.size(width = 411.dp, height = 640.dp)) {
                            VaultApp(
                                state = state,
                                onNavigate = {},
                                onSwitchProfile = {},
                            )
                        }
                    }
                }
            }
            compose.waitForIdle()

            assertTrue(
                compose.onAllNodesWithText(context.getString(resources.first))
                    .fetchSemanticsNodes().isNotEmpty(),
                "The ${failure.name} title was not rendered.",
            )
            assertTrue(
                compose.onAllNodesWithText(
                    context.getString(
                        resources.second,
                        context.getString(R.string.convex_projection_transactions),
                    ),
                )
                    .fetchSemanticsNodes().isNotEmpty(),
                "The ${failure.name} detail was not rendered.",
            )
            assertTrue(
                compose.onAllNodesWithText(context.getString(R.string.refresh_failed_title))
                    .fetchSemanticsNodes().isEmpty(),
                "The generic refresh notice rendered over the ${failure.name} diagnosis.",
            )
        }
    }

    @Test
    fun `only transport uses could not reach Convex copy`() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val state = VaultUiState.of(
            profile = FamilyMember.VICTOR,
            status = Freshness.ERROR,
        ).copy(
            rowReadDiagnostics =
                setOf(
                    RowReadDiagnostic(
                        RowReadProjection.TRANSACTIONS,
                        RowReadFailure.HTTP,
                    ),
                ),
        )

        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 640.dp)) {
                        VaultApp(state = state, onNavigate = {}, onSwitchProfile = {})
                    }
                }
            }
        }
        compose.waitForIdle()

        assertTrue(
            compose.onAllNodesWithText(context.getString(R.string.convex_row_failure_http_title))
                .fetchSemanticsNodes().isNotEmpty(),
        )
        assertTrue(
            compose.onAllNodesWithText(
                context.getString(R.string.convex_row_failure_transport_title),
            ).fetchSemanticsNodes().isEmpty(),
            "An HTTP response was incorrectly presented as a connection failure.",
        )
    }

    @Test
    fun `generic error copy does not point to a missing diagnostic notice`() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()

        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 640.dp)) {
                        StateBlock(Freshness.ERROR)
                    }
                }
            }
        }
        compose.waitForIdle()

        assertTrue(
            compose.onAllNodesWithText(context.getString(R.string.convex_read_error_detail))
                .fetchSemanticsNodes().isNotEmpty(),
            "The self-contained row-read fallback was not rendered.",
        )
        assertTrue(
            compose.onAllNodesWithText(
                "The row read failed. Check the specific diagnostic notice before changing " +
                    "credentials or retrying.",
            ).fetchSemanticsNodes().isEmpty(),
            "The fallback still points to a diagnosis that may not exist.",
        )
    }
}
