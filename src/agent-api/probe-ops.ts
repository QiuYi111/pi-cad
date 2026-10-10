import { jsonValue } from "../harness/canonical.ts";
import type { AgentApiRequest } from "../authority/protocol.ts";
import { executeCadProbe } from "../modules/probe/tool.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";

export async function probeOp(cwd: string, request: Extract<AgentApiRequest, { op: "probe" }>) {
  const preset = request.preset?.trim() || "python";
  const rendered = await executeCadProbe(cwd, {
    preset,
    // An explicit artifact is already the exact subject. Do not also
    // synthesize `current`, because the probe contract rejects two targets.
    subject: request.subject ?? (request.args?.artifact ? undefined : "current"),
    purpose: request.purpose,
    code: request.code,
    script: request.script,
    args: request.args,
  }, mechanicalRegistries);
  const details = "details" in rendered ? rendered.details as any : undefined;
  const rawValue = preset === "python" ? details?.envelope?.payload?.result : details?.envelope?.payload;
  // Face fingerprints exist for change detection between builds; a probe
  // answer must not carry thousands of them into the agent's context.
  const value = rawValue && typeof rawValue === "object" && Array.isArray(rawValue.faceFingerprints)
    ? (({ faceFingerprints, ...rest }) => ({ ...rest, faceFingerprintCount: faceFingerprints.length }))(rawValue)
    : rawValue;
  if (details?.presetFailed || value === undefined) throw new Error(rendered.content.map((item) => item.type === "text" ? item.text : "").join("\n") || `probe preset ${preset} failed`);
  const visuals = Array.isArray(details?.observation?.visuals) ? details.observation.visuals : [];
  const images = rendered.content.filter((item) => item.type === "image").map((item, index) => ({
    name: visuals[index]?.name ?? `view-${index + 1}`,
    data: item.data,
    mimeType: item.mimeType,
  }));
  return jsonValue({
    preset,
    value,
    ...(preset === "python" && typeof details?.envelope?.payload?.stdout === "string" && details.envelope.payload.stdout
      ? { stdout: details.envelope.payload.stdout } : {}),
    ...(images.length ? { images } : {}),
    artifactHash: details.artifactHash ?? details.envelope?.inputHashes?.artifact,
    scriptHash: details.envelope?.inputHashes?.script,
    observationId: details.observationId,
  });
}
