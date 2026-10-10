import SwiftUI
import ReifyCloud

struct SimulationView: View {
    @EnvironmentObject var app: AppModel
    @State private var expanded = false
    @State private var youngs = "70000"
    @State private var poisson = "0.33"
    @State private var force = "-100"
    @State private var meshSize = "2"
    private var inputError: String? {
        do { _ = try SimulationInputs(youngs: youngs, poisson: poisson, force: force, meshSize: meshSize); return nil }
        catch { return error.localizedDescription }
    }
    private var source: MeshModel? { app.preview.flatMap { try? MeshModel.read($0) } }
    var body: some View {
        DisclosureGroup("结构分析", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 10) {
                Text("线性弹性 · torch-fem 0.9").font(ReifyDesign.font(13, .medium))
                Text(source?.source ?? "请先打开项目中的 STEP 模型").font(ReifyDesign.font(11)).textSelection(.enabled)
                if let sha = source?.sha256 { Text("文件版本：\(sha.prefix(10))").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted) }
                if let device = app.simulationRuntime?.device { Text(device).font(ReifyDesign.font(11)).foregroundStyle(ReifyDesign.muted) }
                if app.simulationChecking || app.simulationStarting {
                    ProgressView(app.simulationStarting ? "核对组件与模型…" : "检查云端 GPU 与组件…").accessibilityIdentifier("simulation.checking")
                } else {
                    Text(app.simulationRuntime?.detail ?? "先检查云端分析组件").font(ReifyDesign.font(11)).foregroundStyle(ReifyDesign.muted).textSelection(.enabled)
                    Button("重新检查组件") { Task { await app.checkSimulationRuntime() } }.disabled(!app.connected || app.generating).accessibilityIdentifier("simulation.check")
                }
                if app.simulationRuntime?.ready != true {
                    Text("组件由云端管理员安装，约 6 GB。缺少组件时，请联系管理员；安装后重新检查。").font(ReifyDesign.font(11)).foregroundStyle(ReifyDesign.muted)
                }
                field("弹性模量", value: $youngs, unit: "MPa", id: "youngs")
                field("泊松比", value: $poisson, unit: "", id: "poisson")
                field("Z 方向载荷", value: $force, unit: "N", id: "force")
                field("网格尺寸", value: $meshSize, unit: "mm", id: "mesh")
                Text("固定 x 最小面（X/Y/Z）\n总载荷作用于 x 最大面\n使用云端 GPU；运行后须检查收敛、反力、网格、位移与应力。").font(ReifyDesign.font(11)).foregroundStyle(ReifyDesign.muted)
                if let error = inputError ?? app.simulationError { Text(error).font(ReifyDesign.font(11)).foregroundStyle(.red).textSelection(.enabled).accessibilityIdentifier("simulation.error") }
                if app.simulationRunning {
                    Button("停止分析") { Task { await app.abort() } }.accessibilityIdentifier("simulation.stop")
                } else {
                    Button("确认并运行") { Task { await app.runSimulation(youngs: youngs, poisson: poisson, force: force, meshSize: meshSize) } }
                        .disabled(inputError != nil || !app.canRunSimulation || app.simulationChecking || app.simulationStarting || app.simulationRuntime?.ready != true)
                        .accessibilityIdentifier("simulation.run")
                }
            }.padding(.top, 10)
        }.font(ReifyDesign.font(12)).buttonStyle(ReifyButtonStyle()).accessibilityIdentifier("simulation.open")
            .onChange(of: expanded) { _, open in if open { Task { await app.checkSimulationRuntime() } } }
    }
    private func field(_ name: String, value: Binding<String>, unit: String, id: String) -> some View {
        HStack { Text(name).frame(width: 85, alignment: .leading); TextField(name, text: value).textFieldStyle(.roundedBorder).accessibilityIdentifier("simulation.\(id)"); Text(unit).frame(width: 30, alignment: .leading) }
            .disabled(app.simulationStarting || app.simulationRunning)
    }
}
