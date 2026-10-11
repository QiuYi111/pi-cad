import Foundation
import ReifyCloud

extension AppModel {
    func refreshPublishPolicy() { publishPolicy = DesktopPublishPolicy.read(server: api.baseURL) }
    func clearPublication() { savedRelease = nil; savedReleaseApproval = nil; publishSequence += 1; publishBusy = false; publishError = nil; publishedTag = nil }
    func publishRelease(remote: String, tag: String) async {
        guard connected, !publishBusy, !releaseBusy, !generating, selected?.role != "viewer", permission != "read-only", let release = savedRelease, let local = releaseURL, let approval = savedReleaseApproval else { return }
        refreshPublishPolicy()
        guard publishPolicy.enabled else { publishError = publishPolicy.message; return }
        guard publishPolicy.allowedRemotes.contains(remote.trimmingCharacters(in: .whitespacesAndNewlines)) else { publishError = "管理员未允许此远程仓库"; return }
        let current = generation, scope = sessionID
        publishSequence += 1; let sequence = publishSequence
        publishBusy = true; publishError = nil; publishedTag = nil
        defer { if generation == current && sessionID == scope && publishSequence == sequence { publishBusy = false } }
        do {
            let manifest = try Data(contentsOf: local.appendingPathComponent("release-manifest.json"))
            guard let info = try JSONSerialization.jsonObject(with: manifest) as? [String: Any], info["releaseId"] as? String == release.releaseId, info["approvalId"] as? String == approval.id, info["sourceRevision"] as? String == approval.sourceRevision else { throw CloudError("本机文件包清单已变化，未发布标签") }
            for file in release.files { guard WorkspaceBridge.hash(try Data(contentsOf: local.appendingPathComponent(file.path))) == file.sha256 else { throw CloudError("本机文件包已变化，未发布标签") } }
            guard await approvalValid(approval, generation: current, session: scope) else { throw CloudError("批准已撤销或版本已变化，未发布标签") }
            let result = try await engineering.publishTag(release, remote: remote, tag: tag, policy: JSONEncoder().encode(publishPolicy), manifestSHA: WorkspaceBridge.hash(manifest), sourceRevision: approval.sourceRevision)
            guard current == generation, sessionID == scope, sequence == publishSequence else { return }
            publishedTag = result
        } catch { if current == generation && sessionID == scope && sequence == publishSequence { publishError = error.localizedDescription } }
    }
}
