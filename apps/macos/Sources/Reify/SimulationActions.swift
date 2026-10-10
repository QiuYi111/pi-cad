import Foundation
import ReifyCloud

struct SimulationInputs {
    let youngs: Double, poisson: Double, force: Double, meshSize: Double
    init(youngs: String, poisson: String, force: String, meshSize: String) throws {
        guard let e = Double(youngs), e.isFinite, e > 0 else { throw CloudError("弹性模量须大于 0") }
        guard let n = Double(poisson), n.isFinite, n > -1, n < 0.5 else { throw CloudError("泊松比须大于 -1、小于 0.5") }
        guard let f = Double(force), f.isFinite, f != 0 else { throw CloudError("载荷须为非零数值") }
        guard let m = Double(meshSize), m.isFinite, m > 0 else { throw CloudError("网格尺寸须大于 0") }
        self.youngs = e; self.poisson = n; self.force = f; self.meshSize = m
    }
    func prompt(path: String, sha: String) -> String {
        func number(_ n: Double) -> String {
            let text = String(n)
            return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
        }
        return "Run the managed simulation/torch-fem-linear-elastic Recipe for CAD artifact \(path) at SHA-256 \(sha). The user confirmed: linear elastic material E=\(number(youngs)) MPa, nu=\(number(poisson)); tetrahedral mesh size=\(number(meshSize)) mm; fix all DOFs on the x-min face; apply total force [0,0,\(number(force))] N on the x-max face. Copy the repository Recipe into simulation/torch-fem-linear-elastic, bind the exact CAD/material/constraints/load/mesh/runtime inputs, run preflight and the managed CUDA solver, and record convergence, reaction balance, mesh refinement, displacement/stress fields, scalar extrema, visualization and runtime health. Do not accept the result from exit code alone."
    }
}

struct SimulationRuntime {
    let state: String, detail: String
    let identity: JSONValue?
    var ready: Bool { state == "ready" }
    var device: String? { identity?["accelerator"]?["gpu"]?.stringValue }
}

extension AppModel {
    var canRunSimulation: Bool { connected && !busy && !generating && !parameterBusy && !parameterPreviewActive && selected?.role != "viewer" && permission != "read-only" }
    var simulationRunning: Bool { generating && simulationTurn == turnSequence }
    func clearSimulation() {
        simulationSequence += 1; simulationRuntime = nil; simulationChecking = false
        simulationStarting = false; simulationError = nil; simulationTurn = nil
    }
    func checkSimulationRuntime() async {
        guard connected, !simulationChecking, !simulationStarting else { return }
        simulationSequence += 1
        let sequence = simulationSequence, current = generation, scope = sessionID
        simulationChecking = true; simulationError = nil; simulationRuntime = nil
        defer { if sequence == simulationSequence { simulationChecking = false } }
        do {
            let result = try await probeSimulationRuntime()
            guard current == generation, scope == sessionID, sequence == simulationSequence else { return }
            simulationRuntime = result
        } catch { if current == generation, scope == sessionID, sequence == simulationSequence { simulationError = error.localizedDescription } }
    }
    private func probeSimulationRuntime() async throws -> SimulationRuntime {
        guard let root = bridge.projectRoot else { throw CloudError("请先连接项目") }
        let request: [String: Any] = ["root": root]
        let text = try await bridge.exec(["/opt/reify/node/bin/node", "-e", Self.simulationProbeScript], input: String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self), timeoutMs: 420000)
        guard let response = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], response["schema"] as? Int == 1,
              let state = response["state"] as? String, ["ready", "missing", "failed"].contains(state), let detail = response["detail"] as? String else { throw CloudError("云端分析组件状态格式错误") }
        let identity = response["identity"].flatMap { try? JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: $0)) }
        if state == "ready" {
            guard let i = response["identity"] as? [String: Any], i["backend"] as? String == "torch-fem", i["runtime"] as? String == "torch-fem-0.9-cu126",
                  let digest = i["digest"] as? String, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let a = i["accelerator"] as? [String: Any], a["actualDevice"] as? String == "cuda", a["requestedDevice"] as? String == "cuda", a["cudaAvailable"] as? Bool == true,
                  a["torch-fem"] as? String == "0.9.0", a["torch"] as? String == "2.13.0+cu126", a["cupy"] as? String == "14.1.1" else { throw CloudError("云端组件版本或 GPU 检查未通过") }
        }
        return SimulationRuntime(state: state, detail: detail, identity: identity)
    }
    func runSimulation(youngs: String, poisson: String, force: String, meshSize: String) async {
        guard canRunSimulation, !simulationStarting, !simulationChecking else { return }
        simulationSequence += 1
        let sequence = simulationSequence, current = generation, scope = sessionID, displayed = preview
        simulationStarting = true; simulationError = nil
        defer { if sequence == simulationSequence { simulationStarting = false } }
        do {
            let inputs = try SimulationInputs(youngs: youngs, poisson: poisson, force: force, meshSize: meshSize)
            guard let displayed else { throw CloudError("请先打开模型") }
            let mesh = try MeshModel.read(displayed)
            guard let source = mesh.source, let sha = mesh.sha256, sha.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CloudError("当前模型缺少文件版本，请打开项目中的 STEP 模型") }
            let path = try bridge.relativeProjectPath(source)
            guard ["step", "stp"].contains((path as NSString).pathExtension.lowercased()) else { throw CloudError("结构分析需要 STEP 模型") }
            let runtime = try await probeSimulationRuntime()
            guard sequence == simulationSequence, current == generation, scope == sessionID, preview == displayed, canRunSimulation else { throw CancellationError() }
            simulationRuntime = runtime
            guard runtime.ready else { throw CloudError("云端分析组件尚未就绪。\(runtime.detail)") }
            _ = try await currentModelExportData()
            guard sequence == simulationSequence, current == generation, scope == sessionID, preview == displayed, canRunSimulation else { throw CancellationError() }
            simulationTurn = turnSequence + 1
            await send(inputs.prompt(path: path, sha: sha))
        } catch { if sequence == simulationSequence, current == generation, scope == sessionID, !(error is CancellationError) { simulationError = error.localizedDescription } }
    }
    // Execute the repository's pinned qualifier, including its real CUDA sparse
    // solve and immutable runtime hash. Never accept a cached availability file.
    static let simulationProbeScript = #"""
    // REIFY_SIMULATION_RUNTIME
    const fs=require('node:fs');
    const q=JSON.parse(fs.readFileSync(0,'utf8'));
    const root=fs.realpathSync(q.root);
    process.env.PI_CAD_REQUALIFY_RUNTIME='1';
    (async()=>{try {
      const jiti=require('/opt/reify/pi-cad/node_modules/jiti').createJiti('/opt/reify/pi-cad/package.json');
      const {ManagedSimulationRunner}=await jiti.import('/opt/reify/pi-cad/src/modules/simulate-v2/runtime.ts');
      const identity=await new ManagedSimulationRunner().resolveRuntime(root,'torch-fem','torch-fem-0.9-cu126');
      console.log(JSON.stringify({schema:1,state:'ready',detail:'云端 GPU 和固定版本组件检查通过',identity}));
    } catch(error) {
      const detail=String(error.message||error).slice(0,8192);
      console.log(JSON.stringify({schema:1,state:/ENOENT|test exited 1|not found|No such file/.test(detail)?'missing':'failed',detail}));
    }})().catch(error=>{console.error(error);process.exitCode=1});
    """#
}
