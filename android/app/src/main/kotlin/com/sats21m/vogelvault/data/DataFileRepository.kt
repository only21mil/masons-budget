package com.sats21m.vogelvault.data

import java.math.BigDecimal
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One entry from `dataFiles:list`. Metadata only — no financial content. */
data class DataFileSummary(
    val name: String,
    val version: Long,
    val updatedAt: Long,
)

/** A fetched legacy data file, retained as exact response text for its lexical decoder. */
class DataFilePayload(val name: String, val rawResponseJson: String) {
    /** Redacted: this is the household's financial data. Size is all a log may have. */
    override fun toString(): String = "DataFilePayload(name=$name, bytes=${rawResponseJson.length})"
}

interface DataFileRepository {
    suspend fun list(): ConvexResult<List<DataFileSummary>>

    suspend fun versions(): ConvexResult<Map<String, Long>>

    suspend fun fetch(name: String): ConvexResult<DataFilePayload>
}

object DisabledDataFileRepository : DataFileRepository {
    override suspend fun list(): ConvexResult<List<DataFileSummary>> = ConvexResult.Disabled

    override suspend fun versions(): ConvexResult<Map<String, Long>> = ConvexResult.Disabled

    override suspend fun fetch(name: String): ConvexResult<DataFilePayload> = ConvexResult.Disabled
}

/** Legacy blob reads. Row reads live separately in [RowQueryRepository]. */
internal class ConvexDataFileRepository(private val client: ConvexQueryClient) : DataFileRepository {

    override suspend fun list(): ConvexResult<List<DataFileSummary>> =
        client.query(ConvexQuery.ListDataFiles).decode { value ->
            val array = value.parsed as? JsonArray ?: return@decode null
            val files = ArrayList<DataFileSummary>(array.size)
            val names = HashSet<String>()
            for (element in array) {
                val item = element as? JsonObject ?: return@decode null
                val name = item.requiredString("name") ?: return@decode null
                val version = item.requiredLong("version") ?: return@decode null
                val updatedAt = item.requiredLong("updatedAt") ?: return@decode null
                if (!names.add(name)) return@decode null
                files += DataFileSummary(name, version, updatedAt)
            }
            files
        }

    override suspend fun versions(): ConvexResult<Map<String, Long>> =
        client.query(ConvexQuery.GetDataFileVersions).decode { value ->
            val json = value.parsed as? JsonObject ?: return@decode null
            val versions = LinkedHashMap<String, Long>(json.size)
            for ((key, element) in json) {
                if (key.isEmpty()) return@decode null
                versions[key] = element.strictLongOrNull() ?: return@decode null
            }
            versions
        }

    override suspend fun fetch(name: String): ConvexResult<DataFilePayload> =
        client.query(ConvexQuery.GetDataFile(name)).decode { value ->
            DataFilePayload(name = name, rawResponseJson = value.rawResponseJson)
        }
}

internal fun JsonObject.requiredString(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }

internal fun JsonObject.requiredBoolean(key: String): Boolean? =
    (get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.content?.let {
        when (it) {
            "true" -> true
            "false" -> false
            else -> null
        }
    }

internal fun JsonObject.requiredLong(key: String): Long? = get(key).strictLongOrNull()

internal fun JsonElement?.strictLongOrNull(): Long? =
    (this as? JsonPrimitive)
        ?.takeUnless { it.isString }
        ?.content
        ?.let { content ->
            try {
                BigDecimal(content).longValueExact()
            } catch (error: NumberFormatException) {
                null
            } catch (error: ArithmeticException) {
                // Out-of-range and genuinely fractional float64 values are corrupt
                // integral fields. Never round or truncate them.
                null
            }
        }

/** Carry every non-success transport state through a typed decoder unchanged. */
internal fun <T> ConvexResult<ConvexValue>.decode(
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

object DataFileRepositories {
    fun disabled(): DataFileRepository = DisabledDataFileRepository

    fun convex(
        configSource: ConvexConfigSource,
        http: HttpPoster = UrlConnectionHttpPoster(),
    ): DataFileRepository = ConvexDataFileRepository(ConvexQueryClient(configSource, http))
}
