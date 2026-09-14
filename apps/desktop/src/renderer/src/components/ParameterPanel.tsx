import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MeshDocument,
  ModelParameterDefinition,
  ModelParameterValue,
  StoredModelParameterManifest,
} from "@shared/contracts";

type PanelState = "idle" | "queued" | "previewing" | "applying" | "applied" | "error";

function initialValues(parameters: ModelParameterDefinition[]): Record<string, ModelParameterValue> {
  return Object.fromEntries(parameters.map((parameter) => [parameter.id, parameter.value]));
}

function sameValues(a: Record<string, ModelParameterValue>, b: Record<string, ModelParameterValue>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export function ParameterPanel({
  stored,
  onPreview,
  onPreviewReady,
  onApply,
  onApplied,
  onAgentFix,
}: {
  stored: StoredModelParameterManifest;
  onPreview: (values: Record<string, ModelParameterValue>) => Promise<MeshDocument>;
  onPreviewReady: (mesh: MeshDocument | null) => void;
  onApply: (values: Record<string, ModelParameterValue>) => Promise<void>;
  onApplied: () => Promise<void> | void;
  onAgentFix?: (request: string) => void;
}) {
  const original = useMemo(() => initialValues(stored.manifest.parameters), [stored.sha256]);
  const [values, setValues] = useState(original);
  const [applied, setApplied] = useState(original);
  const [state, setState] = useState<PanelState>("idle");
  const [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const [failures, setFailures] = useState<Array<{ values: Record<string, ModelParameterValue>; message: string; at: number }>>([]);
  const generation = useRef(0);

  useEffect(() => {
    const next = initialValues(stored.manifest.parameters);
    generation.current += 1;
    setValues(next);
    setApplied(next);
    setState("idle");
    setMessage("");
    setDirty(false);
    onPreviewReady(null);
  }, [stored.sha256]);

  useEffect(() => {
    if (!dirty) return;
    const current = ++generation.current;
    setState("queued");
    const timer = window.setTimeout(() => {
      setState("previewing");
      setMessage("");
      void onPreview(values).then((mesh) => {
        if (generation.current !== current) return;
        onPreviewReady(mesh);
        setState("idle");
      }).catch((error) => {
        if (generation.current !== current) return;
        const detail = error instanceof Error ? error.message : String(error);
        onPreviewReady(null);
        setState("error");
        setMessage(detail);
        setFailures((history) => [{ values, message: detail, at: Date.now() }, ...history].slice(0, 5));
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [values, dirty, onPreview, onPreviewReady]);

  const setValue = (id: string, value: ModelParameterValue) => {
    setValues((current) => ({ ...current, [id]: value }));
    setDirty(true);
  };
  const reset = () => {
    generation.current += 1;
    setValues(applied);
    setDirty(false);
    setState("idle");
    setMessage("");
    onPreviewReady(null);
  };
  const apply = async () => {
    generation.current += 1;
    setState("applying");
    setMessage("");
    try {
      await onApply(values);
      setApplied(values);
      setDirty(false);
      onPreviewReady(null);
      setState("applied");
      await onApplied();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      onPreviewReady(null);
      setState("error");
      setMessage(detail);
      setFailures((history) => [{ values, message: detail, at: Date.now() }, ...history].slice(0, 5));
    }
  };

  const groups = new Map<string, ModelParameterDefinition[]>();
  for (const parameter of stored.manifest.parameters) {
    const group = parameter.group || "Parameters";
    groups.set(group, [...(groups.get(group) ?? []), parameter]);
  }
  const changed = !sameValues(values, applied);

  return <aside className="parameter-panel" data-testid="parameter-panel">
    <header>
      <div><span>Live model</span><strong>Parameters</strong><small title={stored.manifest.source.path}>Source · {stored.manifest.source.path.split(/[\\/]/).at(-1)} · {stored.manifest.source.sha256.slice(0, 10)}</small></div>
      <button type="button" disabled={!changed} onClick={reset}>Reset preview</button>
    </header>
    <div className="parameter-scroll">
      {[...groups].map(([group, parameters]) => <section key={group}>
        <h3>{group}</h3>
        {parameters.map((parameter) => <ParameterControl
          key={parameter.id}
          parameter={parameter}
          value={values[parameter.id]!}
          appliedValue={applied[parameter.id]!}
          onChange={(value) => setValue(parameter.id, value)}
        />)}
      </section>)}
    </div>
    {failures.length > 0 && <details className="parameter-failures" open={state === "error"}><summary>Failed candidate · {new Date(failures[0]!.at).toLocaleTimeString()}</summary><strong>Known</strong><p>The applied model is still displayed. Candidate values: {JSON.stringify(failures[0]!.values)}</p><strong>Diagnostic / possible cause</strong><p>{failures[0]!.message}</p><div><button type="button" onClick={reset}>Restore applied values</button><button type="button" onClick={() => onAgentFix?.(`Fix the failed parameter candidate for ${stored.manifest.output.path}. Candidate values: ${JSON.stringify(failures[0]!.values)}. Diagnostic: ${failures[0]!.message}. Preserve unrelated working changes and the current applied model.`)}>Ask Agent to fix</button></div></details>}
    <p className="parameter-material-note">Appearance belongs to the Viewer. Engineering material properties belong to the analysis workflow and its evidence.</p>
    <footer>
      <span className={`parameter-status ${state}`} title={message}>
        <i />{state === "queued" ? "Queued" : state === "previewing" ? "Previewing" : state === "applying" ? "Applying" : state === "applied" ? "Applied" : state === "error" ? message : changed ? "Preview ready" : "Up to date"}
      </span>
      <button className="parameter-apply" type="button" disabled={!changed || state === "applying"} onClick={() => void apply()}>Apply</button>
    </footer>
  </aside>;
}

function ParameterControl({ parameter, value, appliedValue, onChange }: {
  parameter: ModelParameterDefinition;
  value: ModelParameterValue;
  appliedValue: ModelParameterValue;
  onChange: (value: ModelParameterValue) => void;
}) {
  if (parameter.type === "boolean") return <label className="parameter-control parameter-toggle">
    <span><strong>{parameter.label || parameter.id}</strong>{parameter.description && <small>{parameter.description}</small>}<small>Applied · {String(appliedValue)}{parameter.unit ? ` ${parameter.unit}` : ""}{value !== appliedValue ? ` · Preview ${String(value)}${parameter.unit ? ` ${parameter.unit}` : ""}` : ""}</small></span>
    <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
  </label>;
  if (parameter.type === "enum") return <label className="parameter-control">
    <span><strong>{parameter.label || parameter.id}</strong>{parameter.description && <small>{parameter.description}</small>}<small>Applied · {String(appliedValue)}{value !== appliedValue ? ` · Preview ${String(value)}` : ""}</small></span>
    <select value={String(value)} onChange={(event) => onChange(event.target.value)}>
      {parameter.options?.map((option) => <option key={option.value} value={option.value}>{option.label || option.value}</option>)}
    </select>
  </label>;

  const number = Number(value);
  const hasRange = parameter.min !== undefined && parameter.max !== undefined;
  const marker = hasRange && parameter.max! > parameter.min!
    ? ((Number(parameter.default) - parameter.min!) / (parameter.max! - parameter.min!)) * 100
    : 0;
  return <label className="parameter-control parameter-number">
    <span><strong>{parameter.label || parameter.id}</strong>{parameter.description && <small>{parameter.description}</small>}<small>Applied · {String(appliedValue)}{parameter.unit ? ` ${parameter.unit}` : ""}{value !== appliedValue ? ` · Preview ${String(value)}${parameter.unit ? ` ${parameter.unit}` : ""}` : ""}{hasRange ? ` · Range ${parameter.min}–${parameter.max} ${parameter.unit || ""}` : ""}</small></span>
    <span className="parameter-value"><input
      type="number"
      value={number}
      min={parameter.min}
      max={parameter.max}
      step={parameter.step ?? (parameter.type === "integer" ? 1 : "any")}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      }}
    />{parameter.unit && <em>{parameter.unit}</em>}</span>
    {hasRange && <span className="parameter-range"><input
      aria-label={`${parameter.label || parameter.id} slider`}
      type="range"
      value={number}
      min={parameter.min}
      max={parameter.max}
      step={parameter.step ?? (parameter.type === "integer" ? 1 : "any")}
      onChange={(event) => onChange(Number(event.target.value))}
    /><i style={{ left: `${Math.max(0, Math.min(100, marker))}%` }} title="Default" /></span>}
  </label>;
}
