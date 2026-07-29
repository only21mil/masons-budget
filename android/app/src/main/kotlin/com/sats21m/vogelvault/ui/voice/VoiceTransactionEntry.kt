package com.sats21m.vogelvault.ui.voice

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import com.sats21m.vogelvault.ui.theme.VaultWarning
import java.math.BigDecimal
import java.time.LocalDate
import java.util.Locale
import kotlinx.coroutines.CancellationException

@Composable
fun VoiceEntryLauncher(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Button(onClick = onClick, modifier = modifier.fillMaxWidth()) {
        Icon(Icons.Filled.Mic, contentDescription = null)
        Text(
            text = stringResource(R.string.voice_add_transaction),
            modifier = Modifier.padding(start = VaultSpace.sm),
        )
    }
}

/**
 * Capture and review surface.
 *
 * Recognition never invokes [onSave]. A draft can cross that boundary only
 * after the user opens review, sees every field, and presses the save button.
 */
@Composable
fun VoiceTransactionEntryDialog(
    activeProfile: FamilyMember,
    onDismiss: () -> Unit,
    onSave: suspend (VoiceTransactionDraft) -> VoiceTransactionSaveResult,
    parser: VoiceTransactionParser = remember { VoiceTransactionParser() },
    today: LocalDate = LocalDate.now(),
) {
    var transcript by rememberSaveable { mutableStateOf("") }
    var parsed by remember { mutableStateOf<ParsedVoiceTransaction?>(null) }
    var merchant by rememberSaveable { mutableStateOf("") }
    var amount by rememberSaveable { mutableStateOf("") }
    var category by rememberSaveable { mutableStateOf("") }
    var date by rememberSaveable { mutableStateOf(today.toString()) }
    var card by rememberSaveable { mutableStateOf("") }
    var note by rememberSaveable { mutableStateOf("") }
    var listening by remember { mutableStateOf(false) }
    var speechError by remember { mutableStateOf<Int?>(null) }
    var validationError by remember { mutableStateOf<Int?>(null) }
    var saving by remember { mutableStateOf(false) }

    fun parseForReview(source: String = transcript) {
        val next = parser.parse(source.trim(), today)
        parsed = next
        merchant = next.merchant.orEmpty()
        amount = next.amountCents?.toDollarInput().orEmpty()
        category = next.category ?: "Other"
        date = (next.date ?: today).toString()
        card = next.card.orEmpty()
        note = next.note.orEmpty()
        validationError = null
    }

    val recognizer =
        rememberVoiceRecognizer(
            onPartialResult = {
                transcript = it
                speechError = null
            },
            onFinalResult = {
                transcript = it
                listening = false
                speechError = null
                parseForReview(it)
            },
            onListeningChanged = { listening = it },
            onError = {
                listening = false
                speechError = R.string.voice_recognition_failed
            },
        )
    val context = LocalContext.current
    val startListening = {
        if (recognizer == null) {
            speechError = R.string.voice_recognition_unavailable
        } else {
            speechError = null
            runCatching { recognizer.start() }
                .onFailure {
                    listening = false
                    speechError = R.string.voice_recognition_failed
                }
        }
    }
    val permissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                startListening()
            } else {
                speechError = R.string.voice_microphone_permission_required
            }
        }

    AlertDialog(
        onDismissRequest = {
            recognizer?.stop()
            onDismiss()
        },
        title = { Text(stringResource(R.string.voice_transaction_title)) },
        text = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .fillMaxHeight(0.82f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
            ) {
                Text(
                    stringResource(R.string.voice_transaction_instruction),
                    color = VaultTextDim,
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm)) {
                    Button(
                        onClick = {
                            if (listening) {
                                recognizer?.stop()
                            } else if (
                                ContextCompat.checkSelfPermission(
                                    context,
                                    Manifest.permission.RECORD_AUDIO,
                                ) == PackageManager.PERMISSION_GRANTED
                            ) {
                                startListening()
                            } else {
                                permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        },
                    ) {
                        Icon(
                            if (listening) Icons.Filled.Stop else Icons.Filled.Mic,
                            contentDescription = null,
                        )
                        Text(
                            stringResource(
                                if (listening) R.string.voice_stop_listening else R.string.voice_start_listening,
                            ),
                            modifier = Modifier.padding(start = VaultSpace.xs),
                        )
                    }
                    OutlinedButton(
                        onClick = { parseForReview(transcript) },
                        enabled = transcript.isNotBlank(),
                    ) {
                        Text(stringResource(R.string.voice_review))
                    }
                }
                OutlinedTextField(
                    value = transcript,
                    onValueChange = {
                        transcript = it
                        parsed = null
                        validationError = null
                    },
                    label = { Text(stringResource(R.string.voice_transcript)) },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                speechError?.let {
                    Text(stringResource(it), color = VaultWarning)
                }

                parsed?.let { result ->
                    Spacer(Modifier.height(VaultSpace.xs))
                    val needsCorrection =
                        !result.hasMinimumFields ||
                            result.category == null ||
                            result.confidence.date < REVIEW_THRESHOLD ||
                            result.confidence.overall < REVIEW_THRESHOLD
                    Text(
                        stringResource(
                            if (needsCorrection) {
                                R.string.voice_low_confidence_review
                            } else {
                                R.string.voice_review_all_fields
                            },
                        ),
                        color = if (needsCorrection) VaultWarning else VaultAccent,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        stringResource(
                            R.string.voice_confidence,
                            (result.confidence.overall * 100).toInt(),
                        ),
                        color = VaultTextDim,
                        style = MaterialTheme.typography.labelSmall,
                    )
                    OutlinedTextField(
                        value = merchant,
                        onValueChange = {
                            merchant = it
                            validationError = null
                        },
                        label = { Text(stringResource(R.string.voice_merchant)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = amount,
                        onValueChange = {
                            amount = it
                            validationError = null
                        },
                        label = { Text(stringResource(R.string.voice_amount)) },
                        supportingText = { Text(stringResource(R.string.voice_amount_sign_hint)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = category,
                        onValueChange = {
                            category = it
                            validationError = null
                        },
                        label = { Text(stringResource(R.string.voice_category)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = date,
                        onValueChange = {
                            date = it
                            validationError = null
                        },
                        label = { Text(stringResource(R.string.voice_date)) },
                        supportingText = { Text(stringResource(R.string.voice_date_hint)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = card,
                        onValueChange = { card = it },
                        label = { Text(stringResource(R.string.voice_card)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = note,
                        onValueChange = { note = it },
                        label = { Text(stringResource(R.string.voice_note)) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    validationError?.let {
                        Text(stringResource(it), color = VaultWarning)
                    }
                    Button(
                        enabled = !saving,
                        onClick = {
                            val cents = amount.toExactCents()
                            val parsedDate = runCatching { LocalDate.parse(date.trim()) }.getOrNull()
                            val nextError =
                                when {
                                    merchant.isBlank() -> R.string.voice_merchant_required
                                    cents == null || cents == 0L -> R.string.voice_valid_amount_required
                                    category.isBlank() -> R.string.voice_category_required
                                    parsedDate == null -> R.string.voice_valid_date_required
                                    category.trim().equals("Income", ignoreCase = true) && cents < 0L ->
                                        R.string.voice_income_must_be_positive
                                    else -> null
                                }
                            validationError = nextError
                            if (nextError == null) {
                                saving = true
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            stringResource(
                                if (saving) R.string.voice_saving else R.string.voice_save_transaction,
                            ),
                        )
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            OutlinedButton(
                onClick = {
                    recognizer?.stop()
                    onDismiss()
                },
            ) {
                Text(stringResource(R.string.voice_cancel), color = VaultCream)
            }
        },
    )

    if (saving) {
        LaunchedEffect(merchant, amount, category, date, card, note, activeProfile) {
            val cents = amount.toExactCents()
            val parsedDate = runCatching { LocalDate.parse(date.trim()) }.getOrNull()
            if (cents == null || parsedDate == null) {
                validationError = R.string.voice_invalid_transaction
                saving = false
                return@LaunchedEffect
            }
            val result =
                try {
                    onSave(
                        VoiceTransactionDraft(
                            amountCents = cents,
                            merchant = merchant.trim(),
                            category = category.trim(),
                            date = parsedDate,
                            card = card.trim().ifBlank { null },
                            note = note.trim().ifBlank { null },
                            owner = activeProfile,
                        ),
                    )
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    VoiceTransactionSaveResult.Failed(R.string.voice_write_failed)
                }
            when (result) {
                VoiceTransactionSaveResult.Saved -> {
                    recognizer?.stop()
                    onDismiss()
                }
                is VoiceTransactionSaveResult.Failed -> {
                    validationError = result.messageRes
                    saving = false
                }
            }
        }
    }
}

private class VoiceRecognizerController(
    private val recognizer: SpeechRecognizer,
    private val onPartialResult: (String) -> Unit,
    private val onFinalResult: (String) -> Unit,
    private val onListeningChanged: (Boolean) -> Unit,
    private val onError: () -> Unit,
) : RecognitionListener {
    init {
        recognizer.setRecognitionListener(this)
    }

    fun start() {
        val intent =
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.US.toLanguageTag())
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
        recognizer.startListening(intent)
        onListeningChanged(true)
    }

    fun stop() {
        recognizer.stopListening()
        onListeningChanged(false)
    }

    fun destroy() {
        recognizer.destroy()
    }

    override fun onReadyForSpeech(params: Bundle?) = onListeningChanged(true)

    override fun onBeginningOfSpeech() = Unit

    override fun onRmsChanged(rmsdB: Float) = Unit

    override fun onBufferReceived(buffer: ByteArray?) = Unit

    override fun onEndOfSpeech() = onListeningChanged(false)

    override fun onError(error: Int) = onError()

    override fun onResults(results: Bundle?) {
        results?.bestTranscript()?.let(onFinalResult) ?: onError()
    }

    override fun onPartialResults(partialResults: Bundle?) {
        partialResults?.bestTranscript()?.let(onPartialResult)
    }

    override fun onEvent(
        eventType: Int,
        params: Bundle?,
    ) = Unit
}

@Composable
private fun rememberVoiceRecognizer(
    onPartialResult: (String) -> Unit,
    onFinalResult: (String) -> Unit,
    onListeningChanged: (Boolean) -> Unit,
    onError: () -> Unit,
): VoiceRecognizerController? {
    val context = LocalContext.current
    val latestPartial by rememberUpdatedState(onPartialResult)
    val latestFinal by rememberUpdatedState(onFinalResult)
    val latestListening by rememberUpdatedState(onListeningChanged)
    val latestError by rememberUpdatedState(onError)
    val controller =
        remember(context) {
            if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                null
            } else {
                VoiceRecognizerController(
                    SpeechRecognizer.createSpeechRecognizer(context),
                    onPartialResult = { latestPartial(it) },
                    onFinalResult = { latestFinal(it) },
                    onListeningChanged = { latestListening(it) },
                    onError = { latestError() },
                )
            }
        }
    DisposableEffect(controller) {
        onDispose { controller?.destroy() }
    }
    return controller
}

private fun Bundle.bestTranscript(): String? =
    getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()?.ifBlank { null }

internal fun String.toExactCents(): Long? =
    trim()
        .removePrefix("$")
        .replace(",", "")
        .takeIf(String::isNotEmpty)
        ?.let { raw ->
            runCatching {
                BigDecimal(raw)
                    .movePointRight(2)
                    .longValueExact()
            }.getOrNull()?.takeIf { it != Long.MIN_VALUE }
        }

private fun Long.toDollarInput(): String =
    BigDecimal.valueOf(this, 2).stripTrailingZeros().toPlainString()

private const val REVIEW_THRESHOLD = 0.75
