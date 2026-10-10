import SwiftUI
import ReifyCloud

struct EngineeringResultsView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("工程结果").font(ReifyDesign.font(14, .medium))
                Spacer()
                Menu {
                    Button("当前结果") { app.selectedCommitID = nil; app.selectedArtifact = nil; app.preview = nil }
                    ForEach(app.engineeringCatalog?.commits ?? []) { commit in
                        Button("\(commit.name) · \(commit.createdAt)") { app.selectedCommitID = commit.id; app.selectedArtifact = nil; app.preview = nil }
                    }
                } label: { Text(app.engineeringCatalog?.commits.first(where: { $0.id == app.selectedCommitID })?.name ?? "当前结果") }
                .accessibilityIdentifier("engineering.version")
            }
            if let error = app.engineeringError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if app.engineeringArtifacts.isEmpty { Text("当前对话没有工程结果").foregroundStyle(ReifyDesign.muted) }
            ForEach(app.engineeringArtifacts) { artifact in
                HStack(alignment: .top) {
                    Button { Task { await app.showArtifact(artifact) } } label: {
                        VStack(alignment: .leading, spacing: 4) { Text((artifact.path as NSString).lastPathComponent); Text(artifact.role).font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted) }
                    }.buttonStyle(.plain).accessibilityIdentifier("engineering.artifact.\(artifact.id)")
                    Spacer()
                    Button { Task { await app.exportArtifact(artifact) } } label: { Image(systemName: "arrow.down.to.line") }.buttonStyle(.plain).help("下载结果").accessibilityIdentifier("engineering.download.\(artifact.id)")
                }.padding(10).background(ReifyDesign.panel, in: RoundedRectangle(cornerRadius: 8))
            }
            if let summary = app.engineeringCatalog?.commits.first(where: { $0.id == app.selectedCommitID })?.acceptanceSummary {
                Text("验收记录").font(ReifyDesign.font(13, .medium))
                ForEach(summary.requirements) { requirement in
                    VStack(alignment: .leading, spacing: 4) { Text("\(requirement.id) · \(requirement.status)"); Text(requirement.method).foregroundStyle(ReifyDesign.muted) }
                }
                ForEach(summary.assumptions, id: \.self) { Text($0).foregroundStyle(ReifyDesign.muted) }
            }
        }.padding(16).frame(width: 260).frame(maxHeight: .infinity, alignment: .top).background(ReifyDesign.paper)
    }
}
