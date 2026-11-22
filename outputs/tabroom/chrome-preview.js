import {acquireTabDebugger} from './debugger-connection.js';
import {nativeTabId} from './tab-identities.js';
import {createTabHighlight} from './tab-highlight.js';

const frames = new Map();
const leases = new Map();

chrome.debugger.onEvent.addListener((source,method,params)=>{
  if (method === 'Page.screencastFrame' && !source.sessionId) frames.get(source.tabId)?.(params);
});

export async function openTabPreview(sessionId,id,onDetach,onFrame) {
  const nativeId = await nativeTabId(sessionId,id);
  const previous = leases.get(nativeId);
  let release;
  const lease = new Promise(resolve=>{ release = resolve; });
  leases.set(nativeId,lease);
  const unlock = ()=>{
    if (leases.get(nativeId) === lease) leases.delete(nativeId);
    release();
  };
  let connection;
  try {
    await previous;
    if (previous && await nativeTabId(sessionId,id) !== nativeId) throw Error('탭룸 탭이 변경됐어요.');
    connection = await acquireTabDebugger(nativeId,'1.3',onDetach);
  } catch (error) {
    unlock();
    throw error;
  }
  const source = {tabId:nativeId};
  const command = (method,params)=>chrome.debugger.sendCommand(source,method,params);
  let started = false;
  return {
    async start(params) {
      await connection.setFocus(true);
      frames.set(nativeId,onFrame);
      await command('Page.startScreencast',params);
      started = true;
    },
    acknowledge:sessionId=>command('Page.screencastFrameAck',{sessionId}),
    async release() {
      frames.delete(nativeId);
      try {
        if (started && connection.connected) await command('Page.stopScreencast').catch(()=>{});
        await connection.release();
      } finally { unlock(); }
    },
  };
}

export async function captureTabStill(sessionId,id,groupId) {
  const nativeId = await nativeTabId(sessionId,id);
  if ((await chrome.tabs.get(nativeId)).groupId !== groupId) return null;
  const connection = await acquireTabDebugger(nativeId);
  try {
    if ((await chrome.tabs.get(nativeId)).groupId !== groupId) return null;
    const source = {tabId:nativeId};
    const viewport = (await chrome.debugger.sendCommand(source,'Page.getLayoutMetrics')).cssVisualViewport;
    if (!viewport?.clientWidth || !viewport?.clientHeight) return null;
    const {data} = await chrome.debugger.sendCommand(source,'Page.captureScreenshot',{
      format:'jpeg',quality:65,fromSurface:true,captureBeyondViewport:false,
      clip:{x:viewport.pageX,y:viewport.pageY,width:viewport.clientWidth,height:viewport.clientHeight,
        scale:Math.min(1,320/viewport.clientWidth)},
    });
    return data;
  } finally { await connection.release(); }
}

export function createPreviewHighlight(windowId) {
  const highlight = createTabHighlight(chrome,windowId);
  let version = 0;
  return async (sender, sessionId, id) => {
    const token = ++version;
    const target = id == null ? null : await nativeTabId(sessionId,id).catch(()=>null);
    if (token === version) await highlight.select(sender?.tab?.id,target);
  };
}

async function focusNativeTab(id) {
  try {
    const tab = await chrome.tabs.update(id,{active:true});
    if (tab) await chrome.windows.update(tab.windowId,{focused:true});
    return Boolean(tab);
  } catch { return false; }
}

export const focusPortalTab = sender=>focusNativeTab(sender?.tab?.id);

export async function focusPreviewTab(sessionId,id,groupId,isCurrent) {
  const nativeId = await nativeTabId(sessionId,id).catch(()=>null);
  if (nativeId == null) return false;
  const tab = await chrome.tabs.get(nativeId).catch(()=>null);
  return tab?.groupId === groupId && isCurrent() && await focusNativeTab(nativeId);
}
