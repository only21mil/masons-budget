package com.sats21m.vogelvault.data

import org.json.JSONArray
import org.json.JSONObject

/** One entry from `dataFiles:list`. Metadata only — no financial content. */
data class DataFileSummary(
    val name: String,
    val version: Long,
    val updatedAt: Long,
)

/**
 * A fetched data file, still as text.
 *
 * See [ConvexValue] for why this is not a decoded object: MC2 money is decimal
 * and `org.json` would turn it into `Double` on the way past. Whoever writes the
 * decoder reads the literals and goes through `Money.parseCents` /
 * `Money.parseBtcToSats` into integer minor units.
 */
class DataFilePayload(val name: String, val rawResponseJson: String) {
    /** Redacted: this is the household's financial data. Size is all a log may have. */
    override fun toString(): String = "DataFilePayload(name=$name, bytes=${rawResponseJson.length})"
}

/**
 * Reading MC2 data files, without saying where from.
 *
 * The app depends on this, not on Convex, so the fixture path and the live path
 * are the same shape and swapping between them is a wiring change rather than a
 * rewrite. Nothing is wired to it yet — that is the next task.
 */
interface DataFileRepository {
    suspend fun list(): ConvexResult<List<DataFileSummary>>

    suspend fun versions(): ConvexResult<Map<String, Long>>

    suspend fun fetch(name: String): ConvexResult<DataFilePayload>
}

/**
 * The default, and what the app ships today.
 *
 * Answers [ConvexResult.Disabled] without touching config, network or the
 * clock. Its existence is the guarantee this package can be merged and even
 * wired without changing a single thing the app renders: the UI keeps showing
 * the sanitized fixtures from `:domain`.
 */
object DisabledDataFileRepository : DataFileRepository {
    override suspend fun list(): ConvexResult<List<DataFileSummary>> = ConvexResult.Disabled

    override suspend fun versions(): ConvexResult<Map<String, Long>> = ConvexResult.Disabled

    override suspend fun fetch(name: String): ConvexResult<DataFilePayload> = ConvexResult.Disabled
}

/**
 * Reads data files from Convex — when, and only when, configuration allows it.
 *
 * The gate is re-checked on every call inside [ConvexQueryClient] rather than
 * once at construction, so turning the feature off at runtime actually stops the
 * next request instead of the one after a restart.
 *
 * `listTodoTombstones` is deliberately absent. It is the fourth query the read
 * token now gates, but it only means something to a client with local todo
 * storage to reconcile, and Android has none yet. Adding a call with no consumer
 * would be a bigger surface for no behaviour.
 */
class ConvexDataFileRepository(private val client: ConvexQueryClient) : DataFileRepository {

    override suspend fun list(): ConvexResult<List<DataFileSummary>> =
        client.query(PATH_LIST).decode<List<DataFileSummary>> { value ->
            val array = value.parsed as? JSONArray ?: return@decode null
            (0 until array.length()).mapNotNull { index ->
                val item = array.optJSONObject(index) ?: return@mapNotNull null
                val name = item.optString("name")
                if (name.isEmpty()) {
                    null
                } else {
                    DataFileSummary(
                        name = name,
                        version = item.optLong("version"),
                        updatedAt = item.optLong("updatedAt"),
                    )
                }
            }
        }

    override suspend fun versions(): ConvexResult<Map<String, Long>> =
        client.query(PATH_VERSIONS).decode<Map<String, Long>> { value ->
            val json = value.parsed as? JSONObject ?: return@decode null
            // Versions are counts, so a Long is honest here. Money never is.
            buildMap<String, Long> {
                for (key in json.keys()) {
                    put(key, json.optLong(key))
                }
            }
        }

    override suspend fun fetch(name: String): ConvexResult<DataFilePayload> =
        client.query(PATH_GET, mapOf("name" to name)).decode<DataFilePayload> { value ->
            DataFilePayload(name = name, rawResponseJson = value.rawResponseJson)
        }

    private companion object {
        const val PATH_LIST = "dataFiles:list"
        const val PATH_VERSIONS = "dataFiles:getVersions"
        const val PATH_GET = "dataFiles:get"
    }
}

/**
 * Turn a transport result into a typed one, carrying every non-success state
 * through untouched.
 *
 * Written out rather than folded into a `map` so the compiler enforces that a
 * new [ConvexResult] state gets a decision here instead of silently collapsing
 * into a generic failure.
 */
private fun <T> ConvexResult<ConvexValue>.decode(
    decoder: (ConvexValue) -> T?,
): ConvexResult<T> = when (this) {
    is ConvexResult.Ok -> decoder(value)?.let { ConvexResult.Ok(it) }
        ?: ConvexResult.Failed("unexpected payload shape")
    ConvexResult.Disabled -> ConvexResult.Disabled
    ConvexResult.NotConfigured -> ConvexResult.NotConfigured
    ConvexResult.Unauthorized -> ConvexResult.Unauthorized
    ConvexResult.Missing -> ConvexResult.Missing
    is ConvexResult.Failed -> this
}

/**
 * How the app gets a repository.
 *
 * [disabled] is what `VaultViewModel` should wire when it wires anything at all.
 * [convex] exists so the live path is a one-line change made deliberately, in a
 * reviewed commit, rather than assembled ad hoc at a call site.
 */
object DataFileRepositories {
    fun disabled(): DataFileRepository = DisabledDataFileRepository

    fun convex(
        configSource: ConvexConfigSource,
        http: HttpPoster = UrlConnectionHttpPoster(),
    ): DataFileRepository = ConvexDataFileRepository(ConvexQueryClient(configSource, http))
}
