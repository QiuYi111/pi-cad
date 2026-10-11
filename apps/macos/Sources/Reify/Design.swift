import SwiftUI
import CoreText

// Colors and geometry from desktop Brand.tsx and the final styles.css overrides.
enum ReifyDesign {
    static func color(_ hex: UInt32) -> Color { Color(nsColor: nsColor(hex)) }
    static func nsColor(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255,
                blue: CGFloat(hex & 255) / 255, alpha: 1)
    }
    static let canvas = color(0xe8e6e1), paper = color(0xf8f6f1), panel = color(0xeeece6)
    static let ink = color(0x293029), muted = color(0x747a73), line = color(0xd4d1ca)
    static let green = color(0x2f6b55), darkGreen = color(0x26342b)
    static func font(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("Geist-Regular", size: size).weight(weight)
    }
    static func registerFont() {
        #if SWIFT_PACKAGE
        let url = Bundle.module.url(forResource: "Geist", withExtension: "ttf", subdirectory: "Resources")
        #else
        let url = Bundle.main.url(forResource: "Geist", withExtension: "ttf")
        #endif
        if let url {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}

struct ReifyMark: View {
    var size: CGFloat = 20
    var body: some View {
        ZStack {
            BrandPath(lower: false).fill(ReifyDesign.darkGreen)
            BrandPath(lower: true).fill(ReifyDesign.darkGreen.opacity(0.68))
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

private struct BrandPath: Shape {
    let lower: Bool
    func path(in rect: CGRect) -> Path {
        var p = Path()
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
        if lower {
            p.move(to: point(17.4, 27.3))
            p.addCurve(to: point(13.2, 29), control1: point(15.8, 27.3), control2: point(14.3, 28))
            p.addLine(to: point(8.6, 33.5))
            p.addCurve(to: point(4, 44.6), control1: point(5.6, 36.4), control2: point(4, 40.3))
            p.addLine(to: point(4, 48.5))
            p.addCurve(to: point(16, 60), control1: point(4, 54.9), control2: point(9.4, 60))
            p.addLine(to: point(59.2, 60))
            p.addCurve(to: point(59.2, 57.3), control1: point(59.7, 59.2), control2: point(59.7, 58.2))
            p.addLine(to: point(23.4, 28))
            p.addCurve(to: point(17.4, 27.3), control1: point(21.5, 27.3), control2: point(19.4, 27.1))
        } else {
            p.move(to: point(6.3, 4))
            p.addCurve(to: point(5.5, 7.3), control1: point(5.6, 4.7), control2: point(5.1, 6.3))
            p.addLine(to: point(42.8, 37.3))
            p.addCurve(to: point(50.3, 37.3), control1: point(45.5, 38.4), control2: point(48.2, 38))
            p.addCurve(to: point(60, 23.8), control1: point(56.3, 34.8), control2: point(60, 29.5))
            p.addLine(to: point(60, 18.1))
            p.addCurve(to: point(45.7, 4), control1: point(60, 10.3), control2: point(53.7, 4))
            p.addLine(to: point(6.3, 4))
        }
        p.closeSubpath()
        return p.applying(CGAffineTransform(scaleX: rect.width / 64, y: rect.height / 64))
    }
}

struct ReifyWordmark: View {
    var body: some View {
        HStack(spacing: 8) {
            ReifyMark()
            Text("Reify").font(ReifyDesign.font(15, .medium))
            Text("器成").font(.system(size: 12)).foregroundStyle(ReifyDesign.muted)
        }.accessibilityElement(children: .combine).accessibilityLabel("Reify · 器成")
    }
}

struct ReifyButtonStyle: ButtonStyle {
    var primary = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.padding(.horizontal, 12).padding(.vertical, 8)
            .foregroundStyle(primary ? .white : ReifyDesign.ink)
            .background(primary ? ReifyDesign.green : ReifyDesign.panel, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(primary ? ReifyDesign.green : ReifyDesign.line))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
