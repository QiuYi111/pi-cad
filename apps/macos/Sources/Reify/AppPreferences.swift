import Foundation

enum AppPreferences {
    static let current: UserDefaults = {
        if let scope = ProcessInfo.processInfo.environment["REIFY_PREFERENCES_SCOPE"], !scope.isEmpty,
           let isolated = UserDefaults(suiteName: scope) { return isolated }
        return .standard
    }()
}
