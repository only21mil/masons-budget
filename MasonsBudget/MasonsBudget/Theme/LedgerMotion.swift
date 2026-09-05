import SwiftUI

// MARK: - Reduce-motion aware animation

private struct LedgerAnimationModifier<Value: Equatable>: ViewModifier {
    let token: LedgerMotionToken
    let value: Value

    @Environment(\.ledgerEffects) private var effects

    func body(content: Content) -> some View {
        content.animation(token.animation(reduceMotion: effects.reduceMotion), value: value)
    }
}

extension View {
    /// Animates changes of `value` with the token's duration, or not at all
    /// when reduce motion is on (system setting or ledger preference).
    func ledgerAnimation(_ token: LedgerMotionToken, value: some Equatable) -> some View {
        modifier(LedgerAnimationModifier(token: token, value: value))
    }
}

// MARK: - Hero numeral settle

/// Animatable modifier whose `animatableData` is the numeric value. SwiftUI
/// re-evaluates `body` each frame, so the text is re-formatted from the
/// interpolated value with monospaced digits. The wrapped content is replaced.
struct LedgerNumeralSettle: ViewModifier, Animatable {
    var value: Double
    let format: (Double) -> String

    var animatableData: Double {
        get { value }
        set { value = newValue }
    }

    func body(content _: Content) -> some View {
        Text(format(value))
            .monospacedDigit()
    }
}

/// A numeral that settles onto a new value over `progressAndTheme` (0.3s).
/// The first render prints the value cold; only later changes animate.
struct LedgerSettlingNumeral: View {
    let value: Double
    let format: (Double) -> String

    var body: some View {
        EmptyView()
            .modifier(LedgerNumeralSettle(value: value, format: format))
            .ledgerAnimation(.progressAndTheme, value: value)
    }
}

// MARK: - Phosphor pulse

/// One soft breath of the Bitcoin hero glow when a new quote arrives: shadow
/// radius 18 to 32 over 0.2s, back to 18 over 0.4s. Never on a timer.
enum LedgerPhosphorPulse {
    static let riseSeconds = 0.2
    static let fallSeconds = 0.4

    static func isAllowed(reduceMotion: Bool, treatment: LedgerTreatment, glowEnabled: Bool) -> Bool {
        !reduceMotion && glowEnabled && treatment == .terminalLedger
    }

    static func run(radius: Binding<CGFloat>, reduceMotion: Bool, treatment: LedgerTreatment, glowEnabled: Bool) {
        guard isAllowed(reduceMotion: reduceMotion, treatment: treatment, glowEnabled: glowEnabled) else { return }
        withAnimation(.easeInOut(duration: riseSeconds)) {
            radius.wrappedValue = LedgerGlowToken.pulseRadius
        }
        withAnimation(.easeInOut(duration: fallSeconds).delay(riseSeconds)) {
            radius.wrappedValue = LedgerGlowToken.restingRadius
        }
    }
}

// MARK: - Skeleton and row reveal

enum LedgerSkeleton {
    static let minimumOpacity = 0.45
    static let maximumOpacity = 0.8
    static let staticOpacity = 0.6

    static func opacity(reduceMotion: Bool, breathingIn: Bool) -> Double {
        guard !reduceMotion else { return staticOpacity }
        return breathingIn ? maximumOpacity : minimumOpacity
    }
}

private struct LedgerRowRevealModifier: ViewModifier {
    let index: Int

    @Environment(\.ledgerEffects) private var effects
    @State private var revealed = false

    func body(content: Content) -> some View {
        content
            .opacity(revealed ? 1 : 0)
            .onAppear {
                guard let animation = LedgerMotionToken.rowReveal.animation(reduceMotion: effects.reduceMotion) else {
                    revealed = true
                    return
                }
                withAnimation(animation.delay(LedgerMotionToken.rowRevealDelay(index: index))) {
                    revealed = true
                }
            }
    }
}

extension View {
    /// Fades a list row in over 0.16s with a 0.02s per-row stagger capped at
    /// index 7. Immediate under reduce motion.
    func ledgerRowReveal(index: Int) -> some View {
        modifier(LedgerRowRevealModifier(index: index))
    }
}

// MARK: - Haptics

enum LedgerHaptic: Equatable, Sendable {
    /// A save the server accepted.
    case success
    /// A save that validation or the server rejected.
    case error
    /// Checkbox and ledger toggle.
    case impactLight

    #if os(iOS)
        var sensoryFeedback: SensoryFeedback {
            switch self {
            case .success: .success
            case .error: .error
            case .impactLight: .impact(weight: .light)
            }
        }
    #endif
}

/// Equatable trigger for `sensoryFeedback`. Each `fire` bumps the count so
/// repeating the same kind still plays.
struct LedgerHapticTrigger: Equatable, Sendable {
    private(set) var count = 0
    private(set) var kind: LedgerHaptic?

    mutating func fire(_ kind: LedgerHaptic) {
        self.kind = kind
        count += 1
    }
}

extension View {
    /// Plays the trigger's haptic on iOS 17 and later. No-op on macOS.
    /// Haptics are not motion and ignore reduce motion.
    func ledgerHaptics(_ trigger: LedgerHapticTrigger) -> some View {
        #if os(iOS)
            sensoryFeedback(trigger: trigger) { _, next in next.kind?.sensoryFeedback }
        #else
            self
        #endif
    }
}
