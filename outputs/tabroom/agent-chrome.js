import {createChromeBackend} from './aside/backend.mjs';
import {acquireTabDebugger} from './debugger-connection.js';
import {firstTabRef,identifyTabs,nativeTabId} from './tab-identities.js';
import {captureReferenceImage,observePage} from './page-references.js';
import {focusPreviewTab} from './chrome-preview.js';
import {referenceUrl} from './interactive-ui/references.js';
import {isPortalOrigin,remoteOrigin} from './remote-config.js';
import {openRemoteAgent} from './remote-agent.js';

const HOST = 'com.tabroom.agent';
const scopes = new Map();
const pending = new Map();
let native;
let opening;
let profile;
let pausePreview = async () => () => {};
let startPreviewActivity = () => {};
let captureBundleFrames = async () => [];
let onSessionTitle = () => {};
let referenceCaptureAllowed = () => false;
let onRemoteDisconnect = () => {};
const siteFavicons = new Map();
const groupColors = ['blue','orange','green','purple','cyan','pink','red','yellow','grey'];

export function setBundleCapture(capture) {
  captureBundleFrames = capture;
}

export function setSessionTitleListener(listener) {
  onSessionTitle = listener;
}

export function setRemoteDisconnectListener(listener) {
  onRemoteDisconnect = listener;
}

export function setReferenceCapturePolicy(allowed) {
  referenceCaptureAllowed=allowed;
}

export function setAgentPreviewPause(pause) {
  pausePreview = pause;
}

export function setAgentPreviewActivity(start) {
  startPreviewActivity = start;
}

function changesPage(method, params = {}) {
  if (method === 'Input.dispatchMouseEvent') return params.type !== 'mouseMoved' || params.buttons > 0;
  return /^(Input\.|Page\.(navigate|reload|navigateToHistoryEntry)$|DOM\.(focus|scrollIntoViewIfNeeded)$)/.test(method);
}

function allowedUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (isPortalOrigin(url.origin)) return url.pathname.startsWith('/demo/');
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch { return false; }
}

function browserUrl(value) {
  if (value === 'about:blank' || allowedUrl(value)) return value;
  throw Error('이 주소는 현재 탭 그룹에서 열 수 없어요.');
}

async function localFavicon(page) {
  if (!allowedUrl(page) || typeof chrome.runtime?.getURL !== 'function') return '';
  if (siteFavicons.has(page)) return siteFavicons.get(page);
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl',page);
  url.searchParams.set('size','16');
  const icon = fetch(url).then(async response=>{
    if (!response.ok) return '';
    const data = new Uint8Array(await response.arrayBuffer());
    return data.length && data.length<=4096 ? 'data:image/png;base64,'+data.toBase64() : '';
  }).catch(()=> '');
  if (siteFavicons.size>=150) siteFavicons.delete(siteFavicons.keys().next().value);
  siteFavicons.set(page,icon);
  return icon;
}

export async function popularSites() {
  const sites = await chrome.topSites?.get?.() ?? [];
  const byHost = new Map();
  for (const site of sites) {
    if (!allowedUrl(site.url) || isPortalOrigin(new URL(site.url).origin)) continue;
    const host = new URL(site.url).hostname.replace(/^www\./i,'');
    if (!byHost.has(host)) byHost.set(host,{url:site.url,title:String(site.title || host).slice(0,120)});
    if (byHost.size===4) break;
  }
  return [...byHost.values()];
}

export async function listPopularSites() {
  return Promise.all((await popularSites()).map(async site=>({...site,favicon:await localFavicon(site.url)})));
}

export async function siteIcons(urls) {
  const pages=Array.isArray(urls) ? urls.filter(url=>typeof url==='string' && url.length<=4096 && allowedUrl(url)).slice(0,8) : [];
  return Object.fromEntries(await Promise.all(pages.map(async url=>[url,await localFavicon(url)])));
}

export async function searchVisitedSites(query) {
  const text=typeof query==='string' ? query.trim().slice(0,200) : '';
  if (!text) return [];
  const normalize=value=>value.normalize('NFKC').toLowerCase();
  const needle=normalize(text);
  const [popular,visits]=await Promise.all([
    chrome.topSites?.get?.().catch(()=>[]) ?? [],
    chrome.history?.search?.({text,startTime:Date.now()-90*86400000,maxResults:40}).catch(()=>[]) ?? [],
  ]);
  const matches=new Map();
  for (const {url,title,lastVisitTime=0,typedCount=0} of [...popular,...visits]) {
    if (!allowedUrl(url)) continue;
    const page=new URL(url);
    if (isPortalOrigin(page.origin)) continue;
    const host=page.hostname.replace(/^www\./i,'');
    const label=String(title || host).slice(0,120);
    const score=normalize(host).startsWith(needle) || normalize(label).startsWith(needle) ? 2
      : normalize(label+' '+url).includes(needle) ? 1 : 0;
    if (score) matches.set(page.href,{url:page.href,title:label,score,lastVisitTime,typedCount});
  }
  const sorted=[...matches.values()].sort((a,b)=>b.score-a.score || b.typedCount-a.typedCount || b.lastVisitTime-a.lastVisitTime);
  return sorted.slice(0,5).map(({url,title})=>({url,title}));
}

