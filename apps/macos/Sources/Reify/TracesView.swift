import SwiftUI
import ReifyCloud

struct TracesView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                HStack { Text("记录与经验").font(ReifyDesign.font(20, .medium)); Spacer()
                    Button { Task { await app.refreshTraces() } } label: { Image(systemName: "arrow.clockwise") }.disabled(app.traceLoading || !app.connected).accessibilityIdentifier("trace.refresh")
                }
                TextField("搜索记录或模型", text: $app.traceQuery).textFieldStyle(.roundedBorder).accessibilityIdentifier("trace.search")
                if app.traceLoading { ProgressView().controlSize(.small) }
                if let error = app.traceError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(app.filteredTraces, id: \.path) { item in
                            HStack(alignment: .top, spacing: 8) {
                                Toggle("选择 \(item.title)", isOn: Binding(get: { app.traceSelection.contains(item.path) }, set: { if $0 { app.traceSelection.insert(item.path) } else { app.traceSelection.remove(item.path) } })).labelsHidden().toggleStyle(.checkbox).accessibilityIdentifier("trace.select.\(item.id)")
                                Button { Task { await app.openTrace(item) } } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(item.title).font(ReifyDesign.font(13, .medium)).lineLimit(2)
                                        Text(item.model ?? "未知模型").foregroundStyle(ReifyDesign.muted).lineLimit(1)
                                        Text("\(item.turns) 条记录 · \(item.toolCalls) 次工具 · \(item.evaluation.map { "质量 \($0.quality)/5" } ?? "未评分")").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }.buttonStyle(.plain).accessibilityIdentifier("trace.open.\(item.id)")
                            }.padding(10).background(app.activeTrace?.path == item.path ? ReifyDesign.panel : .clear, in: RoundedRectangle(cornerRadius: 9))
                        }
                        if app.filteredTraces.isEmpty && !app.traceLoading { Text(app.traceQuery.isEmpty ? "暂无保存记录" : "没有匹配记录").foregroundStyle(ReifyDesign.muted).padding(.vertical) }
                    }
                }
                Divider()
                TraceRatingControls(current: false)
            }.padding(20).frame(width: 310).background(ReifyDesign.paper)
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                if let item = app.activeTrace {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(item.title).font(ReifyDesign.font(22, .medium))
                        Text("\(item.model ?? "未知模型") · \((item.tokens ?? 0).formatted()) tokens · \(Date(timeIntervalSince1970: item.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened))").foregroundStyle(ReifyDesign.muted)
                        if let rating = item.evaluation {
                            Text("质量 \(rating.quality)/5 · 难度 \(rating.difficulty)/5").foregroundStyle(ReifyDesign.muted)
                            if let feedback = rating.feedback, !feedback.isEmpty { Text(feedback).textSelection(.enabled) }
                        }
                    }.padding(24)
                    Divider()
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 20) {
                            if app.traceReading { ProgressView("读取记录") }
                            ForEach(app.traceEntries) { TraceEntryView(entry: $0) }
                        }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    VStack(spacing: 12) { Image(systemName: "clock.arrow.circlepath").font(.title); Text("选择记录").font(ReifyDesign.font(22, .medium)); Text("查看对话、工具结果、用量与评分").foregroundStyle(ReifyDesign.muted) }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                TraceJobView()
            }.frame(maxWidth: .infinity, maxHeight: .infinity).background(ReifyDesign.canvas)
        }.task { await app.refreshTraces() }.onChange(of: app.connected) { _, connected in if connected { Task { await app.refreshTraces() } } }.onChange(of: app.selected?.id) { _, _ in Task { await app.refreshTraces() } }.accessibilityIdentifier("trace.page")
    }
}

struct TraceRatingControls: View {
    @EnvironmentObject var app: AppModel
    let current: Bool
    @State private var quality = 4
    @State private var difficulty = 3
    @State private var feedback = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(current ? "给当前对话评分" : "已选 \(app.traceSelection.count) 条记录").font(ReifyDesign.font(13, .medium))
            HStack {
                Picker("质量", selection: $quality) { ForEach(1...5, id: \.self) { Text("\($0)/5").tag($0) } }.accessibilityIdentifier("trace.quality")
                Picker("难度", selection: $difficulty) { ForEach(1...5, id: \.self) { Text("\($0)/5").tag($0) } }.accessibilityIdentifier("trace.difficulty")
            }
            TextField("哪些做得好，哪些失败了？", text: $feedback, axis: .vertical).lineLimit(3...6).textFieldStyle(.roundedBorder).accessibilityIdentifier("trace.feedback")
            HStack {
                Button(app.traceWorking == "rate" ? "保存中…" : "保存评分") { Task {
                    if current { await app.rateCurrentTrace(quality: quality, difficulty: difficulty, feedback: feedback) }
                    else { await app.startTraceJob("rate", paths: app.traceItems.filter { app.traceSelection.contains($0.path) }.map(\.path), quality: quality, difficulty: difficulty, feedback: feedback) }
                } }.buttonStyle(ReifyButtonStyle(primary: true)).accessibilityIdentifier("trace.rate")
                if !current {
                    Button("整理经验") { Task { await app.startTraceJob("distill", paths: app.traceItems.filter { app.traceSelection.contains($0.path) }.map(\.path), quality: quality, difficulty: difficulty) } }.buttonStyle(ReifyButtonStyle()).accessibilityIdentifier("trace.distill")
                }
            }.disabled(!app.traceWriteAllowed || app.traceWorking != nil || (!current && app.traceSelection.isEmpty))
            if !current { Text("先给所选记录评分，再整理经验库中待处理的已评分记录。").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted) }
            if let rating = app.traceRating {
                Text("已保存 \(rating.rated) 条评分。\(rating.triggered ? "已启动后台经验整理。" : "距自动整理还需 \(max(0, rating.thresholdTokens - rating.pendingTokens).formatted()) tokens。")").foregroundStyle(ReifyDesign.muted).accessibilityIdentifier("trace.rating-status")
            }
        }
    }
}

