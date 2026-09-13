package com.sats21m.vogelvault.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.theme.LedgerRadii
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

internal fun ledgerToday(clock: Clock = Clock.system(ZoneId.systemDefault())): LocalDate = LocalDate.now(clock)

// Material's millis encode a calendar date at UTC midnight, not a local instant.
internal fun ledgerPickerMillis(date: LocalDate): Long = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
internal fun ledgerPickerDate(millis: Long): LocalDate = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LedgerDateField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    optional: Boolean = false,
) {
    var showPicker by rememberSaveable { mutableStateOf(false) }
    Column(modifier.fillMaxWidth()) {
        Text(label, style = LocalLedgerTheme.current.type.kpiLabel)
        OutlinedButton(onClick = { showPicker = true }, enabled = enabled,
            shape = RoundedCornerShape(LedgerRadii.control), modifier = Modifier.fillMaxWidth()) {
            Text(value.ifBlank { "Choose date" })
        }
        if (optional && value.isNotBlank()) {
            TextButton(onClick = { onValueChange("") }, enabled = enabled) { Text("Clear date") }
        }
    }
    if (showPicker) {
        val date = runCatching { LocalDate.parse(value) }.getOrElse { ledgerToday() }
        val state = rememberDatePickerState(initialSelectedDateMillis = ledgerPickerMillis(date))
        DatePickerDialog(
            onDismissRequest = { showPicker = false },
            confirmButton = {
                TextButton(enabled = enabled && state.selectedDateMillis != null, onClick = {
                    state.selectedDateMillis?.let { onValueChange(ledgerPickerDate(it).toString()) }
                    showPicker = false
                }) { Text(stringResource(R.string.add_transaction_date_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { showPicker = false }) { Text(stringResource(R.string.write_cancel)) }
            },
        ) { DatePicker(state = state) }
    }
}