export async function withSessionGroups(rows) {
  if (!rows.some(row=>row.group)) return rows;
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}),chrome.tabs.query({})]);
  const keys = rows.filter(row=>row.group).map(row=>row.id);
  const ownership = await chrome.storage.session.get([
    ...groups.map(group=>'owner:'+group.id), ...keys.map(key=>'group:'+key),
  ]);
  const ids = new Map();
  for (const group of groups) {
    const known = ownership['owner:'+group.id];
    const owner = known && ownership['group:'+known]===group.id ? known : null;
    const candidates = owner ? [owner] : keys.filter(key=>group.title==='탭룸 · '+key.slice(0,12));
    if (candidates.length===1) {
      const key = candidates[0];
      ids.set(key,ids.has(key) ? null : group);
    }
  }
  const byGroup = Map.groupBy(tabs.filter(tab=>tab.groupId>=0),tab=>tab.groupId);
  return Promise.all(rows.map(async row=>{
    if (!row.group) return row;
    const group = ids.get(row.id);
    const members = byGroup.get(group?.id);
    const open = Boolean(members?.length);
    const count = open ? members.length : row.group.count;
    if (!count) return {...row,group:null};
    const ordered = open ? members.sort((a,b)=>a.index-b.index).map(describe) : row.group.tabs;
    const preview = await Promise.all(ordered.map(async ({title,url},i)=>({
      title,
      ...(i<3 && {favicon:await localFavicon(url)}),
    })));
    return {...row,group:{status:open ? 'open' : 'saved',...(open && {color:group.color}),count,tabs:preview}};
  }));
}

function listedUrl(tab) {
  return [tab.pendingUrl,tab.url].find(allowedUrl) || (tab.url === 'about:blank' ? tab.url : '');
}

function describe(tab) {
  const url = listedUrl(tab);
  return {title:tab.title || url || '새 탭', url, favicon:tab.favIconUrl || ''};
}

async function describeTabs(key,tabs,legacyIds=false) {
  const ids = await identifyTabs(key,tabs);
  return tabs.map((tab,i)=>({...describe(tab),id:ids[i],...(legacyIds && {legacyId:tab.id})}));
}

async function ungroupedBrowserTabs(windowId) {
  return (await chrome.tabs.query({windowId,groupId:-1})).filter(tab=>listedUrl(tab));
}

export async function listPreviewTabs(windowId, scopes) {
  const groupIds = new Set(scopes.map(scope=>scope.groupId));
  const lists = await Promise.all([...groupIds].map(async groupId=>[
    groupId,
    (await chrome.tabs.query(groupId === null ? {windowId,groupId:-1} : {groupId}))
      .filter(tab=>!tab.discarded && allowedUrl(listedUrl(tab))).sort((a,b)=>a.index-b.index),
  ]));
  const groups = new Map(lists);
  return (await Promise.all(scopes.map(async ({sessionId,groupId})=>{
    const tabs = groups.get(groupId);
    const ids = await identifyTabs(sessionId,tabs);
    return tabs.map((tab,i)=>{
      const {url,title,favicon} = describe(tab);
      return {id:ids[i],sessionId,groupId:tab.groupId,windowId:tab.windowId,title,favicon,
        domain:new URL(url).hostname};
    });
  }))).flat();
}

function groupTitle(key) {
  if (typeof key !== 'string' || !/^[a-f0-9-]{36}$/.test(key)) throw Error('잘못된 그룹 식별자입니다.');
  return '탭룸 · ' + key.slice(0, 12);
}

async function findGroup(key) {
  const title = groupTitle(key);
  const cache = 'group:' + key;
  const id = (await chrome.storage.session.get(cache))[cache];
  if (Number.isInteger(id)) {
    const remembered = await chrome.tabGroups.get(id).catch(() => null);
    if (remembered) return remembered;
  }
  const exact = (await chrome.tabGroups.query({title})).filter(group => group.title === title);
  if (exact.length > 1) throw Error('같은 이름의 Chrome 탭 그룹이 두 개 있어 대상을 확정할 수 없어요.');
  if (exact[0]) await trackGroup(key,exact[0].id);
  return exact[0] || null;
}

async function trackGroup(key,id) {
  await chrome.storage.session.set({['group:'+key]:id,['owner:'+id]:key});
}

async function groupIdentity(groupId) {
  if (!Number.isInteger(groupId) || groupId < 0) return null;
  const group = await chrome.tabGroups.get(groupId).catch(()=>null);
  if (!group) return null;
  const cache = 'owner:'+groupId;
  const key = (await chrome.storage.session.get(cache))[cache];
  if (key && (await findGroup(key))?.id === groupId) return {key};
  const legacy = /^탭룸 · ([0-9a-f]{8}-[0-9a-f]{3})$/.exec(group.title);
  return legacy ? {legacyPrefix:legacy[1]} : null;
}

