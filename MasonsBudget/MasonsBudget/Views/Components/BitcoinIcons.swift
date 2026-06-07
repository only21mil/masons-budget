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
    var color: Color = .white

    private var glyph: CategoryGlyph {
        CategoryGlyph(rawValue: kind) ?? .box
    }

    var body: some View {
        Image(systemName: glyph.systemImage)
            .font(.system(size: size * 0.7, weight: .medium))
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
                .font(.system(size: size))
                .foregroundStyle(color)
        } else {
            Image(systemName: "bitcoinsign.circle")
                .font(.system(size: size))
                .foregroundStyle(color)
        }
    }
}

// MARK: - Sats Glyph (custom — no SF Symbol equivalent)

struct SatsGlyphView: View {
    var size: CGFloat = 20
    var color: Color = .init(hex: 0xF7931A)

    var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / 24
            let dotR = 1.4 * scale
            let y = 12 * scale

            for cx in [6.0, 12.0, 18.0] {
                let center = CGPoint(x: cx * scale, y: y)
                context.fill(Circle().path(in: CGRect(
                    x: center.x - dotR, y: center.y - dotR,
                    width: dotR * 2, height: dotR * 2,
                )), with: .color(color))
            }

            var topLine = Path()
            topLine.move(to: CGPoint(x: 3 * scale, y: 7 * scale))
            topLine.addLine(to: CGPoint(x: 21 * scale, y: 7 * scale))
            context.stroke(topLine, with: .color(color), lineWidth: 1.6 * scale / 12)

            var bottomLine = Path()
            bottomLine.move(to: CGPoint(x: 3 * scale, y: 17 * scale))
            bottomLine.addLine(to: CGPoint(x: 21 * scale, y: 17 * scale))
            context.stroke(bottomLine, with: .color(color), lineWidth: 1.6 * scale / 12)
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Payment Method Icon

enum PaymentMethod: String {
    case lightning, onChain = "on-chain"

    var icon: String {
        switch self {
        case .lightning: "bolt.fill"
        case .onChain: "link"
        }
    }

    var label: String {
        switch self {
        case .lightning: "Lightning"
        case .onChain: "On-chain"
        }
    }
}

// MARK: - Convenience SF Symbol References

enum AppIcon {
    static let dashboard = "bitcoinsign.circle"
    static let budget = "chart.bar.fill"
    static let activity = "bolt.fill"
    static let retirement = "lock.shield.fill"
    static let netWorth = "target"
    static let today = "checkmark.circle"
    static let projects = "tray.fill"
    static let settings = "gearshape"
    static let search = "magnifyingglass"
    static let filter = "line.3.horizontal.decrease"
    static let plus = "plus"
    static let calendar = "calendar"
    static let flag = "flag"
    static let flagFilled = "flag.fill"
    static let inbox = "tray"
    static let arrowUp = "arrow.up"
    static let arrowDown = "arrow.down"
    static let arrowRight = "arrow.right"
    static let dots = "ellipsis"
    static let checkOpen = "circle"
    static let checkDone = "checkmark.circle.fill"
    static let wallet = "creditcard"
    static let vault = "lock.shield"
    static let chain = "link"
    static let bolt = "bolt"
}
