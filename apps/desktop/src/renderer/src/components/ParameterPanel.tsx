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
}: {
  stored: StoredModelParameterManifest;
  onPreview: (values: Record<string, ModelParameterValue>) => Promise<MeshDocument>;
  onPreviewReady: (mesh: MeshDocument | null) => void;
  onApply: (values: Record<string, ModelParameterValue>) => Promise<void>;
  onApplied: () => Promise<void> | void;
}) {
  const original = useMemo(() => initialValues(stored.manifest.parameters), [stored.sha256]);
  const [values, setValues] = useState(original);
  const [applied, setApplied] = useState(original);
  const [state, setState] = useState<PanelState>("idle");
  const [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
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
        setState("error");
        setMessage(error instanceof Error ? error.message : String(error));
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [values, dirty, onPreview, onPreviewReady]);

  const setValue = (id: string, value: ModelParameterValue) => {
    setValues((current) => ({ ...current, [id]: value }));
    setDirty(true);
  };
  const reset = () => {
    setValues(Object.fromEntries(stored.manifest.parameters.map((parameter) => [parameter.id, parameter.default])));
    setDirty(true);
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
      setState("error");
      setMessage(error instanceof Error ? error.message : String(error));
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
      <div><span>Live model</span><strong>Parameters</strong></div>
      <button type="button" onClick={reset}>Reset</button>
    </header>
    <div className="parameter-scroll">
      {[...groups].map(([group, parameters]) => <section key={group}>
        <h3>{group}</h3>
        {parameters.map((parameter) => <ParameterControl
          key={parameter.id}
          parameter={parameter}
          value={values[parameter.id]!}
          onChange={(value) => setValue(parameter.id, value)}
        />)}
      </section>)}
    </div>
    <footer>
      <span className={`parameter-status ${state}`} title={message}>
        <i />{state === "queued" ? "Queued" : state === "previewing" ? "Previewing" : state === "applying" ? "Applying" : state === "applied" ? "Applied" : state === "error" ? message : changed ? "Preview ready" : "Up to date"}
      </span>
      <button className="parameter-apply" type="button" disabled={!changed || state === "applying"} onClick={() => void apply()}>Apply</button>
    </footer>
  </aside>;
}

function ParameterControl({ parameter, value, onChange }: {
  parameter: ModelParameterDefinition;
  value: ModelParameterValue;
  onChange: (value: ModelParameterValue) => void;
}) {
  if (parameter.type === "boolean") return <label className="parameter-control parameter-toggle">
    <span><strong>{parameter.label || parameter.id}</strong>{parameter.description && <small>{parameter.description}</small>}</span>
    <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
  </label>;
  if (parameter.type === "enum") return <label className="parameter-control">
    <span><strong>{parameter.label || parameter.id}</strong>{parameter.description && <small>{parameter.description}</small>}</span>
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
    <span><strong>{parameter.label || parameter.id}</strong>{parameter.description && <small>{parameter.description}</small>}</span>
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