async function groupState(key,title,expectedGroupId,legacyIds) {
  const group = await findGroup(key);
  if (!group || expectedGroupId != null && group.id !== expectedGroupId) return {open:false,tabs:[]};
  if (title && title !== group.title) {
    await trackGroup(key,group.id);
    await chrome.tabGroups.update(group.id,{title});
  }
  const tabs = await chrome.tabs.query({groupId:group.id});
  return {open:tabs.length > 0,groupId:group.id,windowId:group.windowId,title:title || group.title,
    tabs:await describeTabs(key,tabs.filter(tab=>listedUrl(tab)).sort((a,b)=>a.index-b.index),legacyIds)};
}

async function groupTabs(key, tabIds, windowId, title, assignments) {
  const id = await chrome.tabs.group({tabIds,createProperties:{windowId}});
  try {
    await trackGroup(key,id);
    const groups = await chrome.tabGroups.query({windowId});
    const colorsInUse = new Set(groups.filter(group=>group.id!==id).map(group=>group.color));
    const color = groupColors.find(value=>!colorsInUse.has(value));
    await chrome.tabGroups.update(id,{title:title || groupTitle(key),...(color && {color})});
    if (assignments?.size) await identifyTabs(key,await chrome.tabs.query({groupId:id}),assignments);
    return await groupState(key);
  } catch (error) {
    const owned = (await chrome.tabs.query({groupId:id}).catch(()=>[])).map(tab=>tab.id);
    if (owned.length) await chrome.tabs.ungroup(owned).catch(() => {});
    throw error;
  }
}

async function bindGroup({key,tabIds,windowId,title}) {
  const existing = await groupState(key);
  if (existing.open) return existing;
  if (!Array.isArray(tabIds) || !tabIds.length || tabIds.length > 100 || !tabIds.every(Number.isInteger)) throw Error('그룹에 넣을 탭을 고르세요.');
  const chosen = new Set(await Promise.all(tabIds.map(id=>nativeTabId(key,id))));
  const eligible = (await ungroupedBrowserTabs(windowId)).filter(tab => chosen.has(tab.id));
  if (eligible.length !== chosen.size) throw Error('탭 목록이 바뀌었어요. #으로 다시 선택해주세요.');
  const refs = await identifyTabs(key,eligible);
  return groupTabs(key,[...chosen],windowId,title,new Map(eligible.map((tab,i)=>[tab.id,refs[i]])));
}

async function restoreGroup({key,urls,refIds,windowId,title,tabIds=[]}) {
  const existing = await groupState(key);
  if (existing.open) return existing;
  if (!urls.length) throw Error('다시 열 수 있는 저장된 탭이 없어요.');
  const selection = await Promise.all(tabIds.map(id=>nativeTabId(key,id)));
  const selected = selection.length ? (await ungroupedBrowserTabs(windowId)).filter(tab=>selection.includes(tab.id)) : [];
  if (selected.length !== tabIds.length) throw Error('탭 목록이 바뀌었어요. #으로 다시 선택해주세요.');
  const selectedRefs = await identifyTabs(key,selected);
  const opened = [];
  try {
    for (const url of urls) opened.push((await chrome.tabs.create({windowId,url:browserUrl(url),active:false})).id);
    const assignments = new Map([
      ...opened.map((id,i)=>[id,refIds?.[i]]),
      ...selected.map((tab,i)=>[tab.id,selectedRefs[i]]),
    ]);
    const live = await groupTabs(key,[...opened,...selection],windowId,title,assignments);
    if (!live.open) throw Error('저장된 탭그룹을 연결할 수 없었어요.');
    const restored = await Promise.all(opened.map(id=>chrome.tabs.get(id).catch(()=>null)));
    const restoredIds=await identifyTabs(key,restored.filter(Boolean));
    let index=0;
    return {...live,restoredTabIds:restored.map(tab=>tab ? restoredIds[index++] : null)};
  } catch (error) {
    if (opened.length) await chrome.tabs.remove(opened).catch(() => {});
    throw error;
  }
}

