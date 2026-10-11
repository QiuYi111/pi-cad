import Foundation

public struct ConversationSummary: Codable, Identifiable {
    public let id: String
    public let path: String
    public let title: String
    public let updatedAt: Double
    public let model: String
    public let turns: Int
    public let toolCalls: Int
    public let tokens: Int
}

extension WorkspaceBridge {
    public func conversations() async throws -> [ConversationSummary] {
        guard let projectRoot else { return [] }
        // Same persisted logs as desktop, bounded to this project's real directory.
        let script = """
        const fs=require('fs'),p=require('path'),dir=process.argv[1],out=[]; // REIFY_CONVERSATIONS
        if(!fs.existsSync(dir)){console.log('[]');process.exit(0)}const root=fs.realpathSync(dir);
        function walk(d,n=0){if(n>8)return;for(const e of fs.readdirSync(d,{withFileTypes:true})){const q=p.join(d,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory()){walk(q,n+1);continue}if(!e.isFile()||!q.endsWith('.jsonl'))continue;const real=fs.realpathSync(q);if(!real.startsWith(root+'/'))continue;const lines=fs.readFileSync(real,'utf8').trim().split(/\\r?\\n/).filter(Boolean);let model='',tools=0,tokens=0,title=p.basename(q,'.jsonl');for(const l of lines){try{const x=JSON.parse(l),m=x.message;if((x.type==='session_info'||x.type==='session')&&x.name)title=x.name;if(m?.role==='toolResult')tools++;if(m?.role==='assistant'){model||=m.provider&&m.model?m.provider+'/'+m.model:'';tokens+=(m.usage?.input||0)+(m.usage?.output||0)}}catch{}}out.push({id:p.basename(q,'.jsonl'),path:p.join(dir,p.relative(root,q)),title,updatedAt:fs.statSync(real).mtimeMs,model,turns:lines.length,toolCalls:tools,tokens})}}walk(root);out.sort((a,b)=>b.updatedAt-a.updatedAt);console.log(JSON.stringify(out));
        """
        let output = try await exec(["/opt/reify/node/bin/node", "-e", script, "\(projectRoot)/.prime-sessions"], timeoutMs: 60000)
        return try JSONDecoder().decode([ConversationSummary].self, from: Data(output.utf8))
    }
    public func switchConversation(_ path: String) async throws {
        guard let projectRoot, path.hasPrefix("\(projectRoot)/.prime-sessions/"), !path.contains(".."), path.hasSuffix(".jsonl") else { throw CloudError("对话路径无效") }
        let verify = "const fs=require('fs'),p=require('path'),r=fs.realpathSync(process.argv[1]),f=fs.realpathSync(process.argv[2]);if(!f.startsWith(r+'/'))throw Error('对话路径无效');console.log(p.relative(r,f)); // REIFY_SESSION_PATH"
        let relative = try await exec(["/opt/reify/node/bin/node", "-e", verify, "\(projectRoot)/.prime-sessions", path])
        let confined = relative.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !confined.isEmpty, !confined.contains(".."), !confined.hasPrefix("/") else { throw CloudError("对话路径无效") }
        let response = try await rpc("switch_session", payload: ["sessionPath": "/workspace/.prime-sessions/\(confined)"])
        if response["cancelled"] as? Bool == true { throw CloudError("对话切换已取消") }
    }
}
