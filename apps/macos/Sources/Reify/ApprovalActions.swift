import Foundation
import ReifyCloud

extension AppModel {
    var approvalRoot: URL {
        let key = WorkspaceBridge.hash(Data("\(api.baseURL)/\(user?.id ?? "")".utf8))
        let base = ProcessInfo.processInfo.environment["REIFY_APPROVAL_ROOT"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Reify/human-approvals", isDirectory: true)
        return base.appendingPathComponent(key, isDirectory: true)
    }
    func clearApprovals() {
        clearRelease()
        approvalSequence += 1; approvals = []; approvalError = nil; approvalBusy = false; approvalForm = nil
        evidenceSequence += 1; evidence = nil; evidenceError = nil; evidenceBusy = false
    }
    func refreshApprovals() async {
        guard connected else { return }
        let current = generation, scope = sessionID, root = approvalRoot
        approvalSequence += 1; let sequence = approvalSequence
        do {
            let envelope = try await engineering.requestEnvelope("viewer-catalog")
            guard current == generation && scope == sessionID && sequence == approvalSequence else { return }
            let records: [HumanApprovalRecord] = try await nativeApprovals.request("list", catalogEnvelope: envelope, root: root)
            guard current == generation && scope == sessionID && sequence == approvalSequence else { return }
            approvals = records
        } catch { if current == generation && scope == sessionID && sequence == approvalSequence { approvalError = error.localizedDescription } }
    }
    @discardableResult func approveVersion(_ id: String, scope: String, reason: String, expected: EngineeringCommit? = nil) async -> HumanApprovalRecord? {
        guard connected, !approvalBusy, selected?.role != "viewer" else { return nil }
        let current = generation, session = sessionID, root = approvalRoot
        let displayed = expected ?? engineeringCatalog?.commits.first { $0.id == id }
        approvalBusy = true; approvalError = nil
        defer { if current == generation && session == sessionID { approvalBusy = false } }
        do {
            let envelope = try await engineering.requestEnvelope("viewer-catalog")
            guard current == generation && session == sessionID else { return nil }
            struct Envelope: Decodable { let result: EngineeringCatalog }
            let fresh = try JSONDecoder().decode(Envelope.self, from: Data(envelope.utf8)).result.commits.first { $0.id == id }
            guard let displayed, let fresh, fresh.sourceRevision == displayed.sourceRevision, fresh.workflowHash == displayed.workflowHash, fresh.artifacts == displayed.artifacts else { throw CloudError("版本已变化，请重新打开批准窗口") }
            let record: HumanApprovalRecord = try await nativeApprovals.request("approve", catalogEnvelope: envelope, root: root, arguments: [id, scope, reason])
            guard current == generation && session == sessionID else { return nil }
            await refreshApprovals(); approvalForm = nil
            return record
        } catch { if current == generation && session == sessionID { approvalError = error.localizedDescription }; return nil }
    }
    func revokeApproval(_ id: String, reason: String) async {
        guard connected, !approvalBusy else { return }
        let current = generation, session = sessionID, root = approvalRoot
        approvalBusy = true; approvalError = nil
        defer { if current == generation && session == sessionID { approvalBusy = false } }
        do {
            let envelope = try await engineering.requestEnvelope("viewer-catalog")
            guard current == generation && session == sessionID else { return }
            let _: HumanApprovalRecord = try await nativeApprovals.request("revoke", catalogEnvelope: envelope, root: root, arguments: [id, reason])
            guard current == generation && session == sessionID else { return }
            await refreshApprovals()
        } catch { if current == generation && session == sessionID { approvalError = error.localizedDescription } }
    }
    func submitIndependentReview() async {
        guard connected, !generating, !busy, selected?.role != "viewer", let artifact = selectedArtifact else { return }
        guard selectedCommitID == nil, engineeringCatalog?.currentRun?.artifacts.contains(where: { $0.path == artifact.path && $0.sha256 == artifact.sha256 }) == true else { error = "请选择当前候选模型"; return }
        let current = generation, scope = sessionID
        do {
            let bytes = try await bridge.download(bridge.relativeProjectPath(artifact.path))
            guard WorkspaceBridge.hash(bytes) == artifact.sha256 else { throw CloudError("候选模型已变化，请重新读取工程结果") }
            guard current == generation && scope == sessionID && selectedArtifact?.revisionKey == artifact.revisionKey else { return }
            await send("Submit the current candidate \(artifact.path) with SHA-256 \(artifact.sha256) for the independent machine review required by the pinned workflow. Reuse an existing review for the exact same candidate and acceptance contract; do not treat machine review as human approval.")
        } catch { if current == generation && scope == sessionID { fail(error) } }
    }
    func readEvidence(_ record: AcceptanceSummary.Requirement.Evidence) async {
        guard connected, let run = workflowRun else { evidenceError = "请先读取当前工作流"; return }
        let current = generation, scope = sessionID
        evidenceSequence += 1; let sequence = evidenceSequence
        evidenceBusy = true; evidenceError = nil
        defer { if current == generation && scope == sessionID && sequence == evidenceSequence { evidenceBusy = false } }
        do {
            let value = try await engineering.evidence(record, run: run)
            guard current == generation && scope == sessionID && sequence == evidenceSequence else { return }
            evidence = value
        } catch { if current == generation && scope == sessionID && sequence == evidenceSequence { evidenceError = error.localizedDescription } }
    }
}