async function closeGroupTabs({key,groupId,tabId}) {
  if (!Number.isInteger(groupId) || groupId < 0) throw Error('연결된 탭 그룹을 다시 확인해주세요.');
  const group = await findGroup(key);
  if (group?.id !== groupId) throw Error('연결된 탭 그룹이 바뀌었어요.');
  const all = (await chrome.tabs.query({groupId})).sort((a,b)=>a.index-b.index);
  const nativeId = tabId == null ? null : await nativeTabId(key,tabId);
  const toClose = nativeId == null ? all : all.filter(tab => tab.id === nativeId && listedUrl(tab));
  if (!toClose.length) throw Error('이미 닫혔거나 그룹에서 이동한 탭이에요.');
  if (toClose.some(tab => [tab.url,tab.pendingUrl].some(value=> {
    if (!value) return false;
    const origin = new URL(value);
    return isPortalOrigin(origin.origin) && !origin.pathname.startsWith('/demo/');
  }))) throw Error('탭룸 채팅을 그룹 밖으로 옮긴 뒤 그룹을 닫아주세요.');
  const before = await describeTabs(key,all.filter(tab=>listedUrl(tab)));
  await chrome.tabs.remove(toClose.map(tab=>tab.id));
  return {before,live:await groupState(key)};
}

async function appendGroupSites({key,groupId,urls,refIds}) {
  const group=await findGroup(key);
  if (group?.id!==groupId || !urls.length) throw Error('연결된 탭 그룹이 바뀌었어요.');
  const addresses=urls.map(browserUrl);
  const existing=await chrome.tabs.query({groupId});
  if (existing.length+addresses.length>100) throw Error('한 그룹에 최대 100개 탭을 열 수 있어요.');
  const opened=[];
  try {
    for (const url of addresses) opened.push(await chrome.tabs.create({windowId:group.windowId,url,active:false}));
    await chrome.tabs.group({groupId,tabIds:opened.map(tab=>tab.id)});
    const tabs=await Promise.all(opened.map(tab=>chrome.tabs.get(tab.id)));
    if (tabs.some(tab=>tab.groupId!==groupId)) throw Error('사이트를 추가할 그룹이 바뀌었어요.');
    const assignments=new Map(tabs.map((tab,index)=>[tab.id,refIds?.[index]]));
    const restoredTabIds=await identifyTabs(key,tabs,assignments);
    const live=await groupState(key,undefined,groupId);
    if (!live.open) throw Error('사이트를 추가할 그룹이 바뀌었어요.');
    return {...live,restoredTabIds};
  } catch (error) {
    if (opened.length) await chrome.tabs.remove(opened.map(tab=>tab.id)).catch(()=>{});
    throw error;
  }
}

async function openReplyReference({key,windowId,title,record}) {
  const url=referenceUrl(record.url);
  if (!url || !allowedUrl(url)) throw Error('이 출처의 웹 주소를 열 수 없어요.');
  const group=await findGroup(key);
  const [tabId,openedTabId]=[record.tabId,record.openedTabId].map(id=>
    Number.isSafeInteger(id) && id>=firstTabRef ? id : undefined);
  const tabInGroup=async id=>{
    if (!group || id===undefined) return null;
    const nativeId=await nativeTabId(key,id).catch(()=>null);
    if (nativeId===null) return null;
    const tab=await chrome.tabs.get(nativeId).catch(()=>null);
    return tab?.groupId===group.id ? tab : null;
  };
  const [original,opened]=await Promise.all([tabInGroup(tabId),tabInGroup(openedTabId)]);
  const match=[{id:tabId,tab:original},{id:openedTabId,tab:opened}].find(({tab})=>
    tab && referenceUrl(tab.pendingUrl || tab.url)===url);
  if (match) {
    await focusPreviewTab(key,match.id,group.id,()=>true);
    return {...await groupState(key,undefined,group.id),referenceTabId:match.id};
  }

  let restoreId;
  if (!original && tabId!==undefined) restoreId=tabId;
  else if (!opened) restoreId=openedTabId;
  const restored={key,urls:[url],refIds:[restoreId]};
  const live=group ? await appendGroupSites({...restored,groupId:group.id})
    : await restoreGroup({...restored,windowId,title});
  const referenceTabId=live.restoredTabIds?.[0];
  if (referenceTabId===undefined) throw Error('출처 탭을 복원하지 못했어요.');
  await focusPreviewTab(key,referenceTabId,live.groupId,()=>true);
  return {...live,referenceTabId};
}

