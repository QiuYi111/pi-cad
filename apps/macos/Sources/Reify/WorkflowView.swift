import SwiftUI
import ReifyCloud

struct WorkflowLibraryView: View {
    @EnvironmentObject var app: AppModel
    @State private var documents: [WorkflowDocument] = []
    @State private var selection: String?
    @State private var source = ""
    @State private var creating = false
    @State private var phaseID: String?
    @State private var sourceOpen = false
    @State private var working = false
    @State private var message = ""
    @State private var failed = false
    @State private var deleting = false
    private var document: WorkflowDocument? { documents.first { $0.key == selection } }
    private var phase: WorkflowPhase? { document?.phases.first { $0.id == phaseID } ?? document?.phases.first }
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                HStack { Text("工作流").font(ReifyDesign.font(20, .medium)); Spacer(); Button { create() } label: { Image(systemName: "plus") }.accessibilityIdentifier("workflow.new") }
                if working { ProgressView().controlSize(.small) }
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(documents, id: \.key) { item in
                            Button { select(item) } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(item.id).font(ReifyDesign.font(13, .medium))
                                    Text("v\(item.version) · \(item.adopted ? "使用中" : "可用")").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted)
                                    Text(item.description).font(ReifyDesign.font(11)).foregroundStyle(ReifyDesign.muted)
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                                    .background(selection == item.key ? ReifyDesign.panel : .clear, in: RoundedRectangle(cornerRadius: 9))
                            }.buttonStyle(.plain).accessibilityIdentifier("workflow.\(item.key)")
                        }
                    }
                }
                Button("重新读取") { Task { await reload() } }.accessibilityIdentifier("workflow.reload")
            }.padding(20).frame(width: 240).background(ReifyDesign.paper)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(document?.id == "mechanical.naked" ? "运行模式" : "工作流文件").foregroundStyle(ReifyDesign.muted)
                            Text(creating ? "新建工作流" : document?.id ?? "选择工作流").font(ReifyDesign.font(24, .medium))
                        }
                        Spacer()
                        if creating || document?.editable == true {
                            Button(sourceOpen ? "收起源码" : "编辑源码") { sourceOpen.toggle() }.accessibilityIdentifier("workflow.source-toggle")
                            Button("保存") { Task { await save() } }.buttonStyle(ReifyButtonStyle(primary: true)).accessibilityIdentifier("workflow.save")
                            if !creating { Button("删除") { deleting = true }.accessibilityIdentifier("workflow.delete") }
                        }
                        if let document, document.id != "mechanical.naked", !document.adopted {
                            Button("使用此版本") { Task { await adopt(document) } }.accessibilityIdentifier("workflow.adopt")
                        }
                    }.buttonStyle(ReifyButtonStyle())
                    if !message.isEmpty { Text(message).foregroundStyle(failed ? .red : ReifyDesign.green).textSelection(.enabled).accessibilityIdentifier("workflow.message") }
                    if sourceOpen {
                        TextEditor(text: $source).font(.system(size: 12, design: .monospaced)).frame(minHeight: 340)
                            .padding(10).background(ReifyDesign.paper, in: RoundedRectangle(cornerRadius: 10)).accessibilityIdentifier("workflow.source")
                    }
                    if let document {
                        ScrollView(.horizontal) {
                            HStack { ForEach(document.phases) { item in Button(item.title) { phaseID = item.id }.buttonStyle(ReifyButtonStyle(primary: phase?.id == item.id)) } }
                        }
                        if let phase {
                            VStack(alignment: .leading, spacing: 16) {
                                Text(phase.title).font(ReifyDesign.font(20, .medium))
                                Text(phase.purpose).textSelection(.enabled)
                                Text("可用操作").foregroundStyle(ReifyDesign.muted)
                                Text(phase.capabilities.isEmpty ? "无" : phase.capabilities.joined(separator: " · ")).textSelection(.enabled)
                                Text("所需记录和证据").foregroundStyle(ReifyDesign.muted)
                                if phase.obligations.isEmpty { Text("无") }
                                ForEach(phase.obligations, id: \.self) { Text($0).textSelection(.enabled) }
                                Text("阶段变化").foregroundStyle(ReifyDesign.muted)
                                ForEach(phase.transitions) { transition in HStack { Text(transition.event); Image(systemName: "chevron.right"); Text(transition.target) } }
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(22)
                                .background(ReifyDesign.paper, in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                }.padding(28)
            }.background(ReifyDesign.canvas)
        }.disabled(working).task { await reload() }
            .alert("删除工作流？", isPresented: $deleting) {
                Button("删除", role: .destructive) { if let document { Task { await remove(document) } } }
                Button("取消", role: .cancel) { }
            } message: { Text("删除 \(document?.key ?? "")") }
    }
    private func select(_ item: WorkflowDocument) {
        selection = item.key; creating = false; source = item.raw; phaseID = item.phases.first?.id; sourceOpen = false; message = ""
    }
    private func create() {
        creating = true; selection = nil; sourceOpen = true; message = ""
        source = """
        schema: 1
        id: custom.workflow
        description: 项目工作流
        tags: [custom]
        version: 1.0.0
        workflow:
          schema: 1
          id: custom.workflow
          version: 1.0.0
          parametersSchema: {type: object, additionalProperties: false}
          initialPhase: work
          phases:
            work:
              purpose: 完成项目工作
              actions: [transition]
              grants: [file_read, transition]
              writeScopes: []
              recordObligations: []
              evidenceObligations: []
              contextProviders: [kernel.current-action]
              hooks: []
              transitions: {finished: {target: done}}
            done:
              purpose: 保存完成结果
              actions: []
              grants: [file_read]
              writeScopes: []
              recordObligations: []
              evidenceObligations: []
              contextProviders: [kernel.current-action]
              hooks: []
              transitions: {}
              terminal: true
        """
    }
    private func reload() async {
        working = true; defer { working = false }
        do {
            try await app.prepareConfiguration()
            documents = try await WorkflowLibrary(bridge: app.bridge).list()
            if let next = documents.first(where: { $0.key == selection }) ?? documents.first { select(next) }
            failed = false
        } catch { message = error.localizedDescription; failed = true }
    }
    private func save() async {
        working = true; defer { working = false }
        do {
            let library = WorkflowLibrary(bridge: app.bridge)
            let saved = try await library.save(source, original: document)
            documents = try await library.list(); select(saved); message = "已保存，校验通过"; failed = false
        } catch { message = error.localizedDescription; failed = true }
    }
    private func remove(_ item: WorkflowDocument) async {
        working = true; defer { working = false }
        do {
            let library = WorkflowLibrary(bridge: app.bridge)
            try await library.delete(item); documents = try await library.list()
            selection = nil; source = ""; if let next = documents.first { select(next) }
            message = "已删除 \(item.key)"; failed = false
        } catch { message = error.localizedDescription; failed = true }
    }
    private func adopt(_ item: WorkflowDocument) async {
        working = true; defer { working = false }
        do {
            let library = WorkflowLibrary(bridge: app.bridge)
            try await library.adopt(item, identity: app.user?.email ?? "native-client")
            documents = try await library.list(); message = "已使用 \(item.key)"; failed = false
        } catch { message = error.localizedDescription; failed = true }
    }
}

