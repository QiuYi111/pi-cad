import Foundation
import ReifyCloud

extension FlowE2E {
    @MainActor static func tracesE2E(_ app: AppModel) async throws {
        func mode(_ value: String) async throws {
            var request = URLRequest(url: URL(string: app.api.baseURL + "/__test/trace-mode")!)
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["mode": value])
            let (_, response) = try await URLSession.shared.data(for: request)
            precondition((response as? HTTPURLResponse)?.statusCode == 200)
        }
        func finished() async throws {
            for _ in 0..<2400 { if app.traceWorking == nil { return }; try await Task.sleep(for: .milliseconds(50)) }
            fatalError("Timed out waiting for original experience scripts: \(app.traceJobError ?? "")")
        }
        let session = app.sessionID, spawn = app.bridge.spawnID, draft = app.draft, messageIDs = app.messages.map(\.id)
        await app.refreshTraces()
        guard let low = app.traceItems.first(where: { $0.id == "trace-low" }), let high = app.traceItems.first(where: { $0.id == "trace-high" }), app.traceError == nil else { fatalError("Trace list failed: \(app.traceError ?? "")") }
        precondition(low.model == "zai/glm-5.3-flash" && low.tokens == 130 && low.toolCalls == 1 && low.turns == 4)
        precondition(!app.traceItems.contains(where: { $0.id == "escape" }), "Transcript symlink appeared in list")
        app.traceQuery = "GLM-5.3"; precondition(app.filteredTraces.contains { $0.path == low.path })
        app.traceQuery = "失败记录"; precondition(app.filteredTraces.count == 1)
        app.traceQuery = "no-matching-record"; precondition(app.filteredTraces.isEmpty); app.traceQuery = ""
        await app.openTrace(low)
        precondition(app.traceEntries.map(\.role) == ["user", "assistant", "toolResult"] && app.traceEntries.last!.text.count > 500 && app.traceEntries.last!.tool == "python" && app.traceSelection.contains(low.path), "Trace read: \(app.traceError ?? String(describing: app.traceEntries.map(\.role)))")
        do { _ = try await app.traces.read(low.path.replacingOccurrences(of: "trace-low.jsonl", with: "escape.jsonl")); fatalError("Escaped symlink read") } catch { precondition(error.localizedDescription.contains("escapes")) }
        do { _ = try await app.traces.read("/workspace/projects/another/.prime-sessions/wrong.jsonl"); fatalError("Read another project") } catch { precondition(error.localizedDescription.contains("escapes")) }
        try await mode("slow-read")
        let oldRead = Task { await app.openTrace(low) }
        try await Task.sleep(for: .milliseconds(50)); await app.openTrace(high); await oldRead.value
        precondition(app.activeTrace?.path == high.path && app.traceEntries.last?.text == "尺寸检查通过", "Old trace read replaced latest selection")
        try await mode("normal")
        await app.startTraceJob("rate", paths: [low.path, high.path], quality: 2, difficulty: 5, feedback: "评分原文保留")
        try await finished()
        precondition(app.traceRating?.rated == 2 && app.traceRating?.triggered == false && app.traceJobError == nil)
        await app.refreshTraces()
        precondition(app.traceItems.first { $0.path == low.path }?.evaluation?.quality == 2 && app.traceItems.first { $0.path == high.path }?.evaluation?.feedback == "评分原文保留")
        await app.rateCurrentTrace(quality: 4, difficulty: 3, feedback: "只评分当前对话")
        try await finished(); await app.refreshTraces()
        precondition(app.traceRating?.rated == 1 && app.traceItems.first { $0.id == session }?.evaluation?.feedback == "只评分当前对话", "Current rating targeted another saved conversation")
        let actualSession = app.sessionID; app.sessionID = "no-saved-record"
        await app.rateCurrentTrace(quality: 4, difficulty: 3, feedback: "不可回退到最新记录")
        precondition(app.traceJobError?.contains("没有唯一") == true, "Missing current conversation rated latest trace")
        app.sessionID = actualSession
        await app.refreshTraces()
        // Invalid values, permission and unknown records are refused before a job.
        await app.startTraceJob("rate", paths: [low.path], quality: 0, difficulty: 5)
        precondition(app.traceWorking == nil && app.traceJobError == "评分须为 1 到 5")
        await app.startTraceJob("rate", paths: ["/workspace/projects/another/unknown.jsonl"], quality: 4, difficulty: 3)
        precondition(app.traceWorking == nil && app.traceJobError == "请选择当前项目的记录")
        app.permission = "read-only"; app.traceJobError = nil
        await app.startTraceJob("rate", paths: [low.path], quality: 4, difficulty: 3)
        precondition(app.traceWorking == nil && app.traceJobError == nil); app.permission = "workspace"
        // Original worker creates a real candidate and job, then original replay
        // checks both synthetic Prime judgement and an executable evidence check.
        await app.startTraceJob("distill", paths: [low.path, high.path], quality: 2, difficulty: 3)
        try await finished()
        guard let candidate = app.traceDistillation, candidate.state == "candidate", let job = candidate.jobPath, app.traceJobError == nil else { fatalError("Experience pipeline failed: \(app.traceJobError ?? app.traceDistillation?.message ?? "no status")") }
        precondition(candidate.processed == 2 && candidate.total == 2 && candidate.changedFiles?.isEmpty == false && candidate.validationStatus == "pending")
        await app.startTraceJob("validate", paths: [], quality: 4, difficulty: 3, jobPath: job)
        try await finished()
        precondition(app.traceDistillation?.validationStatus == "passed" && app.traceValidation?["status"]?.stringValue == "passed" && app.traceJobError == nil)
        try await mode("replay-failure")
        await app.startTraceJob("validate", paths: [], quality: 4, difficulty: 3, jobPath: job)
        try await finished()
        precondition(app.traceValidation == nil && app.traceDistillation?.validationStatus == "failed" && app.traceJobError != nil, "Failed engineering evidence was accepted")
        try await mode("normal")
        await app.startTraceJob("validate", paths: [], quality: 4, difficulty: 3, jobPath: job)
        try await finished(); precondition(app.traceDistillation?.validationStatus == "passed" && app.traceJobError == nil)
        try await mode("failure")
        await app.startTraceJob("distill", paths: [low.path], quality: 4, difficulty: 3)
        try await finished(); precondition(app.traceJobError == "Synthetic experience failure")
        try await mode("wait")
        await app.startTraceJob("distill", paths: [low.path], quality: 4, difficulty: 3)
        precondition(app.traceWorking == "distill")
        await app.stopTraceJob(); precondition(app.traceWorking == nil && app.traceJobError?.contains("停止等待") == true)
        await app.startTraceJob("distill", paths: [high.path], quality: 4, difficulty: 3)
        precondition(app.traceWorking == "distill"); app.clearTraces()
        try await Task.sleep(for: .milliseconds(150))
        precondition(app.traceWorking == nil && app.traceDistillation == nil && app.traceItems.isEmpty && app.traceJobError == nil, "Old job wrote into reset conversation")
        try await mode("normal")
        let state = try await app.bridge.rpc("get_state")
        precondition(state["sessionId"] as? String == session && app.bridge.spawnID == spawn && app.draft == draft && app.messages.map(\.id) == messageIDs, "Trace jobs changed assistant, conversation or draft")
        print("PASS: original desktop trace list/read/rating/archive/distillation/replay scripts over native network with real transcript/index/candidate files; search/stats/tools, symlink/cross-project refusal, stale read guard, multi/current rating without latest fallback, original selected GLM environment, evidence replay failure/retry, stop waiting and scope cleanup; Prime and analyzer executable results are synthetic")
    }
}
