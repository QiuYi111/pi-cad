// Window-only acceptance. NOT RUN while the Mac is locked. Use a separate
// fixture app and disposable transfer/settings/preferences directories.
export async function simulationUIE2E(cua, {appPath,fixtureURL}) {
 if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureURL))throw Error('Disposable fixture required');
 const app=await cua.getApp(appPath),checks=[];
 const snapshot=()=>app.getAXState({emit:false,disableDiffing:true});
 async function control(id){const tree=await snapshot(),row=tree.split('\n').find(x=>x.includes('ID: '+id)&&!x.includes('(disabled)'));if(!row)throw Error('Missing enabled control '+id);return Number(row.match(/^\s*(\d+)/)[1])}
 const click=async id=>app.click(await control(id));
 async function visible(text){const end=Date.now()+30000;do{if((await snapshot()).includes(text))return;}while(Date.now()<end);throw Error('Missing visible result '+text)}
 await click('simulation.open');await visible('固定版本组件检查通过');
 for(const id of ['youngs','poisson','force','mesh'])await control('simulation.'+id);
 checks.push('analysis fields, cloud qualification and source version visible');
 await click('simulation.run');await visible('simulation.stop');checks.push('confirmed analysis reaches running state');
 await click('simulation.stop');checks.push('visible Stop clicked; caller must verify cloud abort and terminal result');
 return checks;
}
