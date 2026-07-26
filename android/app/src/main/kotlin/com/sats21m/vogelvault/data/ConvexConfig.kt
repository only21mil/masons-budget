package com.sats21m.vogelvault.data

import java.net.URI
import java.net.URISyntaxException
import java.util.concurrent.atomic.AtomicReference

/**
 * The Vogel Vault — Android Convex read configuration.
 *
 * Reads were entirely unauthenticated until 2026-07-26: the deployment URL alone
 * — committed in this repo and baked into every shipped client — was enough to
 * pull the household's whole financial history. `validateReadToken` in
 * `convex/dataFiles.ts` now gates `get`, `getVersions`, `list` and
 * `listTodoTombstones`, fail-closed, behind an `ALLOW_TOKENLESS_READ` escape
 * hatch that exists purely so the cutover does not lock out live clients.
 *
 * This file is the Android half of step (2) of that cutover — "ship clients that
 * send the token" — landed early so Android is not the thing blocking step (3).
 *
 * Three rules this type exists to enforce:
 *
 *  1. **The token is never a constant.** It is not in source, not in a resource,
 *     not in `BuildConfig`, not in the APK. It arrives at runtime through a
 *     [ConvexConfigSource] and lives in memory only. A shipped binary that is
 *     never configured simply cannot read anything remote.
 *  2. **Off by default.** [remoteReadEnabled] defaults to `false`, so wiring this
 *     package into the app changes nothing observable: the UI keeps rendering
 *     the sanitized fixtures in `:domain`.
 *  3. **Nothing is reported but presence.** [toString] and [readiness] say
 *     "present"/"absent", never a value, because config objects end up in logs
 *     and crash reports whatever anyone intends.
 */
class ConvexConfig(
    deploymentUrl: String? = null,
    readToken: String? = null,
    /**
     * The kill switch, and the reason this whole package is inert today.
     *
     * Deliberately separate from "is it configured": a build that happens to
     * have a URL and a token must still not start talking to the deployment
     * until someone flips this on. Configuration presence is not consent.
     */
    val remoteReadEnabled: Boolean = false,
) {
    /** Trimmed, with blank treated as absent — a whitespace-only setting is a typo, not a value. */
    val deploymentUrl: String? = deploymentUrl?.trim()?.takeIf { it.isNotEmpty() }

    private val readToken: String? = readToken?.trim()?.takeIf { it.isNotEmpty() }

    /** Presence only. There is deliberately no public accessor for the value. */
    val hasReadToken: Boolean
        get() = readToken != null

    /**
     * The token itself, visible only inside this module's data layer.
     *
     * `internal` rather than `public` so a UI or logging call site cannot reach
     * it by accident; [ConvexQueryClient] is the single consumer.
     */
    internal fun readTokenOrNull(): String? = readToken

    /**
     * Convex's HTTP query endpoint for this deployment, or null when unusable.
     *
     * Null is the fail-closed answer for a missing or non-HTTPS URL, and the
     * only place the endpoint path is spelled out.
     */
    internal fun queryEndpoint(): String? {
        val base = deploymentUrl ?: return null
        if (!isSecureDeployment(base)) return null
        return base.trimEnd('/') + "/api/query"
    }

    /**
     * What a cutover check should be told about this build.
     *
     * Named states rather than a boolean because the runbook has to distinguish
     * "we are not configured" from "we are configured but sending no token" —
     * the second reads fine against a permissive deployment and dies the moment
     * `ALLOW_TOKENLESS_READ` is removed, which is exactly the failure the staged
     * cutover exists to avoid.
     */
    val readiness: ReadReadiness
        get() = when {
            !remoteReadEnabled -> ReadReadiness.DISABLED
            deploymentUrl == null -> ReadReadiness.NO_DEPLOYMENT_URL
            !isSecureDeployment(deploymentUrl) -> ReadReadiness.INSECURE_DEPLOYMENT_URL
            !hasReadToken -> ReadReadiness.READY_WITHOUT_TOKEN
            else -> ReadReadiness.READY
        }

    val allowsRemoteRead: Boolean
        get() = readiness == ReadReadiness.READY || readiness == ReadReadiness.READY_WITHOUT_TOKEN

    /**
     * Redacted on purpose.
     *
     * The default `data class` rendering would have printed the read token into
     * every log line that touched a config object, which is the same class of
     * mistake as committing it.
     */
    override fun toString(): String =
        "ConvexConfig(deploymentUrl=${deploymentUrl ?: "unset"}, " +
            "readToken=${if (hasReadToken) "present" else "absent"}, " +
            "remoteReadEnabled=$remoteReadEnabled)"

    private companion object {
        /**
         * HTTPS or nothing.
         *
         * Cleartext would put the read token and the family's finances on the
         * wire in plain text. Android blocks cleartext by default at this
         * `targetSdk` anyway, so an `http://` setting would fail at the socket
         * with a far less obvious error than "not configured".
         */
        fun isSecureDeployment(url: String): Boolean = try {
            val uri = URI(url)
            uri.scheme?.lowercase() == "https" && !uri.host.isNullOrEmpty()
        } catch (error: URISyntaxException) {
            false
        }
    }
}

/** Why a build can or cannot read from Convex. Carries no secret material. */
enum class ReadReadiness {
    /** The kill switch is off. The default, and today's shipped state. */
    DISABLED,

    /** Enabled, but nothing to point at. */
    NO_DEPLOYMENT_URL,

    /** Enabled with a non-HTTPS deployment URL. Refused rather than downgraded. */
    INSECURE_DEPLOYMENT_URL,

    /**
     * Enabled and pointed somewhere, but no token to send.
     *
     * Works only while `ALLOW_TOKENLESS_READ=true` is still set on the
     * deployment. Treated as usable — matching the iOS client, which omits an
     * empty token and lets the server decide — but reported distinctly so the
     * cutover can spot it before enforcement lands.
     */
    READY_WITHOUT_TOKEN,

    /** Enabled, HTTPS, and a token is present. What step (3) requires. */
    READY,
}

/**
 * Where configuration comes from.
 *
 * An interface, not a concrete store, because the storage decision is not this
 * lane's to make: persisting a read token wants `EncryptedSharedPreferences`,
 * that needs a new Gradle dependency, and adding one silently is how a secret
 * ends up sitting in plain `SharedPreferences` forever. iOS keeps the equivalent
 * settings under the `convex_deployment_url` / `convex_read_token` UserDefaults
 * keys; whatever Android grows should mirror those names.
 */
interface ConvexConfigSource {
    fun current(): ConvexConfig
}

/**
 * The app's default source: permanently unconfigured, permanently off.
 *
 * A real object rather than a null, so the "no remote reads" state is something
 * you can wire, inject and assert on instead of a branch every call site has to
 * remember.
 */
object DisabledConvexConfigSource : ConvexConfigSource {
    override fun current(): ConvexConfig = ConvexConfig()
}

/**
 * In-memory configuration, replaceable at runtime.
 *
 * Deliberately not persisted — the token dies with the process. That is the
 * conservative default for an unwired feature; a later lane that adds a settings
 * screen can add durable, encrypted storage behind this same interface.
 *
 * [AtomicReference] because the config is read from whatever thread a fetch
 * happens on and written from the main thread.
 */
class MutableConvexConfigSource(initial: ConvexConfig = ConvexConfig()) : ConvexConfigSource {
    private val config = AtomicReference(initial)

    override fun current(): ConvexConfig = config.get()

    fun update(next: ConvexConfig) {
        config.set(next)
    }
}
