import { useState } from "react";
import { Wrench } from "./icons";
import type { CadTransferTarget, CadTransferTargetStatus, CadTransferTestResult } from "@shared/contracts";
import {
  CAD_EXPORTS_INTRO, CAD_EXPORTS_TITLE, FUSION_GUIDE, SOLIDWORKS_GUIDE, TEST_EXPORT_GUIDE,
} from "@shared/cad-transfer-guide";
import { useCadTransfer } from "../hooks/useCadTransfer";

function Steps({ steps }: { steps: readonly string[] }) {
  return <ol className="cad-steps">{steps.map((text) => <li key={text}>{text}</li>)}</ol>;
}

/** Settings section "CAD exports": setup guide and live state of each target. */
export function CadExportsCard() {
  const { status, error, refresh, setStatus } = useCadTransfer();
  const [busy, setBusy] = useState<string>("");
  const [tests, setTests] = useState<Partial<Record<CadTransferTarget, CadTransferTestResult>>>({});
  const [message, setMessage] = useState("");
  const install = async () => {
    setBusy("install"); setMessage("");
    try { setStatus(await window.piCad.cadTransfer.installFusionAddin()); setMessage("Add-in installed."); }
    catch (e) { setMessage(`Install failed: ${String(e)}`); }
    finally { setBusy(""); }
  };
  const test = async (target: CadTransferTarget) => {
    setBusy(`test-${target}`);
    try { const result = await window.piCad.cadTransfer.testExport(target); setTests((current) => ({ ...current, [target]: result })); }
    catch (e) { setTests((current) => ({ ...current, [target]: { ok: false, target, message: String(e), steps: [] } })); }
    finally { setBusy(""); void refresh(true); }
  };
  const fusion = status?.targets.fusion;
  const solidworks = status?.targets.solidworks;
  const badge = (target?: CadTransferTargetStatus) => target
    ? <span className={`cad-state ${target.state === "ready" ? "ok" : ""}`} data-testid={`cad-state-${target.target}`}>{target.state === "ready" ? "Ready" : target.detail}</span>
    : null;
  const result = (target: CadTransferTarget) => {
    const value = tests[target];
    if (busy === `test-${target}`) return <small role="status">{TEST_EXPORT_GUIDE.running}</small>;
    if (!value) return null;
    return <div className="cad-test" role="status" data-testid={`cad-test-${target}`}>
      <strong>{value.ok ? TEST_EXPORT_GUIDE.passed : TEST_EXPORT_GUIDE.failed}</strong> <small>{value.message}</small>
      {value.failedFeature && <small> Feature: <code>{value.failedFeature}</code></small>}
      {value.logPath && <small> {TEST_EXPORT_GUIDE.logLabel}: <code>{value.logPath}</code></small>}
    </div>;
  };
  return <section id="settings-cad-exports" className="settings-card wide" data-testid="cad-exports-card">
    <header><div><span className="setting-icon"><Wrench size={18} /></span><div><h2>{CAD_EXPORTS_TITLE}</h2><p>{CAD_EXPORTS_INTRO}</p></div></div></header>
    {error && <p role="alert">{error}</p>}
    {fusion && fusion.state !== "unsupported_platform" && <div className="cad-target" data-testid="cad-fusion">
      <h3>{FUSION_GUIDE.title} {badge(fusion)}</h3>
      <Steps steps={FUSION_GUIDE.steps} />
      <div className="cad-row">
        <button disabled={fusion.state === "not_installed" || busy === "install"} onClick={() => void install()}>
          {fusion.updateAvailable ? FUSION_GUIDE.updateButton : FUSION_GUIDE.installButton}
        </button>
        <small>{FUSION_GUIDE.installedVersionLabel}: {fusion.addinInstalledVersion ?? "none"}{fusion.addinBundledVersion ? ` (included: ${fusion.addinBundledVersion})` : ""}</small>
      </div>
      <div className="cad-row" data-testid="cad-fusion-heartbeat"><i className={fusion.state === "ready" ? "online" : ""} /><span>{fusion.state === "ready" ? FUSION_GUIDE.runningLabel : FUSION_GUIDE.notRunningLabel}</span>{fusion.appVersion && <small>{fusion.appVersion}</small>}</div>
      {fusion.note && <small>{fusion.note}</small>}
      <div className="cad-row"><button disabled={fusion.state !== "ready" || !!busy} onClick={() => void test("fusion")}>{TEST_EXPORT_GUIDE.button}</button></div>
      {result("fusion")}
    </div>}
    {solidworks?.visible && <div className="cad-target" data-testid="cad-solidworks">
      <h3>{SOLIDWORKS_GUIDE.title} {badge(solidworks)}</h3>
      {solidworks.state === "unsupported_platform"
        ? solidworks.note && <small>{solidworks.note}</small>
        : <>
          <Steps steps={SOLIDWORKS_GUIDE.steps} />
          <small>{SOLIDWORKS_GUIDE.minimumVersionText}{solidworks.appVersion ? ` Found: ${solidworks.appVersion}.` : ""}{solidworks.executorVersion ? ` Export program: ${solidworks.executorVersion}.` : ""}</small>
          {solidworks.note && <small>{solidworks.note}</small>}
          <div className="cad-row"><button disabled={solidworks.state !== "ready" || !!busy} onClick={() => void test("solidworks")}>{TEST_EXPORT_GUIDE.button}</button></div>
          {result("solidworks")}
        </>}
    </div>}
    <small className="settings-note">{TEST_EXPORT_GUIDE.description}</small>
    {message && <small role={message.startsWith("Install failed") ? "alert" : "status"}>{message}</small>}
  </section>;
}
