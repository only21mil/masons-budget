package com.sats21m.vogelvault.data

import java.net.URI
import java.net.URISyntaxException
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The Vogel Vault — Android Convex read configuration.
 *
 * Production reads are fail-closed. The deployment URL is public configuration;
 * the runtime read token is what authorizes access to the household's data.
 * Android therefore refuses to open a socket unless the feature is enabled, the
 * endpoint is HTTPS, and a non-blank token is present.
 *
 * Three rules this type exists to enforce:
 *
 *  1. **The token is never committed or built into the APK.** Users enter it in
 *     Settings, where [SecureConvexConfigSource] encrypts it with an
 *     AndroidKeyStore AES/GCM key before writing authenticated ciphertext to
 *     private SharedPreferences. A fresh install remains unconfigured.
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
     * The kill switch that keeps secretless builds inert.
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
     * Why a remote read can or cannot start.
     *
     * Named states keep a missing URL, insecure endpoint, and missing credential
     * distinguishable while all three still fail closed before network I/O.
     */
    val readiness: ReadReadiness
        get() = when {
            !remoteReadEnabled -> ReadReadiness.DISABLED
            deploymentUrl == null -> ReadReadiness.NO_DEPLOYMENT_URL
            !isSecureDeployment(deploymentUrl) -> ReadReadiness.INSECURE_DEPLOYMENT_URL
            !hasReadToken -> ReadReadiness.NO_READ_TOKEN
            else -> ReadReadiness.READY
        }

    val allowsRemoteRead: Boolean
        get() = readiness == ReadReadiness.READY

    /** Compare a rejected attempt without exposing either credential. */
    internal fun hasSameReadConfigurationAs(other: ConvexConfig): Boolean =
        deploymentUrl == other.deploymentUrl &&
            readToken == other.readToken &&
            remoteReadEnabled == other.remoteReadEnabled

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
    /** The kill switch is off. The default for builds without configuration. */
    DISABLED,

    /** Enabled, but nothing to point at. */
    NO_DEPLOYMENT_URL,

    /** Enabled with a non-HTTPS deployment URL. Refused rather than downgraded. */
    INSECURE_DEPLOYMENT_URL,

    /** Enabled and pointed at HTTPS, but no credential is present. No socket may open. */
    NO_READ_TOKEN,

    /** Enabled, HTTPS, and a token is present. */
    READY,
}

/**
 * Where configuration comes from.
 *
 * Persistence stays outside this interface. [SecureConvexConfigSource] owns the
 * custom AndroidKeyStore AES/GCM encryption and stores only authenticated
 * ciphertext in private SharedPreferences.
 */
interface ConvexConfigSource {
    fun current(): ConvexConfig
}

/**
 * An explicit source that is permanently unconfigured and off.
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
 * Deliberately not persisted itself: manual entry is durably encrypted by
 * [SecureConvexConfigSource] before replacing this value for the running process.
 *
 * [AtomicReference] because the config is read from whatever thread a fetch
 * happens on and written from the main thread.
 */
class MutableConvexConfigSource(initial: ConvexConfig = ConvexConfig()) : ConvexConfigSource {
    private val config = AtomicReference(initial)
    private val _allowsRemoteRead = MutableStateFlow(initial.allowsRemoteRead)

    /**
     * Effective, non-secret read readiness for UI and lifecycle consumers.
     *
     * This is updated only from [ConvexConfig.allowsRemoteRead], so credential
     * presence, cached row provenance, and UI-local flags cannot claim a
     * connection after the effective configuration has failed closed.
     */
    val allowsRemoteRead: StateFlow<Boolean> = _allowsRemoteRead.asStateFlow()

    override fun current(): ConvexConfig = config.get()

    fun update(next: ConvexConfig) {
        config.set(next)
        _allowsRemoteRead.value = next.allowsRemoteRead
    }
}
