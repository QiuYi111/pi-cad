import Foundation
import ReifyCloud

extension AppModel {
    var selectedParameters: StoredParameterManifest? {
        guard let artifact = selectedArtifact, selectedCommitID == nil else { return nil }
        return engineeringCatalog?.parameterManifests.first { !$0.path.hasPrefix("@commit/") && $0.manifest.output.sha256 == artifact.sha256 && $0.manifest.output.path == artifact.path }
    }
    func restoreParameterPreview() {
        if let saved = parameterOriginal { preview = saved.0; previewName = saved.1; selectedArtifact = saved.2 }
        parameterOriginal = nil; parameterPreviewActive = false
    }
    func previewParameters(_ manifest: StoredParameterManifest, values: [String: JSONValue]) async {
        guard connected, !parameterBusy, !generating else { return }
        let current = generation, selectedSHA = selectedArtifact?.sha256
        parameterBusy = true; parameterError = nil
        defer { if current == generation { parameterBusy = false } }
        do {
            let next = try await engineering.previewParameters(manifest, updates: values)
            guard current == generation, selectedArtifact?.sha256 == selectedSHA else { return }
            if parameterOriginal == nil { parameterOriginal = (preview, previewName, selectedArtifact) }
            preview = next; parameterPreviewActive = true
        } catch { if current == generation { parameterError = error.localizedDescription } }
    }
    func applyParameters(_ manifest: StoredParameterManifest, values: [String: JSONValue]) async {
        guard connected, !parameterBusy, !generating, selected?.role != "viewer", permission != "read-only" else { return }
        let current = generation
        parameterBusy = true; parameterError = nil
        defer { if current == generation { parameterBusy = false } }
        do {
            try await engineering.applyParameters(manifest, updates: values)
            guard current == generation else { return }
            restoreParameterPreview(); await refreshEngineering()
            guard current == generation else { return }
            if let output = engineeringArtifacts.first(where: { $0.path == manifest.manifest.output.path }) { await showArtifact(output) }
            else { throw CloudError("参数已应用，但新结果尚未读取，请重新读取工程结果") }
        } catch { if current == generation { restoreParameterPreview(); parameterError = error.localizedDescription } }
    }
}
