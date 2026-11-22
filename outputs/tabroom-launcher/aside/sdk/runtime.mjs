import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {initializeBrowserEngine} from './original-library.mjs';
import {ExtensionCdp} from './cdp.mjs';

// SQL 저장소 대신 MCP 세션의 탭 상태를 보존한다. 브라우저 동작은 원본 클래스를 사용한다.
export async function createRuntime({transport,profileId,sessionId,storageDir,emit=()=>{}}){
  await fs.mkdir(storageDir,{recursive:true,mode:0o700});
  await fs.mkdir(path.join(storageDir,'tmp'),{recursive:true,mode:0o700});
  await fs.mkdir(path.join(storageDir,'artifacts'),{recursive:true,mode:0o700});
  const session={id:sessionId,status:'running',runtimeConfig:{takeScreenshotOnEverySnapshot:false},browserBinding:{profileId,browserMode:'default'}};
  const rows=new Map();
  const store={get:()=>session,update:(_account,_id,change)=>Object.assign(session,change)};
  const tabStore={
    list:()=>[...rows.values()],get:(_account,id)=>rows.get(id),byTarget:(_account,_session,targetId)=>[...rows.values()].find(t=>t.targetId===targetId),
    insert:(_account,data)=>{const row={id:crypto.randomUUID(),...data};rows.set(row.id,row);return row;},
    update:(_account,id,data)=>{const row=rows.get(id);if(!row)return null;Object.assign(row,data);return row;},
    remove:(_account,id)=>rows.delete(id),
  };
  const cdp=new ExtensionCdp(transport,profileId);
  const engine=initializeBrowserEngine({SessionStore:store,sessionTabs:tabStore,storageDir,cdp,extensionCommand:(command)=>cdp.send(command.method,command.params)});
  const tabController={
    createTab:p=>cdp.send('Aside.createAgentTab',p),
    closeTab:p=>cdp.send('Aside.controlTab',{action:'close',...p}),
    ownsTarget:async id=>(await cdp.send('Aside.ownsTarget',{targetId:id})).owned,
    ensureInAgentTabsGroup:id=>cdp.send('Aside.ensureTabInAiTabsGroup',{targetId:id}),
  };
  const browser=new engine.AsideBrowser(cdp,'local',session,undefined,{tabs:tabController,getConsoleStateKey:async()=>`bridge-console-${sessionId}`});
  const scope=await engine.createScope({browser,cwd:storageDir,sessionStorageDir:storageDir,accountRoot:storageDir});
  const globals=scope.globals;
  globals.chrome=engine.createChromeApi(()=>browser.extensionBridgeRoute);
  globals.cua=engine.createCua(browser);
  Object.assign(globals,{
    listBrowserTabs:async()=> (await cdp.send('Aside.listTabs',{accountId:'local'})).items,
    openBrowserTab:(url='about:blank')=>cdp.send('Aside.createAgentTab',{url}),
    createTabGroup:tabIds=>transport('group',{tabIds}),
    attachBrowserTab:async ref=>{
      const tab=(await globals.listBrowserTabs()).find(tab=>tab.tabId===ref || tab.targetId===ref);
      if(!tab)throw Error('No open browser tab found for that Tabroom ID.');
      const {targetId}=tab;
      if(!browser.state.tabs.some(tab=>tab.targetId===targetId))browser.addNewTabState({
        targetId,url:tab.url,title:tab.title,iconUrl:tab.faviconUrl||undefined,ownership:'borrowed',source:'attachment',
      });
      const page=await browser.ensurePage(targetId);
      browser.page=page;
      await scope.sync();
      return page;
    },
    listTabBundles:()=>transport('bundle',{action:'list'}),
    saveTabBundle:name=>transport('bundle',{action:'save',name}),
    loadTabBundle:bundleId=>transport('bundle',{action:'load',bundleId}),
    saveCitation:({tabId,url})=>transport('reference',{tabId,url}),
  });
  globals.attachActiveBrowserTab=async()=>{const list=await globals.listBrowserTabs();const windowId=browser.extensionBridgeRoute.windowId;const t=list.find(t=>t.active&&(windowId===undefined||t.windowId===windowId));if(!t)throw Error('No active browser tab is available to attach.');return globals.attachBrowserTab(t.tabId);};
  const repl=await engine.createRepl(scope);
  return {engine,browser,globals,runCode:(code,options)=>repl.run(code,options),onEvent:(name,data)=>cdp.onEvent(name,data),async dispose(){repl.dispose();await browser.dispose();}};
}
