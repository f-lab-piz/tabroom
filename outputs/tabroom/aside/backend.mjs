// 원본 Aside의 CDP와 앱 전용 브라우저 명령을 일반 Chrome API에 연결한다.
import {allowedMv3Methods} from './mv3-policy.mjs';
export function createChromeBackend(chrome, emit = () => {}) {
  const roots = new Map(), children = new Map(), owners = new Map();
  let profileId = 'chrome',testViewport;
  const ownerKey = c => `${c.connectionId}:${c.sessionId}`;
  function claim(id,c) {
    const existing=owners.get(id);
    if(existing&&existing!==ownerKey(c))throw Error(`Tab ${id} is leased by another agent session`);
    owners.set(id,ownerKey(c));
  }
  const target = t => ({...t,id:t.id,targetId:t.id,type:t.type??'page',title:t.title??'',url:t.url??'',browserContextId:profileId});
  async function targets(){const tabs=await chrome.tabs.query({});const all=(await chrome.debugger.getTargets()).filter(t=>['page','iframe'].includes(t.type));return all.map(t=>{const tab=tabs.find(x=>x.id===t.tabId);const opener=all.find(x=>x.tabId===tab?.openerTabId);return {...target(t),active:tab?.active??false,windowId:tab?.windowId,...(opener?{openerId:opener.id}:{})};});}
  async function find(id){const t=(await targets()).find(t=>t.id===id);if(!t)throw Error(`Target not found: ${id}`);return t;}
  function debuggee(root,child){return {...(root.tabId?{tabId:root.tabId}:{targetId:root.targetId}),...(child?{sessionId:child}:{})};}
  function forgetRoot(sid,root){roots.delete(sid);for(const [id,owner]of children)if(owner===root)children.delete(id);}
  async function attach(id,c){
    const t=await find(id);if(t.tabId)claim(t.tabId,c);
    const sid=`bridge:${id}`;
    if(!roots.has(sid)){await chrome.debugger.attach(t.tabId?{tabId:t.tabId}:{targetId:id},'1.3');const root={targetId:id,tabId:t.tabId,owner:ownerKey(c)};roots.set(sid,root);if(testViewport)await chrome.debugger.sendCommand(debuggee(root),'Emulation.setDeviceMetricsOverride',{...testViewport,mobile:false});}
    return {sessionId:sid};
  }
  chrome.debugger.onEvent.addListener((source,method,params)=>{
    const entry=[...roots].find(([,r])=>source.tabId?r.tabId===source.tabId:r.targetId===source.targetId);
    if(!entry)return;
    const [sid,root]=entry;
    if(method==='Target.attachedToTarget')children.set(params.sessionId,root);
    if(method==='Target.detachedFromTarget')children.delete(params.sessionId);
    emit('cdp',{method,params,sessionId:source.sessionId??sid});
  });
  chrome.debugger.onDetach.addListener((source,reason)=>{
    for(const [sid,r]of roots)if(source.tabId?r.tabId===source.tabId:r.targetId===source.targetId){forgetRoot(sid,r);emit('cdp',{method:'Target.detachedFromTarget',params:{sessionId:sid,targetId:r.targetId,reason}});}
  });
  chrome.tabs.onRemoved.addListener(id=>{owners.delete(id);for(const [sid,r]of roots)if(r.tabId===id){forgetRoot(sid,r);emit('cdp',{method:'Target.targetDestroyed',params:{targetId:r.targetId}});}});
  chrome.tabs.onUpdated.addListener(async(id,change)=>{if(!('url'in change||'title'in change))return;const t=(await targets()).find(t=>t.tabId===id);if(t)emit('cdp',{method:'Target.targetInfoChanged',params:{targetInfo:t}});});
  chrome.tabs.onCreated?.addListener(async tab=>{
    // chrome.debugger는 브라우저 세션의 Target 생성 이벤트를 제공하지 않아 탭 이벤트로 복원한다.
    if(tab.openerTabId&&owners.has(tab.openerTabId))owners.set(tab.id,owners.get(tab.openerTabId));
    for(let i=0;i<40;i++){
      const t=(await targets()).find(t=>t.tabId===tab.id);
      if(t){emit('cdp',{method:'Target.targetCreated',params:{targetInfo:t}});return;}
      await new Promise(r=>setTimeout(r,25));
    }
  });
  async function createTab(params,c){
    // 마지막 탭을 닫은 뒤에도 세션에 이전 anchor ID가 남을 수 있다.
    const anchor=params.anchorTargetId?(await targets()).find(t=>t.id===params.anchorTargetId):null;
    const windowId=params.windowId??anchor?.windowId;
    const t=await chrome.tabs.create({url:params.url??'about:blank',active:false,...(windowId!==undefined?{windowId}:{})});
    claim(t.id,c);
    const all=await targets();let found=all.find(x=>x.tabId===t.id);
    for(let i=0;!found&&i<20;i++){await new Promise(r=>setTimeout(r,25));found=(await targets()).find(x=>x.tabId===t.id);}
    if(!found)throw Error('Created Chrome tab has no debugger target');
    return {targetId:found.id,tabId:t.id,windowId:t.windowId};
  }
  async function waitForDownload(params,c){
    const started=params.startedAfterMs??Date.now();const deadline=Date.now()+(params.timeoutMs??30000);
    while(Date.now()<deadline){
      const rows=await chrome.downloads.search({startedAfter:new Date(started-50).toISOString(),orderBy:['-startTime'],limit:20});
      const ownTabs=await chrome.tabs.query({});
      const allowed=ownTabs.filter(t=>owners.get(t.id)===ownerKey(c));
      const normalizeName=name=>(name??'').split(/[\\/]/).at(-1).replace(/ \(\d+\)(?=\.[^.]+$|$)/,'');
      const withoutHash=url=>{try{const u=new URL(url);u.hash='';return u.href}catch{return url}};
      const item=rows.find(d=>{
        if(params.expectedFilename&&normalizeName(d.filename)!==normalizeName(params.expectedFilename))return false;
        if(params.referrerUrl){const referrer=withoutHash(params.referrerUrl);return d.referrer?withoutHash(d.referrer)===referrer:allowed.some(t=>withoutHash(t.url)===referrer);}
        return !d.referrer||allowed.some(t=>withoutHash(d.referrer)===withoutHash(t.url));
      });
      if(item?.state==='complete')return {downloadId:item.id,absolutePath:item.filename};
      if(item?.state==='interrupted')throw Error(`Download interrupted: ${item.error}`);
      await new Promise(r=>setTimeout(r,50));
    }
    throw Error('Timed out waiting for Chrome download');
  }
  async function aside(method,p,c){
    if(method==='Aside.callExtensionMV3Api'){
      if(!allowedMv3Methods.has(p.method))throw Error(`Chrome API is not allowed: ${p.method}`);
      const keys=p.method.split('.').slice(1);const methodName=keys.pop();let namespace=chrome;for(const key of keys)namespace=namespace?.[key];
      if(typeof namespace?.[methodName]!=='function')throw Error(`Chrome API unavailable: ${p.method}`);
      return namespace[methodName](...(p.args??[]));
    }
    if(method==='Aside.listTabs')return {items:(await targets()).filter(t=>t.type==='page').map(t=>({targetId:t.id,tabId:t.tabId,title:t.title,url:t.url,active:t.active,windowId:t.windowId}))};
    if(method==='Aside.ownsTarget')return {owned:(await targets()).some(t=>t.id===p.targetId)};
    if(method==='Aside.createAgentTab')return createTab(p,c);
    if(method==='Aside.controlTab'){
      if(p.action==='open'){
        const t=p.targetId?(await targets()).find(t=>t.id===p.targetId):null;
        if(t?.tabId){claim(t.tabId,c);await chrome.tabs.update(t.tabId,{active:true});return {success:true,action:'open',created:false,targetId:t.id,tabId:t.tabId};}
        const created=await createTab(p,c);return {success:true,action:'open',created:true,...created};
      }
      const t=await find(p.targetId);if(t.tabId)claim(t.tabId,c);
      if(p.action==='close'){if(t.tabId)await chrome.tabs.remove(t.tabId);return {};}
      if(['activate','focus'].includes(p.action)){await chrome.tabs.update(t.tabId,{active:true});return {};}
      throw Error(`Unsupported tab action: ${p.action}`);
    }
    if(method==='Aside.ensureTabInAiTabsGroup'){
      const t=await find(p.targetId);if(!t.tabId)return {};
      claim(t.tabId,c);const groups=await chrome.tabGroups.query({title:'Agent Tabs',...(t.windowId!==undefined?{windowId:t.windowId}:{})});
      const id=await chrome.tabs.group({tabIds:[t.tabId],...(groups[0]?{groupId:groups[0].id}:{})});
      await chrome.tabGroups.update(id,{title:'Agent Tabs',color:'blue'});return {};
    }
    if(method==='Aside.waitForDownload')return waitForDownload(p,c);
    if(method==='Aside.grantNotificationPermission'||method==='Aside.revokeNotificationPermission'){
      const origin=new URL(p.url??p.origin??(await find(p.targetId)).url).origin;
      await chrome.contentSettings.notifications.set({primaryPattern:origin+'/*',setting:method.includes('revoke')?'ask':'allow'});return method.includes('revoke')?{revoked:true}:{success:true};
    }
    if(method==='Aside.getThirdPartyCookies')return {enabled:(await chrome.privacy.websites.thirdPartyCookiesAllowed.get({})).value};
    if(method==='Aside.setThirdPartyCookies'){await chrome.privacy.websites.thirdPartyCookiesAllowed.set({value:p.enabled});return {};}
    throw Error(`Aside app command has no Chrome adapter: ${method}`);
  }
  async function cdp(p,c){
    const method=p.method,params=p.params??{};
    if(method.startsWith('Aside.'))return aside(method,params,c);
    if(method==='Target.getTargets')return {targetInfos:await targets()};
    if(method==='Target.getTargetInfo')return {targetInfo:await find(params.targetId??roots.get(p.sessionId)?.targetId)};
    if(method==='Target.setDiscoverTargets')return {};
    if(method==='Target.attachToTarget')return attach(params.targetId,c);
    if(method==='Target.createTarget')return createTab(params,c);
    if(method==='Target.closeTarget'){const t=await find(params.targetId);if(t.tabId){claim(t.tabId,c);await chrome.tabs.remove(t.tabId);}return {success:true};}
    if(method==='Target.detachFromTarget'){
      const r=roots.get(params.sessionId);if(r){if(r.tabId)claim(r.tabId,c);await chrome.debugger.detach(debuggee(r)).catch(()=>{});forgetRoot(params.sessionId,r);if(r.tabId)owners.delete(r.tabId);return {};}
    }
    if(method==='Browser.getVersion')return {userAgent:navigator.userAgent,product:navigator.userAgent.match(/Chrome\/[^ ]+/)?.[0]??'Chrome',protocolVersion:'1.3'};
    if(method==='Browser.setDownloadBehavior')return {};
    if(method==='Browser.cancelDownload'){await chrome.downloads.cancel(Number(params.guid));return {};}
    if(method==='Network.getCookies'&&!p.sessionId){const rows=(await Promise.all((params.urls??[]).map(url=>chrome.cookies.getAll({url})))).flat();return {cookies:rows.map(d=>({...d,expires:d.expirationDate??-1}))};}
    const root=roots.get(p.sessionId)??children.get(p.sessionId);
    if(!root)throw Error(`CDP target session unavailable: ${p.sessionId} (${method})`);
    if(root.tabId)claim(root.tabId,c);
    return chrome.debugger.sendCommand(debuggee(root,children.has(p.sessionId)?p.sessionId:undefined),method,params);
  }
  async function release(predicate){
    for(const [sid,r]of roots)if(predicate(r.owner)){
      roots.delete(sid);for(const [id,root]of children)if(root===r)children.delete(id);
      await chrome.debugger.detach(debuggee(r)).catch(()=>{});
    }
    for(const [id,key]of owners)if(predicate(key))owners.delete(id);
  }
  return {
    setProfileId(id){profileId=id;},
    setTestViewport(value){testViewport=value;},
    async invoke(method,args,c){
      if(method==='cdp')return cdp(args[0],c);
      if(method==='releaseSession'){await release(key=>key===ownerKey(c));return {};}
      throw Error(`Unknown bridge operation: ${method}`);
    },
    releaseConnection(id){return release(key=>key.startsWith(id+':')).catch(()=>{});},
  };
}
