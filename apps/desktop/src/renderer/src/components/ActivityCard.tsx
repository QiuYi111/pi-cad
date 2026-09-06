import { Box, Check, ChevronDown, GitCommit, Image, ScanLine, ShieldCheck, TriangleAlert, Waves } from "./icons";
import type { CadActivity } from "@shared/contracts";
import { memo, useState } from "react";

const icons = { build: Box, probe: ScanLine, workflow: GitCommit, simulation: Waves, review: ShieldCheck, commit: GitCommit, image: Image };

export const ActivityCard = memo(function ActivityCard({ activity, onReference }: { activity: CadActivity; onReference?: (text: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  if (activity.kind === "tool") return <ToolActivity activity={activity} />;
  const Icon = icons[activity.kind];
  if (activity.kind === "workflow") return <WorkflowActivity activity={activity} />;
  const running = activity.state === "running" || activity.state === "queued";
  const failed = activity.state === "failed" || activity.state === "denied";
  return <section className={`activity-card ${activity.kind} ${activity.state}`} data-testid={`activity-${activity.kind}`}>
    <header>
      <span className="activity-icon">
        {running && <span className="activity-orbit" />}
        {failed ? <TriangleAlert size={17} /> : running ? <Icon size={17} /> : <Check size={17} />}
      </span>
      <div><strong>{activity.title}</strong>{activity.summary && <p>{activity.summary}</p>}</div>
      <div className="activity-actions">
        {activity.artifactPath && <button onClick={() => window.dispatchEvent(new CustomEvent("pi-cad:open-viewer", { detail: { path: activity.artifactPath } }))}>{activity.kind === "simulation" ? "View result" : "View"}</button>}
        {activity.state === "success" && (activity.artifactPath || activity.media?.length) ? <button onClick={() => onReference?.(`Use the ${activity.kind} result from tool call ${activity.id}${activity.artifactPath ? ` at ${activity.artifactPath}` : ""}. ${activity.summary || "Keep this exact artifact identity and version in context."}`)}>Reference</button> : null}
        {activity.details ? <button onClick={() => setExpanded(!expanded)} aria-label="Toggle details"><ChevronDown size={15} className={expanded ? "rotated" : ""} /></button> : null}
      </div>
    </header>
    {running && <ActivityMotion kind={activity.kind} progress={activity.progress} />}
    {!!activity.metrics?.length && <div className="activity-metrics">{activity.metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><b>{metric.value}</b></div>)}</div>}
    {!!activity.media?.length && <div className={`activity-media media-${activity.media.length}`}>
      {activity.media.map((media) => <button key={media.id} className="media-tile" onClick={() => media.dataUrl && setPreview(media.dataUrl)}>{media.dataUrl ? <img src={media.dataUrl} alt={media.label || media.role} /> : <span><Image size={22} />{media.label || media.role}</span>}</button>)}
    </div>}
    {expanded && <pre className="activity-details">{JSON.stringify(activity.details, null, 2)}</pre>}
    {preview && <div className="activity-preview" role="dialog" aria-label="Tool image preview" onClick={() => setPreview(null)}><img src={preview} alt="Tool output preview" /></div>}
  </section>;
});

function ActivityMotion({ kind, progress = .4 }: { kind: CadActivity["kind"]; progress?: number }) {
  if (kind === "build") return <div className="build-motion"><span className="wire-cube" /><i /></div>;
  if (kind === "probe") return <div className="probe-motion"><span /><i /><b>↔</b></div>;
  if (kind === "simulation") return <div className="simulation-motion"><div className="field-lines">{[0,1,2,3,4].map((item) => <i key={item} style={{ animationDelay: `${item * .12}s` }} />)}</div><span style={{ width: `${progress * 100}%` }} /></div>;
  if (kind === "review") return <div className="review-motion"><i /><b /></div>;
  if (kind === "image") return <div className="pixel-motion">{Array.from({ length: 24 }, (_, index) => <i key={index} style={{ animationDelay: `${index * .04}s` }} />)}</div>;
  return null;
}

function ToolActivity({ activity }: { activity: CadActivity }) {
  const running = activity.state === "running" || activity.state === "queued";
  const failed = activity.state === "failed" || activity.state === "denied";
  return <div className={`tool-activity ${activity.state}`} data-testid="activity-tool">
    <span>{running ? <i /> : failed ? <TriangleAlert size={13} /> : <Check size={13} />}</span>
    <strong>{activity.title}</strong>
    <small>{activity.summary || (running ? "正在执行" : failed ? "执行失败" : "已完成")}</small>
  </div>;
}

function WorkflowActivity({ activity }: { activity: CadActivity }) {
  return <div className={`workflow-activity ${activity.state}`}>
    <span>{activity.state === "running" ? "Current phase" : "Workflow updated"}</span>
    <i><b /></i>
    <strong>{activity.summary || activity.title}</strong>
  </div>;
}
