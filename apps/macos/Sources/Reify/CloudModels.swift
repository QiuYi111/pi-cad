import Foundation
import ReifyCloud

struct CloudModelChoice: Identifiable {
    var id: String { provider + "/" + model }
    let provider: String
    let model: String
    let name: String
}

extension AppModel {
    func loadCloudModels() async {
        guard connected, let selected else { modelCatalogMessage = "打开云端项目后可读取模型列表。"; return }
        modelCatalogMessage = "正在读取云端模型…"
        do {
            let text = try await bridge.exec([
                "/opt/reify/node/bin/node", "/opt/reify/pi-cad/scripts/desktop-prime-config.mjs",
                "/opt/reify/prime-agent", "/workspace/home/.prime/agent", "/workspace/projects/\(selected.id)", "catalog"
            ], input: "{}")
            guard let catalog = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw CloudError("云端模型列表无效") }
            cloudModels = (catalog["providers"] as? [[String: Any]] ?? []).flatMap { provider in
                (provider["models"] as? [[String: Any]] ?? []).compactMap { row in
                    guard row["available"] as? Bool == true, let id = row["id"] as? String, let source = row["provider"] as? String else { return nil }
                    return CloudModelChoice(provider: source, model: id, name: row["name"] as? String ?? id)
                }
            }
            modelCatalogMessage = cloudModels.isEmpty ? "云端没有已配置的模型。" : "已读取云端模型"
        } catch { modelCatalogMessage = error.localizedDescription }
    }
}
