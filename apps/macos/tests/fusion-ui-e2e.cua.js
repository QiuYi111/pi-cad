// Native Fusion window test. Not executed while the Mac is locked.
// The caller must launch a separate fixture app with REIFY_TRANSFER_HOME set
// to a disposable test-results/fusion-home-* directory and a synthetic worker.
export async function fusionUIE2E(cua, {appPath, fixtureURL}) {
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureURL))throw Error('Disposable local fixture required');
  const app=await cua.getApp(appPath),checks=[];
  const snapshot=()=>app.getAXState({emit:false,disableDiffing:true});
  async function action(id,fn){const tree=await snapshot(),row=tree.split('\n').find(x=>x.includes('ID: '+id)&&!x.includes('(disabled)'));if(!row)throw Error('Missing control: '+id);await fn(Number(row.match(/^\s*(\d+)/)[1]));return snapshot()}
  const click=id=>action(id,index=>app.click(index));
  async function visible(text){const end=Date.now()+30000;do{const tree=await snapshot();if(tree.includes(text))return tree;}while(Date.now()<end);throw Error('Missing visible result: '+text)}
  await click('nav.settings');await visible('CAD 导出');
  await click('fusion.refresh');await visible('Fusion 已连接');checks.push('settings state, version and instructions');
  await click('fusion.install');await visible('fusion.versions');checks.push('original plugin installation through visible button');
  await click('fusion.test');await visible('测试导出通过');checks.push('reference plate test, progress and result');
  await click('nav.workbench');await click('model.export-fusion');await visible('形状检查通过');checks.push('canvas export and checked result');
  const tree=await snapshot();if(!tree.includes('ID: fusion.folder.')||!tree.includes('ID: fusion.log.'))throw Error('Result folder/log controls missing');
  // Opening these controls launches Finder/TextEdit; those apps need a separate
  // fresh inspection before the caller records those checks as passed.
  return checks;
}
