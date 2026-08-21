#!/usr/bin/env swift
// Generates Mason's Budget App icons at all required iOS sizes.
// Run: swift scripts/generate-app-icon.swift
// Outputs to: MasonsBudget/MasonsBudget/Resources/Assets.xcassets/AppIcon.appiconset/

import Foundation
import AppKit
import CoreGraphics

// MARK: - Required iOS icon sizes

let sizes: [(name: String, px: Int)] = [
    ("icon-40.png", 40),
    ("icon-58.png", 58),
    ("icon-60.png", 60),
    ("icon-76.png", 76),
    ("icon-80.png", 80),
    ("icon-87.png", 87),
    ("icon-120.png", 120),
    ("icon-152.png", 152),
    ("icon-167.png", 167),
    ("icon-180.png", 180),
    ("icon-1024.png", 1024),
]

// MARK: - Color palette (matches AppTheme.swift)

func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
    let r = CGFloat((hex >> 16) & 0xFF) / 255
    let g = CGFloat((hex >> 8) & 0xFF) / 255
    let b = CGFloat(hex & 0xFF) / 255
    return CGColor(red: r, green: g, blue: b, alpha: alpha)
}

let bgTop = rgb(0x1F1614)        // warm-tinted near-black, top
let bgBottom = rgb(0x080604)     // deeper black, bottom
let glowColor = rgb(0xF7931A, alpha: 0.18)
let bitcoinOrange = rgb(0xF7931A)
let bitcoinOrangeLight = rgb(0xFFB347)
let goldAccent = rgb(0xD4A857)

// MARK: - Drawing

