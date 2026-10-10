import Foundation
import ReifyCloud

extension AppModel {
    var traces: TraceService { TraceService(bridge: bridge, sessionID: sessionID, provider: provider, model: model, thinking: thinking) }
    var filteredTraces: [TraceSummary] {
        traceItems.filter { traceQuery.isEmpty || "\($0.title) \($0.model ?? "")".localizedCaseInsensitiveContains(traceQuery) }
    }
    var traceWriteAllowed: Bool { connected && !reconnecting && !generating && selected?.role != "viewer" && permission != "read-only" }
    func clearTraces() {
        traceListSequence += 1; traceReadSequence += 1; traceJobSequence += 1
        let process = traceProcess; traceProcess = nil; if let process { Task { await process.stop() } }
        traceTimeout?.cancel(); traceTimeout = nil; traceWorking = nil
        traceItems = []; traceSelection = []; activeTrace = nil; traceEntries = []
        traceLoading = false; traceReading = false; traceError = nil; traceJobError = nil
        traceRating = nil; traceDistillation = nil; traceValidation = nil; traceQuery = ""; currentRatingPresented = false
    }
    func refreshTraces() async {
        guard connected else { traceError = "请先连接云端项目"; return }
        let current = generation, scope = sessionID
        traceListSequence += 1; let sequence = traceListSequence
        traceLoading = true; traceError = nil
        defer { if current == generation && scope == sessionID && sequence == traceListSequence { traceLoading = false } }
        do {
            let items = try await traces.list()
            guard current == generation && scope == sessionID && sequence == traceListSequence else { return }
            traceItems = items
            traceSelection.formIntersection(Set(items.map(\.path)))
            if let activeTrace { self.activeTrace = items.first { $0.path == activeTrace.path }; if self.activeTrace == nil { traceEntries = [] } }
        } catch { if current == generation && scope == sessionID && sequence == traceListSequence { traceError = error.localizedDescription } }
    }
    func openTrace(_ item: TraceSummary) async {
        guard connected, traceItems.contains(where: { $0.path == item.path }) else { return }
        let current = generation, scope = sessionID
        traceReadSequence += 1; let sequence = traceReadSequence
        activeTrace = item; traceSelection.insert(item.path); traceEntries = []; traceReading = true; traceError = nil
        defer { if current == generation && scope == sessionID && sequence == traceReadSequence { traceReading = false } }
        do {
            let entries = try await traces.read(item.path)
            guard current == generation && scope == sessionID && sequence == traceReadSequence else { return }
            traceEntries = entries
        } catch { if current == generation && scope == sessionID && sequence == traceReadSequence { traceError = error.localizedDescription } }
    }
    func rateCurrentTrace(quality: Int, difficulty: Int, feedback: String) async {
        guard traceWriteAllowed, traceWorking == nil else { return }
        let current = generation, scope = sessionID
        await refreshTraces()
        guard current == generation && scope == sessionID else { return }
        let matches = traceItems.filter { $0.id == scope }
        guard matches.count == 1, let item = matches.first else { traceJobError = "当前对话没有唯一的保存记录，未评分"; return }
        await startTraceJob("rate", paths: [item.path], quality: quality, difficulty: difficulty, feedback: feedback)
    }
    func startTraceJob(_ operation: String, paths: [String], quality: Int, difficulty: Int, feedback: String = "", jobPath: String? = nil) async {
        guard traceWriteAllowed, traceWorking == nil else { return }
        guard operation == "validate" || (!paths.isEmpty && paths.allSatisfy { path in traceItems.contains { $0.path == path } }) else { traceJobError = "请选择当前项目的记录"; return }
        if operation == "validate", jobPath == nil || jobPath != traceDistillation?.jobPath { traceJobError = "请先整理经验，选定候选规则"; return }
        let current = generation, scope = sessionID
        traceJobSequence += 1; let sequence = traceJobSequence
        traceWorking = operation; traceJobError = nil
        if operation == "rate" { traceRating = nil }
        if operation == "distill" { traceDistillation = nil; traceValidation = nil }
        if operation == "validate" { traceValidation = nil }
        var receivedResult = false
        func valid() -> Bool { current == generation && scope == sessionID && sequence == traceJobSequence }
        do {
            let process = try await traces.start(operation, paths: paths, quality: quality, difficulty: difficulty, feedback: feedback, jobPath: jobPath, onEvent: { [weak self] event in
                guard let self, valid() else { return }
                do {
                    switch event["type"] as? String {
                    case "error", "auth_error": self.traceJobError = event["message"] as? String ?? "经验任务失败"
                    case "status":
                        if let status = event["status"] { self.traceDistillation = try JSONDecoder().decode(TraceDistillation.self, from: JSONSerialization.data(withJSONObject: status)) }
                    case "result":
                        let data = try JSONSerialization.data(withJSONObject: event["result"] ?? NSNull(), options: .fragmentsAllowed)
                        if operation == "rate" { self.traceRating = try JSONDecoder().decode(TraceRating.self, from: data) }
                        if operation == "distill" { self.traceDistillation = try JSONDecoder().decode(TraceDistillation.self, from: data) }
                        if operation == "validate" {
                            let result = try JSONDecoder().decode(JSONValue.self, from: data)
                            guard result["status"]?.stringValue == "passed", result["candidateRoot"]?.stringValue == self.traceDistillation?.candidateRoot else { throw CloudError("重放结果没有验证当前候选规则") }
                            self.traceValidation = result; self.traceDistillation?.validationStatus = "passed"
                        }
                        receivedResult = true
                    default: break
                    }
                } catch { self.traceJobError = error.localizedDescription }
            }, onExit: { [weak self] code in
                guard let self, valid() else { return }
                self.traceTimeout?.cancel(); self.traceTimeout = nil
                if !receivedResult && self.traceJobError == nil { self.traceJobError = self.traceProcess?.stderr.isEmpty == false ? self.traceProcess?.stderr : "经验任务结束，未返回结果（\(code)）" }
                if code != 0 && self.traceJobError == nil { self.traceJobError = "经验任务失败（\(code)）" }
                if operation == "validate" && self.traceJobError != nil { self.traceDistillation?.validationStatus = "failed" }
                self.traceProcess = nil; self.traceWorking = nil
                if receivedResult { Task { if valid() { await self.refreshTraces() } } }
            })
            guard valid() else { await process.stop(); return }
            if !process.finished {
                traceProcess = process
                let seconds = operation == "rate" ? 900 : (operation == "validate" ? 1800 : 7200)
                traceTimeout = Task { @MainActor [weak self] in
                    do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
                    guard let self, valid() else { return }
                    await self.stopTraceJob(message: "等待超时；已启动的经验整理仍可能在云端运行")
                }
            }
        } catch { if valid() { traceWorking = nil; traceJobError = error.localizedDescription } }
    }
    func stopTraceJob(message: String = "已停止等待；已启动的经验整理仍可能在云端运行") async {
        traceJobSequence += 1; traceTimeout?.cancel(); traceTimeout = nil
        let process = traceProcess; traceProcess = nil; traceWorking = nil; traceJobError = message
        await process?.stop()
    }
}
