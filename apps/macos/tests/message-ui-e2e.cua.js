// Run only against the disposable fixture account after the basic UI test.
// Each exported step is bounded and uses the real native controls.
export async function messageUIE2E(cua, { appPath }) {
  const app = await cua.getApp(appPath);
  const snapshot = () => app.getAXState({ disableDiffing: true, emit: false });
  async function act(id, action) {
    const tree = await snapshot();
    const row = tree.split('\n').find(line => line.endsWith('ID: ' + id) && !line.includes('(disabled)'));
    if (!row) throw Error('Missing control: ' + id);
    await action(Number(row.match(/^\s*(\d+)/)[1]));
    return snapshot();
  }
  const click = id => act(id, index => app.click(index));
  const fill = (id, value) => act(id, index => app.setValue(index, value));
  async function expect(text) {
    const tree = await snapshot();
    if (!tree.includes(text)) throw Error('Missing text: ' + text);
    return tree;
  }
  async function generateCards() {
    await click('nav.settings');
    await expect('e2e@reify.test');
    await click('model.close');
    await fill('chat.draft', '工具卡片验收');
    await click('chat.send');
  }
  async function inspectCards() {
    await expect('制作模型');
    await expect('运行分析');
    await expect('12 MPa');
    await expect('print(12)');
    await expect('已检查');
    await click('tool.media.flow-build-media-0');
    await expect('工具图片');
    const tree = await snapshot();
    const close = tree.split('\n').find(line => /button 关闭/.test(line));
    if (!close) throw Error('Missing picture close button');
    await app.click(Number(close.match(/^\s*(\d+)/)[1]));
    await snapshot();
    await click('tool.reference.flow-build');
    await expect('Use the build result from tool call flow-build');
    await fill('chat.draft', '');
  }
  async function inspectFollowing() {
    await click('chat.follow');
    await expect('跟随新消息');
    await fill('chat.draft', '重试状态验收');
    await click('chat.send');
  }
  async function finishFollowing() {
    await expect('重试成功');
    await expect('跟随新消息');
    await click('chat.follow');
    await expect('暂停跟随');
  }
  return { app, generateCards, inspectCards, inspectFollowing, finishFollowing };
}