private struct TraceEntryView: View {
    let entry: TraceEntry
    @State private var expanded = false
    private var isTool: Bool { entry.role == "toolResult" }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { Label(isTool ? entry.tool ?? "工具" : (entry.role == "user" ? "用户" : "助手"), systemImage: isTool ? "wrench" : "person").font(ReifyDesign.font(11, .medium)).foregroundStyle(ReifyDesign.muted)
                Spacer(); if let timestamp = entry.timestamp { Text(timestamp).font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted) }
            }
            if isTool { Text(expanded ? entry.text : String(entry.text.prefix(500))).font(.system(size: 11, design: .monospaced)).textSelection(.enabled) }
            else { MarkdownView(text: entry.text) }
            if isTool && entry.text.count > 500 { Button(expanded ? "收起" : "展开完整结果") { expanded.toggle() }.buttonStyle(.plain).foregroundStyle(ReifyDesign.green).accessibilityIdentifier("trace.expand.\(entry.id)") }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(16).background(ReifyDesign.paper, in: RoundedRectangle(cornerRadius: 10))
    }
}

struct TraceJobView: View {
    @EnvironmentObject var app: AppModel
    private var statusTitle: String {
        switch app.traceDistillation?.state { case "running": return "正在整理经验"; case "candidate": return "候选规则已生成"; case "complete": return "整理结束"; case "failed": return "整理失败"; default: return "经验任务" }
    }
    var body: some View {
        if app.traceWorking != nil || app.traceDistillation != nil || app.traceJobError != nil {
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Text(app.traceWorking == "validate" ? "正在重放验证" : statusTitle).font(ReifyDesign.font(13, .medium))
                    if app.traceWorking != nil { ProgressView().controlSize(.small); Spacer(); Button("停止等待") { Task { await app.stopTraceJob() } }.accessibilityIdentifier("trace.stop") }
                }
                if let error = app.traceJobError { Text(error).foregroundStyle(.red).textSelection(.enabled).accessibilityIdentifier("trace.job-error") }
                if let status = app.traceDistillation {
                    ProgressView(value: Double(status.processed), total: Double(max(1, status.total)))
                    Text("\(status.processed)/\(status.total) · \(status.message ?? "")").textSelection(.enabled)
                    if let files = status.changedFiles, !files.isEmpty { Text("修改文件：\(files.joined(separator: "、"))").textSelection(.enabled) }
                    if let sources = status.sourceFailureSeqs, !sources.isEmpty { Text("来源记录：\(sources.map(String.init).joined(separator: "、"))") }
                    if let path = status.outputPath { Text(path).foregroundStyle(ReifyDesign.muted).textSelection(.enabled) }
                    if status.state == "candidate" && status.jobPath != nil {
                        HStack {
                            Text("验证：\(status.validationStatus == "passed" ? "通过" : status.validationStatus == "failed" ? "失败" : "待验")")
                            Button("重放验证") { Task { await app.startTraceJob("validate", paths: [], quality: 4, difficulty: 3, jobPath: status.jobPath) } }.disabled(!app.traceWriteAllowed || app.traceWorking != nil).accessibilityIdentifier("trace.validate")
                        }
                        Text("现有云端模式不支持采纳候选规则。当前规则未更改。").foregroundStyle(ReifyDesign.muted)
                    }
                }
                if let validation = app.traceValidation {
                    DisclosureGroup("重放结果与报告") { Text(String(decoding: (try? JSONSerialization.data(withJSONObject: validation.foundationValue, options: [.prettyPrinted, .sortedKeys])) ?? Data(), as: UTF8.self)).font(.system(size: 11, design: .monospaced)).textSelection(.enabled) }
                }
            }.padding(16).background(ReifyDesign.panel).accessibilityIdentifier("trace.job")
        }
    }
}

struct CurrentTraceRatingView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            TraceRatingControls(current: true)
            TraceJobView()
            HStack { Spacer(); Button("关闭") { app.currentRatingPresented = false }.keyboardShortcut(.cancelAction) }
        }.padding(24).frame(width: 520)
    }
}
