package com.sats21m.vogelvault.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import com.sats21m.vogelvault.domain.FamilyMember

/** Saveable inputs reset live state, but do not validate a restored state's owner. */
@Composable
internal fun <T> rememberProfileSaveable(
    profile: FamilyMember,
    init: () -> MutableState<T>,
): MutableState<T> = rememberSaveable(
    profile,
    saver = Saver<MutableState<T>, Any>(
        save = { listOf(profile.name, it.value) },
        restore = { saved ->
            val values = saved as? List<*>
            if (values?.size == 2 && values[0] == profile.name) {
                // The same call site's initializer and saver own the value type.
                @Suppress("UNCHECKED_CAST")
                init().also { it.value = values[1] as T }
            } else {
                null
            }
        },
    ),
    init = init,
)
