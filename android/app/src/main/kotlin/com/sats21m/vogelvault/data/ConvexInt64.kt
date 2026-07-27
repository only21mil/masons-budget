package com.sats21m.vogelvault.data

import java.util.Base64
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private const val INT64_TAG = "\$integer"
private const val INT64_BYTES = 8
private val CANONICAL_INT64_BASE64 = Regex("^[A-Za-z0-9+/]{11}=$")

/**
 * Decode Convex's canonical JSON representation of a signed `v.int64()`.
 *
 * Convex sends exactly eight little-endian two's-complement bytes inside a
 * single-key `{"$integer":"..."}` object. Numeric, decimal-string, URL-safe,
 * unpadded, over-padded, extra-key, and non-canonical aliases are rejected.
 */
internal fun JsonElement.decodeConvexInt64OrNull(): Long? {
    val tagged = this as? JsonObject ?: return null
    if (tagged.size != 1 || tagged.keys.singleOrNull() != INT64_TAG) return null

    val encodedValue = tagged[INT64_TAG] as? JsonPrimitive ?: return null
    if (!encodedValue.isString) return null
    val encoded = encodedValue.content
    if (!CANONICAL_INT64_BASE64.matches(encoded)) return null

    val bytes = try {
        Base64.getDecoder().decode(encoded)
    } catch (error: IllegalArgumentException) {
        return null
    }
    if (bytes.size != INT64_BYTES) return null
    if (Base64.getEncoder().encodeToString(bytes) != encoded) return null

    var value = 0L
    for (index in bytes.indices.reversed()) {
        value = (value shl 8) or (bytes[index].toLong() and 0xffL)
    }
    return value
}
