import Foundation
import AppKit
import ReifyCloud

extension AppModel {
    var canExportFusion: Bool { connected && selected?.role != "viewer" && permission != "read-only" && !generating }
    var fusionReady: Bool { canExportFusion && fusionAttached && fusionStatus?.fusion?.state == "ready" }
    func clearFusion() {
        fusionSequence += 1; fusion?.dispose(); fusion = nil; fusionAttached = false
        fusionStatus = nil; fusionJobs = []; fusionTest = nil; fusionError = nil; fusionBusy = false; fusionTesting = false
    }
    func stopFusion() async {
        let service = fusion
        // Disable stale UI events immediately, but let the original dispatcher
        // publish cancellation before the old conversation/connection is closed.
        service?.onEvent = nil
        await service?.stop()
        if fusion === service { clearFusion() }
    }
    func fusionService() -> NativeFusion {
        if let fusion { return fusion }
        let service = NativeFusion(), current = generation, scope = sessionID
        fusion = service
        service.authorized = { [weak self] in
            guard let self else { return false }
            return current == self.generation && scope == self.sessionID && self.connected && self.selected?.role != "viewer" && self.permission != "read-only"
        }
        service.onEvent = { [weak self, weak service] event in
            guard let self, self.fusion === service, current == self.generation, scope == self.sessionID else { return }
            do {
                if event["type"] as? String == "scope-error" { self.fusionError = event["message"] as? String }
                if let value = event["status"] { self.fusionStatus = try JSONDecoder().decode(FusionStatus.self, from: JSONSerialization.data(withJSONObject: value)) }
                if let value = event["job"] {
                    let job = try JSONDecoder().decode(FusionJob.self, from: JSONSerialization.data(withJSONObject: value))
                    if let index = self.fusionJobs.firstIndex(where: { $0.id == job.id }) { self.fusionJobs[index] = job }
                    else { self.fusionJobs.insert(job, at: 0); self.fusionJobs = Array(self.fusionJobs.prefix(30)) }
                }
            } catch { self.fusionError = "Fusion 状态格式错误" }
        }
        return service
    }
    func connectFusion() async {
        guard connected, selected?.role != "viewer", permission != "read-only", !fusionAttached else { return }
        let service = fusionService(), sequence = fusionSequence
        do {
            let status = try await service.attach(bridge: bridge, sessionID: sessionID)
            guard fusion === service, sequence == fusionSequence else { return }
            fusionAttached = true; fusionStatus = status; fusionError = nil
        } catch { if fusion === service && sequence == fusionSequence { fusionError = error.localizedDescription } }
    }
    func refreshFusion() async {
        let service = fusionService()
        do {
            let status: FusionStatus = try await service.request("status")
            guard fusion === service else { return }
            fusionStatus = status
            if connected && !fusionAttached { await connectFusion() }
        } catch { if fusion === service { fusionError = error.localizedDescription } }
    }
    func installFusion() async {
        guard !fusionBusy, !fusionTesting, !fusionJobs.contains(where: \.working) else { return }
        let service = fusionService()
        fusionBusy = true; fusionError = nil
        defer { if fusion === service { fusionBusy = false } }
        do {
            let status: FusionStatus = try await service.request("install")
            guard fusion === service else { return }
            fusionStatus = status
        } catch { if fusion === service { fusionError = error.localizedDescription } }
    }
    func testFusion() async {
        guard fusionReady, !fusionBusy, !fusionTesting else { return }
        let service = fusionService()
        fusionTesting = true; fusionError = nil; fusionTest = nil
        defer { if fusion === service { fusionTesting = false } }
        do {
            let result: FusionTest = try await service.request("test", timeout: 600)
            guard fusion === service else { return }
            fusionTest = result
        } catch { if fusion === service { fusionError = error.localizedDescription } }
    }
    func exportFusion() async {
        guard fusionReady, !fusionBusy, !parameterPreviewActive, let displayed = preview else { return }
        let service = fusionService(), sequence = fusionSequence
        fusionBusy = true; fusionError = nil
        defer { if fusion === service { fusionBusy = false } }
        do {
            let mesh = try MeshModel.read(displayed)
            guard let source = mesh.source, mesh.sha256 != nil else { throw CloudError("当前模型缺少来源，请打开项目中的 STEP 模型") }
            let path = try bridge.relativeProjectPath(source)
            _ = try await currentModelExportData()
            guard fusion === service, sequence == fusionSequence, preview == displayed, fusionReady else { throw CancellationError() }
            let _: FusionJob = try await service.request("export", fields: ["path": path, "sha256": mesh.sha256!])
        } catch { if fusion === service && !(error is CancellationError) { fusionError = error.localizedDescription } }
    }
    func cancelFusion(_ job: FusionJob) async {
        guard job.working, let service = fusion else { return }
        do { let _: Bool = try await service.request("cancel", fields: ["jobId": job.id]) }
        catch { if fusion === service { fusionError = error.localizedDescription } }
    }
    func openFusionFile(_ path: String, folder: Bool = false) {
        guard let service = fusion else { return }
        let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        let roots = [service.transferRoot, service.cacheRoot].map { $0.standardizedFileURL.resolvingSymlinksInPath().path }
        guard roots.contains(where: { url.path.hasPrefix($0 + "/") }), FileManager.default.fileExists(atPath: url.path) else { fusionError = "本机找不到此导出结果"; return }
        if !NSWorkspace.shared.open(url) { fusionError = folder ? "无法打开导出目录" : "无法打开导出日志" }
    }
}
