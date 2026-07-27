package com.sats21m.vogelvault.data

import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

/**
 * A poster that refuses to talk to anything and remembers being asked.
 *
 * The point of most of these tests is that it is never asked at all.
 */
class RecordingPoster(private val response: HttpTextResponse = HttpTextResponse(200, "")) : HttpPoster {
    val urls = mutableListOf<String>()
    val bodies = mutableListOf<String>()

    override suspend fun postJson(url: String, body: String): HttpTextResponse {
        urls += url
        bodies += body
        return response
    }
}

/**
 * A test token, invented per run.
 *
 * Generated rather than written down so no string in this repo can ever be
 * mistaken for — or quietly replaced by — a real one.
 */
internal fun testToken(): String = "vv-test-" + UUID.randomUUID()

/**
 * Plain JVM tests — no Robolectric, so they are fast and always run.
 *
 * These guard the only promise this package makes today: it is off, and while it
 * is off nothing leaves the device. Everything asserted here runs before a single
 * byte of JSON is touched, which is why it needs no Android runtime.
 */
class ConvexReadGateTest {

    @Test
    fun `remote reads are off by default`() {
        val config = ConvexConfig()

        assertEquals(ReadReadiness.DISABLED, config.readiness)
        assertFalse(config.allowsRemoteRead)
        assertFalse(config.remoteReadEnabled)
        assertFalse(config.hasReadToken)
    }

    @Test
    fun `a fully configured but disabled build still makes no request`() {
        val poster = RecordingPoster()
        val client = ConvexQueryClient(
            configSource = sourceOf(
                ConvexConfig(
                    deploymentUrl = DEPLOYMENT,
                    readToken = testToken(),
                    // The whole point: configuration present, consent absent.
                    remoteReadEnabled = false,
                ),
            ),
            http = poster,
        )

        val result = runBlocking { client.list() }

        assertEquals(ConvexResult.Disabled, result)
        assertTrue(poster.urls.isEmpty(), "a disabled client must not open a connection")
    }

    @Test
    fun `enabled with no deployment url is not configured and makes no request`() {
        val poster = RecordingPoster()
        val client = ConvexQueryClient(
            configSource = sourceOf(ConvexConfig(readToken = testToken(), remoteReadEnabled = true)),
            http = poster,
        )

        assertEquals(ConvexResult.NotConfigured, runBlocking { client.list() })
        assertTrue(poster.urls.isEmpty())
    }

    @Test
    fun `a cleartext deployment url is refused rather than downgraded`() {
        val poster = RecordingPoster()
        val config = ConvexConfig(
            deploymentUrl = "http://keen-elephant-452.convex.cloud",
            readToken = testToken(),
            remoteReadEnabled = true,
        )
        val client = ConvexQueryClient(configSource = sourceOf(config), http = poster)

        assertEquals(ReadReadiness.INSECURE_DEPLOYMENT_URL, config.readiness)
        assertEquals(ConvexResult.NotConfigured, runBlocking { client.list() })
        assertTrue(poster.urls.isEmpty(), "the token must never go out over cleartext")
    }

    @Test
    fun `a blank token counts as absent and cannot read`() {
        val config = ConvexConfig(deploymentUrl = DEPLOYMENT, readToken = "   ", remoteReadEnabled = true)

        assertFalse(config.hasReadToken)
        assertEquals(ReadReadiness.NO_READ_TOKEN, config.readiness)
        assertFalse(config.allowsRemoteRead)
    }

    @Test
    fun `a configured token reports ready`() {
        val config = ConvexConfig(deploymentUrl = DEPLOYMENT, readToken = testToken(), remoteReadEnabled = true)

        assertEquals(ReadReadiness.READY, config.readiness)
        assertTrue(config.hasReadToken)
    }

    @Test
    fun `the config never prints the token`() {
        val token = testToken()
        val rendered = ConvexConfig(DEPLOYMENT, token, remoteReadEnabled = true).toString()

        assertFalse(rendered.contains(token), "a config object must be safe to log")
        assertTrue(rendered.contains("present"))
    }

    @Test
    fun `turning the switch off stops the next read`() {
        val poster = RecordingPoster()
        val source = MutableConvexConfigSource(
            ConvexConfig(DEPLOYMENT, testToken(), remoteReadEnabled = true),
        )
        val client = ConvexQueryClient(configSource = source, http = poster)

        source.update(ConvexConfig(DEPLOYMENT, testToken(), remoteReadEnabled = false))

        assertEquals(ConvexResult.Disabled, runBlocking { client.list() })
        assertTrue(poster.urls.isEmpty(), "the gate is read per call, not cached at construction")
    }

    @Test
    fun `the default repository answers Disabled for everything`() = runBlocking {
        val repository = DataFileRepositories.disabled()

        assertEquals(ConvexResult.Disabled, repository.list())
        assertEquals(ConvexResult.Disabled, repository.versions())
        assertEquals(ConvexResult.Disabled, repository.fetch("transactions"))
    }

    private fun sourceOf(config: ConvexConfig): ConvexConfigSource = MutableConvexConfigSource(config)

    /**
     * Calls the client the way the repository does, without needing a JSON
     * runtime: every case here returns before a request is built.
     */
    private suspend fun ConvexQueryClient.list(): ConvexResult<ConvexValue> = query(ConvexQuery.ListDataFiles)

    private companion object {
        /**
         * The deployment URL is already public — it is committed at
         * `scripts/convex-codegen.mjs:7` and was, until 2026-07-26, the only
         * thing standing between anyone and the household's finances. It is not
         * a secret and never was; the token is.
         */
        const val DEPLOYMENT = "https://keen-elephant-452.convex.cloud"
    }
}
