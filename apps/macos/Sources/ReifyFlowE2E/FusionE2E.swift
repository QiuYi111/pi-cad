import Foundation
import ReifyCloud

extension FlowE2E {
    @MainActor static func fusionE2E(_ app: AppModel) async throws {
        guard let testHome = ProcessInfo.processInfo.environment["REIFY_TRANSFER_HOME"], testHome.contains("test-results/fusion-home-") else { fatalError("Disposable Fusion home required") }
        let fm = FileManager.default, home = URL(fileURLWithPath: testHome)
        defer { try? fm.removeItem(at: home) }
        func write(_ value: Any, _ url: URL) throws { try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true); try JSONSerialization.data(withJSONObject: value).write(to: url, options: .atomic) }
        func mode(_ value: String) async throws { var r = URLRequest(url: URL(string: app.api.baseURL + "/__test/fusion-mode")!); r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type"); r.httpBody = try JSONSerialization.data(withJSONObject: ["mode": value]); let (_, response) = try await URLSession.shared.data(for: r); precondition((response as? HTTPURLResponse)?.statusCode == 200) }
        await app.refreshFusion()
        precondition(app.fusionStatus?.fusion?.state == "not_installed" && app.fusionStatus?.targets["solidworks"]?.visible == false, "Fusion detection: \(app.fusionError ?? "")")
        let service = app.fusionService(), plugin = service.addinsRoot.appendingPathComponent("ReifyExport"), other = service.addinsRoot.appendingPathComponent("KeepOtherPlugin/note.txt")
        try fm.createDirectory(at: other.deletingLastPathComponent(), withIntermediateDirectories: true); try Data("keep unrelated plugin".utf8).write(to: other)
        try write(["version": "0.0.0"], plugin.appendingPathComponent("ReifyExport.manifest")); try Data("obsolete".utf8).write(to: plugin.appendingPathComponent("obsolete.py"))
        try fm.createDirectory(at: home.appendingPathComponent(".system-applications/Autodesk Fusion.app"), withIntermediateDirectories: true)
        await app.refreshFusion(); precondition(app.fusionStatus?.fusion?.state == "addin_not_running" && app.fusionStatus?.fusion?.updateAvailable == true)
        await app.installFusion()
        precondition(app.fusionError == nil && app.fusionStatus?.fusion?.updateAvailable != true && !fm.fileExists(atPath: plugin.appendingPathComponent("obsolete.py").path), "Original installer: \(app.fusionError ?? "")")
        for file in try fm.contentsOfDirectory(atPath: service.addin.path) { let expected = try Data(contentsOf: service.addin.appendingPathComponent(file)), actual = try Data(contentsOf: plugin.appendingPathComponent(file)); precondition(expected == actual, "Bundled Fusion asset changed: \(file)") }
        let otherText = try String(contentsOf: other, encoding: .utf8); precondition(otherText == "keep unrelated plugin")
        let heartbeat = service.transferRoot.appendingPathComponent("fusion/heartbeat.json")
        try write(["updatedAt": Date(timeIntervalSinceNow: -30).ISO8601Format(), "app": "Synthetic Fusion", "signedIn": true], heartbeat)
        await app.refreshFusion(); precondition(app.fusionStatus?.fusion?.state == "addin_not_running")
        var executorMode = "normal", seen = Set<String>(), executorJobs: [[String: Any]] = []
        let worker = Task { @MainActor in
            while !Task.isCancelled {
                do {
                    try write(["updatedAt": Date().ISO8601Format(), "app": "Synthetic Fusion", "signedIn": true], heartbeat)
                    let inbox = service.transferRoot.appendingPathComponent("fusion/inbox")
                    for name in (try? fm.contentsOfDirectory(atPath: inbox.path)) ?? [] where name.hasSuffix(".json") {
                        if seen.contains(name) || executorMode == "wait" { continue }
                        seen.insert(name)
                        let q = try JSONSerialization.jsonObject(with: Data(contentsOf: inbox.appendingPathComponent(name))) as! [String: Any]
                        executorJobs.append(q)
                        let id = q["jobId"] as! String, folder = service.transferRoot.appendingPathComponent("fusion/outbox/" + id)
                        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
                        try Data("Synthetic Fusion log".utf8).write(to: folder.appendingPathComponent("log.txt"))
                        if executorMode == "unsupported" { try write(["schema": "reify.transfer.result/1", "jobId": id, "ok": false, "error": ["code": "UNSUPPORTED_OP", "message": "Unsupported fixture operation", "feature": "plate/holes", "step": "hole"]], folder.appendingPathComponent("result.json")); continue }
                        try Data("Synthetic Fusion native bytes".utf8).write(to: folder.appendingPathComponent("part.f3d"))
                        try Data("Synthetic executor STEP".utf8).write(to: folder.appendingPathComponent("check.step"))
                        try write(["schema": "reify.transfer.result/1", "jobId": id, "ok": true, "features_built": 6, "feature_volumes": [["name": "plate/base", "volume_mm3": 6000]], "files": ["native": "part.f3d", "check_step": "check.step"]], folder.appendingPathComponent("result.json"))
                    }
                } catch { fatalError("Synthetic Fusion executable boundary failed: \(error)") }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        defer { worker.cancel() }
        try await Task.sleep(for: .milliseconds(120)); await app.refreshFusion()
        precondition(app.fusionReady && app.fusionError == nil, "Dispatcher failed: \(app.fusionError ?? "")")
        await app.testFusion()
        guard let test = app.fusionTest, test.ok, let exported = test.job, exported.state == "done", let native = exported.native, let folder = exported.nativeFolder else { fatalError("Original Fusion reference test failed: \(app.fusionError ?? app.fusionTest?.message ?? "no result")") }
        precondition(test.steps.count == 4 && exported.message.contains("shape check passed"))
        let downloaded = try await app.bridge.download(native); precondition(downloaded == Data("Synthetic Fusion native bytes".utf8))
        let localBytes = try Data(contentsOf: URL(fileURLWithPath: folder).appendingPathComponent((native as NSString).lastPathComponent)); precondition(localBytes == downloaded)
        func finish(_ id: String) async throws -> FusionJob {
            for _ in 0..<600 { if let job = app.fusionJobs.first(where: { $0.id == id }), !job.working { return job }; try await Task.sleep(for: .milliseconds(100)) }
            fatalError("Native Fusion job timed out: \(app.fusionJobs.first { $0.id == id }?.message ?? app.fusionError ?? "")")
        }
        guard let step = app.files.first(where: { $0.name == "bracket.step" }) else { fatalError("Missing current STEP") }
        await app.showFile(step); await app.exportFusion()
        guard let first = app.fusionJobs.first else { fatalError("Missing export: \(app.fusionError ?? "")") }
        let part = try await finish(first.id); precondition(part.state == "done" && part.native == "exports/bracket.f3d")
        // Use the exact current viewer source and its SHA, never a basename lookup.
        let currentPreview = app.preview
        app.permission = "read-only"; let count = app.fusionJobs.count
        await app.exportFusion(); precondition(app.fusionJobs.count == count); app.permission = "workspace"
        app.parameterPreviewActive = true; await app.exportFusion(); precondition(app.fusionJobs.count == count); app.parameterPreviewActive = false
        try await mode("shape-fail"); await app.exportFusion()
        let failed = try await finish(app.fusionJobs.first!.id)
        precondition(failed.state == "failed" && failed.error?.code == "TRANSFER_CHECK_FAILED" && failed.error?.feature == nil && failed.logPath != nil && app.preview == currentPreview, "Failed equivalence falsely passed: \(failed.state) \(failed.error?.code ?? "") \(failed.error?.feature ?? "") \(failed.logPath ?? "no log")")
        try await mode("displayed-mismatch"); await app.exportFusion()
        let wrongDocument = try await finish(app.fusionJobs.first!.id)
        precondition(wrongDocument.state == "failed" && wrongDocument.message.contains("与所看模型不一致"), "Same-name FreeCAD document exported another displayed geometry")
        try await mode("normal"); executorMode = "unsupported"; await app.exportFusion()
        let unsupported = try await finish(app.fusionJobs.first!.id)
        precondition(unsupported.state == "failed" && unsupported.error?.code == "TRANSFER_UNSUPPORTED_OP" && unsupported.error?.feature == "plate/holes" && unsupported.error?.step == "hole" && unsupported.logPath != nil, "Unsupported final result: \(unsupported.state) \(unsupported.error?.code ?? "") \(unsupported.error?.feature ?? "") \(unsupported.logPath ?? "no log")")
        executorMode = "wait"; await app.exportFusion(); let cancelled = app.fusionJobs.first!
        await app.cancelFusion(cancelled); let stopped = try await finish(cancelled.id); precondition(stopped.state == "cancelled")
        // Actual original assembly spool preserves occurrence identities and pose.
        let armPath = "arm.step", armBytes = Data("ISO-10303-21;\nSynthetic arm STEP".utf8)
        try await app.bridge.upload(armBytes, name: armPath)
        let armMesh = try await app.bridge.previewStep(armPath, expectedSHA: WorkspaceBridge.hash(armBytes)); app.preview = armMesh; app.previewName = armPath
        executorMode = "normal"; await app.exportFusion(); let arm = try await finish(app.fusionJobs.first!.id)
        precondition(arm.state == "done" && arm.native == "exports/arm.f3d" && arm.message.contains("Joints were not exported"))
        let assembly = executorJobs.first { $0["kind"] as? String == "assembly" }?["assembly"] as? [String: Any]
        precondition((assembly?["occurrences"] as? [[String: Any]])?.map { $0["id"] as! String } == ["left", "right"])
        let direct: JSONValue = try await app.engineering.request("transfer-export", fields: ["doc": "parts/arm.FCStd", "target": "fusion", "check": true, "jobId": "native-current-scope"])
        precondition(direct["check"]?.stringValue == "passed" && app.fusionJobs.contains { $0.id == "native-current-scope" }, "Current conversation spool was rejected")
        func scopedRequests(_ enabled: Bool) async throws {
            var request = URLRequest(url: URL(string: app.api.baseURL + "/__test/fusion-scope")!)
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["projectId": app.selected!.id, "sessionId": app.sessionID!, "enabled": enabled])
            let (_, response) = try await URLSession.shared.data(for: request); precondition((response as? HTTPURLResponse)?.statusCode == 200)
        }
        let scopedCount = app.fusionJobs.count
        try await scopedRequests(true); try await Task.sleep(for: .milliseconds(2500))
        precondition(app.fusionJobs.count == scopedCount && !executorJobs.contains { ["native-old-scope", "native-unbound-scope"].contains($0["jobId"] as? String ?? "") }, "Other/unbound conversation entered native Fusion")
        try await scopedRequests(false)
        let beforeReplacement = app.fusionJobs.count
        try await app.bridge.upload(Data("changed displayed STEP".utf8), name: armPath)
        await app.exportFusion()
        precondition(app.fusionJobs.count == beforeReplacement && app.fusionError?.contains("已变化") == true, "Changed viewer source entered an export")
        try await app.bridge.upload(armBytes, name: armPath)
        executorMode = "wait"
        await app.exportFusion(); let running = app.fusionJobs.first!
        let runningInbox = service.transferRoot.appendingPathComponent("fusion/inbox/" + running.id + ".json")
        for _ in 0..<120 { if fm.fileExists(atPath: runningInbox.path) { break }; try await Task.sleep(for: .milliseconds(100)) }
        precondition(fm.fileExists(atPath: runningInbox.path), "First Fusion job did not reach the executor")
        await app.exportFusion(); let queued = app.fusionJobs.first!
        try await Task.sleep(for: .milliseconds(2500))
        precondition(app.fusionJobs.first { $0.id == queued.id }?.state == "queued", "Second Fusion export bypassed original queue")
        await app.cancelFusion(queued); let stoppedQueue = try await finish(queued.id); precondition(stoppedQueue.state == "cancelled")
        await app.cancelFusion(running); let stoppedRun = try await finish(running.id); precondition(stoppedRun.state == "cancelled")
        try await mode("timeout"); await app.exportFusion(); let timeout = try await finish(app.fusionJobs.first!.id)
        precondition(timeout.state == "failed" && timeout.error?.code == "TRANSFER_TIMEOUT")
        try await mode("normal")
        await app.exportFusion()
        let oldGeneration = app.generation, oldSession = app.sessionID
        async let firstSwitch: Void = app.newConversation()
        async let secondSwitch: Void = app.newConversation()
        _ = await (firstSwitch, secondSwitch)
        precondition(app.generation == oldGeneration + 1 && app.sessionID != oldSession && app.fusionJobs.isEmpty && app.fusionAttached, "Concurrent switches or old Fusion events changed the new conversation")
        try await Task.sleep(for: .milliseconds(2500)); precondition(app.fusionJobs.isEmpty, "Old Fusion job restored state after conversation switch")
        await app.stopFusion(); precondition(app.fusion == nil && !app.fusionAttached)
        worker.cancel(); await app.connectFusion()
        print("PASS: original Fusion dispatcher/installer and transfer-export spool + shape equivalence checker over native HTTP/WebSocket and real disposable files; full bundled assets/version replacement/unrelated plugin preservation, app/heartbeat detection, original reference plate, byte-verified upload/local result, part/assembly identity and joint notice, failure/feature/log/timeout, original queue with queued/running cancellation, read-only/temporary-preview/changed-source and mismatched displayed-geometry refusal, direct current-conversation spool, foreign/legacy-unbound spool refusal, concurrent conversation switch and scope cleanup; CAD construction/inspection and Fusion executable results are synthetic")
    }
}
