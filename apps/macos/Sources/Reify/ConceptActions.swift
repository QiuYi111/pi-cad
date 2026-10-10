import SwiftUI
import AppKit
import UniformTypeIdentifiers
import ReifyCloud

extension ChatMedia {
    var inlineImage: Data? {
        guard mimeType.hasPrefix("image/"), let url = dataUrl, url.hasPrefix("data:\(mimeType);base64,"), url.count <= 12 * 1024 * 1024,
              let comma = url.firstIndex(of: ","), let data = Data(base64Encoded: String(url[url.index(after: comma)...])), data.count <= 8 * 1024 * 1024 else { return nil }
        return data
    }
}
struct ConceptDirection: Identifiable {
    let id: String
    let label: String
    let origin: String
    let mimeType: String
    let data: Data
    let sha256: String
    @MainActor init(id: String, label: String, origin: String, mimeType: String, data: Data) {
        self.id = id; self.label = label; self.origin = origin; self.mimeType = mimeType; self.data = data
        self.sha256 = WorkspaceBridge.hash(data)
    }
}
struct ConceptRegion: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    var valid: Bool {
        [x, y, width, height].allSatisfy(\.isFinite) && x >= 0 && y >= 0 && width > 0.01 && height > 0.01 && x + width <= 1.000001 && y + height <= 1.000001
    }
    var reference: String { String(format: "Selected normalized region x=%.3f, y=%.3f, width=%.3f, height=%.3f.", x, y, width, height) }
}
struct ConceptAnnotation: Codable, Equatable {
    var note = ""
    var region: ConceptRegion?
    var outdated = false
}

