// Native window test for a logged-in disposable fixture project.
// Not yet executed: the Mac is locked. Network E2E is separate.
export async function tracesUIE2E(cua, {appPath}) {
  const app=await cua.getApp(appPath),checks=[];
  const snapshot=()=>app.getAXState({emit:false,disableDiffing:true});
  async function action(id,fn) {
    const tree=await snapshot(),row=tree.split('\n').find(line=>line.includes('ID: '+id)&&!line.includes('(disabled)'));
    if(!row)throw Error('Missing control: '+id);
    await fn(Number(row.match(/^\s*(\d+)/)[1]));return await snapshot();
  }
  const click=id=>action(id,index=>app.click(index));
  const fill=(id,value)=>action(id,index=>app.setValue(index,value));
  async function visible(text) {
    const deadline=Date.now()+20000;
    do{const tree=await snapshot();if(tree.includes(text))return tree;}while(Date.now()<deadline);
    throw Error('Missing result: '+text);
  }
  await click('nav.traces');await visible('失败记录');
  await fill('trace.search','失败记录');
  const searched=await snapshot();if(searched.includes('ID: trace.open.trace-high'))throw Error('Search left unmatched record');
  await click('trace.open.trace-low');await visible('Tool failed');
  await click('trace.expand.3');await visible('收起');checks.push('search, record read and full tool result');
  await fill('trace.search','');await click('trace.select.trace-high');await visible('已选 2 条记录');
  await fill('trace.feedback','原生窗口多选评分');await click('trace.rate');await visible('已保存 2 条评分');checks.push('two records rated through visible controls');
  await click('nav.workbench');await click('chat.rate');
  await fill('trace.feedback','原生窗口当前对话评分');await click('trace.rate');await visible('已保存 1 条评分');
  // Close the rating sheet through its visible button, then open records again.
  const tree=await snapshot(),close=tree.split('\n').find(line=>line.includes('button')&&line.includes('关闭'));
  if(!close)throw Error('Missing rating close button');await app.click(Number(close.match(/^\s*(\d+)/)[1]));await snapshot();
  await click('nav.traces');await visible('记录与经验');checks.push('current-conversation rating status');
  await click('trace.distill');await visible('候选规则已生成');await visible('修改文件');checks.push('candidate and progress through native controls');
  await click('trace.validate');await visible('验证：通过');checks.push('replay result through native controls');
  return checks;
}
