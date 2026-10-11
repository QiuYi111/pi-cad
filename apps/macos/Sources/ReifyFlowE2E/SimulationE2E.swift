import Foundation
import ReifyCloud

extension FlowE2E {
    @MainActor static func simulationE2E(_ app: AppModel) async throws {
        func mode(_ value: String) async throws {
            var r = URLRequest(url: URL(string: app.api.baseURL + "/__test/simulation-mode")!)
            r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: ["mode": value])
            let (_, response) = try await URLSession.shared.data(for: r); precondition((response as? HTTPURLResponse)?.statusCode == 200)
        }
        func settled() async throws {
            for _ in 0..<200 { if !app.generating { return }; try await Task.sleep(for: .milliseconds(50)) }
            fatalError("Analysis did not stop")
        }
        try await settled()
        for state in ["missing", "cpu", "wrong-version", "probe-error", "malformed", "forged-ready"] {
            try await mode(state); await app.checkSimulationRuntime()
            precondition(app.simulationRuntime?.ready != true && !app.simulationChecking, "Invalid solver was accepted: \(state)")
            if state == "missing" { precondition(app.simulationRuntime?.state == "missing") }
            if state == "cpu" || state == "wrong-version" || state == "probe-error" { precondition(app.simulationRuntime?.state == "failed") }
            if state == "malformed" || state == "forged-ready" { precondition(app.simulationError != nil) }
        }
        try await mode("normal"); await app.checkSimulationRuntime()
        precondition(app.simulationRuntime?.ready == true && app.simulationRuntime?.device == "Synthetic GPU" && app.simulationError == nil, "Original qualifier failed: \(app.simulationRuntime?.detail ?? app.simulationError ?? "")")
        guard let step = app.files.first(where: { $0.path == "bracket.step" }) else { fatalError("Missing exact current analysis STEP") }
        await app.showFile(step)
        guard let displayed = app.preview else { fatalError("Missing analysis viewer") }
        let mesh = try MeshModel.read(displayed), turn = app.turnSequence
        for values in [("0", "0.33", "-100", "2"), ("70000", "0.5", "-100", "2"), ("70000", "-1", "-100", "2"), ("70000", "0.33", "0", "2"), ("70000", "0.33", "-100", "0"), ("nan", "0.33", "-100", "2"), ("70000", "0.33", "inf", "2")] {
            await app.runSimulation(youngs: values.0, poisson: values.1, force: values.2, meshSize: values.3)
            precondition(app.turnSequence == turn && app.simulationError != nil, "Invalid parameters reached agent")
        }
        func run() async { await app.runSimulation(youngs: "70000", poisson: "0.33", force: "-100", meshSize: "2") }
        app.permission = "read-only"; await run(); precondition(app.turnSequence == turn); app.permission = "workspace"
        app.parameterPreviewActive = true; await run(); precondition(app.turnSequence == turn); app.parameterPreviewActive = false
        let writer = app.selected!
        var reader = try JSONSerialization.jsonObject(with: JSONEncoder().encode(writer)) as! [String: Any]; reader["role"] = "viewer"
        app.selected = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: reader))
        await run(); precondition(app.turnSequence == turn); app.selected = writer
        app.preview = Data("temporary unversioned preview".utf8); await run(); precondition(app.turnSequence == turn && app.simulationError != nil); app.preview = displayed
        let path = try app.bridge.relativeProjectPath(mesh.source!), bytes = try await app.bridge.download(path)
        try await app.bridge.upload(Data("changed STEP".utf8), name: path); await run()
        precondition(app.turnSequence == turn && app.simulationError?.contains("已变化") == true, "Changed model reached solver")
        try await app.bridge.upload(bytes, name: path)
        try await mode("missing"); await run(); precondition(app.turnSequence == turn && app.simulationRuntime?.ready != true)
        try await mode("normal")
        app.attachments = [ImageAttachment(id: "simulation-preserved-attachment", name: "草稿图片.png", data: Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=")!, mimeType: "image/png", remotePath: "images/keep-draft.png")]
        let savedDraft = "保留待发送内容", attachments = app.attachments
        app.draft = savedDraft
        await run()
        precondition(app.turnSequence == turn + 1 && app.draft == savedDraft && app.attachments == attachments && app.simulationError == nil, "Analysis lost draft or did not dispatch: \(app.simulationError ?? "")")
        let request = app.messages.last(where: { $0.role == "user" })?.text ?? ""
        precondition(request.contains("CAD artifact \(path) at SHA-256 \(mesh.sha256!).") && request.contains("E=70000 MPa, nu=0.33") && request.contains("mesh size=2 mm") && request.contains("[0,0,-100]") && request.contains("Do not accept the result from exit code alone."), "Analysis source/input/evidence binding lost")
        precondition(app.generating && app.simulationRunning, "Analysis Stop was not available")
        await app.abort()
        try await settled()
        // Preserve a valid value next to the exclusive nu=0.5 boundary; rounding
        // the user's input to 15 digits would silently turn it into invalid 0.5.
        await app.runSimulation(youngs: "210000.125", poisson: "0.49999999999999994", force: "250.5", meshSize: "0.25")
        let adjusted = app.messages.last(where: { $0.role == "user" })?.text ?? ""
        precondition(app.turnSequence == turn + 2 && app.simulationRunning && adjusted.contains("E=210000.125 MPa, nu=0.49999999999999994") && adjusted.contains("mesh size=0.25 mm") && adjusted.contains("[0,0,250.5]"), "Adjusted material/load/mesh values were rounded or lost")
        precondition(app.draft == savedDraft && app.attachments == attachments)
        await app.abort(); try await settled()
        // A completed qualification from another conversation must not enable Run.
        try await mode("delay")
        let checking = Task { await app.checkSimulationRuntime() }
        try await Task.sleep(for: .milliseconds(100)); await app.newConversation(); await checking.value
        precondition(app.simulationRuntime == nil && !app.simulationChecking && !app.simulationStarting && app.simulationTurn == nil, "Stale runtime crossed conversations")
        try await mode("normal"); await app.checkSimulationRuntime(); precondition(app.simulationRuntime?.ready == true)
        await app.showFile(step)
        let before = app.turnSequence
        try await mode("delay")
        let starting = Task { await run() }
        try await Task.sleep(for: .milliseconds(100)); await app.newConversation(); await starting.value
        precondition(app.turnSequence == before && app.simulationRuntime == nil && !app.simulationStarting, "Analysis preflight dispatched into a different conversation")
        try await mode("normal")
        print("PASS: native structural analysis over HTTP/WebSocket with original managed runtime qualifier/registry and original desktop Recipe request; missing/GPU/version/probe/malformed/forged-state refusal, finite material/load/mesh inputs, exact displayed STEP SHA, changed-source/read-only/viewer/temporary-preview refusal, draft preservation, abort, retry and delayed check/start conversation isolation. Linux runtime executables/GPU qualification outputs and agent/solver replies remain synthetic; no real calculation acceptance claimed")
    }
}