func makeIcon(size: Int) -> CGImage? {
    let w = size
    let h = size
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil, width: w, height: h,
        bitsPerComponent: 8, bytesPerRow: 0,
        space: cs,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    let cx = CGFloat(w) / 2
    let cy = CGFloat(h) / 2
    let s = CGFloat(size)

    // Background gradient (linear, top-to-bottom)
    let bgGradient = CGGradient(
        colorsSpace: cs,
        colors: [bgTop, bgBottom] as CFArray,
        locations: [0.0, 1.0]
    )!
    ctx.drawLinearGradient(
        bgGradient,
        start: CGPoint(x: 0, y: h),
        end: CGPoint(x: 0, y: 0),
        options: []
    )

    // Warm radial glow centered slightly above middle
    let glowGradient = CGGradient(
        colorsSpace: cs,
        colors: [glowColor, rgb(0xF7931A, alpha: 0)] as CFArray,
        locations: [0.0, 1.0]
    )!
    ctx.drawRadialGradient(
        glowGradient,
        startCenter: CGPoint(x: cx, y: cy + s * 0.05),
        startRadius: 0,
        endCenter: CGPoint(x: cx, y: cy + s * 0.05),
        endRadius: s * 0.55,
        options: []
    )

    // Subtle upward chart line beneath the wordmark (gold, low opacity)
    ctx.saveGState()
    ctx.setStrokeColor(goldAccent.copy(alpha: 0.32)!)
    ctx.setLineWidth(s * 0.014)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    let chartPath = CGMutablePath()
    let chartBaseY: CGFloat = s * 0.10
    let pts: [CGPoint] = [
        CGPoint(x: s * 0.18, y: chartBaseY + s * 0.00),
        CGPoint(x: s * 0.34, y: chartBaseY + s * 0.03),
        CGPoint(x: s * 0.50, y: chartBaseY + s * 0.01),
        CGPoint(x: s * 0.66, y: chartBaseY + s * 0.05),
        CGPoint(x: s * 0.82, y: chartBaseY + s * 0.10),
    ]
    chartPath.move(to: pts[0])
    for p in pts.dropFirst() { chartPath.addLine(to: p) }
    ctx.addPath(chartPath)
    ctx.strokePath()

    // Small dot at the end of the chart line for emphasis
    let dot = CGRect(
        x: pts.last!.x - s * 0.018,
        y: pts.last!.y - s * 0.018,
        width: s * 0.036, height: s * 0.036
    )
    ctx.setFillColor(goldAccent.copy(alpha: 0.65)!)
    ctx.fillEllipse(in: dot)
    ctx.restoreGState()

    // Wordmark "FAMILY BUDGET" beneath the glyph — small, ivory, tracked
    let wordmark = "FAMILY  BUDGET"
    let wordSize = s * 0.078
    let wordFont = NSFont.systemFont(ofSize: wordSize, weight: .semibold)
    let wordAttrs: [NSAttributedString.Key: Any] = [
        .font: wordFont,
        .foregroundColor: NSColor(cgColor: rgb(0xF5F1E8, alpha: 0.92)) ?? .white,
        .kern: wordSize * 0.18,
    ]
    let wordStr = NSAttributedString(string: wordmark, attributes: wordAttrs)
    let wordLine = CTLineCreateWithAttributedString(wordStr)
    let wordBounds = CTLineGetBoundsWithOptions(wordLine, .useOpticalBounds)
    ctx.saveGState()
    ctx.textPosition = CGPoint(
        x: cx - wordBounds.midX,
        y: s * 0.21
    )
    CTLineDraw(wordLine, ctx)
    ctx.restoreGState()

    // Bitcoin glyph (₿) — drawn as text, centered higher to make room for wordmark
    let glyph = "\u{20BF}"  // ₿
    let fontSize = s * 0.42
    let font = NSFont.systemFont(ofSize: fontSize, weight: .heavy)

    // Compose the glyph attributes with gradient fill via shading
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor(cgColor: bitcoinOrange) ?? .orange,
    ]
    let str = NSAttributedString(string: glyph, attributes: attrs)
    let line = CTLineCreateWithAttributedString(str)
    let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)

    let textX = cx - bounds.midX
    let textY = cy - bounds.midY + s * 0.13

    // Draw a soft drop-shadow underneath
    ctx.saveGState()
    ctx.setShadow(
        offset: CGSize(width: 0, height: -s * 0.02),
        blur: s * 0.04,
        color: rgb(0x000000, alpha: 0.55)
    )
    ctx.textPosition = CGPoint(x: textX, y: textY)
    CTLineDraw(line, ctx)
    ctx.restoreGState()

    // Overlay a subtle gradient sheen on top of the glyph by clipping to its path
    if let path = CTLineCreateWithAttributedString(NSAttributedString(string: glyph, attributes: [
        .font: font,
        .foregroundColor: NSColor.white,
    ])) as CTLine? {
        ctx.saveGState()
        let glyphRuns = CTLineGetGlyphRuns(path) as! [CTRun]
        let combined = CGMutablePath()
        for run in glyphRuns {
            let attrs = CTRunGetAttributes(run) as! [String: Any]
            let runFont = attrs[kCTFontAttributeName as String] as! CTFont
            let count = CTRunGetGlyphCount(run)
            var glyphs = [CGGlyph](repeating: 0, count: count)
            var positions = [CGPoint](repeating: .zero, count: count)
            CTRunGetGlyphs(run, CFRangeMake(0, count), &glyphs)
            CTRunGetPositions(run, CFRangeMake(0, count), &positions)
            for i in 0..<count {
                if let p = CTFontCreatePathForGlyph(runFont, glyphs[i], nil) {
                    var t = CGAffineTransform(translationX: textX + positions[i].x, y: textY + positions[i].y)
                    combined.addPath(p, transform: t)
                }
            }
        }
        ctx.addPath(combined)
        ctx.clip()
        let sheen = CGGradient(
            colorsSpace: cs,
            colors: [bitcoinOrangeLight, bitcoinOrange] as CFArray,
            locations: [0.0, 1.0]
        )!
        ctx.drawLinearGradient(
            sheen,
            start: CGPoint(x: 0, y: cy + s * 0.2),
            end: CGPoint(x: 0, y: cy - s * 0.2),
            options: []
        )
        ctx.restoreGState()
    }

    return ctx.makeImage()
}

// MARK: - Save PNGs

func savePNG(_ image: CGImage, to url: URL) throws {
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "icon", code: 1)
    }
    try data.write(to: url)
}

let outDir = URL(fileURLWithPath: "MasonsBudget/MasonsBudget/Resources/Assets.xcassets/AppIcon.appiconset", isDirectory: true)

for (name, px) in sizes {
    guard let img = makeIcon(size: px) else {
        print("✗ Failed to render \(name)")
        continue
    }
    let dest = outDir.appendingPathComponent(name)
    do {
        try savePNG(img, to: dest)
        print("✓ \(name) (\(px)×\(px))")
    } catch {
        print("✗ \(name): \(error)")
    }
}

print("\nDone. Wrote \(sizes.count) icons to \(outDir.path)")
