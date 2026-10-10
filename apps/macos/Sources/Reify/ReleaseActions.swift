import Foundation
import AppKit
import ReifyCloud

extension AppModel {
    func clearRelease() {
        clearPublication()
        releaseSequence += 1; releaseBusy = false; releaseError = nil; releaseURL = nil
        let job = releaseJob; releaseJob = nil
        Task { await job?.cancel() }
    }
    func approvalValid(_ record: HumanApprovalRecord, generation expectedGeneration: Int, session expectedSession: String?) async -> Bool {
        guard generation == expectedGeneration, sessionID == expectedSession, connected else { return false }
        do {
            let envelope = try await engineering.requestEnvelope("viewer-catalog")
            let records: [HumanApprovalRecord] = try await nativeApprovals.request("list", catalogEnvelope: envelope, root: approvalRoot)
            guard generation == expectedGeneration, sessionID == expectedSession, connected else { return false }
            return records.contains { $0.id == record.id && $0.valid && $0.artifactSetHash == record.artifactSetHash && $0.sourceRevision == record.sourceRevision && $0.workflowHash == record.workflowHash }
        } catch { return false }
    }
    func chooseReleaseFolder(_ record: HumanApprovalRecord) async {
        guard !releaseBusy else { return }
        let panel = NSOpenPanel(); panel.title = "保存正式文件包"; panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
        guard await panel.begin() == .OK, let destination = panel.url else { return }
        await releaseVersion(record, to: destination)
    }
    func releaseVersion(_ record: HumanApprovalRecord, to destination: URL) async {
        guard connected, !releaseBusy, !generating, selected?.role != "viewer" else { return }
        let current = generation, scope = sessionID
        releaseSequence += 1; let sequence = releaseSequence
        clearPublication()
        let job = CloudReleaseJob(); releaseJob = job; releaseBusy = true; releaseError = nil; releaseURL = nil
        let staging = destination.appendingPathComponent(".reify-download-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: staging); if generation == current && sessionID == scope && releaseSequence == sequence { releaseBusy = false; releaseJob = nil } }
        do {
            guard await approvalValid(record, generation: current, session: scope) else { throw CloudError("批准已撤销或版本已变化") }
            let release = try await job.run(bridge: bridge, sessionID: scope, approvalJSON: JSONEncoder().encode(record)) { [weak self] in
                guard let self, self.releaseSequence == sequence else { return false }
                return await self.approvalValid(record, generation: current, session: scope)
            }
            guard generation == current, sessionID == scope, releaseSequence == sequence else { throw CloudError("已切换项目或对话") }
            let remote = try bridge.relativeProjectPath(release.path)
            guard remote.hasPrefix(".pi-cad/releases/Reify-"), release.manifestPath == release.path + "/release-manifest.json", release.releaseId.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CloudError("发布目录无效") }
            let manifestBytes = try await bridge.download(remote + "/release-manifest.json")
            guard let manifest = try JSONSerialization.jsonObject(with: manifestBytes) as? [String: Any], manifest["releaseId"] as? String == release.releaseId, manifest["projectId"] as? String == record.projectId, manifest["commitId"] as? String == record.commitId, manifest["approvalId"] as? String == record.id, manifest["workflowHash"] as? String == record.workflowHash, manifest["sourceRevision"] as? String == record.sourceRevision,
                  let declared = manifest["files"] as? [[String: Any]], declared.count == release.files.count,
                  Set(release.files.map(\.path)).count == release.files.count, release.files.contains(where: { $0.role == "human-approval" }), release.files.contains(where: { $0.role == "acceptance-summary" }) else { throw CloudError("发布清单与批准不一致") }
            let catalog = try await engineering.catalog()
            guard let version = catalog.commits.first(where: { $0.id == record.commitId }), version.sourceRevision == record.sourceRevision, version.workflowHash == record.workflowHash,
                  release.files.count == version.artifacts.count + 2,
                  release.files.contains(where: { $0.path == "human-approval.json" && $0.role == "human-approval" }),
                  release.files.contains(where: { $0.path == "acceptance-summary.json" && $0.role == "acceptance-summary" }) else { throw CloudError("文件包与批准版本不一致") }
            for artifact in version.artifacts {
                let path = "files/" + (try bridge.relativeProjectPath(artifact.path))
                guard release.files.contains(where: { $0.path == path && $0.sha256 == artifact.sha256 && $0.role == artifact.role }) else { throw CloudError("文件包与批准版本不一致") }
            }
            let name = (release.path as NSString).lastPathComponent, target = destination.appendingPathComponent(name, isDirectory: true)
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false)
            for file in release.files {
                guard !file.path.isEmpty, !file.path.hasPrefix("/"), !file.path.contains("\\"), !file.path.contains("\0"), !file.path.split(separator: "/").contains(".."), file.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                      declared.contains(where: { $0["path"] as? String == file.path && $0["sha256"] as? String == file.sha256 && $0["role"] as? String == file.role }) else { throw CloudError("发布文件清单无效") }
                let data = try await bridge.download(remote + "/" + file.path)
                guard WorkspaceBridge.hash(data) == file.sha256 else { throw CloudError("发布文件校验失败：\(file.path)") }
                let local = staging.appendingPathComponent(file.path)
                try FileManager.default.createDirectory(at: local.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: local, options: .atomic)
            }
            try manifestBytes.write(to: staging.appendingPathComponent("release-manifest.json"), options: .atomic)
            guard releaseSequence == sequence, await approvalValid(record, generation: current, session: scope) else { throw CloudError("批准已撤销或版本已变化，未完成下载") }
            if FileManager.default.fileExists(atPath: target.path) {
                // Reuse requires the exact saved manifest and every local file.
                guard (try? Data(contentsOf: target.appendingPathComponent("release-manifest.json"))) == manifestBytes else { throw CloudError("此文件包目录已存在，未覆盖") }
                for file in release.files { guard WorkspaceBridge.hash(try Data(contentsOf: target.appendingPathComponent(file.path))) == file.sha256 else { throw CloudError("已保存的文件包被修改，未覆盖") } }
            } else { try FileManager.default.moveItem(at: staging, to: target) }
            releaseURL = target; savedRelease = release; savedReleaseApproval = record; refreshPublishPolicy()
        } catch { if generation == current && sessionID == scope && releaseSequence == sequence { releaseError = error.localizedDescription } }
    }
    func cancelRelease() async {
        await releaseJob?.cancel(); releaseSequence += 1; releaseBusy = false; releaseJob = nil; releaseError = "已取消发布"
    }
}
