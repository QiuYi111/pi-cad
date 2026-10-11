import AppKit
// Resize the existing desktop icon. Do not replace or redraw the brand.
let source = CommandLine.arguments[1]
let folder = CommandLine.arguments[2]
guard let original = NSImage(contentsOfFile: source) else { fatalError("Missing desktop icon: \(source)") }
try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        original.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: folder).appendingPathComponent(name))
    }
}
