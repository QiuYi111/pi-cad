import Foundation
import JavaScriptCore
import ReifyCloud

struct FusionTarget: Codable {
    let state: String
    let visible: Bool
    let detail: String
    let note: String?
    let appVersion: String?
    let addinInstalledVersion: String?
    let addinBundledVersion: String?
    let updateAvailable: Bool?
    let heartbeatAgeS: Int?
    let signedIn: Bool?
}
struct FusionStatus: Codable {
    let platform: String
    let dispatcherActive: Bool
    let jobRoot: String
    let checkedAt: String
    let targets: [String: FusionTarget]
    var fusion: FusionTarget? { targets["fusion"] }
}
struct FusionJob: Codable, Identifiable {
    let jobId: String
    let target: String
    let state: String
    let message: String
    let updatedAt: String
    let part: String?
    let native: String?
    let nativeFolder: String?
    let logPath: String?
    struct Failure: Codable { let code: String; let message: String; let feature: String?; let step: String? }
    let error: Failure?
    var id: String { jobId }
    var working: Bool { state == "queued" || state == "running" }
}
struct FusionTest: Codable {
    let ok: Bool
    let message: String
    let logPath: String?
    let failedFeature: String?
    struct Step: Codable { let name: String; let ok: Bool; let detail: String? }
    let steps: [Step]
    let job: FusionJob?
}

