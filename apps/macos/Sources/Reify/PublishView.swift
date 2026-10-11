import SwiftUI

struct PublishView: View {
    @EnvironmentObject var app: AppModel
    @State private var remote = ""
    @State private var tag = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Git 标签发布").font(ReifyDesign.font(13, .medium))
            Text("只发布代码标签，文件包保存在本机").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted)
            Text(app.publishPolicy.message).font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted)
            if app.publishPolicy.enabled {
                Picker("远程仓库", selection: $remote) { ForEach(app.publishPolicy.allowedRemotes, id: \.self) { Text($0).tag($0) } }.accessibilityIdentifier("publish.remote")
                TextField("标签名称", text: $tag).textFieldStyle(.roundedBorder).accessibilityIdentifier("publish.tag")
                Button(app.publishBusy ? "正在发布…" : "发布标签") { Task { await app.publishRelease(remote: remote, tag: tag) } }.disabled(app.publishBusy || app.releaseBusy || app.generating || remote.isEmpty || tag.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || app.selected?.role == "viewer" || app.permission == "read-only").accessibilityIdentifier("publish.start")
            }
            if let result = app.publishedTag { Text("\(result.reused ? "已存在，版本相同" : "标签已发布")：\(result.tag)\n\(result.remoteUrl)").font(ReifyDesign.font(10)).textSelection(.enabled) }
            if let error = app.publishError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
        }.task { app.refreshPublishPolicy(); remote = app.publishPolicy.allowedRemotes.first ?? ""; tag = "reify/" + (app.savedReleaseApproval?.commitId ?? "") }
    }
}