export function scopedBackend(key, windowId, initiallyBound, emit) {
  let bound = initiallyBound;
  let queue = Promise.resolve();
  const disposers = [];
  const started = new Map();
  const recordings = new Map();
  const downloads = new Set();
  const startedAt = Date.now();
  let closed = false;
  const guard = () => {
    if (closed) throw Error('이 브라우저 작업이 끝났어요.');
  };
  async function group() {
    guard();
    if (!bound) throw Error('createTabGroup으로 이 채팅에 탭 그룹을 연결해주세요.');
    const result = await findGroup(key);
    if (!result) throw Error('연결된 탭 그룹을 다시 열어주세요.');
    return result;
  }
  async function tabs(query = {}) {
    guard();
    if (!bound) return ungroupedBrowserTabs(windowId);
    const g = await group();
    if (query.groupId != null && query.groupId !== g.id ||
        query.windowId != null && query.windowId >= 0 && query.windowId !== g.windowId) return [];
    const {currentWindow, lastFocusedWindow, ...filter} = query;
    return (await chrome.tabs.query({...filter,windowId:g.windowId,groupId:g.id})).filter(tab=>listedUrl(tab));
  }
  async function checkTab(id) {
    const g = await group();
    const tab = await chrome.tabs.get(id);
    guard();
    if (tab.groupId !== g.id || tab.windowId !== g.windowId || !listedUrl(tab)) {
      throw Error('이 탭은 현재 채팅의 탭 그룹에 속하지 않아요.');
    }
    return tab;
  }
  async function trackPreviewActivity(tab) {
    const [id] = await identifyTabs(key,[tab]);
    const onChange = listener => {
      const update = (nativeId,change,current)=>{
        if (nativeId !== tab.id) return;
        if (current.groupId !== tab.groupId) listener({closed:true});
        else if (change.status) listener({loading:change.status === 'loading'});
      };
      const remove = nativeId=>{ if (nativeId === tab.id) listener({closed:true}); };
      chrome.tabs.onUpdated.addListener(update);
      chrome.tabs.onRemoved.addListener(remove);
      return () => {
        chrome.tabs.onUpdated.removeListener(update);
        chrome.tabs.onRemoved.removeListener(remove);
      };
    };
    return startPreviewActivity({id,groupId:tab.groupId,status:tab.status},onChange);
  }
  async function agentTabIds(rows,field) {
    const allowed = new Map((await tabs()).map(tab=>[tab.id,tab]));
    const physical = rows.flatMap(row=>allowed.has(row[field]) ? [allowed.get(row[field])] : []);
    const refs = await identifyTabs(key,physical);
    const idMap = new Map(physical.map((tab,i)=>[tab.id,refs[i]]));
    return rows.flatMap(row=>{
      const source = row[field];
      if (!Number.isInteger(source)) return [row];
      const id = idMap.get(source);
      if (id === undefined) return [];
      const next = {...row,[field]:id};
      if ('openerTabId' in next) {
        const opener = idMap.get(row.openerTabId);
        if (opener === undefined) delete next.openerTabId;
        else next.openerTabId = opener;
      }
      return [next];
    });
  }
  function scopedEvent(event, filter) {
    return {addListener(listener) {
      const wrapped = async (...args) => {
        if (closed || !bound) return;
        try { if (await filter(...args) && !closed) await listener(...args); }
        catch { /* 탭이 이동하거나 닫혔을 때 전달하지 않는다. */ }
      };
      event.addListener(wrapped);
      disposers.push(() => event.removeListener(wrapped));
    }};
  }
  async function downloadRows(query = {}) {
    const permitted = new Set((await tabs()).map(tab=>new URL(tab.url).origin));
    const rows = await chrome.downloads.search(query);
    return rows.filter(item=>{
      if (downloads.has(item.id)) return true;
      if (Date.parse(item.startTime) < startedAt || !item.referrer) return false;
      try { return permitted.has(new URL(item.referrer).origin); } catch { return false; }
    });
  }
  async function stopRecording(tabId) {
    const recording = recordings.get(tabId);
    if (!recording) return {};
    try {
      await recording.started;
      return await chrome.debugger.sendCommand({tabId}, recording.stop);
    } finally {
      recordings.delete(tabId);
      recording.resume();
    }
  }
  const chromeForGroup = {
    downloads:{
      search:downloadRows,
      async download(options) {
        const url = browserUrl(options.url);
        const origin = new URL(url).origin;
        if (!(await tabs()).some(tab=>new URL(tab.url).origin === origin)) {
          throw Error('선택한 탭의 사이트에서만 파일을 받을 수 있어요.');
        }
        guard();
        const id = await chrome.downloads.download({
          url, filename:options.filename, conflictAction:'uniquify',saveAs:options.saveAs,
        });
        downloads.add(id);
        return id;
      },
    },
    tabs:{
      query:tabs,
      get:checkTab,
      async update(id, changes) {
        const tab = await checkTab(id);
        const endActivity = changes.url ? await trackPreviewActivity(tab) : undefined;
        try { return await chrome.tabs.update(id,changes); }
        finally { endActivity?.(); }
      },
      remove:async id => { await checkTab(id); return chrome.tabs.remove(id); },
      create:async ({url}) => {
        guard();
        const g = bound ? await group() : null;
        const tab = await chrome.tabs.create({url:browserUrl(url),windowId:g?.windowId ?? windowId,active:false});
        if (g) {
          try { await chrome.tabs.group({tabIds:[tab.id],groupId:g.id}); }
          catch (error) { await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
          if (url !== 'about:blank') (await trackPreviewActivity({...tab,groupId:g.id}))?.();
        }
        return tab;
      },
      onCreated:scopedEvent(chrome.tabs.onCreated,tab=>checkTab(tab.id)),
      onUpdated:scopedEvent(chrome.tabs.onUpdated,id=>checkTab(id)),
      onRemoved:scopedEvent(chrome.tabs.onRemoved,id=>started.has(id)),
    },
    tabGroups:{
      query:async () => [await group()],
      get:async id => {
        const g = await group();
        if (g.id !== id) throw Error('이 세션의 탭 그룹만 조회할 수 있어요.');
        return g;
      },
    },
    windows:{
      get:async id => {
        const g = await group();
        if (g.windowId !== id) throw Error('이 세션의 Chrome 창만 조회할 수 있어요.');
        return {...await chrome.windows.get(id), tabs:await tabs()};
      },
    },
    runtime:{getManifest:()=>chrome.runtime.getManifest()},
    debugger:{
      getTargets:async () => {
        const targets = await chrome.debugger.getTargets();
        const ids = new Set((await tabs()).map(tab=>tab.id));
        return targets.filter(target=>ids.has(target.tabId));
      },
      attach:async (target,version) => {
        await checkTab(target.tabId);
        if (started.get(target.tabId)?.connected) return;
        const connection = await acquireTabDebugger(target.tabId, version);
        try { await checkTab(target.tabId); }
        catch (error) { await connection.release(); throw error; }
        if (started.get(target.tabId)?.connected) {
          await connection.release();
          return;
        }
        started.set(target.tabId, connection);
      },
      detach:async target => {
        const connection = started.get(target.tabId);
        started.delete(target.tabId);
        await stopRecording(target.tabId).catch(() => {});
        await connection?.release();
      },
      sendCommand:async (target,method,params) => {
        const tab = await checkTab(target.tabId);
        const connection = started.get(target.tabId);
        if (!connection?.connected) {
          throw Error('이 브라우저 작업의 디버거 연결이 없어요.');
        }
        if (method === 'Page.navigate') browserUrl(params.url);
        if (method === 'Page.setDownloadBehavior') throw Error('브라우저 다운로드 설정을 바꿀 수 없어요.');
        if (method === 'DOM.setFileInputFiles' && params.files?.length) throw Error('로컬 파일 업로드는 탭룸에서 사용할 수 없어요.');
        if (/^(Browser|Storage|Fetch)\./.test(method) || /^Network\.(getAllCookies|getCookies|setCookie|setCookies|deleteCookies|clearBrowserCookies)$/.test(method) ||
            /^Target\./.test(method) && !['Target.setAutoAttach','Target.setDiscoverTargets','Target.getTargetInfo'].includes(method)) {
          throw Error('이 Chrome 명령은 현재 탭으로 한정할 수 없어요.');
        }
        if (!target.sessionId) {
          const {tabId} = target;
          if (method === 'Emulation.setFocusEmulationEnabled' && typeof params.enabled === 'boolean') {
            return connection.setFocus(params.enabled);
          }
          const recording = recordings.get(tabId);
          if (method === 'Page.startScreencast' || method === 'Page.startScreenRecording') {
            const [id] = await identifyTabs(key,[tab]);
            const resume = await pausePreview(id);
            const stop = method === 'Page.startScreencast' ? 'Page.stopScreencast' : 'Page.stopScreenRecording';
            const started = chrome.debugger.sendCommand(target, method, params);
            recordings.set(tabId, {stop, resume, started});
            try { return await started; }
            catch (error) { recordings.delete(tabId); resume(); throw error; }
          }
          if (method === 'Page.stopScreencast' || method === 'Page.stopScreenRecording') {
            return recording?.stop === method ? stopRecording(tabId) : {};
          }
          if (method === 'Page.screencastFrameAck' && recording?.stop !== 'Page.stopScreencast') return {};
          if (method === 'Page.disable' && !recording) {
            const resume = await pausePreview(tabId);
            try { return await chrome.debugger.sendCommand(target, method, params); }
            finally { resume(); }
          }
        }
        const endActivity = changesPage(method,params) ? await trackPreviewActivity(tab) : undefined;
        try { return await chrome.debugger.sendCommand(target,method,params); }
        finally { endActivity?.(); }
      },
      onEvent:scopedEvent(chrome.debugger.onEvent,(source, method)=>
        started.has(source.tabId) && (source.sessionId || !method.startsWith('Page.screencast') || recordings.has(source.tabId)) && checkTab(source.tabId)),
      onDetach:scopedEvent(chrome.debugger.onDetach,source=>started.has(source.tabId)),
    },
  };
  for (const method of ['getCurrent','getLastFocused']) chromeForGroup.windows[method] = async () => chromeForGroup.windows.get((await group()).windowId);
  chromeForGroup.windows.getAll = async () => [await chromeForGroup.windows.getCurrent()];

  for (const method of ['cancel','pause','resume','erase']) {
    chromeForGroup.downloads[method] = async argument => {
      const rows = await downloadRows(method === 'erase' ? argument : {id:argument});
      guard();
      if (method === 'erase') return (await Promise.all(rows.map(item=>chrome.downloads.erase({id:item.id})))).flat();
      if (!rows.length) throw Error('이 브라우저 작업의 다운로드가 아니에요.');
      return chrome.downloads[method](argument);
    };
  }

  const backend = createChromeBackend(chromeForGroup,(name,data)=>{
    const info = data.params?.targetInfo;
    if (!info || !Number.isInteger(info.tabId)) return emit(name,data);
    void agentTabIds([info],'tabId').then(([targetInfo])=>{
      if (targetInfo && !closed) emit(name,{...data,params:{...data.params,targetInfo}});
    }).catch(()=>{});
  });
  const releaseMovedTab = async (id,changes) => {
    if (!('groupId' in changes) && !('url' in changes)) return;
    const connection = started.get(id);
    if (!connection) return;
    try { await checkTab(id); }
    catch {
      if (started.get(id) !== connection) return;
      started.delete(id);
      await stopRecording(id).catch(()=>{});
      await connection.release();
    }
  };
  chrome.tabs.onUpdated.addListener(releaseMovedTab);
  disposers.push(()=>chrome.tabs.onUpdated.removeListener(releaseMovedTab));
  backend.setProfileId(profile);
  const context = {connectionId:'tabroom',sessionId:crypto.randomUUID()};
  function serial(task) {
    const next = queue.then(task);
    queue = next.catch(()=>{});
    return next;
  }
  return {
    bind:(tabIds,title)=>serial(async()=>{
      guard();
      if (bound) throw Error('이 채팅에는 이미 탭 그룹이 연결돼 있어요.');
      if (!Array.isArray(tabIds) || !tabIds.length || tabIds.length > 100) throw Error('그룹에 넣을 탭을 고르세요.');
      const result = await bindGroup({key,tabIds,windowId,title});
      if (!result.open) throw Error('선택한 탭의 그룹을 만들 수 없었어요.');
      bound = true;
      return result;
    }),
    adopt:()=>serial(async()=>{
      guard();
      bound = Boolean(await findGroup(key));
    }),
    invoke:command=>serial(async()=>{
      guard();
      const method = command.method, params = command.params || {};
      if (!bound && !['Aside.listTabs','Aside.createAgentTab','Aside.ownsTarget','Target.getTargets','Target.setDiscoverTargets','Browser.getVersion'].includes(method)) {
        throw Error('createTabGroup으로 이 채팅에 탭 그룹을 연결해주세요.');
      }
      if (method === 'Aside.ensureTabInAiTabsGroup') {
        const targets = await chromeForGroup.debugger.getTargets();
        if (!targets.some(target=>target.id === params.targetId)) throw Error('대상 탭이 연결된 그룹에 없어요.');
        return {};
      }
      if (method === 'Aside.getThirdPartyCookies' || method === 'Aside.setThirdPartyCookies' ||
          method === 'Network.getCookies' ||
          method.startsWith('Aside.') && !['Aside.listTabs','Aside.ownsTarget','Aside.createAgentTab','Aside.controlTab','Aside.callExtensionMV3Api','Aside.waitForDownload'].includes(method)) {
        throw Error('이 동작은 선택한 브라우저 탭으로 한정할 수 없어요.');
      }
      const api = method === 'Aside.callExtensionMV3Api' ? params.method : '';
      if (api === 'chrome.tabs.get') {
        const nativeId = await nativeTabId(key,params.args?.[0]);
        command = {...command,params:{...params,args:[nativeId]}};
      }
      const result = await backend.invoke('cdp',[command],context);
      if (method === 'Aside.listTabs') return {...result,items:await agentTabIds(result.items,'tabId')};
      if (method === 'Target.getTargets') return {...result,targetInfos:await agentTabIds(result.targetInfos,'tabId')};
      if (method === 'Target.getTargetInfo') {
        const [targetInfo] = await agentTabIds([result.targetInfo],'tabId');
        if (!targetInfo) throw Error('이 탭은 현재 연결되어 있지 않아요.');
        return {...result,targetInfo};
      }
      if (method === 'Aside.createAgentTab' || method === 'Aside.controlTab' && Number.isInteger(result?.tabId)) {
        const [row] = await agentTabIds([result],'tabId');
        if (!row) throw Error('이 탭은 현재 연결되어 있지 않아요.');
        return row;
      }
      if (api === 'chrome.tabs.query') return agentTabIds(result,'id');
      if (api === 'chrome.tabs.get') return (await agentTabIds([result],'id'))[0] ?? null;
      if (api.startsWith('chrome.windows.')) {
        const windowInfo = async row=>row?.tabs ? {...row,tabs:await agentTabIds(row.tabs,'id')} : row;
        return Array.isArray(result) ? Promise.all(result.map(windowInfo)) : windowInfo(result);
      }
      return result;
    }),
    async close() {
      closed = true;
      for (const dispose of disposers) dispose();
      await backend.releaseConnection('tabroom');
      await Promise.allSettled([...recordings.keys()].map(stopRecording));
      await Promise.allSettled([...started.values()].map(connection=>connection.release()));
      started.clear();
    },
  };
}

export async function operation(name, params) {
  switch (name) {
    case 'reference/open': return openReplyReference(params);
    case 'reference/observe': {
      const group=await findGroup(params.key);
      return group && observePage(params.key,group.id,params);
    }
    case 'reference/image': {
      const group=await findGroup(params.key);
      const allowed=()=>group && referenceCaptureAllowed(group.windowId,params.record.tabId);
      return {enabled:referenceCaptureAllowed(),frame:allowed()
        ? await captureReferenceImage(params.key,group.id,params.record,allowed).catch(()=>null) : null};
    }
    case 'group/read': return groupState(params.key,params.title,params.expectedGroupId,params.legacyIds);
    case 'group/identity': return groupIdentity(params.groupId);
    case 'group/bind': return bindGroup(params);
    case 'group/restore': return restoreGroup(params);
    case 'group/appendSites': return appendGroupSites(params);
    case 'group/close': return closeGroupTabs(params);
    case 'browser/references': return (params.bound ? (await groupState(params.key)).tabs :
      await describeTabs(params.key,await ungroupedBrowserTabs(params.windowId))).filter(tab=>!params.tabIds || params.tabIds.includes(tab.id));
    case 'group/bundleFrames': {
      const group = await groupState(params.key,undefined,params.groupId);
      if (!group.open) return [];
      return captureBundleFrames(params.key,group.groupId,group.tabs.map(tab=>tab.id));
    }
    case 'browser/open': {
      if (scopes.has(params.runId)) throw Error('이미 열린 작업입니다.');
      const backend = scopedBackend(params.key,params.windowId,params.bound,(event,data)=>{
        native?.postMessage({type:'event',runId:params.runId,event,data});
      });
      scopes.set(params.runId,backend);
      return {};
    }
    case 'browser/group': {
      const backend = scopes.get(params.runId);
      if (!backend) throw Error('이 작업의 브라우저 연결이 닫혔어요.');
      return backend.bind(params.tabIds,params.title);
    }
    case 'browser/bound': {
      await scopes.get(params.runId)?.adopt();
      return {};
    }
    case 'browser/cdp': {
      const backend = scopes.get(params.runId);
      if (!backend) throw Error('선택한 탭에 대한 브라우저 연결이 닫혔어요.');
      return backend.invoke(params.command);
    }
    case 'browser/close': {
      const backend = scopes.get(params.runId);
      scopes.delete(params.runId);
      await backend?.close();
      return {};
    }
    default: throw Error('지원하지 않는 브라우저 요청입니다.');
  }
}

export async function connectAgent(ticket) {
  if (native) return native;
  if (!opening) opening = (async () => {
    if (remoteOrigin && !ticket) throw Error('포털에서 원격 연결을 다시 시작해주세요.');
    const device = (await chrome.storage.local.get('tabroomBrowserId')).tabroomBrowserId || crypto.randomUUID();
    await chrome.storage.local.set({tabroomBrowserId:device});
    const remote = remoteOrigin ? await openRemoteAgent(ticket,device) : null;
    profile = remote?.profile ?? device;
    const port = remote?.port ?? chrome.runtime.connectNative(HOST);
    native = port;
    port.onMessage.addListener(async message => {
      if (message.type === 'result') {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        request.reply(message.result,message.error);
      } else if (message.type === 'sessionTitleChanged') {
        onSessionTitle(message.sessionId,message.title);
      } else if (message.type === 'call') {
        try {
          const result = await operation(message.method,message.params);
          port.postMessage({type:'reply',id:message.id,result});
        } catch (error) {
          try { port.postMessage({type:'reply',id:message.id,error:String(error.message)}); } catch { /* connection closed */ }
        }
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (native !== port) return;
      native = undefined;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reply(null,remote ? '원격 탭룸 연결이 끊겼어요.' : '탭룸 로컬 실행기에 연결할 수 없어요. 일반 Chrome 탭룸 열기를 실행해주세요.');
      }
      pending.clear();
      for (const backend of scopes.values()) void backend.close();
      scopes.clear();
      if (remote) onRemoteDisconnect();
    });
    if (!remote) port.postMessage({type:'hello',profile});
    return port;
  })().finally(() => { opening = undefined; });
  return opening;
}

export async function sendAgentRequest(windowId, message, reply) {
  const id = crypto.randomUUID();
  try {
    const port = await connectAgent();
    const timer = setTimeout(() => {
      pending.delete(id);
      reply(null,'탭룸 응답 시간이 초과됐어요.');
    },25000);
    pending.set(id,{reply,timer});
    port.postMessage({type:'api',id,method:message.method,params:message.params || {},windowId});
  } catch (error) {
    const request = pending.get(id);
    clearTimeout(request?.timer);
    pending.delete(id);
    reply(null,remoteOrigin ? error.message : '탭룸 로컬 실행기에 연결할 수 없어요.');
  }
}
