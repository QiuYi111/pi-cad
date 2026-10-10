import SwiftUI
import AppKit
import ReifyCloud

struct HumanApprovalForm: View {
    @EnvironmentObject var app: AppModel
    let commit: EngineeringCommit
    @State private var scope = ""
    @State private var reason = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("人工批准").font(ReifyDesign.font(18, .medium)); Spacer(); Button("关闭") { app.approvalForm = nil }.disabled(app.approvalBusy) }
            Text(commit.name).font(ReifyDesign.font(14, .medium))
            Text("批准人：\(NSUserName())").foregroundStyle(ReifyDesign.muted)
            Text("源码：\(commit.sourceRevision ?? "未记录")").textSelection(.enabled)
            Text("工作流：\(commit.workflowHash ?? "未记录")").textSelection(.enabled)
            ForEach(commit.artifacts) { artifact in Text("\(artifact.path) · \(artifact.sha256)").font(ReifyDesign.font(10)).textSelection(.enabled) }
            TextField("批准范围", text: $scope, axis: .vertical).textFieldStyle(.roundedBorder).accessibilityIdentifier("approval.scope")
            TextField("批准理由", text: $reason, axis: .vertical).lineLimit(3...6).textFieldStyle(.roundedBorder).accessibilityIdentifier("approval.reason")
            if let error = app.approvalError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack { Spacer(); Button(app.approvalBusy ? "保存中…" : "批准此版本") { Task { _ = await app.approveVersion(commit.id, scope: scope, reason: reason, expected: commit) } }
                .disabled(app.approvalBusy || scope.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("approval.confirm") }
        }.padding(24).frame(width: 640).font(ReifyDesign.font(12)).background(ReifyDesign.paper).buttonStyle(ReifyButtonStyle())
    }
}
struct HumanApprovalRow: View {
    @EnvironmentObject var app: AppModel
    let record: HumanApprovalRecord
    @State private var reason = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(record.revokedAt != nil ? "已撤销" : record.valid ? "批准有效" : "版本已变化，批准失效").font(ReifyDesign.font(12, .medium))
            Text("\(record.approver.id) · \(record.decidedAt)").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted)
            Text("范围：\(record.scope)")
            Text("理由：\(record.rationale)").textSelection(.enabled)
            if record.valid { Button("发布并保存文件包") { Task { await app.chooseReleaseFolder(record) } }.disabled(app.releaseBusy || app.generating || app.selected?.role == "viewer").accessibilityIdentifier("release.prepare.\(record.id)") }
            if let revoked = record.revokedAt { Text("撤销：\(revoked) · \(record.revocationReason ?? "")").foregroundStyle(ReifyDesign.muted) }
            else if record.approver.id == NSUserName() {
                TextField("撤销理由", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder).accessibilityIdentifier("approval.revoke-reason.\(record.id)")
                Button("撤销批准") { Task { await app.revokeApproval(record.id, reason: reason) } }
                    .disabled(app.approvalBusy || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("approval.revoke.\(record.id)")
            }
        }.padding(12).background(ReifyDesign.panel, in: RoundedRectangle(cornerRadius: 8)).accessibilityIdentifier("approval.record.\(record.id)")
    }
}
struct EvidenceView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text("验收证据").font(ReifyDesign.font(16, .medium)); Spacer(); Button("关闭") { app.evidence = nil }.accessibilityIdentifier("evidence.close") }
            if let evidence = app.evidence {
                Text(evidence.path).textSelection(.enabled)
                Text("记录校验：\(evidence.sha256)\n文件校验：\(evidence.contentSHA256)").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted).textSelection(.enabled)
                if !evidence.bindingVerified { Text("旧版本未保存证据哈希；已核验保存的文件内容").foregroundStyle(ReifyDesign.muted) }
                ScrollView { Text(pretty(evidence.value)).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                Button("引用证据") { app.draft += (app.draft.isEmpty ? "" : "\n") + "Reference acceptance evidence \(evidence.path) with record digest \(evidence.declaredSHA256 ?? "not preserved") and content SHA-256 \(evidence.contentSHA256) from this conversation's pinned workflow. Keep the exact evidence revision."; app.evidence = nil; app.canvasMode = false; app.saveConversationDraft() }.accessibilityIdentifier("evidence.reference")
            }
        }.padding(20).frame(width: 720, height: 560).font(ReifyDesign.font(12)).background(ReifyDesign.paper).buttonStyle(ReifyButtonStyle()).accessibilityIdentifier("evidence.view")
    }
    private func pretty(_ value: JSONValue) -> String { (try? JSONSerialization.data(withJSONObject: value.foundationValue, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])).map { String(decoding: $0, as: UTF8.self) } ?? "" }
}
