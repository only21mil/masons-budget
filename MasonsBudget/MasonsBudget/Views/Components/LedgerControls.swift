import SwiftUI

// MARK: - Ledger toggle

enum LedgerToggleGeometry {
    static let knobDiameter: CGFloat = 18
    static let knobInset: CGFloat = 3
    static let knobTravel: CGFloat = LedgerMetrics.toggleSize.width - knobDiameter - knobInset * 2
}

/// The handoff's 42x24 toggle: a Capsule track and a Circle knob. Track colour
/// settles over 0.18s, the knob travels over 0.2s, and a light impact plays on
/// iOS. Both animations land immediately under reduce motion.
struct LedgerToggle<Label: View>: View {
    @Binding var isOn: Bool
    private let label: Label

    @Environment(\.theme) private var theme
    @Environment(\.ledgerTokens) private var tokens
    @State private var haptic = LedgerHapticTrigger()

    init(isOn: Binding<Bool>, @ViewBuilder label: () -> Label) {
        _isOn = isOn
        self.label = label()
    }

    var body: some View {
        Button {
            isOn.toggle()
            haptic.fire(.impactLight)
        } label: {
            HStack(spacing: 12) {
                label
                Spacer(minLength: 8)
                track
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .ledgerHaptics(haptic)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(isOn ? "On" : "Off")
    }

    private var track: some View {
        ZStack(alignment: .leading) {
            Capsule()
                .fill(isOn ? tokens.colors.accentFill : theme.surface2)
                .overlay(Capsule().stroke(isOn ? tokens.colors.accentFill : theme.borderStrong, lineWidth: 1))
                .ledgerAnimation(.toggleAndButton, value: isOn)
            Circle()
                .fill(tokens.colors.toggleKnob)
                .frame(width: LedgerToggleGeometry.knobDiameter, height: LedgerToggleGeometry.knobDiameter)
                .padding(LedgerToggleGeometry.knobInset)
                .offset(x: isOn ? LedgerToggleGeometry.knobTravel : 0)
                .ledgerAnimation(.toggleKnob, value: isOn)
        }
        .frame(width: LedgerMetrics.toggleSize.width, height: LedgerMetrics.toggleSize.height)
    }
}

extension LedgerToggle where Label == LedgerToggleTitle {
    init(_ title: String, detail: String? = nil, isOn: Binding<Bool>) {
        self.init(isOn: isOn) {
            LedgerToggleTitle(title: title, detail: detail)
        }
    }
}

struct LedgerToggleTitle: View {
    let title: String
    let detail: String?

    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(AppFont.monoMicroStrong)
                .foregroundStyle(theme.text)
            if let detail {
                Text(detail)
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
            }
        }
    }
}

// MARK: - Ledger checkbox

/// Task checkbox. The fill settles over 0.18s and a light impact plays on iOS.
struct LedgerCheckbox: View {
    let isOn: Bool
    var size: CGFloat = 20
    let action: () -> Void

    @Environment(\.theme) private var theme
    @State private var haptic = LedgerHapticTrigger()

    var body: some View {
        Button {
            haptic.fire(.impactLight)
            action()
        } label: {
            ZStack {
                Circle()
                    .stroke(isOn ? theme.accent : theme.borderStrong, lineWidth: 1.5)
                Circle()
                    .fill(theme.accent)
                    .scaleEffect(isOn ? 1 : 0.85)
                    .opacity(isOn ? 1 : 0)
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.55, weight: .bold))
                    .foregroundStyle(theme.surface)
                    .opacity(isOn ? 1 : 0)
            }
            .frame(width: size, height: size)
            .frame(minWidth: LedgerMetrics.minimumHitTarget, minHeight: LedgerMetrics.minimumHitTarget)
            .contentShape(Rectangle())
            .ledgerAnimation(.toggleAndButton, value: isOn)
        }
        .buttonStyle(.plain)
        .ledgerHaptics(haptic)
    }
}

// MARK: - Ledger progress bar

/// Budget progress fill. The fraction animates over 0.3s (immediate under
/// reduce motion). `trackFraction` lets a bar draw a partial track, as the
/// budget versus actual rows do.
struct LedgerProgressBar: View {
    let fraction: Double
    var trackFraction: Double = 1
    var height: CGFloat = 6
    var fillHeight: CGFloat?
    var cornerRadius: CGFloat = 3
    let fill: Color
    let track: Color

    static func clamped(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return min(max(value, 0), 1)
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: cornerRadius)
                    .fill(track)
                    .frame(width: geo.size.width * Self.clamped(trackFraction), height: height)
                RoundedRectangle(cornerRadius: cornerRadius)
                    .fill(fill)
                    .frame(width: geo.size.width * Self.clamped(fraction), height: fillHeight ?? height)
            }
            .frame(maxHeight: .infinity, alignment: .center)
        }
        .frame(height: height)
        .ledgerAnimation(.progressAndTheme, value: Self.clamped(fraction))
        .ledgerAnimation(.progressAndTheme, value: Self.clamped(trackFraction))
        .ledgerAnimation(.progressAndTheme, value: fill)
        .accessibilityElement(children: .ignore)
        .accessibilityValue("\(Int(Self.clamped(fraction) * 100)) percent")
    }
}

// MARK: - Skeleton rows

/// Three ghost rows that breathe between 0.45 and 0.8 opacity over 1.1s while
/// a canonical source loads. Static at 0.6 under reduce motion. No shimmer.
struct LedgerSkeletonRows: View {
    var rows = 3

    @Environment(\.theme) private var theme
    @Environment(\.ledgerEffects) private var effects
    @State private var breathingIn = false

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0 ..< rows, id: \.self) { index in
                ghostRow
                if index < rows - 1 {
                    Hairline(indent: 54)
                }
            }
        }
        .opacity(LedgerSkeleton.opacity(reduceMotion: effects.reduceMotion, breathingIn: breathingIn))
        .glassCard(padding: 0, radius: AppLayout.radiusMedium)
        .accessibilityLabel("Loading")
        .onAppear {
            guard !effects.reduceMotion else { return }
            withAnimation(.easeInOut(duration: LedgerMotionToken.skeletonBreathe.duration).repeatForever(autoreverses: true)) {
                breathingIn = true
            }
        }
    }

    private var ghostRow: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 4)
                .fill(theme.borderStrong)
                .frame(width: 28, height: 16)
            VStack(alignment: .leading, spacing: 6) {
                GeometryReader { geo in
                    RoundedRectangle(cornerRadius: 3)
                        .fill(theme.borderStrong)
                        .frame(width: geo.size.width * 0.45, height: 12)
                }
                .frame(height: 12)
                RoundedRectangle(cornerRadius: 3)
                    .fill(theme.border)
                    .frame(width: 72, height: 9)
            }
            Spacer()
            RoundedRectangle(cornerRadius: 3)
                .fill(theme.borderStrong)
                .frame(width: 64, height: 12)
        }
        .padding(14)
    }
}