extension AppModel {
    var hasSelectedText: Bool { ((NSApp?.keyWindow?.firstResponder as? NSTextView)?.selectedRange().length ?? 0) > 0 }
    func showConcept(_ id: String) {
        guard conceptImages.contains(where: { $0.id == id }) else { error = "概念图已变化，请重新选择"; return }
        selectedConceptID = id; canvasContent = "concept"; canvasMode = true; newConceptID = nil; saveLayout()
    }
    func offerGeneratedConcept(previous: Set<String>) {
        guard let next = conceptImages.last(where: { $0.origin == "generated" && !previous.contains($0.id) }) else { return }
        if canvasMode {
            if canvasContent != "concept" { newConceptID = next.id }
        } else if draft.isEmpty && attachments.isEmpty && !readingHistory && !hasSelectedText { showConcept(next.id) }
        else { newConceptID = next.id }
    }
    var conceptKey: String { "\(WorkspaceBridge.hash(Data(api.baseURL.utf8))).\(conversationKey)" }
    var conceptImages: [ConceptDirection] {
        var seen = Set<String>()
        let generated = messages.flatMap { message -> [ConceptDirection] in
            guard let activity = message.activity, activity.kind == "image", activity.state == "success" else { return [] }
            return (activity.media ?? []).compactMap { media in
                guard let data = media.inlineImage, NSImage(data: data) != nil else { return nil }
                return ConceptDirection(id: "tool:\(activity.id):\(media.id):\(WorkspaceBridge.hash(data))", label: media.label ?? media.role, origin: "generated", mimeType: media.mimeType, data: data)
            }
        }
        return ((conceptsByConversation[conceptKey] ?? []) + generated).filter { seen.insert($0.id).inserted }
    }
    func restoreConceptAnnotations() {
        conceptAnnotations = AppPreferences.current.data(forKey: "\(conceptKey).concept-annotations").flatMap { try? JSONDecoder().decode([String: ConceptAnnotation].self, from: $0) } ?? [:]
    }
    func setConceptAnnotation(_ annotation: ConceptAnnotation, id: String) {
        guard conceptImages.contains(where: { $0.id == id }) else { return }
        conceptAnnotations[id] = annotation
        AppPreferences.current.set(try? JSONEncoder().encode(conceptAnnotations), forKey: "\(conceptKey).concept-annotations")
    }
    func addConcept(_ data: Data, name: String, mimeType: String, id: String? = nil, origin: String = "uploaded") throws {
        guard data.count <= 8 * 1024 * 1024, mimeType.hasPrefix("image/"), NSImage(data: data) != nil else { throw CloudError("图片无法读取，单张最多 8 MB") }
        let image = ConceptDirection(id: id ?? UUID().uuidString, label: name, origin: origin, mimeType: mimeType, data: data)
        if !conceptImages.contains(where: { $0.id == image.id }) { conceptsByConversation[conceptKey, default: []].append(image) }
        canvasContent = "concept"; canvasMode = true; selectedConceptID = image.id; saveLayout()
    }
    func importConcepts() async {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.image]; panel.allowsMultipleSelection = true; panel.canChooseDirectories = false; panel.title = "导入概念图"
        guard panel.runModal() == .OK else { return }
        do {
            for url in panel.urls {
                guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 8 * 1024 * 1024 else { throw CloudError("单张图片最多 8 MB") }
                let mime = try url.resourceValues(forKeys: [.contentTypeKey]).contentType?.preferredMIMEType ?? "image/png"
                try addConcept(Data(contentsOf: url), name: url.lastPathComponent, mimeType: mime)
            }
        } catch { fail(error) }
    }
    func openToolImage(_ activity: ChatActivity, media: ChatMedia) async {
        let current = generation, scope = sessionID
        do {
            let bytes: Data
            if let inline = media.inlineImage { bytes = inline }
            else if let path = media.path { bytes = try await bridge.download(bridge.relativeProjectPath(path)) }
            else { throw CloudError("图片没有可读取的内容") }
            guard current == generation && scope == sessionID else { return }
            let id = "tool:\(activity.id):\(media.id):\(WorkspaceBridge.hash(bytes))"
            try addConcept(bytes, name: media.label ?? media.role, mimeType: media.mimeType, id: id, origin: "generated")
        } catch { if current == generation && scope == sessionID { fail(error) } }
    }
    func continueConcept(_ image: ConceptDirection) async {
        guard connected, !generating, !busy, !conceptBusy, selected?.role != "viewer", permission != "read-only" else { return }
        guard let version = conceptImages.firstIndex(where: { $0.id == image.id && $0.sha256 == image.sha256 }) else { error = "概念图已变化，请重新选择"; return }
        let annotation = conceptAnnotations[image.id] ?? ConceptAnnotation()
        guard !annotation.outdated else { error = "此概念图已标记过期"; return }
        guard annotation.region?.valid ?? true else { error = "框选区域无效，请重新选择"; return }
        guard catalog.model(provider: provider, id: model)?.input?.contains("image") != false else { error = "当前模型不支持图片，请先切换模型"; return }
        let current = generation, scope = sessionID
        conceptBusy = true; error = nil
        defer { if current == generation && scope == sessionID { conceptBusy = false } }
        do {
            let name = image.label.replacingOccurrences(of: "[^A-Za-z0-9._-]+", with: "_", options: .regularExpression).replacingOccurrences(of: "^\\.+", with: "", options: .regularExpression)
            let remote = ".reify/uploads/\(image.sha256.prefix(16))-\(name.isEmpty ? "concept.png" : name)"
            try await bridge.upload(image.data, name: remote)
            guard current == generation && scope == sessionID else { return }
            let region = annotation.region?.reference ?? "Use the full image."
            let note = annotation.note.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = "Continue the design from concept V\(version + 1) (\(image.label)); imageId=\(image.id); imageSHA256=\(image.sha256). \(region)\(note.isEmpty ? "" : " Design note: " + note) Preserve this exact image/version and region reference in the design rationale."
            selectedConceptID = image.id
            await send(text, images: [ImageAttachment(id: image.id, name: image.label, data: image.data, mimeType: image.mimeType, remotePath: remote)])
        } catch { if current == generation && scope == sessionID { fail(error) } }
    }
    var successfulChecks: Int { messages.filter { $0.activity?.state == "success" && ["probe", "review", "simulation"].contains($0.activity?.kind ?? "") }.count }
    var latestEngineeringIssue: ChatActivity? { messages.reversed().compactMap(\.activity).first { ["failed", "denied"].contains($0.state) } }
    var machineReviewSummary: String {
        let build = messages.lastIndex { $0.activity?.kind == "build" && $0.activity?.state == "success" }
        let review = messages.lastIndex { $0.activity?.kind == "review" && $0.activity?.state == "success" }
        if let review, build.map({ review > $0 }) ?? true { return "最新制作之后有机器审查记录" }
        return "最新制作之后尚无机器审查记录"
    }
}
