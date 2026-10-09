/**
 * Paste box for the OAuth callback in cloud mode (plan §9.7). The sign-in script runs in the
 * workspace, so the browser's redirect to localhost cannot reach it; the user pastes the address instead.
 */
export function CloudManualCode({ value, onChange, onSubmit }: { value: string; onChange: (value: string) => void; onSubmit: () => void }) {
  return <div className="cloud-manual-code">
    <p className="cloud-hint">浏览器显示无法连接时，复制地址栏的完整地址，粘贴到这里</p>
    <div className="setup-auth-input">
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="粘贴地址栏中的完整地址" aria-label="粘贴地址栏中的完整地址" />
      <button disabled={!value.trim()} onClick={onSubmit}>继续</button>
    </div>
  </div>;
}