/// Runs the original desktop CAD dispatcher locally. Swift provides confined
/// Mac file access and conversation-scoped network IO; Fusion executes its
/// original bundled add-in, and the cloud verifies the exported shape.
@MainActor final class NativeFusion {
    var onEvent: (([String: Any]) -> Void)?
    var authorized: (() -> Bool)?
    let home: URL
    let addin: URL
    let transferRoot: URL
    let addinsRoot: URL
    let cacheRoot: URL
    private let applicationRoot: URL
    private let context = JSContext()!
    private var failure: String?
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]
    private var timers: [String: Task<Void, Never>] = [:]
    private var bridge: WorkspaceBridge?
    private var projectRoot: String?
    private var sessionID: String?
    private var scope = ""
    private var tasks: [String: Task<Void, Never>] = [:]
    private var disposed = false
    private var closing = false
    private var knownJobs: Set<String> = []
    init() {
        let override = ProcessInfo.processInfo.environment["REIFY_TRANSFER_HOME"]
        home = URL(fileURLWithPath: override ?? FileManager.default.homeDirectoryForCurrentUser.path).standardizedFileURL.resolvingSymlinksInPath()
        applicationRoot = override == nil ? URL(fileURLWithPath: "/Applications") : home.appendingPathComponent(".system-applications")
        transferRoot = home.appendingPathComponent("Library/Application Support/Reify/transfer")
        addinsRoot = home.appendingPathComponent("Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns")
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        let packaged = Bundle.main.resourceURL?.appendingPathComponent("executors/fusion/ReifyExport")
        addin = packaged.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil } ?? executable.appendingPathComponent("ReifyExport")
        cacheRoot = FileManager.default.temporaryDirectory.appendingPathComponent("reify-fusion-\(UUID().uuidString)", isDirectory: true)
        context.exceptionHandler = { [weak self] _, value in self?.failure = value?.toString() }
        let pid: @convention(block) () -> Int = { Int(ProcessInfo.processInfo.processIdentifier) }
        let path: @convention(block) (String, String) -> String = { op, json in
            let args = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String] ?? []
            let value = args.first ?? ""
            if op == "join" { return (args.joined(separator: "/") as NSString).standardizingPath }
            if op == "dirname" { let value = (value as NSString).deletingLastPathComponent; return value.isEmpty ? "." : value }
            return (value as NSString).lastPathComponent
        }
        let fs: @convention(block) (String, String, String, String) -> String = { [weak self] op, path, text, other in
            do {
                guard let self else { throw CloudError("Fusion 服务已关闭") }
                let value = try self.file(op, path: path, text: text, other: other)
                return String(decoding: try JSONSerialization.data(withJSONObject: ["ok": true, "value": value]), as: UTF8.self)
            } catch { return String(decoding: (try? JSONSerialization.data(withJSONObject: ["ok": false, "error": error.localizedDescription])) ?? Data(), as: UTF8.self) }
        }
        let timer: @convention(block) (String, Int, Bool) -> Void = { [weak self] id, milliseconds, repeats in
            guard let self else { return }
            self.timers[id] = Task { @MainActor [weak self] in
                repeat {
                    do { try await Task.sleep(for: .milliseconds(max(1, milliseconds))) } catch { return }
                    guard let self, !self.disposed, !Task.isCancelled else { return }
                    self.context.objectForKeyedSubscript("reifyCadTimer")?.call(withArguments: [id])
                    if !repeats { self.timers.removeValue(forKey: id) }
                } while repeats
            }
        }
        let cancelTimer: @convention(block) (String) -> Void = { [weak self] id in self?.timers.removeValue(forKey: id)?.cancel() }
        let io: @convention(block) (String, String) -> Void = { [weak self] id, json in
            guard let self else { return }
            self.tasks[id] = Task { @MainActor [weak self] in
                guard let self else { return }
                defer { self.tasks.removeValue(forKey: id) }
                do {
                    let q = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
                    let value = try await self.remote(q)
                    guard !self.disposed, q["scope"] as? String == self.scope else { throw CloudError("Fusion 项目已切换") }
                    let data = try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
                    self.context.objectForKeyedSubscript("reifyCadResolve")?.call(withArguments: [id, String(decoding: data, as: UTF8.self), NSNull()])
                } catch {
                    guard !self.disposed else { return }
                    var detail: [String: Any] = ["message": error.localizedDescription]
                    if let error = error as? AuthorityError { detail["code"] = error.code; detail["target"] = error.target; detail["detail"] = error.detail?.foundationValue }
                    self.context.objectForKeyedSubscript("reifyCadResolve")?.call(withArguments: [id, "null", detail])
                }
            }
        }
        let event: @convention(block) (String) -> Void = { [weak self] json in
            if let value = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] {
                if let job = value["job"] as? [String: Any], let id = job["jobId"] as? String { self?.knownJobs.insert(id) }
                self?.onEvent?(value)
            }
        }
        let complete: @convention(block) (String, String, String) -> Void = { [weak self] id, json, error in
            guard let continuation = self?.pending.removeValue(forKey: id) else { return }
            if error.isEmpty { continuation.resume(returning: Data(json.utf8)) } else { continuation.resume(throwing: CloudError(error)) }
        }
        for (name, value) in [("nativeCadPID", pid as Any), ("nativeCadPath", path as Any), ("nativeCadFS", fs as Any), ("nativeCadTimer", timer as Any), ("nativeCadCancelTimer", cancelTimer as Any), ("nativeCadIO", io as Any), ("nativeCadEvent", event as Any), ("nativeCadComplete", complete as Any)] { context.setObject(value, forKeyedSubscript: name as NSString) }
        do {
            let resource = Bundle.main.url(forResource: "DesktopTransfer", withExtension: "js") ?? executable.appendingPathComponent("DesktopTransfer.js")
            context.evaluateScript(try String(contentsOf: resource, encoding: .utf8))
            context.objectForKeyedSubscript("reifyCadInit")?.call(withArguments: [home.path, addin.path])
        } catch { failure = "Fusion 组件缺失，请重新安装客户端" }
    }
    func request<T: Decodable>(_ operation: String, fields: [String: Any] = [:], timeout: Int = 30) async throws -> T {
        if let failure { throw CloudError(failure) }
        guard !disposed else { throw CloudError("Fusion 服务已关闭") }
        let id = UUID().uuidString, json = String(decoding: try JSONSerialization.data(withJSONObject: fields), as: UTF8.self)
        let bytes = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            pending[id] = continuation
            context.objectForKeyedSubscript("reifyCadRequest")?.call(withArguments: [id, operation, json])
            if let failure { pending.removeValue(forKey: id)?.resume(throwing: CloudError(failure)) }
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                self?.pending.removeValue(forKey: id)?.resume(throwing: CloudError("Fusion 操作超时"))
            }
        }
        return try JSONDecoder().decode(T.self, from: bytes)
    }
    func attach(bridge: WorkspaceBridge, sessionID: String?) async throws -> FusionStatus {
        guard let root = bridge.projectRoot else { throw CloudError("请先连接项目") }
        self.bridge = bridge; projectRoot = root; self.sessionID = sessionID; scope = UUID().uuidString
        return try await request("attach", fields: ["root": root, "scope": scope, "sessionId": sessionID.map { $0 as Any } ?? NSNull()])
    }
    func stop() async {
        guard !disposed else { return }
        closing = true
        let _: Bool? = try? await request("close", timeout: 8)
        dispose()
    }
    func dispose() {
        guard !disposed else { return }
        disposed = true; onEvent = nil
        context.objectForKeyedSubscript("reifyCadDispose")?.call(withArguments: [])
        for task in timers.values { task.cancel() }; timers.removeAll()
        for task in tasks.values { task.cancel() }; tasks.removeAll()
        for continuation in pending.values { continuation.resume(throwing: CloudError("Fusion 连接已关闭")) }; pending.removeAll()
        scope = ""; bridge = nil; projectRoot = nil
    }
    private func local(_ path: String, roots: [URL]) throws -> URL {
        let value = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        guard roots.contains(where: { value.path == $0.standardizedFileURL.resolvingSymlinksInPath().path || value.path.hasPrefix($0.standardizedFileURL.resolvingSymlinksInPath().path + "/") }) else { throw CloudError("Fusion 文件路径不属于客户端") }
        return value
    }
    private func file(_ op: String, path: String, text: String, other: String) throws -> Any {
        let fm = FileManager.default
        let appNames = ["Autodesk Fusion.app", "Autodesk Fusion 360.app"]
        if op == "exists", appNames.contains((path as NSString).lastPathComponent), (path as NSString).deletingLastPathComponent == "/Applications" { return fm.fileExists(atPath: applicationRoot.appendingPathComponent((path as NSString).lastPathComponent).path) }
        let url = try local(path, roots: [transferRoot, addinsRoot, addin, home.appendingPathComponent("Applications")])
        switch op {
        case "exists": return fm.fileExists(atPath: url.path)
        case "read": return (try? String(contentsOf: url, encoding: .utf8)).map { $0 as Any } ?? NSNull()
        case "list": return (try? fm.contentsOfDirectory(atPath: url.path)) ?? []
        case "mkdir":
            _ = try local(path, roots: [transferRoot, addinsRoot]); try fm.createDirectory(at: url, withIntermediateDirectories: true)
        case "write":
            _ = try local(path, roots: [transferRoot]); try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true); try Data(text.utf8).write(to: url, options: .atomic)
        case "remove":
            let plugin = addinsRoot.appendingPathComponent("ReifyExport").standardizedFileURL.resolvingSymlinksInPath()
            guard url == plugin || url.path.hasPrefix(transferRoot.standardizedFileURL.resolvingSymlinksInPath().path + "/") else { throw CloudError("不能删除其他 Fusion 插件") }
            if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) }
        case "copy":
            guard url == addin.standardizedFileURL.resolvingSymlinksInPath(), URL(fileURLWithPath: other).standardizedFileURL == addinsRoot.appendingPathComponent("ReifyExport").standardizedFileURL else { throw CloudError("插件复制路径无效") }
            let target = try local(other, roots: [addinsRoot]); try fm.copyItem(at: url, to: target)
        default: throw CloudError("未知 Fusion 文件操作")
        }
        return NSNull()
    }
    private func relative(_ path: String) throws -> String {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), !path.contains("\0"), !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." || $0.isEmpty }) else { throw CloudError("Fusion 文件不属于项目") }
        return path
    }
    private func remote(_ q: [String: Any]) async throws -> Any {
        guard let bridge, let root = projectRoot, q["scope"] as? String == scope, root == bridge.projectRoot else { throw CloudError("Fusion 项目已切换") }
        let op = q["operation"] as? String ?? ""
        let closingPath = q["path"] as? String ?? ""
        let leaf = (closingPath as NSString).lastPathComponent
        let jobID = (leaf as NSString).deletingPathExtension
        let jobCleanup = knownJobs.contains(leaf) || knownJobs.contains(jobID)
        let cleanup = closing && (
            ["read", "list", "exists", "metadata", "cache"].contains(op)
            || (op == "upload" && jobCleanup && closingPath.hasPrefix(".pi-cad/transfer/logs/"))
            || (op == "write" && jobCleanup && ["cancel", "status", "results"].contains((closingPath as NSString).deletingLastPathComponent.components(separatedBy: "/").last ?? "") && closingPath.hasPrefix(".pi-cad/transfer/"))
            || (op == "write" && closingPath == ".pi-cad/transfer/dispatcher.json" && (q["text"] as? String)?.contains("\"stopped\": true") == true)
        )
        guard (!closing && authorized?() == true) || cleanup else { throw CloudError("当前项目没有写入权限，或对话已切换") }
        if op == "agent" {
            let body = q["body"] as? [String: Any] ?? [:], operation = body["op"] as? String ?? ""
            guard ["part-open", "part-apply", "transfer-export"].contains(operation) else { throw CloudError("Fusion 请求无效") }
            var snapshots: [(String, String)] = []
            if operation == "transfer-export", let source = q["source"] as? [String: Any], let path = source["path"] as? String, let expected = source["sha256"] as? String, let doc = body["doc"] as? String {
                for (file, expectedSHA) in [(path, Optional(expected)), (doc, nil)] {
                    let metadata = try await remote(["scope": scope, "operation": "metadata", "path": file]) as? [String: Any]
                    guard let sha = metadata?["sha256"] as? String, expectedSHA == nil || expectedSHA == sha else { throw CloudError("所看模型的文件已变化，未导出新版本") }
                    snapshots.append((file, sha))
                }
            }
            let service = EngineeringService(bridge: bridge, sessionID: sessionID)
            let value: JSONValue = try await service.request(operation, fields: body.filter { $0.key != "op" }, timeoutMs: q["timeout"] as? Int ?? 60000)
            if operation == "transfer-export", let source = q["source"] as? [String: Any], let path = source["path"] as? String, let jobID = body["jobId"] as? String {
                let fields: [String: Any] = ["root": root, "source": path, "jobId": jobID]
                let result = try await bridge.execResult(["/opt/reify/node/bin/node", "-e", Self.viewerCheckScript], input: String(decoding: try JSONSerialization.data(withJSONObject: fields), as: UTF8.self), timeoutMs: 180000)
                guard result["code"] as? Int == 0, let output = result["stdout"] as? String,
                      let check = (try? JSONSerialization.jsonObject(with: Data(output.utf8))) as? [String: Any], check["passed"] as? Bool == true else {
                    throw CloudError("Fusion 对应的 FreeCAD 文档与所看模型不一致，或无法核对形状。结果未通过检查，请重新制作并导出。")
                }
            }
            for (file, expectedSHA) in snapshots {
                let metadata = try await remote(["scope": scope, "operation": "metadata", "path": file]) as? [String: Any]
                guard metadata?["sha256"] as? String == expectedSHA else { throw CloudError("导出期间模型或 FreeCAD 文档已变化，请重新导出") }
            }
            return value.foundationValue
        }
        let path = try relative(q["path"] as? String ?? "")
        if op == "upload" {
            let localFile = try local(q["file"] as? String ?? "", roots: [transferRoot])
            let bytes = try Data(contentsOf: localFile)
            guard bytes.count <= 64 * 1024 * 1024 else { throw CloudError("Fusion 文件超过 64 MB") }
            try await bridge.upload(bytes, name: path)
            guard WorkspaceBridge.hash(try await bridge.download(path)) == WorkspaceBridge.hash(bytes) else { throw CloudError("Fusion 上传校验失败") }
            let target = try local(cacheRoot.appendingPathComponent(path).path, roots: [cacheRoot])
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true); try bytes.write(to: target, options: .atomic)
            return NSNull()
        }
        var fields: [String: Any] = ["root": root, "operation": op == "cache" ? "metadata" : op, "path": path]
        if op == "write" { fields["text"] = q["text"] as? String ?? "" }
        let output = try await bridge.exec(["/opt/reify/node/bin/node", "-e", Self.projectScript], input: String(decoding: try JSONSerialization.data(withJSONObject: fields), as: UTF8.self))
        let value = try JSONSerialization.jsonObject(with: Data(output.utf8), options: .fragmentsAllowed)
        if op == "cache" {
            let meta = value as? [String: Any] ?? [:]
            let target = try local(cacheRoot.appendingPathComponent(path).path, roots: [cacheRoot])
            if meta["directory"] as? Bool == true {
                guard FileManager.default.fileExists(atPath: target.path) else { throw CloudError("本机尚无此导出目录") }
                return target.path
            }
            let bytes = try await bridge.download(path)
            guard WorkspaceBridge.hash(bytes) == meta["sha256"] as? String else { throw CloudError("Fusion 文件已变化") }
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true); try bytes.write(to: target, options: .atomic)
            return target.path
        }
        return value
    }
    private static let viewerCheckScript = #"""
    // REIFY_TRANSFER_VIEW
    let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{(async()=>{
      const fs=require('fs'),p=require('path'),q=JSON.parse(text),root=fs.realpathSync(q.root),jiti=require('/opt/reify/pi-cad/node_modules/jiti').createJiti('/opt/reify/pi-cad/package.json');
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(q.jobId))throw Error('Invalid transfer job');
      const work='build/transfer/'+q.jobId,reference=work+'/reference.step';
      for(const path of [q.source,reference,work+'/displayed.geometry.json',work+'/displayed-reference.geometry.json']){let ancestor=p.resolve(root,path);while(!fs.existsSync(ancestor))ancestor=p.dirname(ancestor);const real=fs.realpathSync(ancestor);if(real!==root&&!real.startsWith(root+p.sep))throw Error('Transfer geometry escapes project')}
      const {compareEquivalence}=await jiti.import('/opt/reify/pi-cad/src/agent-api/transfer-check.ts');
      const inspector=await jiti.import('/opt/reify/pi-cad/src/shared/capability.ts');
      const [source,ref]=await Promise.all([inspector.inspectGeometry(root,q.source,work+'/displayed.geometry.json'),inspector.inspectGeometry(root,reference,work+'/displayed-reference.geometry.json')]);
      if(!source.ok||!ref.ok)throw Error('Cannot inspect displayed geometry');console.log(JSON.stringify(compareEquivalence(source.payload,ref.payload)));
    })().catch(error=>{console.error(error.message);process.exitCode=1})});
    """#
    private static let projectScript = #"""
    // REIFY_TRANSFER_IO
    const fs=require('fs'),p=require('path'),c=require('crypto');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{try{const q=JSON.parse(input),root=fs.realpathSync(q.root);if(typeof q.path!=='string'||q.path.startsWith('/')||q.path.includes('\0')||q.path.includes('\\')||q.path.split('/').some(x=>!x||x==='..'))throw Error('Fusion 文件不属于项目');const file=p.join(root,q.path);let ancestor=file;while(!fs.existsSync(ancestor))ancestor=p.dirname(ancestor);const real=fs.realpathSync(ancestor);if(real!==root&&!real.startsWith(root+p.sep))throw Error('Fusion 文件逃逸项目');let value=null;
    if(q.operation==='read')value=fs.existsSync(file)&&fs.statSync(file).isFile()?fs.readFileSync(file,'utf8'):null;
    else if(q.operation==='list')value=fs.existsSync(file)&&fs.statSync(file).isDirectory()?fs.readdirSync(file):[];
    else if(q.operation==='exists')value=fs.existsSync(file);
    else if(q.operation==='write'){fs.mkdirSync(p.dirname(file),{recursive:true});const tmp=file+'.'+c.randomUUID()+'.tmp';fs.writeFileSync(tmp,q.text);fs.renameSync(tmp,file)}
    else if(q.operation==='remove')fs.rmSync(file,{force:true});
    else if(q.operation==='metadata'){const s=fs.statSync(file);value=s.isDirectory()?{directory:true}:{directory:false,sha256:c.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}}
    else throw Error('Fusion 项目操作无效');console.log(JSON.stringify(value));}catch(error){console.error(error.message);process.exitCode=1}});
    """#
}
