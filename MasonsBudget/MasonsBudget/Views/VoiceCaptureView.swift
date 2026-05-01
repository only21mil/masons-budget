import SwiftUI
import Speech
import AVFoundation

final class VoiceCaptureModel: ObservableObject {
    @Published var isListening = false
    @Published var transcript = ""
    @Published var partialResult: ParsedTransaction?
    @Published var isConfirming = false
    @Published var errorMessage: String?

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()
    private let parser = VoiceParser()

    func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    func startListening() {
        guard let speechRecognizer = speechRecognizer else {
            errorMessage = "Speech recognition not available"
            return
        }
        recognitionTask?.cancel()
        recognitionTask = nil
        transcript = ""
        partialResult = nil
        isConfirming = false

        #if os(iOS)
        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
        try? audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        #endif

        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest = recognitionRequest else { return }
        recognitionRequest.shouldReportPartialResults = true

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            recognitionRequest.append(buffer)
        }

        audioEngine.prepare()
        try? audioEngine.start()
        isListening = true

        recognitionTask = speechRecognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let result = result {
                    self.transcript = result.bestTranscription.formattedString
                }
                if error != nil || result?.isFinal == true {
                    self.stopListening()
                    self.parseTranscript()
                }
            }
        }
    }

    func stopListening() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.finish()
        recognitionRequest = nil
        recognitionTask = nil
        isListening = false
    }

    private func parseTranscript() {
        guard !transcript.isEmpty else { return }
        let result = parser.parse(transcript, today: Date())
        partialResult = result
        isConfirming = true
    }

    func reset() {
        stopListening()
        transcript = ""
        partialResult = nil
        isConfirming = false
        errorMessage = nil
    }
}

struct VoiceCaptureView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = VoiceCaptureModel()
    var onSave: ((ParsedTransaction) -> Void)?

    var body: some View {
        ZStack {
            AppTheme.background.ignoresSafeArea()

            VStack(spacing: 32) {
                if !model.isConfirming {
                    listeningView
                } else {
                    confirmView
                }
            }
            .padding(.horizontal, AppTheme.horizontalPadding)
        }
        .task {
            let granted = await model.requestPermission()
            if granted { model.startListening() }
        }
        .onDisappear { model.reset() }
    }

    // MARK: - Listening state

    private var listeningView: some View {
        VStack(spacing: 40) {
            Spacer()

            ZStack {
                ForEach(0..<3) { i in
                    Circle()
                        .stroke(AppTheme.accentColor.opacity(0.3), lineWidth: 2)
                        .scaleEffect(model.isListening ? 1.0 + CGFloat(i) * 0.4 : 0.8)
                        .opacity(model.isListening ? 0.6 : 0)
                        .animation(
                            .easeInOut(duration: 1.2).repeatForever(autoreverses: true).delay(Double(i) * 0.3),
                            value: model.isListening
                        )
                }

                Circle()
                    .fill(AppTheme.accentColor)
                    .frame(width: 100, height: 100)
                    .scaleEffect(model.isListening ? 1.0 : 0.9)
                    .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: model.isListening)

                Image(systemName: "mic.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(.white)
            }
            .frame(height: 200)

            Text(model.transcript.isEmpty ? "Listening..." : model.transcript)
                .font(.title3)
                .foregroundStyle(model.transcript.isEmpty ? AppTheme.secondaryText : AppTheme.primaryText)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 80)
                .padding(.horizontal)

            Text("Tap mic or hold to speak")
                .font(.caption)
                .foregroundStyle(AppTheme.tertiaryText)

            Spacer()

            Button(action: { model.stopListening() }) {
                Text("Done Speaking")
                    .font(.headline)
                    .foregroundStyle(.black)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(AppTheme.accentColor)
                    .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
            }
        }
    }

    // MARK: - Confirm state

    private var confirmView: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(AppTheme.positive)

            Text("Review Transaction")
                .font(.title2.bold())
                .foregroundStyle(AppTheme.primaryText)

            if let partial = model.partialResult {
                VStack(spacing: 12) {
                    confirmRow(label: "Amount", value: partial.amount.map { formatCurrency($0) } ?? "—")
                    confirmRow(label: "Merchant", value: partial.merchant ?? "—")
                    confirmRow(label: "Category", value: partial.category ?? "—")
                    confirmRow(label: "Card", value: partial.card ?? "—")
                    if let note = partial.note, !note.isEmpty {
                        confirmRow(label: "Note", value: note)
                    }
                }
                .padding(20)
                .background(AppTheme.cardBackground)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
            }

            Text("\"\(model.transcript)\"")
                .font(.caption)
                .foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center)

            HStack(spacing: 16) {
                Button(action: { model.reset(); model.startListening() }) {
                    Text("Edit")
                        .font(.headline)
                        .foregroundStyle(AppTheme.accentColor)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(AppTheme.cardBackground)
                        .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                }

                Button(action: {
                    if let result = model.partialResult {
                        onSave?(result)
                    }
                    dismiss()
                }) {
                    Text("Save")
                        .font(.headline)
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(AppTheme.accentColor)
                        .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                }
            }

            Spacer()
        }
    }

    private func confirmRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(AppTheme.secondaryText)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(.subheadline)
                .foregroundStyle(AppTheme.primaryText)
            Spacer()
        }
    }
}
