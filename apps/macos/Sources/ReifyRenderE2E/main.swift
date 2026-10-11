import AppKit
import SwiftUI
import CoreText
import SceneKit
import Vision
import ReifyCloud

// Render the shipping views in hidden AppKit windows. No screen capture, mouse,
// login to production, or replacement UI. Business operations use AppModel.
@main struct RenderE2E {
    @MainActor static func main() async {
        do { try await run() }
        catch { fputs("FAIL: \(error.localizedDescription)\n", stderr); exit(1) }
    }
    @MainActor static func run() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["REIFY_CLOUD_URL"], server.hasPrefix("http://127.0.0.1:"),
              let scope = env["REIFY_SESSION_SCOPE"], scope.hasPrefix("render-e2e-"),
              let preferences = env["REIFY_PREFERENCES_SCOPE"], preferences.hasPrefix("app.reify.render-e2e-") else {
            throw CloudError("Rendering tests require a disposable local server and login scope")
        }
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let font = URL(fileURLWithPath: "Sources/Reify/Resources/Geist.ttf")
        guard CTFontManagerRegisterFontsForURL(font as CFURL, .process, nil) else { throw CloudError("Original Geist font could not be loaded") }
        let output = URL(fileURLWithPath: "test-results/render-e2e", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        AppPreferences.current.removePersistentDomain(forName: preferences)
        defer { AppPreferences.current.removePersistentDomain(forName: preferences) }
        defer { try? SessionStore(scope: scope).clear() }
        let app = AppModel()
        var results: [[String: Any]] = []
        func capture<V: View>(_ name: String, _ content: V, width: CGFloat, height: CGFloat, required: [String], sceneRequired: Bool = false, navigationRequired: Bool = false) async throws {
            let root = content.environmentObject(app).font(ReifyDesign.font(12)).foregroundStyle(ReifyDesign.ink)
                .tint(ReifyDesign.green).preferredColorScheme(.light).frame(width: width, height: height, alignment: .topLeading).background(ReifyDesign.canvas)
            let host = NSHostingView(rootView: root)
            host.frame = NSRect(x: 0, y: 0, width: width, height: height)
            let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = host
            defer { window.close() }
            // Let the real .task handlers load their catalogs over HTTP/WebSocket.
            try await Task.sleep(for: .milliseconds(700))
            for _ in 0..<100 {
                if !app.configWorking && !app.traceLoading && !app.fusionBusy { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            host.layoutSubtreeIfNeeded()
            guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { throw CloudError("No native bitmap for \(name)") }
            host.cacheDisplay(in: host.bounds, to: bitmap)
            guard let png = bitmap.representation(using: .png, properties: [:]) else { throw CloudError("PNG export failed for \(name)") }
            try png.write(to: output.appendingPathComponent(name + ".png"))
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            try VNImageRequestHandler(data: png).perform([request])
            let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            try lines.joined(separator: "\n").write(to: output.appendingPathComponent(name + ".txt"), atomically: true, encoding: .utf8)
            let text = lines.joined().replacingOccurrences(of: " ", with: "")
            let missing = required.filter { !text.contains($0.replacingOccurrences(of: " ", with: "")) }
            let headerLines = (request.results ?? []).filter { $0.boundingBox.minY >= 1 - 58 / height }
                .compactMap { $0.topCandidates(1).first?.string.replacingOccurrences(of: " ", with: "") }
            let missingNavigation = navigationRequired ? ["工作台", "项目", "工作流", "记录", "设置"].filter { title in !headerLines.contains(where: { $0.contains(title) }) } : []
            let scaleX = Double(bitmap.pixelsWide) / Double(width), scaleY = Double(bitmap.pixelsHigh) / Double(height)
            guard abs(scaleX - scaleY) < 0.01, scaleX >= 1 else { throw CloudError("Unexpected native bitmap dimensions for \(name)") }
            var sceneEvidence: [String: Any] = [:]
            if sceneRequired {
                func findScene(_ view: NSView) -> SCNView? {
                    if let scene = view as? SCNView { return scene }
                    for child in view.subviews { if let scene = findScene(child) { return scene } }
                    return nil
                }
                guard let view = findScene(host), let scene = view.scene,
                      let model = scene.rootNode.childNode(withName: "model", recursively: false), !model.childNodes.isEmpty,
                      let tiff = view.snapshot().tiffRepresentation, let rendered = NSBitmapImageRep(data: tiff),
                      let image = rendered.representation(using: .png, properties: [:]) else { throw CloudError("Shipping SceneKit view did not render \(name)") }
                try image.write(to: output.appendingPathComponent(name + "-scene.png"))
                var contrastSamples = 0, backgroundSamples = 0
                for y in stride(from: 0, to: rendered.pixelsHigh, by: max(1, rendered.pixelsHigh / 40)) {
                    for x in stride(from: 0, to: rendered.pixelsWide, by: max(1, rendered.pixelsWide / 40)) {
                        if let color = rendered.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) {
                            let red = abs(color.redComponent - 232.0 / 255), green = abs(color.greenComponent - 230.0 / 255), blue = abs(color.blueComponent - 225.0 / 255)
                            let difference = red + green + blue
                            if difference > 0.15 { contrastSamples += 1 }
                            // SceneKit's output color conversion shifts the pale background slightly.
                            if red < 0.03 && green < 0.03 && blue < 0.03 { backgroundSamples += 1 }
                        }
                    }
                }
                guard contrastSamples > 20, backgroundSamples > 200 else { throw CloudError("Blank or incorrect SceneKit model bitmap for \(name)") }
                sceneEvidence = ["geometryNodes": model.childNodes.count, "contrastSamples": contrastSamples, "backgroundSamples": backgroundSamples,
                                 "pixelsWide": rendered.pixelsWide, "pixelsHigh": rendered.pixelsHigh]
            }
            results.append(["name": name, "width": width, "height": height, "pixelsWide": bitmap.pixelsWide,
                            "pixelsHigh": bitmap.pixelsHigh, "required": required, "missing": missing, "recognized": lines,
                            "missingNavigation": missingNavigation, "headerLines": headerLines, "scene": sceneEvidence])
            try JSONSerialization.data(withJSONObject: ["server": "local protocol fixture", "screens": results,
                "scope": "Native view rendering and fixture-backed AppModel; no mouse, production GLM, Fusion or GPU acceptance"], options: [.prettyPrinted, .sortedKeys])
                .write(to: output.appendingPathComponent("report.json"))
            guard missing.isEmpty else { throw CloudError("Visible text missing in \(name): \(missing.joined(separator: ", "))") }
            guard missingNavigation.isEmpty else { throw CloudError("Navigation clipped or wrapped in \(name): \(missingNavigation.joined(separator: ", "))") }
            print("PASS: \(name) \(Int(width))×\(Int(height)), native bitmap + visible text"); fflush(stdout)
        }
        try await capture("login-minimum", RootView(), width: 920, height: 620, required: ["Reify", "邮箱", "密码", "高级设置"])
        await app.login(email: "e2e@reify.test", password: "fixture-password", server: server)
        guard app.user != nil, app.error == nil, let project = app.projects.first else { throw CloudError(app.error ?? "Test login failed") }
        try await capture("projects-minimum", RootView(), width: 920, height: 620, required: ["云端项目", "桌面支架", "新建项目"], navigationRequired: true)
        await app.open(project)
        guard app.connected, app.engineeringError == nil else { throw CloudError(app.error ?? app.engineeringError ?? "Project connection failed") }
        var settings = app.settingsDraft
        settings.provider = "zai"; settings.model = "glm-5.3-flash"; settings.thinking = "high"
        settings.reviewer = ReviewerSelection(mode: "fixed", provider: "zai", model: "glm-5.3-flash", thinking: "off")
        guard await app.applySettings(settings) else { throw CloudError(app.configError ?? "GLM selection failed") }
        app.settingsPresented = true
        try await capture("settings-minimum", RootView(), width: 920, height: 620, required: ["服务商与账户", "保存设置", "云端账户", "选择云端项目"], navigationRequired: true)
        try await capture("settings-full", SettingsView(), width: 1100, height: 2100, required: ["生成模型", "独立审查模型", "GLM", "收藏模型", "自定义服务商", "CAD导出", "Autodesk Fusion", "校验并保存", "版本"])
        guard app.catalog.model(provider: "zai", id: "glm-5.3-flash")?.available == true, app.model == settings.model,
              app.reviewer == settings.reviewer, app.configError == nil else { throw CloudError("Rendering changed settings or lost catalog") }
        app.settingsPresented = false
        app.draft = "离屏验收：保留草稿"
        try await capture("workbench-minimum", RootView(), width: 920, height: 620, required: ["Reify", "离屏验收", "给当前对话评分"], navigationRequired: true)
        try await capture("workbench-default", RootView(), width: 1320, height: 850, required: ["离屏验收", "给当前对话评分"], navigationRequired: true)
        app.canvasMode = true
        try await capture("canvas-minimum", RootView(), width: 920, height: 620, required: ["离屏验收", "当前模型"], navigationRequired: true)
        guard app.draft == "离屏验收：保留草稿" else { throw CloudError("Rendering lost the draft") }
        let mesh = try await app.bridge.previewStep("bracket.step")
        try await capture("model-preview", ModelPreview(data: mesh), width: 920, height: 620,
                          required: ["复位", "拖动旋转", "装配", "显示全部"], sceneRequired: true)
        if let path = env["REIFY_ACCEPTANCE_STL"], let expected = env["REIFY_ACCEPTANCE_SHA256"] {
            guard URL(fileURLWithPath: path).pathExtension.lowercased() == "stl", expected.count == 64 else { throw CloudError("An STL file with its recorded SHA-256 is required") }
            let bytes = try Data(contentsOf: URL(fileURLWithPath: path))
            guard WorkspaceBridge.hash(bytes) == expected else { throw CloudError("Saved real-cloud artifact SHA-256 changed") }
            let model = try MeshModel.read(bytes)
            let coordinates = model.parts.flatMap(\.positions)
            let dimensions = (0..<3).map { axis -> Float in
                let values = stride(from: axis, to: coordinates.count, by: 3).map { coordinates[$0] }
                return values.max()! - values.min()!
            }
            if let expectedDimensions = env["REIFY_ACCEPTANCE_DIMENSIONS"] {
                let values = expectedDimensions.split(separator: ",").compactMap { Float($0) }
                guard values.count == 3, zip(values, dimensions).allSatisfy({ abs($0 - $1) < 0.001 }) else { throw CloudError("Saved real-cloud artifact dimensions changed") }
            }
            try await capture("saved-real-cloud-model", ModelPreview(data: bytes), width: 920, height: 620,
                              required: ["复位", "STL模型", "显示全部"], sceneRequired: true)
            try JSONSerialization.data(withJSONObject: ["source": path, "sha256": expected, "dimensions": dimensions.map(Double.init),
                "triangles": model.parts.reduce(0) { $0 + $1.indices.count / 3 },
                "scope": "Latest native client renders a previously downloaded real-cloud GLM artifact; no new authenticated cloud request"], options: [.prettyPrinted, .sortedKeys])
                .write(to: output.appendingPathComponent("saved-real-cloud-model.json"))
        }
        try await capture("analysis-form", SimulationView(expanded: true).padding(24).background(ReifyDesign.paper), width: 520, height: 720,
                          required: ["结构分析", "弹性模量", "泊松比", "网格尺寸", "重新检查组件", "确认并运行", "MPa"])
        try await capture("engineering-results", EngineeringResultsView().padding(24).background(ReifyDesign.paper), width: 520, height: 1200,
                          required: ["工程结果", "结果分类", "结构分析"])
        app.canvasMode = false; app.workflowsPresented = true
        try await capture("workflows-minimum", RootView(), width: 920, height: 620, required: ["工作流", "重新读取"], navigationRequired: true)
        app.workflowsPresented = false; app.tracesPresented = true
        try await capture("traces-minimum", RootView(), width: 920, height: 620, required: ["记录与经验", "选择记录", "保存评分"], navigationRequired: true)
        await app.shutdown()
        try await app.api.logout()
        try JSONSerialization.data(withJSONObject: ["server": "local protocol fixture", "screens": results, "completed": true,
            "scope": "Native view rendering and fixture-backed AppModel; no mouse, production GLM, Fusion or GPU acceptance"], options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("report.json"))
        print("PASS: native rendering acceptance finished; test session cleared")
    }
}
