package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.BudgetPlanCarryGateway
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.DeviceCapabilities
import com.sats21m.vogelvault.data.DeviceCapability
import com.sats21m.vogelvault.data.HttpPoster
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertEquals
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

/**
 * The "copy the plan forward" action on the Budget screen.
 *
 * The fixture plan is July 2026. The test application pins the trusted current
 * month, so the action's visibility is a decision about data, not the wall
 * clock. Transport is a recording poster: the assertions read the exact wire
 * body the device would send.
 */
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [34],
    application = BudgetPlanCarryTestApplication::class,
)
class BudgetPlanCarryComposeTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>
    private val application: BudgetPlanCarryTestApplication
        get() = RuntimeEnvironment.getApplication() as BudgetPlanCarryTestApplication
    private var writesSucceeded = 0

    @Before
    fun startHost() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun stopHost() {
        activityController.pause().stop().destroy()
    }

    private fun show(state: VaultUiState) {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 900.dp)) {
                        ScreenHost(
                            destination = Destination.BUDGET,
                            state = state,
                            displayUnit = DisplayUnit.USD,
                            onWriteSucceeded = { writesSucceeded += 1 },
                        )
                    }
                }
            }
        }
        settle()
    }

    @Test
    fun `a plan behind the current month offers the copy, a current plan does not`() {
        application.currentMonth = "2026-08"
        show(liveState())
        compose.onNodeWithText("Copy July plan to August").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("August has no budget plan yet").performScrollTo().assertIsDisplayed()

        application.currentMonth = "2026-07"
        show(liveState())
        assertEquals(0, nodesWithText("Copy July plan to August"))
    }

    @Test
    fun `a plan without a server revision cannot be copied`() {
        application.currentMonth = "2026-08"
        show(liveState(revision = 0L))
        assertEquals(0, nodesWithText("Copy July plan to August"))
    }

    @Test
    fun `the copy needs a confirm tap then sends exactly one device mutation`() {
        application.currentMonth = "2026-08"
        show(liveState())

        compose.onNodeWithText("Copy July plan to August").performScrollTo().performClick()
        settle()
        compose.onNodeWithText("Confirm copy to August").assertIsDisplayed()
        compose.onNodeWithText("Keep July").assertIsDisplayed()
        assertEquals(0, application.poster.bodies.size)

        compose.onNodeWithText("Confirm copy to August").performClick()
        settle()
        compose.waitUntil(timeoutMillis = 5_000L) { application.poster.bodies.isNotEmpty() }
        settle()

        val wire = Json.parseToJsonElement(application.poster.bodies.single()).jsonObject
        assertEquals("tables:copyBudgetPlanForwardFromDevice", wire.getValue("path").jsonPrimitive.content)
        val args = wire.getValue("args").jsonObject
        assertEquals("victor", args.getValue("owner").jsonPrimitive.content)
        assertEquals("budget", args.getValue("sourceFile").jsonPrimitive.content)
        assertEquals("2026-07", args.getValue("fromMonth").jsonPrimitive.content)
        assertEquals("2026-08", args.getValue("toMonth").jsonPrimitive.content)
        assertEquals(REVISION.toString(), args.getValue("baseUpdatedAtMs").jsonPrimitive.content)
        assertEquals(1, writesSucceeded)
    }

    @Test
    fun `keeping the current plan disarms the confirm without a write`() {
        application.currentMonth = "2026-08"
        show(liveState())

        compose.onNodeWithText("Copy July plan to August").performScrollTo().performClick()
        settle()
        compose.onNodeWithText("Keep July").performClick()
        settle()

        compose.onNodeWithText("Copy July plan to August").performScrollTo().assertIsDisplayed()
        assertEquals(0, nodesWithText("Confirm copy to August"))
        assertEquals(0, application.poster.bodies.size)
    }

    @Test
    fun `a server rejection shows the failure banner and reloads nothing`() {
        application.currentMonth = "2026-08"
        application.poster.response = HttpTextResponse(
            200,
            """{"status":"error","errorMessage":"x","errorData":{"code":"PLAN_EXISTS"}}""",
        )
        show(liveState())

        compose.onNodeWithText("Copy July plan to August").performScrollTo().performClick()
        settle()
        compose.onNodeWithText("Confirm copy to August").performClick()
        settle()
        compose.waitUntil(timeoutMillis = 5_000L) { application.poster.bodies.isNotEmpty() }
        settle()

        assertEquals(
            1,
            nodesWithText("Plan not copied: the write failed (PLAN_EXISTS: that month already has a budget plan)."),
            "a rejected copy did not name its cause",
        )
        assertEquals(1, application.poster.bodies.size)
        assertEquals(0, writesSucceeded)
    }

    private fun liveState(revision: Long = REVISION): VaultUiState {
        val base = VaultUiState.of(FamilyMember.VICTOR, Destination.BUDGET, Freshness.LIVE)
        val budget = requireNotNull(base.data.budget.value).copy(updatedAtMs = revision)
        return base.copy(data = base.data.copy(budget = base.data.budget.copy(value = budget)))
    }

    private fun nodesWithText(text: String): Int =
        compose.onAllNodesWithText(text).fetchSemanticsNodes().size

    private fun settle() {
        repeat(3) {
            compose.waitForIdle()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    private companion object {
        const val REVISION = 1_787_654_321_000L
    }
}

/** Recording transport whose reply can be swapped per test. */
class SwappableRecordingPoster : HttpPoster {
    val bodies = mutableListOf<String>()
    var response: HttpTextResponse = HttpTextResponse(
        200,
        """{"status":"success","value":{"ok":true,"outcome":"copied","sourceFile":"budget","fromMonth":"2026-07","toMonth":"2026-08","categoryCount":8,"updatedAtMs":1787654321001}}""",
    )

    override suspend fun postJson(url: String, body: String): HttpTextResponse {
        bodies += body
        return response
    }
}

class BudgetPlanCarryTestApplication : VaultApplication() {
    override val deviceCapabilities = DeviceCapabilities(
        FamilyMember.VICTOR, setOf(DeviceCapability.BUDGET.wire),
    )
    val poster = SwappableRecordingPoster()
    var currentMonth: String = "2026-08"

    override val budgetPlanCarryGateway: BudgetPlanCarryGateway by lazy {
        BudgetPlanCarryGateway(
            client = ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig("https://budget-carry-compose-test.convex.cloud"),
                ),
                credentialSource = ConvexDeviceCredentialSource {
                    ConvexDeviceCredential(
                        "compose-device", "t".repeat(43), FamilyMember.VICTOR,
                        setOf(DeviceCapability.BUDGET.wire),
                    )
                },
                http = poster,
            ),
            trustedCurrentMonth = { currentMonth },
        )
    }
}
