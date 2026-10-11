import SwiftUI
import ReifyCloud

struct ToolCardView: View {
    @EnvironmentObject var app: AppModel
    let activity: ChatActivity
    @State private var expanded = false
    @State private var image: Data?
    private var running: Bool { ["running", "queued"].contains(activity.state) }
    private var failed: Bool { ["failed", "denied"].contains(activity.state) }
    private var title: String {
        let names = ["build": "制作模型", "probe": "检查模型", "simulation": "运行分析", "workflow": "更新工作流", "review": "独立审查", "commit": "保存版本", "image": "生成概念图"]
        let value = names[activity.kind] ?? activity.title
        return failed ? value + "失败" : running ? value : value + " · 已完成"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                if running { ProgressView().controlSize(.small) }
                else { Image(systemName: failed ? "exclamationmark.triangle" : "checkmark.circle").foregroundStyle(failed ? .red : ReifyDesign.green) }
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(ReifyDesign.font(13, .medium))
                    Text((running ? activity.stage ?? activity.summary : activity.summary) ?? (running ? "正在执行" : failed ? "执行失败" : "已完成")).font(ReifyDesign.font(11)).foregroundStyle(ReifyDesign.muted).textSelection(.enabled)
                }
                Spacer()
                if let path = activity.artifactPath { Button("查看") { Task { await app.openToolArtifact(path) } }.accessibilityIdentifier("tool.open.\(activity.id)") }
                if !running, !failed {
                    Button("引用") { app.draft += (app.draft.isEmpty ? "" : "\n") + "Use the \(activity.kind) result from tool call \(activity.id)\(activity.artifactPath.map { " at " + $0 } ?? ""). \(activity.summary ?? "Keep this exact artifact identity and version in context.")"; app.saveConversationDraft() }.accessibilityIdentifier("tool.reference.\(activity.id)")
                }
            }.buttonStyle(ReifyButtonStyle())
            if running, let progress = activity.progress { ProgressView(value: min(1, max(0, progress))).tint(ReifyDesign.green) }
            if let metrics = activity.metrics, !metrics.isEmpty {
                HStack { ForEach(Array(metrics.enumerated()), id: \.offset) { _, metric in VStack(alignment: .leading) { Text(metric.label).foregroundStyle(ReifyDesign.muted); Text(metric.value) } } }.font(ReifyDesign.font(11))
            }
            if let media = activity.media, !media.isEmpty {
                ScrollView(.horizontal) {
                    HStack { ForEach(media) { item in
                        VStack {
                        Button { if let bytes = item.inlineImage { image = bytes } else if let path = item.path { Task { image = try? await app.bridge.download(app.bridge.relativeProjectPath(path)) } } } label: {
                            VStack { if let bytes = item.inlineImage, let image = NSImage(data: bytes) { Image(nsImage: image).resizable().scaledToFit().frame(width: 170, height: 110) }; Text(item.label ?? item.role).font(ReifyDesign.font(10)) }
                        }.buttonStyle(.plain).accessibilityIdentifier("tool.media.\(item.id)")
                        if !running, !failed, item.mimeType.hasPrefix("image/") { Button("到画板引用") { Task { await app.openToolImage(activity, media: item) } }.accessibilityIdentifier("tool.concept.\(item.id)") }
                        }
                    } }
                }
            }
            if let details = activity.details {
                DisclosureGroup("详情", isExpanded: $expanded) { Text(pretty(details)).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            }
        }.padding(16).background(ReifyDesign.panel, in: RoundedRectangle(cornerRadius: 12)).accessibilityIdentifier("tool.\(activity.id)")
            .sheet(isPresented: Binding(get: { image != nil }, set: { if !$0 { image = nil } })) {
                VStack { HStack { Text("工具图片"); Spacer(); Button("关闭") { image = nil } }; if let image, let value = NSImage(data: image) { Image(nsImage: value).resizable().scaledToFit() } }.padding(20).frame(minWidth: 600, minHeight: 450)
            }
    }
    private func pretty(_ value: JSONValue) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value.foundationValue, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}

struct TurnStatusView: View {
    @EnvironmentObject var app: AppModel
    private func title(_ phase: String) -> String {
        ["starting_turn": "开始任务", "waiting_provider": "等待模型", "thinking": "思考中", "responding": "回复中", "running_tool": "执行工具", "compacting": "整理对话", "retrying": "正在重试", "provider_wait": "等待服务商", "stalled": "模型尚未回应", "stopping": "停止中", "aborted": "已停止", "reasoning_limit": "已达思考上限", "provider_timeout": "模型超时", "rpc_timeout": "助手请求超时", "provider_error": "模型出错", "failed": "任务失败", "ready": "就绪"][phase] ?? phase
    }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            VStack(alignment: .leading, spacing: 5) {
            ForEach(app.extensionStatuses.keys.sorted(), id: \.self) { key in Text(app.extensionStatuses[key] ?? "").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted) }
            if let turn = app.presentation.turn() {
                HStack {
                    if !turn.terminal { ProgressView().controlSize(.mini) }
                    Text(turn.terminal ? ["provider_error": "模型出错", "rpc_rejected": "请求被拒绝", "process_exit": "助手已退出", "forced_stop": "强制停止"][turn.reason ?? ""] ?? title(turn.phase) : title(turn.phase))
                    if let retry = turn.retry { Text("\(retry.attempt)/\(retry.maxAttempts)") }
                    if !turn.terminal {
                        Text("本阶段 \(Int(turn.phaseSeconds)) 秒")
                        if turn.showSilent { Text("等待回应 \(Int(turn.silentSeconds)) 秒") }
                        Text("总计 \(Int(turn.turnSeconds)) 秒")
                    }
                }.font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted).accessibilityIdentifier("chat.turn-status")
            }
            }
        }
    }
}

extension AppModel {
    func openToolArtifact(_ path: String) async {
        do {
            let relative = try bridge.relativeProjectPath(path)
            if let artifact = engineeringArtifacts.first(where: { $0.path == relative }) { await showArtifact(artifact); return }
            if let file = files.first(where: { $0.path == relative }) { await showFile(file); return }
            throw CloudError("结果文件尚未读取，请重新读取工程结果")
        } catch { fail(error) }
    }
}
