import SwiftUI

// MARK: - Category Glyph

enum CategoryGlyph: String, CaseIterable {
    case fork, home, plane, heart, bolt, wrench, gift, box, doc, cpu, vault, people

    var systemImage: String {
        switch self {
        case .fork: "fork.knife"
        case .home: "house"
        case .plane: "airplane"
        case .heart: "heart"
        case .bolt: "bolt.fill"
        case .wrench: "wrench.and.screwdriver"
        case .gift: "gift"
        case .box: "shippingbox"
        case .doc: "doc.text"
        case .cpu: "cpu"
        case .vault: "lock.shield"
        case .people: "person.2"
        }
    }
}

struct CatGlyphView: View {
    let kind: String
    var size: CGFloat = 18
    let color: Color

    private var glyph: CategoryGlyph {
        CategoryGlyph(rawValue: kind) ?? .box
    }

    var body: some View {
        Image(systemName: glyph.systemImage)
            .font(AppFont.icon(size: size * 0.7, weight: .medium))
            .foregroundStyle(color)
            .frame(width: size, height: size)
    }
}

// MARK: - Bitcoin Glyph

struct BtcGlyphView: View {
    var size: CGFloat = 20
    var color: Color = .init(hex: 0xF7931A)
    var filled: Bool = false

    var body: some View {
        if filled {
            Image(systemName: "bitcoinsign.circle.fill")
                .font(AppFont.icon(size: size))
                .foregroundStyle(color)
        } else {
            Image(systemName: "bitcoinsign.circle")
                .font(AppFont.icon(size: size))
                .foregroundStyle(color)
        }
    }
}

// MARK: - Payment Method Icon

/// Maps a persisted payment-source wire to its display glyph and label.
/// Display concern only — the wire values themselves live in
/// `TransactionSourceCatalog`. Retired wires ("lightning"/"on-chain") keep
/// their historical presentation so legacy rows still render sensibly, and
/// unknown wires surface verbatim, matching the catalogue's synthetic-option
/// presentation.
enum PaymentMethod {
    /// Lightning-style sources get the bolt; on-chain style, fiat cards, and
    /// unknown wires fall back to the link glyph.
    static func icon(forWire wire: String?) -> String {
        switch wire {
        case "lightning", "zeus_lightning": "bolt.fill"
        default: "link"
        }
    }

    /// Display label for a stored wire value. A missing card keeps the
    /// historical On-chain default.
    static func label(forWire wire: String?) -> String {
        guard let wire, !wire.isEmpty else { return "On-chain" }
        if wire == "lightning" { return "Lightning" }
        return TransactionSourceCatalog.common.first { $0.wire == wire }?.label ?? wire
    }
}

// MARK: - Convenience SF Symbol References

enum AppIcon {
    static let today = "checkmark.circle"
    static let calendar = "calendar"
    static let flagFilled = "flag.fill"
    static let inbox = "tray"
    static let arrowUp = "arrow.up"
    static let arrowRight = "arrow.right"
    static let checkOpen = "circle"
    static let vault = "lock.shield"
}
