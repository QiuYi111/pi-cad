import SwiftUI
import AppKit

/// Wheel and navigation keys pause following while the reader moves upward.
/// Layout changes and streamed text do not count as reader input.
struct ReadingPosition: NSViewRepresentable {
    @Binding var followsBottom: Bool
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        context.coordinator.view = view
        context.coordinator.install()
        return view
    }
    func updateNSView(_ view: NSView, context: Context) { context.coordinator.parent = self }
    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { coordinator.remove() }
    final class Coordinator {
        var parent: ReadingPosition
        weak var view: NSView?
        var monitor: Any?
        init(_ parent: ReadingPosition) { self.parent = parent }
        func install() {
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .keyDown, .leftMouseDragged]) { [weak self] event in
                guard let self, let scroll = self.view?.enclosingScrollView, event.window === scroll.window else { return event }
                let point = scroll.convert(event.locationInWindow, from: nil)
                let key = event.type == .keyDown && ([115, 116, 119, 121, 125, 126].contains(Int(event.keyCode)) || event.keyCode == 49)
                let responder = scroll.window?.firstResponder as? NSView
                let navigation = key && responder?.isDescendant(of: scroll) == true && !(responder is NSTextView)
                guard navigation || scroll.bounds.contains(point) else { return event }
                if event.type == .keyDown && !navigation { return event }
                self.parent.followsBottom = false
                DispatchQueue.main.async { [weak self, weak scroll] in
                    guard let self, let scroll, let document = scroll.documentView else { return }
                    let visible = scroll.contentView.bounds
                    self.parent.followsBottom = document.bounds.height - visible.maxY < 40
                }
                return event
            }
        }
        func remove() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
        deinit { remove() }
    }
}
