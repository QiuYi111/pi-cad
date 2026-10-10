import Foundation
import ReifyCloud

extension AppModel {
    var engineering: EngineeringService { EngineeringService(bridge: bridge, sessionID: sessionID) }
    func clearEngineering() {
        engineeringSequence += 1
        workflowRun = nil; engineeringCatalog = nil; engineeringError = nil; engineeringLoading = false
        selectedCommitID = nil; selectedArtifact = nil
    }
    func refreshEngineering() async {
        guard connected else { return }
        let current = generation, scope = sessionID
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
            if let selectedCommitID, !snapshot.1.commits.contains(where: { $0.id == selectedCommitID }) { self.selectedCommitID = nil; selectedArtifact = nil }
        } catch { if current == generation && scope == sessionID && sequence == engineeringSequence { engineeringError = error.localizedDescription } }
    }
    var engineeringArtifacts: [EngineeringArtifact] {
        guard let catalog = engineeringCatalog else { return [] }
        if let selectedCommitID { return catalog.commits.first(where: { $0.id == selectedCommitID })?.artifacts ?? [] }
        return catalog.currentRun?.artifacts ?? catalog.projectHead.artifacts
    }
    func showArtifact(_ artifact: EngineeringArtifact) async {
        let current = generation, scope = sessionID
        error = nil
        do {
            let path = try bridge.relativeProjectPath(artifact.path)
            let bytes = try await bridge.download(path)
            guard WorkspaceBridge.hash(bytes) == artifact.sha256 else { throw CloudError("文件已变化，请重新读取工程结果") }
            let ext = (path as NSString).pathExtension.lowercased()
            let mesh = ["step", "stp"].contains(ext) ? try await bridge.previewStep(path, expectedSHA: artifact.sha256) : bytes
            guard current == generation && scope == sessionID else { return }
            guard ["step", "stp", "stl"].contains(ext) else { throw CloudError("此结果不是可预览的模型，请下载查看") }
            preview = mesh; previewName = (path as NSString).lastPathComponent; selectedArtifact = artifact
            canvasMode = true; filesOpen = false; saveLayout()
        } catch { if current == generation && scope == sessionID { fail(error) } }
    }
    func exportArtifact(_ artifact: EngineeringArtifact) async {
        do {
            let path = try bridge.relativeProjectPath(artifact.path)
            let bytes = try await bridge.download(path)
            guard WorkspaceBridge.hash(bytes) == artifact.sha256 else { throw CloudError("文件已变化，请重新读取工程结果") }
            save(bytes, name: (path as NSString).lastPathComponent)
        } catch { fail(error) }
    }
}
