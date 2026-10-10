import Foundation
import Darwin
import ReifyCloud

@main struct FlowE2E {
    @MainActor static func main() async throws {
        setbuf(stdout, nil)
        let scope = ProcessInfo.processInfo.environment["REIFY_PREFERENCES_SCOPE"]!
        AppPreferences.current.removePersistentDomain(forName: scope)
        defer { AppPreferences.current.removePersistentDomain(forName: scope) }
        let app = AppModel()
        try await app.api.logout()
        await app.login(email: "e2e@reify.test", password: "fixture-password", server: app.api.baseURL)
        guard app.user != nil, let project = app.projects.first else { fatalError("Fixture login failed") }
        await app.open(project)
        guard app.connected else { fatalError("Fixture connection failed: \(app.error ?? "")") }
        var choice = app.settingsDraft; choice.provider = "zai"; choice.model = "glm-5.3-flash"; choice.thinking = "high"
        guard await app.applySettings(choice) else { fatalError("Fixture GLM selection failed") }
        try await fusionE2E(app)
        await app.shutdown(); try await app.api.logout()
    }
}
