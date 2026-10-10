import SwiftUI
import ReifyCloud

@main struct ReifyApp: App {
    init() { ReifyDesign.registerFont() }
    @StateObject private var model = AppModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene {
        WindowGroup("Reify") {
            RootView().environmentObject(model).frame(minWidth: 920, minHeight: 620).task { delegate.shutdown = { await model.shutdown() }; await model.boot() }
        }
        .defaultSize(width: 1320, height: 850)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("新建项目") { model.newProjectPresented = true }.keyboardShortcut("n").disabled(model.user == nil)
                Button("新对话") { Task { await model.newConversation() } }.keyboardShortcut("n", modifiers: [.command, .shift]).disabled(!model.connected || model.generating)
            }
            CommandGroup(replacing: .appSettings) {
                Button("设置…") { model.settingsPresented = true }.keyboardShortcut(",")
            }
            CommandMenu("工作台") {
                Button(model.canvasMode ? "展开对话" : "切换到画布") { model.canvasMode.toggle(); model.filesOpen = false }
                    .keyboardShortcut("\\").disabled(model.selected == nil)
                Button("复位输入框") { model.composerX = 0.5; model.composerY = 0.82; model.saveLayout() }
            }
        }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    var shutdown: (() async -> Void)?
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task { await shutdown?(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}
