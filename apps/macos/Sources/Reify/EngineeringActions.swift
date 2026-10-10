import Foundation
import AppKit
import UniformTypeIdentifiers
import ReifyCloud

extension EngineeringArtifact {
    var isModel: Bool { ["step", "stp", "stl"].contains((path as NSString).pathExtension.lowercased()) }
    var revisionKey: String { "\((path as NSString).pathExtension.lowercased()):\(sha256)" }
}
struct ParameterDifference: Identifiable {
    let id: String
    let label: String
    let before: String
    let after: String
}

extension AppModel {
    var engineering: EngineeringService { EngineeringService(bridge: bridge, sessionID: sessionID) }
    func clearEngineering(preserveViewer: Bool = false) {
        clearTraces()
        restoreParameterPreview()
        parameterBusy = false; parameterError = nil
        engineeringSequence += 1; previewSequence += 1
        engineeringError = nil; engineeringLoading = false
        guard !preserveViewer else { return }
        clearApprovals()
        clearRebuild()
        workflowRun = nil; engineeringCatalog = nil
        selectedCommitID = nil; selectedArtifact = nil
        closeComparison(); newResult = nil; previewPinned = false; readingHistory = false
        artifactFilter = "全部"; includesHistoricalArtifacts = false; canvasContent = "model"; newConceptID = nil
    }
    func refreshEngineering(offerNewResult: Bool = false) async {
        guard connected else { return }
        let current = generation, scope = sessionID
        let previous = Set((engineeringCatalog?.currentRun?.artifacts ?? []).filter(\.isModel).map(\.revisionKey))
        engineeringSequence += 1; let sequence = engineeringSequence
        engineeringLoading = true; engineeringError = nil
        defer { if current == generation && scope == sessionID && sequence == engineeringSequence { engineeringLoading = false } }
        do {
            let service = engineering
            async let run = service.workflow()
            async let catalog = service.catalog()
            let snapshot = try await (run, catalog)
            guard current == generation && scope == sessionID && sequence == engineeringSequence else { return }
            workflowRun = snapshot.0; engineeringCatalog = snapshot.1
            await refreshApprovals()
            guard current == generation && scope == sessionID && sequence == engineeringSequence else { return }
            if let selectedCommitID, !snapshot.1.commits.contains(where: { $0.id == selectedCommitID }) { self.selectedCommitID = nil; selectedArtifact = nil }
            if offerNewResult, let next = snapshot.1.currentRun?.artifacts.first(where: { $0.isModel && !previous.contains($0.revisionKey) }) {
                newResult = next
                if (canvasContent != "concept" || !canvasMode) && draft.isEmpty && attachments.isEmpty && !readingHistory && !hasSelectedText && !previewPinned && selectedCommitID == nil && comparisonArtifact == nil && !parameterBusy && !parameterPreviewActive {
                    await showArtifact(next, pin: false)
                }
            }
        } catch { if current == generation && scope == sessionID && sequence == engineeringSequence { engineeringError = error.localizedDescription } }
    }
    var allEngineeringArtifacts: [EngineeringArtifact] {
        guard let catalog = engineeringCatalog else { return [] }
        let candidates: [EngineeringArtifact]
        if let selectedCommitID { candidates = catalog.commits.first(where: { $0.id == selectedCommitID })?.artifacts ?? [] }
        else { candidates = (catalog.currentRun?.artifacts ?? []) + catalog.projectHead.artifacts + (includesHistoricalArtifacts ? catalog.commits.flatMap(\.artifacts) : []) }
        var seen = Set<String>()
        return candidates.filter { seen.insert($0.revisionKey).inserted }
    }
    var engineeringArtifacts: [EngineeringArtifact] {
        allEngineeringArtifacts.filter { artifactFilter == "全部" || (artifactFilter == "模型" ? $0.isModel : !$0.isModel) }
    }
    var comparisonChoices: [EngineeringArtifact] {
        guard let catalog = engineeringCatalog else { return [] }
        var seen = Set<String>()
        return ((catalog.currentRun?.artifacts ?? []) + catalog.projectHead.artifacts + catalog.commits.flatMap(\.artifacts))
            .filter { $0.isModel && $0.revisionKey != selectedArtifact?.revisionKey && seen.insert($0.revisionKey).inserted }
    }
    func selectVersion(_ id: String?) {
        clearRebuild()
        restoreParameterPreview(); previewSequence += 1; closeComparison()
        selectedCommitID = id; selectedArtifact = nil; preview = nil; previewName = ""; previewPinned = id != nil
    }
    func verifiedMesh(_ artifact: EngineeringArtifact) async throws -> Data {
        let path = try bridge.relativeProjectPath(artifact.path)
        guard artifact.isModel else { throw CloudError("此结果不是可预览的模型，请下载查看") }
        let bytes = try await bridge.download(path)
        guard WorkspaceBridge.hash(bytes) == artifact.sha256 else { throw CloudError("文件已变化，不能作为此版本预览") }
        let mesh = ["step", "stp"].contains((path as NSString).pathExtension.lowercased()) ? try await bridge.previewStep(path, expectedSHA: artifact.sha256) : bytes
        _ = try MeshModel.read(mesh)
        return mesh
    }
    func showArtifact(_ artifact: EngineeringArtifact, pin: Bool = true) async {
        let current = generation, scope = sessionID
        previewSequence += 1; let sequence = previewSequence
        if pin { previewPinned = true }
        error = nil
        do {
            let mesh = try await verifiedMesh(artifact)
            guard current == generation && scope == sessionID && sequence == previewSequence else { return }
            closeComparison()
            preview = mesh; previewName = (artifact.path as NSString).lastPathComponent; selectedArtifact = artifact
            parameterPreviewActive = false; parameterOriginal = nil
            if newResult?.revisionKey == artifact.revisionKey { newResult = nil }
            canvasContent = "model"; canvasMode = true; filesOpen = false; saveLayout()
        } catch { if current == generation && scope == sessionID && sequence == previewSequence { fail(error) } }
    }
    func closeComparison() {
        comparisonSequence += 1; comparisonArtifact = nil; comparisonPreview = nil; comparisonError = nil; comparisonLoading = false
    }
    func compareArtifact(_ artifact: EngineeringArtifact) async {
        guard let primary = selectedArtifact, preview != nil, !parameterPreviewActive else { return }
        comparisonSequence += 1; let sequence = comparisonSequence
        let current = generation, scope = sessionID
        previewPinned = true; comparisonLoading = true; comparisonError = nil
        defer { if sequence == comparisonSequence { comparisonLoading = false } }
        do {
            let mesh = try await verifiedMesh(artifact)
            guard current == generation && scope == sessionID && sequence == comparisonSequence && primary.revisionKey == selectedArtifact?.revisionKey else { return }
            comparisonArtifact = artifact; comparisonPreview = mesh; comparisonReset += 1
        } catch { if current == generation && scope == sessionID && sequence == comparisonSequence { comparisonError = error.localizedDescription } }
    }
    func parameterRecord(for artifact: EngineeringArtifact) -> StoredParameterManifest? {
        engineeringCatalog?.parameterManifests.first { $0.manifest.output.path == artifact.path && $0.manifest.output.sha256 == artifact.sha256 }
    }
    var parameterDifferences: [ParameterDifference] {
        guard let primary = selectedArtifact, let other = comparisonArtifact,
              let left = parameterRecord(for: primary), let right = parameterRecord(for: other) else { return [] }
        func text(_ value: JSONValue?) -> String {
            guard let value else { return "未记录" }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "未记录"
        }
        let a = left.manifest.parameters, b = right.manifest.parameters
        return Set(a.map(\.id) + b.map(\.id)).sorted().compactMap { id in
            let first = a.first { $0.id == id }, second = b.first { $0.id == id }
            guard first?.value != second?.value else { return nil }
            return ParameterDifference(id: id, label: first?.label ?? second?.label ?? id, before: text(first?.value), after: text(second?.value))
        }
    }
    func cachedArtifact(_ artifact: EngineeringArtifact) async throws -> URL {
        let current = generation, scope = sessionID
        let path = try bridge.relativeProjectPath(artifact.path)
        let bytes = try await bridge.download(path)
        guard WorkspaceBridge.hash(bytes) == artifact.sha256 else { throw CloudError("文件已变化，请重新读取工程结果") }
        guard current == generation && scope == sessionID else { throw CancellationError() }
        let key = WorkspaceBridge.hash(Data("\(api.baseURL)/\(user?.id ?? "")/\(selected?.id ?? "")".utf8))
        let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("app.reify.mac/\(key)/\(artifact.sha256)", isDirectory: true)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        let destination = cache.appendingPathComponent((path as NSString).lastPathComponent)
        try bytes.write(to: destination, options: .atomic)
        return destination
    }
    func revealArtifact(_ artifact: EngineeringArtifact) async {
        do { NSWorkspace.shared.activateFileViewerSelecting([try await cachedArtifact(artifact)]) } catch { fail(error) }
    }
    func exportArtifact(_ artifact: EngineeringArtifact) async {
        do { save(try Data(contentsOf: await cachedArtifact(artifact)), name: (artifact.path as NSString).lastPathComponent) } catch { fail(error) }
    }
    func currentModelExportData() async throws -> (data: Data, name: String) {
        guard let displayed = preview else { throw CloudError("请先打开模型") }
        let current = generation, scope = sessionID
        let mesh = try MeshModel.read(displayed)
        if let source = mesh.source, let expected = mesh.sha256 {
            let path = try bridge.relativeProjectPath(source)
            let bytes = try await bridge.download(path)
            guard WorkspaceBridge.hash(bytes) == expected else { throw CloudError("所看模型的文件已变化，未导出新版本") }
            guard generation == current && sessionID == scope && preview == displayed else { throw CancellationError() }
            return (bytes, (path as NSString).lastPathComponent)
        }
        // STL is already the exact downloaded model shown by SceneKit.
        guard (previewName as NSString).pathExtension.lowercased() == "stl" else { throw CloudError("当前预览缺少文件版本，无法导出") }
        return (displayed, (previewName as NSString).lastPathComponent)
    }
    func exportCurrentModel() async {
        do { let file = try await currentModelExportData(); save(file.data, name: file.name) } catch { fail(error) }
    }
    func importStep() async {
        guard connected, selected?.role != "viewer", permission != "read-only" else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false; panel.title = "导入 STEP"
        panel.allowedContentTypes = [UTType(filenameExtension: "step"), UTType(filenameExtension: "stp")].compactMap { $0 }
        if panel.runModal() == .OK, let url = panel.url {
            do {
                guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 64 * 1024 * 1024 else { throw CloudError("文件超过 64 MB") }
                await importStep(try Data(contentsOf: url), fileName: url.lastPathComponent)
            } catch { fail(error) }
        }
    }
    func importStep(_ bytes: Data, fileName: String) async {
        guard connected, selected?.role != "viewer", permission != "read-only" else { error = "当前项目没有写入权限"; return }
        let current = generation, scope = sessionID
        previewSequence += 1; let sequence = previewSequence
        previewPinned = true; error = nil
        do {
            let result = try await bridge.importStep(bytes, fileName: fileName)
            let mesh = try await bridge.previewStep(result.path, expectedSHA: result.sha256)
            _ = try MeshModel.read(mesh)
            let nextFiles = try await bridge.files()
            guard current == generation && scope == sessionID && sequence == previewSequence else { return }
            closeComparison(); preview = mesh; previewName = result.name; selectedArtifact = nil
            parameterPreviewActive = false; parameterOriginal = nil; files = nextFiles
            canvasContent = "model"; canvasMode = true; filesOpen = false; saveLayout()
        } catch { if current == generation && scope == sessionID && sequence == previewSequence { fail(error) } }
    }
}
