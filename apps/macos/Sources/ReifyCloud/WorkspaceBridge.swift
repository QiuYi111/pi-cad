import Foundation
import CryptoKit

@MainActor public final class WorkspaceBridge {
    public var onEvent: (([String: Any]) -> Void)?
    public var onDisconnect: ((Error) -> Void)?
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var pending: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var pendingIDs: [String: UUID] = [:]
    private var buffers: [Int: Data] = [:]
    private var stdout = Data()
    private var replaying = false
    private var channel = 3
    private var sequence = 0
    private var projectID = ""
    private var spawnKey: String?
    private var stopping = false
    private var processes: [Int: RemoteProcess] = [:]
    public private(set) var spawnID: String?
    public var isOpen: Bool { socket != nil }
    public var projectRoot: String? { projectID.isEmpty ? nil : "/workspace/projects/\(projectID)" }
    public init() {}
    public func openServices(api: CloudAPI, projectID: String? = nil) async throws {
        close(); self.projectID = projectID ?? ""
        let ws = try await api.socket("/v1/workspace/bridge"); socket = ws; read(ws)
    }
    public func connect(api: CloudAPI, project: Project, provider: String, model: String, thinking: String, reviewer: ReviewerSelection = ReviewerSelection(), permission: String = "workspace", sessionPath: String? = nil) async throws {
        let key = "reify.native.spawn.\(api.baseURL).\(api.session?.user.id ?? "").\(project.id)"
        let previousSpawn = (projectID == project.id ? spawnID : nil) ?? UserDefaults.standard.string(forKey: key)
        close()
        spawnKey = key
        projectID = project.id
        let ws = try await api.socket("/v1/workspace/bridge")
        socket = ws
        read(ws)
        let root = "/workspace/projects/\(project.id)"
        let node = "/opt/reify/node/bin/node"
        var args = ["env", "PI_CAD_REPO=/opt/reify/pi-cad", "PI_CAD_PROJECT_CWD=\(root)",
                    "PRIME_AGENT_REPO=/opt/reify/prime-agent", "PRIME_AGENT_CODING_AGENT_DIR=/workspace/home/.prime/agent",
                    "PI_CAD_NODE_WRAPPER=\(node)", "PI_CAD_DESKTOP_PERMISSION=\(project.role == "viewer" ? "read-only" : permission)",
                    node, "/opt/reify/pi-cad/scripts/prime-cad-sidecar.mjs", "--mode", "rpc",
                    "--provider", provider, "--model", model, "--thinking", thinking]
        args += reviewer.mode == "fixed"
            ? ["--reviewer-provider", reviewer.provider, "--reviewer-model", reviewer.model, "--reviewer-thinking", reviewer.thinking]
            : ["--reviewer-inherit-author"]
        do {
            if let previousSpawn {
                do {
                    replaying = true
                    _ = try await exchange(key: "attach", message: ["type": "attach", "ch": 1, "spawnId": previousSpawn], afterSend: {
                        try await self.send(["type": "ping"])
                    })
                    spawnID = previousSpawn
                } catch let error as CloudError where error.code == "no_such_spawn" {
                    UserDefaults.standard.removeObject(forKey: key)
                    replaying = false; stdout.removeAll()
                }
            }
            if spawnID == nil {
                let script = "const fs=require('fs'),p=require('path'),root=process.argv[1],found=[];function walk(d,n=0){if(n>6||!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())walk(f,n+1);else if(e.isFile()&&e.name.endsWith('.jsonl'))found.push({name:e.name,time:fs.statSync(f).mtimeMs});}}walk(root);found.sort((a,b)=>b.time-a.time);console.log(JSON.stringify(found[0]?.name??null)); // REIFY_LATEST_SESSION"
                let latest = try await exec([node, "-e", script, "\(root)/.prime-sessions"])
                if let sessionPath {
                    let name = (sessionPath as NSString).lastPathComponent
                    guard sessionPath.hasPrefix("\(root)/.prime-sessions/"), !sessionPath.contains(".."), name.hasSuffix(".jsonl") else { throw CloudError("对话路径无效") }
                    args += ["--resume", "/workspace/.prime-sessions/\(name)"]
                } else
                if let name = (try? JSONSerialization.jsonObject(with: Data(latest.utf8), options: .fragmentsAllowed)) as? String,
                   name == (name as NSString).lastPathComponent, name.hasSuffix(".jsonl") {
                    args += ["--resume", "/workspace/.prime-sessions/\(name)"]
                }
                let spawned = try await exchange(key: "ch-1", message: ["type": "spawn", "ch": 1, "args": args,
                      "env": ["PI_CAD_CANONICAL_PROJECT_DIR": "/workspace/state/\(project.id)"]])
                spawnID = spawned["spawnId"] as? String
            }
            if let spawnID { UserDefaults.standard.set(spawnID, forKey: key) }
            _ = try await rpc("get_state")
            heartbeat = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    do {
                        try await Task.sleep(for: .seconds(20))
                        try await self?.send(["type": "ping"])
                    } catch { return }
                }
            }
        } catch { close(error: error); throw error }
    }
    private func read(_ ws: URLSessionWebSocketTask) {
        reader = Task { @MainActor [weak self] in
            do {
                while !Task.isCancelled {
                    let message = try await ws.receive()
                    guard let self, self.socket === ws else { return }
                    switch message {
                    case .string(let string): try self.control(string)
                    case .data(let data): try self.binary(data)
                    @unknown default: break
                    }
                }
            } catch {
                guard let self, self.socket === ws, !Task.isCancelled else { return }
                self.close(error: error, preserveSpawn: true)
                if !self.stopping { self.onDisconnect?(error) }
            }
        }
    }
    public func close(error: Error = CloudError("连接已关闭"), preserveSpawn: Bool = false) {
        for process in processes.values { process.end(-1) }
        processes.removeAll()
        reader?.cancel(); reader = nil
        heartbeat?.cancel(); heartbeat = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        for continuation in pending.values { continuation.resume(throwing: error) }
        pending.removeAll(); pendingIDs.removeAll(); buffers.removeAll(); stdout.removeAll(); replaying = false
        if !preserveSpawn { spawnID = nil }
    }
    // Explicitly terminate our sidecar when switching projects or signing out. The workspace stays intact.
    public func stop(api: CloudAPI? = nil) async {
        for ch in Array(processes.keys) { await stopProcess(ch) }
        stopping = true
        defer { stopping = false }
        if socket == nil, let spawnID, let api {
            if let ws = try? await api.socket("/v1/workspace/bridge") {
                socket = ws
                read(ws); replaying = true
                _ = try? await exchange(key: "attach", message: ["type": "attach", "ch": 1, "spawnId": spawnID], afterSend: { try await self.send(["type": "ping"]) }, timeout: .seconds(5))
            }
        }
        if spawnID != nil {
            var exited = false
            for (message, timeout) in [(["type": "stdin_end", "ch": 1] as [String: Any], 5),
                                       (["type": "kill", "ch": 1, "signal": "SIGTERM"], 3),
                                       (["type": "kill", "ch": 1, "signal": "SIGKILL"], 2)] {
                do { _ = try await exchange(key: "stop", message: message, timeout: .seconds(timeout)); exited = true; break }
                catch { if socket == nil { break } }
            }
            if exited, let spawnKey { UserDefaults.standard.removeObject(forKey: spawnKey) }
        }
        close()
    }
    private func send(_ message: [String: Any]) async throws {
        guard let socket else { throw CloudError("连接已断开，请重连") }
        let bytes = try JSONSerialization.data(withJSONObject: message)
        try await socket.send(.string(String(decoding: bytes, as: UTF8.self)))
    }
    private func frame(_ ch: Int, _ bytes: Data) async throws {
        guard let socket else { throw CloudError("连接已断开") }
        var header = UInt32(ch).bigEndian
        var data = Data(bytes: &header, count: 4)
        data.append(bytes)
        try await socket.send(.data(data))
    }
    private func exchange(key: String, message: [String: Any], rpc: Bool = false, afterSend: (() async throws -> Void)? = nil, timeout: Duration = .seconds(60)) async throws -> [String: Any] {
        guard pending[key] == nil else { throw CloudError("重复请求") }
        let requestID = UUID()
        return try await withCheckedThrowingContinuation { continuation in
            pending[key] = continuation
            pendingIDs[key] = requestID
            Task { @MainActor in
                do {
                    if rpc {
                        let data = try JSONSerialization.data(withJSONObject: message)
                        try await frame(1, data + Data([10]))
                    } else { try await send(message) }
                    try await afterSend?()
                } catch { if pendingIDs[key] == requestID { finish(key, error: error) } }
            }
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: timeout)
                if self?.pendingIDs[key] == requestID { self?.finish(key, error: CloudError("请求超时，请重连", code: rpc ? "rpc_timeout" : "transport_timeout")) }
            }
        }
    }
    private func finish(_ key: String, result: [String: Any] = [:], error: Error? = nil) {
        guard let continuation = pending.removeValue(forKey: key) else { return }
        pendingIDs.removeValue(forKey: key)
        if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: result) }
    }
    public func rpc(_ type: String, payload: [String: Any] = [:]) async throws -> [String: Any] {
        sequence += 1
        let id = "mac-\(sequence)"
        var message = payload; message["id"] = id; message["type"] = type
        return try await exchange(key: id, message: message, rpc: true)
    }
    public func respond(_ id: String, response: [String: Any]) async throws {
        var message = response; message["id"] = id; message["type"] = "extension_ui_response"
        try await frame(1, JSONSerialization.data(withJSONObject: message) + Data([10]))
    }
    private func control(_ string: String) throws {
        guard let data = string.data(using: .utf8), let message = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let type = message["type"] as? String ?? ""
        let ch = message["ch"] as? Int ?? -1
        let key = "ch-\(ch)"
        if let process = processes[ch] {
            process.control(message)
            if type == "exit" { processes.removeValue(forKey: ch); finish("process-stop-\(ch)", result: message); return }
        }
        if type == "pong", replaying { replaying = false; stdout.removeAll(); finish("attach"); return }
        if type == "error" {
            let error = CloudError(message["message"] as? String ?? "云端错误", code: message["code"] as? String)
            if let process = processes[ch] {
                process.onEvent?(["type": "auth_error", "message": error.message]); process.end(-1)
                processes.removeValue(forKey: ch); finish("process-stop-\(ch)", error: error)
            }
            if ch == 1 {
                if replaying { replaying = false; finish("attach", error: error) }
                else if stopping { finish("stop", error: error) }
                else { throw error }
            } else { finish(key, error: error) }
            return
        }
        if type == "exit", ch == 1 {
            if stopping { finish("stop", result: message); return }
            throw CloudError("云端助手已退出，请重连")
        }
        if type == "file_end" {
            let bytes = buffers[ch] ?? Data()
            guard bytes.count == message["size"] as? Int, Self.hash(bytes) == message["sha256"] as? String else {
                finish(key, error: CloudError("下载校验失败")); return
            }
        }
        if ["spawned", "exec_result", "file_end", "file_put_done"].contains(type) { finish(key, result: message) }
    }
    private func binary(_ bytes: Data) throws {
        guard bytes.count >= 4 else { throw CloudError("云端数据格式错误") }
        let ch = Int(bytes.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) })
        let payload = bytes.dropFirst(4)
        if ch == 1 {
            if replaying { return }
            stdout.append(payload)
            guard stdout.count <= 16 * 1024 * 1024 else { throw CloudError("云端消息过大") }
            while let newline = stdout.firstIndex(of: 10) {
                let line = Data(stdout[..<newline]); stdout.removeSubrange(...newline)
                guard let record = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
                if record["type"] as? String == "response", let id = record["id"] as? String {
                    if record["success"] as? Bool == true { finish(id, result: record["data"] as? [String: Any] ?? [:]) }
                    else { finish(id, error: CloudError(record["error"] as? String ?? "操作失败")) }
                } else { onEvent?(record) }
            }
        } else if buffers[ch] != nil {
            guard buffers[ch]!.count + payload.count <= 64 * 1024 * 1024 else { throw CloudError("文件超过 64 MB") }
            buffers[ch]!.append(payload)
        } else if let process = processes[ch] { process.receive(Data(payload)) }
        else if let process = processes[ch - 1] { process.control(["type": "stderr", "data": String(decoding: payload, as: UTF8.self)]) }
    }
    private func allocate() -> Int { defer { channel += 2 }; return channel }
    public func startProcess(_ args: [String], onEvent: @escaping ([String: Any]) -> Void, onExit: @escaping (Int) -> Void) async throws -> RemoteProcess {
        let ch = allocate(); let process = RemoteProcess(channel: ch, bridge: self)
        process.onEvent = onEvent; process.onExit = onExit; processes[ch] = process
        do {
            let result = try await exchange(key: "ch-\(ch)", message: ["type": "spawn", "ch": ch, "args": args])
            process.spawned(result["spawnId"] as? String); return process
        } catch {
            // The server may have spawned the process even if its acknowledgement was lost.
            await stopProcess(ch); process.end(-1); throw error
        }
    }
    func writeProcess(_ ch: Int, value: String) async throws {
        guard processes[ch]?.finished == false else { throw CloudError("云端登录已结束") }
        try await frame(ch, JSONSerialization.data(withJSONObject: ["value": value]) + Data([10]))
    }
    func stopProcess(_ ch: Int) async {
        guard processes[ch] != nil else { return }
        _ = try? await exchange(key: "process-stop-\(ch)", message: ["type": "kill", "ch": ch, "signal": "SIGTERM"], timeout: .seconds(5))
        processes[ch]?.end(-1); processes.removeValue(forKey: ch)
    }
    public static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    public func exec(_ args: [String], input: String? = nil, timeoutMs: Int = 45000) async throws -> String {
        let response = try await execResult(args, input: input, timeoutMs: timeoutMs)
        guard response["code"] as? Int == 0 else { throw CloudError(response["stderr"] as? String ?? "云端操作失败") }
        return response["stdout"] as? String ?? ""
    }
    public func execResult(_ args: [String], input: String? = nil, timeoutMs: Int = 45000) async throws -> [String: Any] {
        let ch = allocate()
        var message: [String: Any] = ["type": "exec", "ch": ch, "args": args, "timeoutMs": timeoutMs]
        if !projectID.isEmpty { message["env"] = ["PI_CAD_CANONICAL_PROJECT_DIR": "/workspace/state/\(projectID)"] }
        if let input { message["input"] = input }
        return try await exchange(key: "ch-\(ch)", message: message, timeout: .milliseconds(timeoutMs + 2000))
    }
    private func absolute(_ path: String) throws -> String {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\0"), !path.split(separator: "/").contains("..") else { throw CloudError("文件路径无效") }
        return "/workspace/projects/\(projectID)/\(path)"
    }
    public func files() async throws -> [CloudFile] {
        // Node ships with every workspace. Resolve symlinks and bound traversal to this project.
        let script = """
        const fs=require('fs'),p=require('path'),root=fs.realpathSync(process.argv[1]),out=[];
        function walk(dir,depth){if(depth>6||out.length>=500)return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name.startsWith('.')||e.name==='node_modules')continue;const f=p.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())walk(f,depth+1);else if(e.isFile()){const s=fs.statSync(f);out.push({path:p.relative(root,f),size:s.size});}if(out.length>=500)break;}}walk(root,0);console.log(JSON.stringify(out));
        """
        let text = try await exec(["/opt/reify/node/bin/node", "-e", script, "/workspace/projects/\(projectID)"])
        return try JSONDecoder().decode([CloudFile].self, from: Data(text.utf8)).sorted { $0.path < $1.path }
    }
    public func relativeProjectPath(_ path: String) throws -> String {
        let relative: String
        if path.hasPrefix("/") {
            let roots = [projectRoot, projectID.isEmpty ? nil : "/workspace/state/\(projectID)"].compactMap { $0 }
            if let root = roots.first(where: { path.hasPrefix($0 + "/") }) { relative = String(path.dropFirst(root.count + 1)) }
            else if path.hasPrefix("/workspace/"), !path.hasPrefix("/workspace/projects/"), !path.hasPrefix("/workspace/state/") { relative = String(path.dropFirst("/workspace/".count)) }
            else { throw CloudError("文件不属于当前项目") }
        } else { relative = path }
        _ = try absolute(relative)
        return relative
    }
    public func previewStep(_ path: String, expectedSHA: String? = nil) async throws -> Data {
        let remote = try absolute(path)
        let text: String
        if let expectedSHA {
            let script = #"""
            // REIFY_BOUND_STEP
            const fs=require('fs'),p=require('path'),c=require('crypto'),cp=require('child_process'),[root,file,expected,python,mesh]=process.argv.slice(1);
            const real=fs.realpathSync(file);if(!real.startsWith(fs.realpathSync(root)+p.sep))throw Error('文件不属于当前项目');
            const hash=()=>c.createHash('sha256').update(fs.readFileSync(real)).digest('hex');if(hash()!==expected)throw Error('文件已变化，请重新读取工程结果');
            const result=cp.spawnSync(python,[mesh,real],{encoding:'utf8',timeout:120000,maxBuffer:64*1024*1024});if(result.error||result.status!==0)throw Error(result.stderr||result.error?.message||'模型预览失败');
            if(hash()!==expected)throw Error('预览时文件已变化，请重新读取工程结果');process.stdout.write(result.stdout);
            """#
            text = try await exec(["/opt/reify/node/bin/node", "-e", script, projectRoot ?? "", remote, expectedSHA, "/opt/reify/pi-cad/python/.venv/bin/python", "/opt/reify/pi-cad/scripts/desktop-export-mesh.py"], timeoutMs: 125000)
        } else { text = try await exec(["/opt/reify/pi-cad/python/.venv/bin/python", "/opt/reify/pi-cad/scripts/desktop-export-mesh.py", remote], timeoutMs: 120000) }
        let data = Data(text.utf8)
        guard let document = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], document["parts"] is [[String: Any]] else {
            throw CloudError("云端模型预览数据无效")
        }
        return data
    }
    public func download(_ path: String) async throws -> Data {
        let remote = try absolute(path)
        let ch = allocate(); buffers[ch] = Data()
        defer { buffers[ch] = nil }
        _ = try await exchange(key: "ch-\(ch)", message: ["type": "file_get", "ch": ch, "path": remote])
        return buffers[ch] ?? Data()
    }
    public func upload(_ data: Data, name: String) async throws {
        guard data.count <= 64 * 1024 * 1024 else { throw CloudError("文件超过 64 MB") }
        let remote = try absolute(name)
        let ch = allocate()
        let response = try await exchange(key: "ch-\(ch)", message: ["type": "file_put_begin", "ch": ch, "path": remote, "size": data.count, "sha256": Self.hash(data)], afterSend: {
            for offset in stride(from: 0, to: data.count, by: 65536) {
                try await self.frame(ch, data.subdata(in: offset..<min(offset + 65536, data.count)))
            }
            try await self.send(["type": "file_put_end", "ch": ch])
        })
        guard response["size"] as? Int == data.count, response["sha256"] as? String == Self.hash(data) else { throw CloudError("上传校验失败") }
    }
}
