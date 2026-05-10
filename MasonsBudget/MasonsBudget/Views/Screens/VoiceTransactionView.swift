import SwiftUI
import SwiftData
import Speech
import AVFoundation

struct VoiceTransactionView: View {
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @StateObject private var transcriber = SpeechTranscriber()
    @State private var transcript = ""
    @State private var parsed = ParsedTransaction()
    @State private var didParse = false

    private let parser = VoiceParser()
    private var btcPrice: Decimal { BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice }
    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }

    private var canSave: Bool {
        parsed.amount != nil && !(parsed.merchant ?? "").isEmpty
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppLayout.cardSpacing) {
                    ScreenHeader(title: "Voice", eyebrow: "Transaction entry")

                    transcriptCard
                    parsedCard
                }
                .padding(.bottom, 28)
            }
            .background(theme.bg)
            .navigationTitle("Voice Transaction")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        transcriber.stop()
                        dismiss()
                    }
                    .foregroundStyle(theme.accent)
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { saveTransaction() }
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(canSave ? theme.accent : theme.textFaint)
                        .disabled(!canSave)
                }
            }
            .onChange(of: transcriber.transcript) { _, value in
                transcript = value
                parseTranscript()
            }
            .onDisappear {
                transcriber.stop()
            }
        }
    }

    private var transcriptCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Button {
                    toggleRecording()
                } label: {
                    Image(systemName: transcriber.isRecording ? "stop.fill" : "mic.fill")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(transcriber.isRecording ? .white : theme.accent)
                        .frame(width: 44, height: 44)
                        .background(transcriber.isRecording ? theme.danger : theme.accentSoft)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 2) {
                    Text(transcriber.isRecording ? "Listening" : "Ready")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(theme.text)
                    Text("Say the merchant, amount, method, and date")
                        .font(.system(size: 12))
                        .foregroundStyle(theme.textFaint)
                }

                Spacer()
            }

            TextEditor(text: $transcript)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(theme.text)
                .frame(minHeight: 120)
                .scrollContentBackground(.hidden)
                .padding(10)
                .background(theme.surface2)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .onChange(of: transcript) { _, _ in parseTranscript() }

            if let error = transcriber.errorMessage {
                Text(error)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(theme.danger)
            }
        }
        .glassCard()
        .padding(.horizontal, AppLayout.sectionPadding)
    }

    private var parsedCard: some View {
        VStack(spacing: 0) {
            parsedRow(label: "Merchant", value: parsed.merchant ?? "Missing")
            Hairline()
            parsedRow(label: "Amount", value: parsed.amount.map { AppFormatter.formatCurrency($0) } ?? "Missing")
            Hairline()
            parsedRow(label: "Category", value: parsed.category ?? "Other")
            Hairline()
            parsedRow(label: "Method", value: parsed.card ?? "Lightning")
            Hairline()
            parsedRow(label: "Date", value: parsed.date.map(formatDate) ?? "Today")
        }
        .glassCard(padding: 0, radius: AppLayout.radiusMedium)
        .padding(.horizontal, AppLayout.sectionPadding)
        .opacity(didParse ? 1 : 0.65)
    }

    private func parsedRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(theme.textMuted)
                .frame(width: 86, alignment: .leading)
            Text(value)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(value == "Missing" ? theme.danger : theme.text)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func toggleRecording() {
        if transcriber.isRecording {
            transcriber.stop()
        } else {
            transcriber.start()
        }
    }

    private func parseTranscript() {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            parsed = ParsedTransaction()
            didParse = false
            return
        }

        parsed = parser.parse(trimmed, today: Date())
        didParse = true
    }

    private func saveTransaction() {
        parseTranscript()
        guard let amount = parsed.amount, let merchant = parsed.merchant, !merchant.isEmpty else { return }

        let isIncome = (parsed.category ?? "").localizedCaseInsensitiveContains("income") ||
            merchant.localizedCaseInsensitiveContains("paycheck") ||
            merchant.localizedCaseInsensitiveContains("salary")
        let signedUsd = isIncome ? abs(amount) : -abs(amount)
        let signedSats = btcPrice > 0 ? Int64(truncating: ((signedUsd / btcPrice) * 100_000_000) as NSNumber) : nil
        let method = parsed.card?.localizedCaseInsensitiveContains("on") == true ? "on-chain" : "lightning"

        let tx = Transaction(
            id: UUID().uuidString,
            date: parsed.date ?? Date(),
            merchant: merchant,
            amount: signedUsd,
            category: parsed.category ?? (isIncome ? "Income" : "Other"),
            amountSats: signedSats,
            card: method,
            note: parsed.note ?? transcript,
            owner: activeMember,
            createdBy: "voice"
        )
        modelContext.insert(tx)
        transcriber.stop()
        dismiss()
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }
}

@MainActor
final class SpeechTranscriber: ObservableObject {
    @Published var transcript = ""
    @Published var isRecording = false
    @Published var errorMessage: String?

    private let recognizer = SFSpeechRecognizer()
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func start() {
        guard !isRecording else { return }

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                guard status == .authorized else {
                    self.errorMessage = "Speech recognition permission is required."
                    return
                }
                self.startAudio()
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        isRecording = false
    }

    private func startAudio() {
        errorMessage = nil
        task?.cancel()
        task = nil

        #if os(iOS)
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            errorMessage = "Microphone setup failed."
            return
        }
        #endif

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
            isRecording = true
        } catch {
            errorMessage = "Microphone recording failed."
            stop()
            return
        }

        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
                if error != nil || result?.isFinal == true {
                    self.stop()
                }
            }
        }
    }
}
