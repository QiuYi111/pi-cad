// Run in cua_repl after the user signs in to the deployed cloud.
// No fixture routes, credentials, or in-app shortcuts. Each wait is bounded so
// the caller can report progress between calls.
export async function realCloudE2E(cua, { appPath }) {
  const app = await cua.getApp(appPath);
  const results = [];
  const snapshot = () => app.getAXState({ disableDiffing: true, emit: false });
  const index = (tree, id) => {
    const row = tree.split('\n').find(line => line.includes('ID: ' + id) && !line.includes('(disabled)'));
    return row ? Number(row.match(/^\s*(\d+)/)[1]) : undefined;
  };
  async function act(id, fn) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const tree = await snapshot(), element = index(tree, id);
      if (element === undefined) throw new Error('Missing or disabled: ' + id);
      try { await fn(element); return await snapshot(); }
      catch (error) { if (attempt === 3 || !String(error).includes('no longer valid')) throw error; }
    }
  }
  const click = id => act(id, element => app.click(element));
  const fill = (id, value) => act(id, element => app.setValue(element, value));
  async function waitFor(text, milliseconds = 25000) {
    const deadline = Date.now() + Math.min(milliseconds, 25000);
    do {
      const tree = await snapshot();
      if (tree.includes('ID: error')) throw new Error(tree.split('\n').filter(line => line.includes('ID: error')).join('\n'));
      if (tree.includes(text)) return true;
    } while (Date.now() < deadline);
    return false;
  }
  async function checkReply(text) {
    const tree = await snapshot();
    if (tree.includes('ID: error')) throw new Error('Cloud error shown; inspect the window.');
    // Matching only the user's prompt would falsely pass a live-model test.
    return { complete: !tree.includes('ID: chat.stop'), replied: tree.includes('Reify ' + text) };
  }
  async function create(name = 'macOS 真实云端 E2E ' + Date.now()) {
    if ((await snapshot()).includes('ID: login.email')) throw new Error('Sign in to the real cloud first.');
    await click('project.new'); await fill('project.name', name); await click('project.create');
    return name;
  }
  async function generate() {
    const tree = await snapshot();
    if (!tree.includes('云端已连接') || tree.includes('ID: chat.stop')) throw new Error('Workspace must be connected and idle.');
    await fill('chat.draft', '这是 macOS 原生客户端的真实云端 E2E。请在当前测试项目创建一个 20×10×5 mm 的简单长方体，导出 real-cloud-e2e.step 和 real-cloud-e2e.stl，完成必要的几何检查。无需图片、渲染、仿真或复杂报告。用现有云端 CAD 工具实际生成文件，不要只描述步骤。');
    await click('chat.send'); results.push('prompt sent to real model');
  }
  async function selectModel(provider, model) {
    await click('nav.settings');
    await fill('model.provider', provider); await fill('model.name', model); await click('model.save');
    results.push('cloud model selected: ' + provider + '/' + model);
  }
  async function checkFiles() {
    const tree = await snapshot();
    if (tree.includes('ID: chat.stop')) return { complete: false, reason: 'model is running' };
    if (tree.includes('ID: error')) throw new Error('Cloud error shown; inspect the window.');
    if (!tree.includes('ID: file.close')) await click('file.toggle');
    const files = await snapshot();
    const paths = [...files.matchAll(/ID: file\.(.+\.(?:step|stl))$/gm)].map(match => match[1]);
    const step = paths.find(path => path.endsWith('real-cloud-e2e.step'));
    const stl = paths.find(path => path.endsWith('real-cloud-e2e.stl'));
    if (!step || !stl) throw new Error('Real model did not produce both requested CAD files.');
    results.push('real STEP and STL listed');
    return { complete: true, step, stl };
  }
  async function preview(path) {
    if (!(await snapshot()).includes('ID: file.close')) await click('file.toggle');
    await click('file.' + path);
    if (!await waitFor('拖动旋转')) return false;
    const tree = await snapshot();
    if (!tree.includes(path.split('/').at(-1))) throw new Error('Preview filename missing');
    results.push('native preview: ' + path); return true;
  }
  return { app, results, snapshot, click, fill, waitFor, checkReply, create, selectModel, generate, checkFiles, preview };
}
