import SwiftUI

struct FusionSettingsView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Label("Autodesk Fusion", systemImage: "cube").font(ReifyDesign.font(14, .medium)); Spacer(); Button("检查连接") { Task { await app.refreshFusion() } }.accessibilityIdentifier("fusion.refresh") }
            if let target = app.fusionStatus?.fusion {
                Text(state(target.state)).accessibilityIdentifier("fusion.status")
                if let version = target.appVersion { Text(version).foregroundStyle(ReifyDesign.muted) }
                Text("插件：\(target.addinInstalledVersion ?? "未安装") · 内置：\(target.addinBundledVersion ?? "缺失")").accessibilityIdentifier("fusion.versions")
                if target.signedIn == false { Text("请在 Fusion 登录账户").foregroundStyle(ReifyDesign.muted) }
                if target.updateAvailable == true { Text("有新版插件，更新后请在 Fusion 重新运行") }
            }
            Text("安装插件 → 打开 Fusion 的工具 → 脚本和附加模块 → 附加模块 → ReifyExport → 运行。勾选启动时运行。").foregroundStyle(ReifyDesign.muted).textSelection(.enabled)
            HStack {
                Button(app.fusionStatus?.fusion?.updateAvailable == true ? "更新插件" : "安装插件") { Task { await app.installFusion() } }.disabled(app.fusionBusy || app.fusionTesting || app.fusionJobs.contains(where: \.working)).accessibilityIdentifier("fusion.install")
                Button("测试导出") { Task { await app.testFusion() } }.disabled(!app.fusionReady || app.fusionBusy || app.fusionTesting).accessibilityIdentifier("fusion.test")
                if app.fusionBusy || app.fusionTesting { ProgressView().controlSize(.small) }
            }
            Text("测试会在当前项目新建 40 × 30 × 5 mm 板，含四个通孔和一个凹槽，导出后检查形状。").font(ReifyDesign.font(11)).foregroundStyle(ReifyDesign.muted)
            if !app.canExportFusion { Text("连接可编辑项目并停止当前任务后，才能测试或导出").foregroundStyle(ReifyDesign.muted) }
            if let result = app.fusionTest {
                Text(result.ok ? "测试导出通过" : result.message).foregroundStyle(result.ok ? ReifyDesign.green : .red).accessibilityIdentifier("fusion.test-result")
                ForEach(Array(result.steps.enumerated()), id: \.offset) { _, step in Text("\(step.ok ? "✓" : "×") \(stepName(step.name))\(step.detail.map { " · " + $0 } ?? "")") }
            }
            FusionJobsView()
        }.task { await app.refreshFusion() }
    }
    private func stepName(_ value: String) -> String {
        ["CAD program ready": "连接检查", "Reference plate built": "测试板制作", "CAD program exported": "Fusion 导出", "Shape check passed": "形状检查"][value] ?? value
    }
    private func state(_ value: String) -> String {
        switch value {
        case "ready": return "Fusion 已连接"
        case "not_installed": return "未找到 Fusion，请先安装"
        case "addin_missing": return "Fusion 插件未安装"
        case "addin_not_running": return "插件未运行，请在 Fusion 中运行 ReifyExport"
        default: return app.fusionStatus?.fusion?.detail ?? "连接不可用"
        }
    }
}
struct FusionJobsView: View {
    @EnvironmentObject var app: AppModel
    var limit = 5
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = app.fusionError { Text(error).foregroundStyle(.red).textSelection(.enabled).accessibilityIdentifier("fusion.error") }
            ForEach(app.fusionJobs.prefix(limit)) { job in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        if job.working { ProgressView().controlSize(.small) }
                        Text(job.part ?? "Fusion 导出").font(ReifyDesign.font(12, .medium)); Spacer()
                        if job.working { Button("取消") { Task { await app.cancelFusion(job) } }.accessibilityIdentifier("fusion.cancel.\(job.id)") }
                    }
                    Text(message(job)).textSelection(.enabled).accessibilityIdentifier("fusion.job.\(job.id)")
                    if let error = job.error { Text([error.code, error.feature, error.step].compactMap { $0 }.joined(separator: " · ")).foregroundStyle(.red) }
                    HStack {
                        if let folder = job.nativeFolder { Button("打开结果目录") { app.openFusionFile(folder, folder: true) }.accessibilityIdentifier("fusion.folder.\(job.id)") }
                        if let log = job.logPath { Button("查看日志") { app.openFusionFile(log) }.accessibilityIdentifier("fusion.log.\(job.id)") }
                    }
                }.padding(10).background(ReifyDesign.canvas, in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}
private func message(_ job: FusionJob) -> String {
    if job.state == "cancelled" { return "导出已取消" }
    if job.state == "done" && job.message.contains("shape check passed") {
        return job.message.contains("Joints were not exported") ? "导出完成，形状检查通过。装配保留位置，关节未导出。" : "导出完成，形状检查通过"
    }
    return ["Preparing the export.": "准备导出", "Waiting for the CAD program.": "等待 Fusion", "Another export is running. This job waits.": "前一项正在导出，请稍候", "Checking the CAD program.": "检查 Fusion 连接", "Exporting to Fusion.": "正在导出到 Fusion", "Finishing cancellation.": "正在结束导出", "Reading the export failure.": "读取导出失败原因", "Checking the shape.": "检查导出形状"][job.message] ?? job.message
}
struct FusionCanvasView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button("导出到 Fusion") { Task { await app.exportFusion() } }.disabled(!app.fusionReady || app.fusionBusy || app.parameterPreviewActive).accessibilityIdentifier("model.export-fusion")
                Button("Fusion 设置") { app.settingsPresented = true }.accessibilityIdentifier("fusion.settings")
                Spacer()
            }
            FusionJobsView(limit: 1)
        }.buttonStyle(ReifyButtonStyle()).padding(12).background(ReifyDesign.paper).overlay(alignment: .bottom) { Divider() }
    }
}
