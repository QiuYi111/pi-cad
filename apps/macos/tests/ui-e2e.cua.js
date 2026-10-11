// Run in Codex's cua_repl, with the fixture running and the app signed out.
// await runReifyUIE2E(cua, { appPath: '/absolute/path/dist/Reify.app', baseURL: 'http://127.0.0.1:18765' })
// Uses the real SwiftUI controls via macOS accessibility; no in-app test shortcuts.
export async function runReifyUIE2E(cua, { appPath, baseURL }) {
  const app = await cua.getApp(appPath);
  const results = [];
  const snapshot = () => app.getAXState({ disableDiffing: true, emit: false });
  async function locate(match, timeout = 15000) {
    const deadline = Date.now() + timeout;
    do {
      const tree = await snapshot();
      const line = tree.split('\n').find(match);
      if (line && !line.includes('(disabled)')) return Number(line.match(/^\s*(\d+)/)[1]);
    } while (Date.now() < deadline);
    throw new Error('UI control missing: ' + match.toString());
  }
  const byID = id => locate(line => line.endsWith('ID: ' + id));
  // SwiftUI may replace an accessibility element while enabling a button.
  async function act(id, action) {
    for (let attempt = 0; ; attempt++) {
      try { await action(await byID(id)); break; }
      catch (error) { if (attempt >= 3 || !String(error).includes('no longer valid')) throw error; }
    }
    await snapshot();
  }
  const clickID = id => act(id, index => app.click(index));
  const fill = (id, value) => act(id, index => app.setValue(index, value));
  async function visible(text) {
    const deadline = Date.now() + 15000;
    do { if ((await snapshot()).includes(text)) return; } while (Date.now() < deadline);
    throw new Error('UI text missing: ' + text);
  }
  await clickID('login.advanced');
  await fill('login.server', baseURL);
  await fill('login.email', 'e2e@reify.test');
  await fill('login.password', 'wrong-password');
  await clickID('login.submit');
  await visible('邮箱或密码错误'); results.push('wrong password');
  await fill('login.password', 'fixture-password');
  await clickID('login.submit');
  await visible('桌面支架'); results.push('login and projects');
  await clickID('project.new');
  await fill('project.name', '原生 E2E ' + Date.now());
  await clickID('project.create');
  await visible('云端已连接'); results.push('create and open project');
  await fill('chat.draft', '草稿保留测试');
  await clickID('composer.toggle');
  await visible('当前模型');
  await clickID('composer.toggle');
  await visible('草稿保留测试'); results.push('conversation / canvas preserves draft');
  await clickID('sidebar.collapse');
  await clickID('sidebar.expand'); results.push('collapse / expand sidebar');
  await fill('chat.draft', '创建一个 80 × 40 × 30 mm 的支架');
  await clickID('chat.send');
  await visible('支架已完成。'); results.push('streaming conversation');
  await clickID('file.toggle');
  await clickID('file.bracket.stl');
  await visible('拖动旋转'); results.push('native STL preview');
  await clickID('file.toggle');
  await clickID('file.bracket.step');
  await visible('bracket.step');
  await visible('拖动旋转'); results.push('cloud STEP / native mesh preview');
  await clickID('composer.toggle');
  await visible('支架已完成。'); results.push('canvas preserves conversation and preview');
  await fill('chat.draft', '长任务：继续制作支架');
  await clickID('chat.send');
  await clickID('chat.stop');
  await visible('ID: chat.send');
  if ((await snapshot()).includes('ID: chat.stop')) throw new Error('abort did not finish');
  results.push('abort');
  await clickID('file.toggle');
  await clickID('download.bracket.step');
  await visible('save-panel');
  await clickID('CancelButton'); results.push('native save panel');
  await clickID('file.close');
  await clickID('chat.new');
  await visible('你想做什么？'); results.push('new conversation');
  await app.getAXState();
  return { app, results };
}
