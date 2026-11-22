import {acquireTabDebugger} from './debugger-connection.js';
import {nativeTabId} from './tab-identities.js';
import {captureTabStill} from './chrome-preview.js';
import {referenceUrl} from './interactive-ui/references.js';

const frameUrl=frame=>referenceUrl(frame.url.includes('#') ? frame.url : frame.url+(frame.urlFragment ?? ''));

export function sameDocument(a,b) {
  return Boolean(a && b && a.nativeId===b.nativeId && a.frameId===b.frameId && a.loaderId===b.loaderId && a.url===b.url);
}

async function inDocument(key,tabId,groupId,action) {
  const nativeId=await nativeTabId(key,tabId);
  const tab=await chrome.tabs.get(nativeId);
  if (tab?.groupId!==groupId || tab.pendingUrl && referenceUrl(tab.pendingUrl)!==referenceUrl(tab.url)) return null;
  const connection=await acquireTabDebugger(nativeId);
  const send=(method,params)=>chrome.debugger.sendCommand({tabId:nativeId},method,params);
  const getDocument=async()=>{
    const {frame}=(await send('Page.getFrameTree')).frameTree;
    const url=frameUrl(frame);
    if (!url || !frame.loaderId) return null;
    return {nativeId,frameId:frame.id,loaderId:frame.loaderId,url};
  };
  try {
    const document=await getDocument();
    if (!document || (await chrome.tabs.get(nativeId))?.groupId!==groupId) return null;
    const result=await action({document,tab});
    if (!sameDocument(document,await getDocument()) || (await chrome.tabs.get(nativeId))?.groupId!==groupId) return null;
    return result;
  } finally { await connection.release(); }
}

export function observePage(key,groupId,{tabId,url}) {
  return inDocument(key,tabId,groupId,({document,tab})=>{
    if (url && referenceUrl(url)!==document.url) return null;
    return {tabId,url:document.url,title:tab.title||new URL(document.url).hostname,document};
  });
}

export function captureReferenceImage(key,groupId,record,allowed) {
  return inDocument(key,record.tabId,groupId,async({document})=>{
    if (!sameDocument(document,record.document) || !allowed()) return null;
    const data=await captureTabStill(key,record.tabId,groupId);
    return allowed() && data?.length<=110000 ? {format:'jpeg',data} : null;
  });
}
