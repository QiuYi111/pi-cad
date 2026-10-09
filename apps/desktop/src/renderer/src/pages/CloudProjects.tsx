import { useEffect, useState } from "react";
import type { CloudProject } from "@shared/contracts";
import { Check, Plus } from "../components/icons";
import type { CloudView } from "../lib/cloud-state";
import { cloudErrorMessage } from "../lib/cloud-state";

/** Cloud project list: open, create, rename and delete. Opening a project makes it the active one. */
export function CloudProjects({ selectedId, view, onSelected, compact = false }: { selectedId?: string; view: CloudView; onSelected: (projectId: string) => void; compact?: boolean }) {
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      setProjects(await window.piCad.cloud.projects());
      setError("");
    } catch (reason) {
      setError(cloudErrorMessage(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(cloudErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const create = () => run(async () => {
    const project = await window.piCad.cloud.createProject(name);
    setName("");
    setProjects((current) => [...current, project]);
  });

  const rename = () => run(async () => {
    if (!editing) return;
    const updated = await window.piCad.cloud.renameProject(editing.id, editing.name);
    setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
    setEditing(null);
  });

  const remove = (id: string) => run(async () => {
    await window.piCad.cloud.deleteProject(id);
    setProjects((current) => current.filter((project) => project.id !== id));
    setConfirming("");
  });

  const open = (id: string) => run(async () => {
    await window.piCad.cloud.selectProject(id);
    onSelected(id);
  });

  const queued = view.status?.workspace.state === "queued" ? view.status.workspace.position : undefined;
  const starting = view.status?.workspace.state === "starting";

  return <section className={`cloud-projects ${compact ? "compact" : ""}`} aria-label="云端项目">
    {!compact && <header className="page-heading"><div><span>Reify 云端</span><h1>项目</h1><p>每个项目保存在你的云端工作区中。</p></div></header>}
    <form className="cloud-create" onSubmit={(event) => { event.preventDefault(); if (name.trim() && !busy) void create(); }}>
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="新项目名称" aria-label="新项目名称" maxLength={120} disabled={busy} />
      <button type="submit" disabled={busy || !name.trim()}><Plus size={14} />新建</button>
    </form>
    {error && <p role="alert" className="cloud-error">{error}</p>}
    {queued !== undefined && <p role="status" className="cloud-queue">服务器繁忙，排队中（第 {queued} 位）</p>}
    {starting && <p role="status" className="cloud-queue">正在启动工作区…</p>}
    {loading ? <p className="cloud-hint">正在读取项目…</p> : projects.length === 0 ? <p className="cloud-hint">还没有项目。在上方输入名称新建一个。</p> : <ul className="cloud-project-list">
      {projects.map((project) => <li key={project.id} className={project.id === selectedId ? "selected" : ""}>
        {editing?.id === project.id
          ? <form className="cloud-rename" onSubmit={(event) => { event.preventDefault(); if (editing.name.trim() && !busy) void rename(); }}>
            <input value={editing.name} onChange={(event) => setEditing({ id: project.id, name: event.target.value })} aria-label="项目名称" maxLength={120} autoFocus />
            <button type="submit" disabled={busy || !editing.name.trim()}>保存</button>
            <button type="button" onClick={() => setEditing(null)}>取消</button>
          </form>
          : <>
            <div className="cloud-project-name">
              <strong>{project.name}</strong>
              {project.id === selectedId && <small><Check size={12} /> 当前项目</small>}
            </div>
            <div className="cloud-project-actions">
              <button onClick={() => void open(project.id)} disabled={busy}>打开</button>
              <button onClick={() => setEditing({ id: project.id, name: project.name })} disabled={busy}>重命名</button>
              {confirming === project.id
                ? <>
                  <button className="danger" onClick={() => void remove(project.id)} disabled={busy}>确认删除</button>
                  <button onClick={() => setConfirming("")} disabled={busy}>取消</button>
                </>
                : <button onClick={() => setConfirming(project.id)} disabled={busy}>删除</button>}
            </div>
          </>}
      </li>)}
    </ul>}
  </section>;
}
