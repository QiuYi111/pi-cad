import SwiftUI
import ReifyCloud

struct EngineeringResultsView: View {
    @EnvironmentObject var app: AppModel
    private var commit: EngineeringCommit? {
        let commits = app.engineeringCatalog?.commits ?? []
        return app.selectedCommitID.flatMap { id in commits.first { $0.id == id } } ?? commits.first
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("工程结果").font(ReifyDesign.font(14, .medium))
                Spacer()
                Menu {
                    Button("当前结果") { app.selectVersion(nil) }
                    ForEach(app.engineeringCatalog?.commits ?? []) { commit in
                        Button("\(commit.name) · \(commit.createdAt)") { app.selectVersion(commit.id) }
                    }
                } label: { Text(app.engineeringCatalog?.commits.first(where: { $0.id == app.selectedCommitID })?.name ?? "当前结果") }
                .accessibilityIdentifier("engineering.version")
            }
            Picker("结果分类", selection: $app.artifactFilter) { ForEach(["全部", "模型", "其他结果"], id: \.self) { Text($0) } }
                .pickerStyle(.segmented).accessibilityIdentifier("engineering.filter")
            if app.selectedCommitID == nil { Toggle("包括历史结果", isOn: $app.includesHistoricalArtifacts).accessibilityIdentifier("engineering.include-history") }
            if let error = app.approvalError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let error = app.evidenceError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let error = app.engineeringError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if app.engineeringArtifacts.isEmpty { Text("没有此类结果").foregroundStyle(ReifyDesign.muted) }
            ForEach(app.engineeringArtifacts, id: \.revisionKey) { artifact in
                HStack(alignment: .top) {
                    Button { Task { await app.showArtifact(artifact) } } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text((artifact.path as NSString).lastPathComponent)
                            Text("\(artifact.role) · \(artifact.sha256.prefix(8))").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted)
                        }
                    }.buttonStyle(.plain).accessibilityIdentifier("engineering.artifact.\(artifact.id)")
                    Spacer()
                    Button { Task { await app.revealArtifact(artifact) } } label: { Image(systemName: "folder") }.buttonStyle(.plain).help("在 Finder 查看副本").accessibilityIdentifier("engineering.reveal.\(artifact.id)")
                    Button { Task { await app.exportArtifact(artifact) } } label: { Image(systemName: "arrow.down.to.line") }.buttonStyle(.plain).help("下载结果").accessibilityIdentifier("engineering.download.\(artifact.id)")
                }.padding(10).background(ReifyDesign.panel, in: RoundedRectangle(cornerRadius: 8))
            }
            if app.selectedArtifact != nil && app.selectedCommitID == nil {
                Button("提交独立机器审查") { Task { await app.submitIndependentReview() } }.disabled(app.generating || !app.connected || app.selected?.role == "viewer").accessibilityIdentifier("review.submit")
            }
            if app.selectedArtifact != nil && !app.parameterPreviewActive {
                Menu("与另一版本比较") {
                    ForEach(app.comparisonChoices, id: \.revisionKey) { artifact in
                        Button("\((artifact.path as NSString).lastPathComponent) · \(artifact.sha256.prefix(8))") { Task { await app.compareArtifact(artifact) } }
                    }
                }.disabled(app.comparisonChoices.isEmpty || app.comparisonLoading).accessibilityIdentifier("comparison.choose")
            }
            if app.comparisonLoading { ProgressView("正在读取比较版本") }
            if let error = app.comparisonError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let primary = app.selectedArtifact, let other = app.comparisonArtifact {
                Text("参数差异").font(ReifyDesign.font(13, .medium))
                if app.parameterRecord(for: primary) == nil || app.parameterRecord(for: other) == nil {
                    Text("此版本没有保存参数记录").foregroundStyle(ReifyDesign.muted)
                } else if app.parameterDifferences.isEmpty { Text("已记录参数相同").foregroundStyle(ReifyDesign.muted) }
                ForEach(app.parameterDifferences) { value in
                    HStack { Text(value.label); Spacer(); Text("\(value.before) → \(value.after)") }
                }
                Text(primary.sha256 == other.sha256 ? "文件内容相同" : "文件内容不同").foregroundStyle(ReifyDesign.muted)
            }
            if let manifest = app.selectedParameters { Divider(); ParameterPanel(manifest: manifest) }
            Divider()
            Text("\(app.successfulChecks) 次检查已完成").font(ReifyDesign.font(12, .medium))
            Text(app.machineReviewSummary).foregroundStyle(ReifyDesign.muted)
            if let issue = app.latestEngineeringIssue { Text("最近问题：\(issue.summary ?? issue.title)").foregroundStyle(.red).textSelection(.enabled) }
            if let run = app.workflowRun {
                Divider()
                Text("工作流：\(run.workflowId) @ \(run.workflowVersion)").textSelection(.enabled)
                Text("\(run.phases.first { $0.id == run.phase }?.title ?? run.phase) · \(run.status)").foregroundStyle(ReifyDesign.muted)
            }
            if let commit {
                Text("版本：\(commit.name)").font(ReifyDesign.font(13, .medium))
                Text(commit.createdAt).foregroundStyle(ReifyDesign.muted)
                if let revision = commit.sourceRevision { Text("源码：\(revision.prefix(12))").textSelection(.enabled) }
                Button("人工批准此版本") { app.approvalError = nil; app.approvalForm = commit }.disabled(app.approvalBusy || !app.connected || app.selected?.role == "viewer" || commit.acceptanceSummary?.requirements.contains { $0.category == "machine" && $0.status == "verified" } != true).accessibilityIdentifier("approval.open")
                ForEach(app.approvals.filter { $0.commitId == commit.id }) { record in HumanApprovalRow(record: record) }
                if let summary = commit.acceptanceSummary {
                    Text("验收记录").font(ReifyDesign.font(13, .medium))
                    ForEach(Set(summary.requirements.map(\.category)).sorted(), id: \.self) { category in
                        Text(category).font(ReifyDesign.font(12, .medium))
                        ForEach(summary.requirements.filter { $0.category == category }) { requirement in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(requirement.id) · \(requirement.status)"); Text(requirement.method).foregroundStyle(ReifyDesign.muted)
                                if let record = requirement.evidence { Button("查看证据") { Task { await app.readEvidence(record) } }.disabled(app.evidenceBusy).accessibilityIdentifier("evidence.read.\(requirement.id)") }
                            }
                        }
                    }
                    ForEach(summary.assumptions, id: \.self) { Text($0).foregroundStyle(ReifyDesign.muted) }
                }
            }
        }.padding(16).frame(width: 280).frame(maxHeight: .infinity, alignment: .top).background(ReifyDesign.paper).disabled(app.parameterBusy)
    }
}