struct WorkflowRailView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        HStack(spacing: 14) {
            if let run = app.workflowRun {
                Text(run.workflowId).foregroundStyle(ReifyDesign.muted)
                ScrollView(.horizontal) {
                    HStack(spacing: 14) {
                        ForEach(run.phases) { phase in
                            HStack(spacing: 5) {
                                Image(systemName: phase.status == "complete" ? "checkmark.circle.fill" : phase.status == "active" ? "circle.inset.filled" : "circle")
                                Text(phase.title)
                            }.foregroundStyle(phase.status == "active" ? ReifyDesign.green : ReifyDesign.muted).help(phase.purpose)
                        }
                    }
                }
                Text(run.status)
            } else { Text(app.engineeringLoading ? "读取工程状态…" : app.engineeringError == nil ? "当前对话尚无工作流" : "工程状态读取失败").foregroundStyle(ReifyDesign.muted) }
            Spacer(minLength: 0)
            Button { Task { await app.refreshEngineering() } } label: { Image(systemName: "arrow.clockwise") }
                .disabled(!app.connected || app.engineeringLoading).accessibilityIdentifier("engineering.refresh")
        }.font(ReifyDesign.font(10)).buttonStyle(.plain).padding(.horizontal, 18).frame(height: 36)
            .background(ReifyDesign.paper).overlay(alignment: .bottom) { Divider() }.accessibilityIdentifier("workflow.rail")
    }
}
