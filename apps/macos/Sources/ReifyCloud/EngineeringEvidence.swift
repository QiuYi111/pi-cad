import Foundation

public struct VerifiedEvidence: Decodable {
    public let path: String
    public let sha256: String
    public let contentSHA256: String
    public let declaredSHA256: String?
    public let bindingVerified: Bool
    public let value: JSONValue
}

extension EngineeringService {
    public func evidence(_ evidence: AcceptanceSummary.Requirement.Evidence, run: WorkflowRun) async throws -> VerifiedEvidence {
        guard evidence.path.range(of: #"^(?:evidence|reviews)/[a-zA-Z0-9._/-]+\.json$"#, options: .regularExpression) != nil, !evidence.path.contains(".."), (evidence.sha256.map { $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil } ?? true) else { throw CloudError("证据记录格式无效") }
        // The original API checks the conversation binding and validates its immutable transaction.
        if evidence.path.hasPrefix("evidence/") { let _: JSONValue = try await request("evidence-read", fields: ["path": evidence.path]) }
        // Older servers reject reviews/ in evidence-read. The same scoped workflow
        // API plus transaction reader below permits that original review namespace.
        guard let root = bridge.projectRoot else { throw CloudError("请先打开项目") }
        let body: [String: Any] = ["root": root, "sessionId": sessionID.map { $0 as Any } ?? NSNull(), "runId": run.runId, "workflowHash": run.workflowHash, "path": evidence.path, "sha256": evidence.sha256.map { $0 as Any } ?? NSNull()]
        let script = #"""
        // REIFY_EVIDENCE_READ
        const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',async()=>{try{
          const q=JSON.parse(input);
          const current=()=>{const result=cp.spawnSync('/opt/reify/node/bin/node',['/opt/reify/pi-cad/scripts/pi-cad-agent-api.mjs','agent-api',q.root],{input:JSON.stringify({schema:1,op:'workflow-current',sessionId:q.sessionId}),encoding:'utf8',timeout:60000});const envelope=JSON.parse(result.stdout);if(result.error||result.status!==0||!envelope.ok)throw Error(envelope.error?.message||result.stderr||'读取工作流失败');if(envelope.result?.runId!==q.runId||envelope.result?.workflowHash!==q.workflowHash)throw Error('工作流已变化，请重新读取工程结果')};
          current();const jiti=require('/opt/reify/pi-cad/node_modules/jiti').createJiti('/opt/reify/pi-cad/package.json');const {HarnessRunStoreV7}=await jiti.import('/opt/reify/pi-cad/src/harness/run-store.ts');const {canonicalDigest}=await jiti.import('/opt/reify/pi-cad/src/harness/canonical.ts');
          const bytes=await new HarnessRunStoreV7(q.root,q.runId).transactions.readPayload(q.path);if(!bytes)throw Error('证据不存在');if(bytes.length>4*1024*1024)throw Error('证据超过 4 MB');
          const value=JSON.parse(bytes.toString('utf8')),contentSHA256=crypto.createHash('sha256').update(bytes).digest('hex');let hash;
          if(value.evidence&&value.envelope){if(value.evidence.workflowHash!==q.workflowHash)throw Error('证据属于另一个工作流');hash=canonicalDigest(value.envelope);if(hash!==value.evidence.sha256)throw Error('证据计算结果校验失败')}
          else if(value.tool==='codex_generate_image'&&typeof value.sha256==='string'){hash=value.sha256}
          else {if(value.workflowHash&&value.workflowHash!==q.workflowHash)throw Error('审查记录属于另一个工作流');hash=canonicalDigest(value)}
          if(q.sha256&&hash!==q.sha256)throw Error('证据内容与此版本记录不一致');current();
          console.log(JSON.stringify({path:q.path,sha256:hash,contentSHA256,declaredSHA256:q.sha256,bindingVerified:!!q.sha256,value}));
        }catch(error){console.error(error.message);process.exitCode=1}});
        """#
        let text = try await bridge.exec(["/opt/reify/node/bin/node", "-e", script], input: String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self), timeoutMs: 130000)
        let result = try JSONDecoder().decode(VerifiedEvidence.self, from: Data(text.utf8))
        guard result.path == evidence.path && (evidence.sha256.map { result.sha256 == $0 } ?? !result.bindingVerified) else { throw CloudError("证据校验失败") }
        return result
    }
}
