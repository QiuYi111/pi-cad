import Foundation
import ReifyCloud

extension AppModel {
    func clearRebuild() { rebuildSequence += 1; rebuildBusy = false; rebuildError = nil; rebuildResult = nil }
    func rebuildManifest(for commit: EngineeringCommit) -> StoredParameterManifest? {
        let candidates = engineeringCatalog?.parameterManifests ?? []
        return candidates.first { record in record.path.hasPrefix("@commit/\(commit.id)/") && commit.artifacts.contains { $0.path == record.manifest.output.path && $0.sha256 == record.manifest.output.sha256 } }
            ?? candidates.first { record in commit.artifacts.contains { $0.path == record.manifest.output.path && $0.sha256 == record.manifest.output.sha256 } }
    }
    func rebuildVersion(_ commit: EngineeringCommit) async {
        guard connected, !rebuildBusy, !generating, selected?.role != "viewer", permission != "read-only" else { return }
        guard let manifest = rebuildManifest(for: commit) else { rebuildError = "此版本没有保存参数记录"; return }
        let current = generation, scope = sessionID
        rebuildSequence += 1; let sequence = rebuildSequence
        rebuildBusy = true; rebuildError = nil; rebuildResult = nil
        defer { if current == generation && scope == sessionID && rebuildSequence == sequence { rebuildBusy = false } }
        do {
            let result = try await engineering.rebuild(commit, manifest: manifest)
            guard current == generation && scope == sessionID && rebuildSequence == sequence else { return }
            rebuildResult = result
        } catch { if current == generation && scope == sessionID && rebuildSequence == sequence { rebuildError = error.localizedDescription } }
    }
    func showRebuiltVersion() async {
        guard let result = rebuildResult, !rebuildBusy else { return }
        let data: [String: Any] = ["id": "rebuild-" + result.commitId, "path": result.output, "role": "source-rebuild", "sha256": result.actualSha256]
        do { await showArtifact(try JSONDecoder().decode(EngineeringArtifact.self, from: JSONSerialization.data(withJSONObject: data))) }
        catch { rebuildError = error.localizedDescription }
    }
}
