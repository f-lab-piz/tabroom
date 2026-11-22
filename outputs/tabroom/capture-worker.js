import {connectAgent, listPopularSites, searchVisitedSites, siteIcons, listPreviewTabs, sendAgentRequest, setAgentPreviewActivity, setAgentPreviewPause, setBundleCapture, setReferenceCapturePolicy, setRemoteDisconnectListener, setSessionTitleListener, withSessionGroups} from './agent-chrome.js';
import {portalOrigin,remoteOrigin} from './remote-config.js';
import {captureTabStill, createPreviewHighlight, focusPortalTab, focusPreviewTab, openTabPreview} from './chrome-preview.js';
import {defaultPreviewSettings, normalizePreviewSettings, previewTabs, ungroupedTabs} from './streams.js';
import {cpuCounters, cpuPercent, previewStages, updateAutoPreview, workPreviewDeadline} from './preview-policy.js';
import {createWindowVisibilitySampler} from './window-visibility.js';
import {nativeTabId} from './tab-identities.js';

const PORTAL = portalOrigin + '/';
const remoteViewers = new Set();
const groupActions = new Set(['closeGroup','closeTab','restore','bundle/save']);
const capturePreferenceKey = 'tabroomCaptureEnabled';
const viewportExitDelay = 200;
const stillBudget = 8*1024*1024;
const windows = new Map();
const captures = new Map();
const closing = new Map();
const pausedForAgent = new Set();
const readyForBudget = new Map();
let settings = defaultPreviewSettings;
let nextBudgetFrame = 0;
let budgetTimer;
let captureEnabled;
const captureReady = chrome.storage.local.get(capturePreferenceKey).then(
  stored => { captureEnabled = stored[capturePreferenceKey] !== false; },
  () => { captureEnabled = true; },
);
let capturePreferenceWrite = captureReady;
let auto = {stage:1};
let previousCpu, systemCpu, cpuTimer, cpuReading = false;
const cpuSamples = [];
let work, workTimer;
let sessionGroupsTimer;
const sampleWindowVisibility = createWindowVisibilitySampler(chrome.runtime, windowsToCheck, applyWindowVisibility);

setReferenceCapturePolicy((windowId,id)=>{
  const state=windows.get(windowId);
  return captureEnabled && (windowId===undefined || Boolean(state && !state.minimized && !state.occluded) && !pausedForAgent.has(id));
});

setBundleCapture(async (sessionId,groupId,ids)=>{
  await captureReady;
  if (!captureEnabled) return [];
  const frames = [];
  let index = 0;
  const deadline = Date.now()+7500;
  const collect = async()=>{
    while (index < ids.length && Date.now() < deadline && captureEnabled) {
      const id = ids[index++];
      const cached = captures.get(id);
      if (cached?.groupId === groupId && cached.width === 320 && cached.lastFrame?.length <= 80000) {
        frames.push({id,format:cached.format,data:cached.lastFrame});
        continue;
      }
      try {
        const data = await captureTabStill(sessionId,id,groupId);
        if (!captureEnabled || !data) continue;
        const bitmap = await createImageBitmap(new Blob([Uint8Array.fromBase64(data)],{type:'image/jpeg'}));
        try {
          if (bitmap.width <= 320 && data.length <= 80000) frames.push({id,format:'jpeg',data});
          else {
            const width=Math.min(320,bitmap.width);
            const height=Math.max(1,Math.round(bitmap.height*width/bitmap.width));
            const canvas=new OffscreenCanvas(width,height);
            canvas.getContext('2d').drawImage(bitmap,0,0,width,height);
            const file=await canvas.convertToBlob({type:'image/jpeg',quality:.65});
            const snapshot=new Uint8Array(await file.arrayBuffer()).toBase64();
            if (captureEnabled && snapshot.length <= 80000) frames.push({id,format:'jpeg',data:snapshot});
          }
        } finally {bitmap.close();}
      } catch { /* 저장은 이미지 없이 진행한다. */ }
    }
  };
  let timer;
  try {
    await Promise.race([Promise.all([collect(),collect(),collect()]),new Promise(resolve=>{ timer=setTimeout(resolve,8000); })]);
    return captureEnabled ? frames.slice() : [];
  } finally {clearTimeout(timer);}
});

function limitMode() {
  return settings.limit === 'auto' ? previewStages[auto.stage] : settings.limit;
}

function frameLimit() {
  return settings.limit === 'auto' || settings.limit === 'active' ? 30 : settings.fps;
}

function publishMonitor(state) {
  const now = performance.now();
  state.drawTimes = state.drawTimes.filter(time => time > now - 2000);
  for (const viewer of state.viewers.values()) {
    send(viewer, {type:'monitorStats', systemCpu, fps:state.drawTimes.length / 2,
      autoStage:settings.limit === 'auto' ? auto.stage : null});
  }
}

async function sampleSystemCpu() {
  if (cpuReading) return;
  cpuReading = true;
  try {
    const counters = cpuCounters(await chrome.system?.cpu?.getInfo());
    if (!cpuTimer) return;
    systemCpu = cpuPercent(previousCpu, counters);
    previousCpu = counters;
    if (systemCpu === null) {
      cpuSamples.length = 0;
      auto = {stage:auto.stage};
    } else {
      cpuSamples.push(systemCpu);
      if (cpuSamples.length > 5) cpuSamples.shift();
      if (settings.limit === 'auto' && cpuSamples.length === 5) {
        const previousStage = auto.stage;
        auto = updateAutoPreview(auto,cpuSamples.reduce((sum, value) => sum + value,0) / 5,performance.now());
        if (auto.stage !== previousStage) refreshPolicy();
      }
    }
  } catch {
    previousCpu = systemCpu = null;
    cpuSamples.length = 0;
    auto = {stage:auto.stage};
  } finally {
    cpuReading = false;
  }
  for (const state of windows.values()) publishMonitor(state);
}

function syncMonitor() {
  const visible = [...windows.values()].some(state => streamViewer(state));
  if (visible && !cpuTimer) {
    cpuTimer = setInterval(sampleSystemCpu,1000);
    void sampleSystemCpu();
  } else if (!visible && cpuTimer) {
    clearInterval(cpuTimer);
    cpuTimer = previousCpu = systemCpu = null;
    cpuSamples.length = 0;
    auto = {stage:auto.stage};
    for (const state of windows.values()) publishMonitor(state);
  }
}

function updateWorkTimer() {
  clearTimeout(workTimer);
  const deadline = workPreviewDeadline(work);
  if (deadline === null) return;
  if (deadline <= performance.now()) {
    work.unwatch();
    work = undefined;
    if (limitMode() === 'active') refreshPolicy();
    return;
  }
  workTimer = setTimeout(updateWorkTimer,Math.ceil(deadline - performance.now()));
}

setAgentPreviewActivity((tab,watch) => {
  const previous = work;
  previous?.unwatch();
  const action = {id:tab.id, groupId:tab.groupId, loading:tab.status === 'loading'};
  work = action;
  action.unwatch = watch(({closed,loading})=>{
    if (work !== action) return;
    if (closed) {
      work.unwatch();
      work = undefined;
      if (limitMode() === 'active') refreshPolicy();
    } else work.loading = loading;
    updateWorkTimer();
  });
  updateWorkTimer();
  if (limitMode() === 'active' && (previous?.id !== action.id || previous.groupId !== action.groupId)) refreshPolicy();
  return () => {
    if (work !== action) return;
    action.endedAt = performance.now();
    updateWorkTimer();
  };
});

setAgentPreviewPause(async id => {
  if (pausedForAgent.has(id)) throw Error('이 탭에서 화면 캡처 작업이 이미 실행 중이에요.');
  pausedForAgent.add(id);
  stopCapture(id);
  for (const state of windows.values()) {
    if (state.tabs.some(tab => tab.id === id)) publish(state);
  }
  await closing.get(id);
  return () => {
    if (!pausedForAgent.delete(id)) return;
    for (const state of windows.values()) {
      if (state.tabs.some(tab => tab.id === id)) scheduleRefresh(state);
    }
  };
});

function isPortal(url) {
  try {
    const u = new URL(url);
    return u.origin === new URL(PORTAL).origin && ['/', '/index.html','/portal.html'].includes(u.pathname);
  } catch { return false; }
}

function windowState(windowId) {
  if (!windows.has(windowId)) {
    windows.set(windowId, {
      windowId, viewers: new Map(), portal: null, tabs: [], panelOpen: null, minimized: false,
      stills:new Map(), referenceShots:new Map(), drawTimes:[], bounds:null, boundsRevision:0, focused:false, coverSamples:0, occluded:false,
      refresh: Promise.resolve(), highlight:createPreviewHighlight(windowId),
    });
  }
  return windows.get(windowId);
}

function send(viewer, message) {
  try { viewer.port.postMessage(message); } catch { /* View closed before delivery. */ }
}

function sourcePortal(state, viewer) {
  return viewer.kind === 'panel' ? state.portal : viewer;
}

function scopedTabs(state, viewer) {
  const portal = sourcePortal(state, viewer);
  if (!portal) return [];
  const candidates = portal.picker && portal.groupId === null ? portal.picker.ids : null;
  const scoped = state.tabs.filter(tab=>tab.sessionId === portal.sessionId);
  const tabs = candidates ? ungroupedTabs(scoped,state.windowId) : scoped;
  return previewTabs(tabs, portal.groupId, candidates);
}

function syncHighlight(state) {
  const portal = state.portal;
  const id = portal?.picker?.selectedId;
  const visible = portal?.visible && id != null && scopedTabs(state,portal).some(tab=>tab.id === id);
  void state.highlight(portal?.port.sender,portal?.sessionId,visible ? id : null);
}

function panelViewer(state) {
  if (state.panelOpen === false) return null;
  return [...state.viewers.values()].find(viewer => viewer.kind === 'panel' && viewer.visible) ?? null;
}

function streamViewer(state) {
  if (state.minimized) return null;
  const portal = state.portal;
  if (portal?.visible && portal.picker?.mode === 'arc') return portal;
  return panelViewer(state) ?? (portal?.visible ? portal : null);
}

function needsWindowCheck(state) {
  const viewer = streamViewer(state);
  return captureEnabled && state.bounds && !state.focused && viewer &&
    (sourcePortal(state,viewer)?.groupId != null || viewer.picker?.mode === 'arc');
}

function windowsToCheck() {
  return [...windows.values()].filter(needsWindowCheck).slice(0,32).map(state=>({
    id:state.windowId, revision:state.boundsRevision, ...state.bounds,
  }));
}

function applyWindowVisibility(checked,covered) {
  const revisions = new Map(checked.map(({id,revision})=>[id,revision]));
  const coveredIds = new Set(covered);
  for (const state of windows.values()) {
    if (checked.length && revisions.get(state.windowId) !== state.boundsRevision) continue;
    const behind = coveredIds.has(state.windowId) && needsWindowCheck(state);
    state.coverSamples = behind ? Math.min(2,state.coverSamples+1) : 0;
    const occluded = state.coverSamples === 2;
    if (state.occluded === occluded) continue;
    state.occluded = occluded;
    if (occluded) state.drawTimes.length = 0;
    syncCaptures(state);
    publishMonitor(state);
  }
}

function updateWindowBounds(state,window) {
  if (window) {
    state.minimized = window.state === 'minimized';
    if (typeof window.focused === 'boolean' && state.focused !== window.focused) {
      state.focused = window.focused;
      state.boundsRevision++;
      state.occluded = false;
      state.coverSamples = 0;
    }
  }
  const {left,top,width,height} = window ?? {};
  const bounds = !state.minimized && [left,top,width,height].every(Number.isInteger) && width>0 && height>0
    ? {left,top,width,height} : null;
  if (JSON.stringify(state.bounds) === JSON.stringify(bounds)) return;
  state.bounds = bounds;
  state.boundsRevision++;
  state.occluded = false;
  state.coverSamples = 0;
}

function syncWindowVisibility() {
  sampleWindowVisibility([...windows.values()].some(needsWindowCheck));
}

function railCardVisible(state, viewer, id) {
  const groupId = sourcePortal(state,viewer)?.groupId;
  return !viewer.hasViewport || (viewer.viewport?.groupId === groupId && viewer.viewport?.ids.has(id));
}

function previewTargets(state, viewer) {
  if (!viewer?.visible || state.minimized || state.occluded) return [];
  const hasRail = streamViewer(state) === viewer;
  const portal = sourcePortal(state, viewer);
  const arc = hasRail && viewer === portal && portal?.picker?.mode === 'arc';
  const visibleArc = arc ? new Set(portal.picker.previewIds) : null;
  const onlyArc = !captureEnabled || (arc && portal.groupId === null);
  const workOnly = limitMode() === 'active';
  return scopedTabs(state, viewer).filter(tab => {
    if (pausedForAgent.has(tab.id)) return false;
    if (onlyArc) return visibleArc?.has(tab.id);
    const capture = captures.get(tab.id);
    const visible = hasRail && railCardVisible(state,viewer,tab.id);
    const leaving = hasRail && capture?.viewer === viewer && capture.offscreenTimer;
    if (!visible && !leaving) return false;
    return !workOnly || (tab.id === work?.id && tab.groupId === work.groupId);
  });
}

function oneFrame(viewer) {
  return !captureEnabled || (limitMode() === 'active' && viewer.picker?.mode === 'arc');
}

function canCapture(state, viewer, id) {
  return previewTargets(state, viewer).some(tab => tab.id === id);
}

function matchesCaptureSettings(capture) {
  return capture.format === settings.format && capture.width === settings.width;
}

function publish(state) {
  if (captureEnabled === undefined) return;
  const stream = streamViewer(state);
  const workOnly = limitMode() === 'active';
  for (const viewer of state.viewers.values()) {
    const portal = sourcePortal(state, viewer);
    const scopedIds = new Set(scopedTabs(state, viewer).map(tab => tab.id));
    const shownStills = new Map();
    const tabs = state.tabs.filter(tab => tab.sessionId === portal?.sessionId &&
      (tab.groupId === portal?.groupId || portal?.groupId === null && tab.groupId === -1)).map(({sessionId,...tab}) => {
      const permitted = scopedIds.has(tab.id);
      const capture = permitted ? captures.get(tab.id) : null;
      const ownStream = capture?.viewer === viewer;
      const elsewhere = captureEnabled && capture && !ownStream;
      const still = permitted && captureEnabled && viewer === stream && (!ownStream || !capture.lastFrame)
        ? state.stills.get(tab.id) : undefined;
      const frozen = still?.groupId === portal?.groupId ? still : undefined;
      const inView = railCardVisible(state,viewer,tab.id);
      if (frozen && (inView || viewer.stillTickets.get(tab.id) === frozen.ticket)) shownStills.set(tab.id, frozen);
      return {
        ...tab,
        status: (!captureEnabled && !ownStream) || !permitted || pausedForAgent.has(tab.id) ? 'paused' :
          elsewhere ? 'elsewhere' : capture?.status ?? ((state.occluded || workOnly || !inView) && portal?.groupId != null ? 'still' : 'starting'),
        reason: pausedForAgent.has(tab.id) ? '에이전트가 이 탭을 녹화 중이에요.' :
          elsewhere ? '다른 화면에서 미리보기 중' : capture?.reason,
        previewTicket: ownStream ? capture.ticket ?? frozen?.ticket : frozen?.ticket,
        stillTicket: frozen?.ticket,
        still: Boolean(frozen),
      };
    });
    send(viewer, {
      type: 'state', tabs, previewSettings: settings, enabled: captureEnabled, panelOpen: Boolean(panelViewer(state)),
      windowId: state.windowId,
      groupId: portal?.groupId ?? null, mode: portal?.picker?.mode ?? null,
      selectedId: portal?.picker?.selectedId ?? null, pickerTabs: portal?.picker?.ids ?? null,
      ...(viewer.kind === 'panel' && {sessionId:portal?.sessionId, group:portal?.group, running:portal?.running}),
    });
    for (const [id, ticket] of viewer.stillTickets) {
      if (shownStills.get(id)?.ticket !== ticket) send(viewer, {type:'release', id, ticket});
    }
    for (const [id, {ticket, format, data}] of shownStills) {
      if (viewer.stillTickets.get(id) !== ticket) send(viewer, {type:'previewFrame', id, ticket, format, data});
    }
    viewer.stillTickets = new Map([...shownStills].map(([id, still]) => [id, still.ticket]));
  }
}

function scheduleRefresh(state) {
  state.refresh = state.refresh.then(() => captureReady).then(() => refresh(state)).catch(console.error);
}

async function refresh(state) {
  if (!state.viewers.size) {
    for (const [id, capture] of captures) {
      if (capture.state === state) stopCapture(id);
    }
    if (!state.viewers.size) windows.delete(state.windowId);
    syncMonitor();
    syncWindowVisibility();
    return;
  }

  const scopes = new Map();
  for (const {kind,sessionId,groupId} of state.viewers.values()) {
    if (kind === 'portal' && sessionId) scopes.set(sessionId+':'+groupId,{sessionId,groupId});
  }
  const [window, rows] = await Promise.all([
    chrome.windows?.get?.(state.windowId)?.catch(() => null),
    listPreviewTabs(state.windowId,[...scopes.values()]),
  ]);
  updateWindowBounds(state,window);
  state.tabs = rows;
  const tabs = new Map(rows.map(tab=>[tab.id,tab]));
  for (const [id, still] of state.stills) {
    if (!captureEnabled || still.groupId !== state.portal?.groupId ||
        tabs.get(id)?.groupId !== still.groupId) state.stills.delete(id);
  }
  if (state.portal?.picker) syncHighlight(state);
  syncCaptures(state);
}

function syncCaptures(state) {
  if (!state.viewers.size || captureEnabled === undefined) return;
  const stream = streamViewer(state);
  const wanted = new Map(previewTargets(state,stream).map(tab=>[tab.id,{tab,viewer:stream}]));
  for (const [id, capture] of captures) {
    if (capture.state !== state) continue;
    const next = wanted.get(id);
    const viewer = next?.viewer;
    if (!viewer || capture.groupId !== next.tab.groupId || capture.once !== oneFrame(viewer) || !matchesCaptureSettings(capture) ||
        (capture.viewer !== viewer && !capture.ticket)) stopCapture(id);
    else if (capture.viewer !== viewer) movePreview(id, capture, viewer);
  }
  publish(state);
  for (const {tab,viewer} of wanted.values()) {
    if (!captures.has(tab.id)) void startCapture(state, viewer, tab);
  }
  syncMonitor();
  syncWindowVisibility();
}

function updateViewport(state,viewer,groupId,ids) {
  if (!viewer.hasViewport || !Array.isArray(ids) || sourcePortal(state,viewer)?.groupId !== groupId) return;
  const previous = viewer.viewport?.groupId === groupId ? viewer.viewport : null;
  const next = {groupId,ids:new Set(ids.filter(Number.isInteger))};
  const sameIds = (a,b)=>a.size === b.size && [...a].every(id=>b.has(id));
  if (previous && sameIds(previous.ids,next.ids)) return;
  viewer.viewport = next;
  for (const [id,capture] of captures) {
    if (capture.viewer !== viewer || capture.groupId !== groupId) continue;
    if (next.ids.has(id)) {
      clearTimeout(capture.offscreenTimer);
      capture.offscreenTimer = undefined;
    } else if (previous?.ids.has(id) && !capture.offscreenTimer) {
      capture.offscreenTimer = setTimeout(()=>{
        capture.offscreenTimer = undefined;
        syncCaptures(state);
      },viewportExitDelay);
    }
  }
  syncCaptures(state);
}

function startCapture(state, viewer, tab) {
  const {id} = tab;
  const capture = {
    state, viewer, sessionId:tab.sessionId, format: settings.format, width: settings.width, groupId:tab.groupId,
    status: 'starting', ticket: crypto.randomUUID(), once: oneFrame(viewer),
    frameId: 0, acks: [],
  };
  captures.set(id, capture);
  publish(state);
  capture.start = openScreencast(id, capture);
}

async function openScreencast(id, capture) {
  try {
    const pendingClosures = limitMode() === 'active' && !capture.once ? [...closing.values()] : [closing.get(id)];
    await Promise.allSettled(pendingClosures);
    if (!capture.ticket) return;
    capture.connection = await openTabPreview(capture.sessionId,id, () => {
      markUnavailable(id, capture, 'Chrome에서 미리보기 연결이 종료됐어요.');
    }, params=>{
      if (!capture.ticket || capture.finish) return;
      capture.acks.push(params.sessionId);
      capture.pendingFrame = params.data;
      deliverFrame(id,capture);
    });
    if (!capture.ticket) return;
    if (!canCapture(capture.state, capture.viewer, id)) {
      stopCapture(id);
      return;
    }
    capture.timeout = setTimeout(() => {
      markUnavailable(id, capture, '미리보기 연결 시간이 초과됐어요.');
    }, 8000);
    const format = capture.format;
    await capture.connection.start({
      format, ...(format === 'jpeg' ? {quality: 85} : {}),
      maxWidth: capture.width, maxHeight: 4096, everyNthFrame: 1,
      maxFramesInFlight: 1, sendLastFrame: true,
    });
  } catch (error) {
    if (!capture.ticket) return;
    console.debug('Tabroom preview:', error.message);
    markUnavailable(id, capture, /already attached/i.test(error.message)
      ? '다른 개발자 도구가 이 탭을 사용 중이에요.'
      : 'Chrome에서 탭 화면을 가져오지 못했어요.');
  }
}

function finishCapture(id, capture) {
  if (capture.finish) return;
  clearTimeout(capture.timeout);
  clearTimeout(capture.deliveryTimer);
  if (readyForBudget.get(id) === capture) readyForBudget.delete(id);
  capture.pendingFrame = null;
  capture.finish = Promise.resolve(capture.start).then(()=>capture.connection?.release());
  closing.set(id, capture.finish);
  void capture.finish.finally(() => {
    if (closing.get(id) === capture.finish) closing.delete(id);
  });
}

function releasePreview(id, capture, retainFrame = false) {
  clearTimeout(capture.offscreenTimer);
  if (capture.ticket && !retainFrame) send(capture.viewer, {type: 'release', id, ticket: capture.ticket});
  capture.ticket = undefined;
  capture.lastFrame = null;
  finishCapture(id, capture);
}

function movePreview(id, capture, viewer) {
  clearTimeout(capture.offscreenTimer);
  capture.offscreenTimer = undefined;
  if (capture.ticket) send(capture.viewer, {type: 'release', id, ticket: capture.ticket});
  capture.viewer = viewer;
  publish(capture.state);
  if (capture.lastFrame && capture.ticket) {
    send(viewer, {type: 'previewFrame', id, ticket: capture.ticket, format: capture.format, data: capture.lastFrame});
  }
  if (capture.inFlight?.id) void finishFrame(id, capture, true);
}

function markUnavailable(id, capture, reason) {
  if (captures.get(id) !== capture || !capture.ticket) return;
  releasePreview(id, capture);
  capture.status = 'unavailable';
  capture.reason = reason;
  publish(capture.state);
}

function storeStill(state,id,frame) {
  const {stills}=state;
  stills.delete(id);
  stills.set(id,frame);
  let size=[...stills.values()].reduce((sum,still)=>sum+still.data.length,0);
  for (const [oldId,still] of stills) {
    if (size<=stillBudget) break;
    stills.delete(oldId);
    size-=still.data.length;
  }
}

function stopCapture(id) {
  const capture = captures.get(id);
  if (!capture) return;
  captures.delete(id);
  const retainFrame = captureEnabled && capture.ticket && capture.lastFrame &&
    capture.groupId >= 0 && capture.groupId === capture.state.portal?.groupId &&
    capture.state.tabs.some(tab => tab.id === id && tab.groupId === capture.groupId);
  if (retainFrame) {
    storeStill(capture.state,id,{groupId:capture.groupId,ticket:capture.ticket,format:capture.format,data:capture.lastFrame});
    capture.viewer.stillTickets.set(id,capture.ticket);
  }
  releasePreview(id, capture, Boolean(retainFrame));
  for (const state of windows.values()) {
    if (state !== capture.state && canCapture(state, streamViewer(state), id)) scheduleRefresh(state);
  }
}

function refreshPolicy() {
  readyForBudget.clear();
  nextBudgetFrame = 0;
  clearTimeout(budgetTimer);
  budgetTimer = null;
  for (const [id, capture] of captures) {
    clearTimeout(capture.deliveryTimer);
    capture.deliveryTimer = null;
    if (!canCapture(capture.state,capture.viewer,id)) stopCapture(id);
    else deliverFrame(id,capture);
  }
  for (const state of windows.values()) {
    scheduleRefresh(state);
    publishMonitor(state);
  }
}

function deliverFrame(id, capture) {
  if (capture.inFlight || capture.deliveryTimer || !capture.pendingFrame || !capture.ticket || capture.finish ||
      !matchesCaptureSettings(capture)) return;
  if (!canCapture(capture.state, capture.viewer, id)) {
    stopCapture(id);
    return;
  }
  const limit = limitMode();
  if ((limit === 'total' || limit === 'active') && !capture.once) {
    readyForBudget.set(id, capture);
    scheduleBudget();
    return;
  }
  const wait = limit === 'tab' && capture.deliveredAt ? capture.deliveredAt + 1000 / frameLimit() - performance.now() : 0;
  if (wait > 1) {
    capture.deliveryTimer = setTimeout(() => {
      capture.deliveryTimer = null;
      deliverFrame(id, capture);
    }, Math.ceil(wait));
    return;
  }
  deliverFrameNow(id, capture);
}

function scheduleBudget() {
  if (budgetTimer || !readyForBudget.size) return;
  budgetTimer = setTimeout(() => {
    budgetTimer = null;
    for (const [id, capture] of readyForBudget) {
      readyForBudget.delete(id);
      if (!matchesCaptureSettings(capture) || !capture.ticket || capture.finish ||
          !canCapture(capture.state, capture.viewer, id)) continue;
      deliverFrameNow(id, capture);
      nextBudgetFrame = performance.now() + 1000 / frameLimit();
      break;
    }
    scheduleBudget();
  }, Math.max(0, Math.ceil(nextBudgetFrame - performance.now())));
}

function deliverFrameNow(id, capture) {
  const frame = capture.pendingFrame;
  capture.pendingFrame = null;
  capture.inFlight = {id: ++capture.frameId, acks: capture.acks.splice(0), frame};
  capture.deliveredAt = performance.now();
  clearTimeout(capture.timeout);
  capture.timeout = setTimeout(() => {
    markUnavailable(id, capture, '미리보기 화면의 응답이 없어요.');
  }, 5000);
  send(capture.viewer, {type: 'previewFrame', id, ticket: capture.ticket, frameId: capture.inFlight.id,
    format: capture.format, data: frame});
}

async function finishFrame(id, capture, ok, drawn = false) {
  clearTimeout(capture.timeout);
  if (!ok) {
    markUnavailable(id, capture, '미리보기 화면을 표시하지 못했어요.');
    return;
  }
  let replacedStill = false;
  if (drawn) {
    capture.lastFrame = capture.inFlight.frame;
    replacedStill = capture.state.stills.delete(id);
    capture.state.drawTimes.push(performance.now());
  }
  if (capture.status === 'starting' || replacedStill) {
    capture.status = 'ready';
    publish(capture.state);
  }
  if (capture.once) {
    capture.inFlight = null;
    finishCapture(id, capture);
    return;
  }
  const {acks} = capture.inFlight;
  capture.inFlight.id = null;
  try {
    for (const sessionId of acks) {
      if (!capture.ticket) return;
      await capture.connection.acknowledge(sessionId);
    }
  } catch {
    markUnavailable(id, capture, '미리보기 연결이 중단됐어요.');
  } finally {
    capture.inFlight = null;
  }
  deliverFrame(id, capture);
}

function onViewer(port, external) {
  if (port.name !== 'tabroom') return;
  let viewer;
  let state;
  port.onMessage.addListener(message => {
    if (message.type === 'hello' && !viewer) {
      const windowId = external ? port.sender.tab?.windowId : message.windowId;
      if (!Number.isInteger(windowId) || message.kind !== (external ? 'portal' : 'panel')) return;
      state = windowState(windowId);
      viewer = {port, kind: message.kind, visible: message.visible !== false,
        groupId: null, picker: null, hasViewport:message.viewport === true, viewport:null, stillTickets:new Map()};
      state.viewers.set(port, viewer);
      if (external && (viewer.visible || !state.portal)) state.portal = viewer;
      publish(state);
      publishMonitor(state);
      scheduleRefresh(state);
      if (!external) void refreshOwner(state);
      return;
    }
    if (!viewer) return;
    if (message.type === 'agent' && typeof message.id === 'string') {
      const origin = sourcePortal(state,viewer);
      if (external && ['reference/open','reference/image'].includes(message.method) &&
          (!viewer.sessionId || viewer.sessionId!==message.params?.id)) {
        send(viewer,{type:'agentResult',id:message.id,error:'현재 채팅의 출처를 확인해주세요.'});
        return;
      }
      if (!external && (!groupActions.has(message.method) || !origin?.sessionId ||
          origin.sessionId !== message.params?.id ||
          message.method !== 'restore' && origin.groupId !== message.params?.groupId)) {
        send(viewer,{type:'agentResult',id:message.id,error:'선택한 채팅의 탭 그룹이 바뀌었어요.'});
        return;
      }
      if (external && message.method==='sites/list') {
        void listPopularSites().then(result=>send(viewer,{type:'agentResult',id:message.id,result}),
          ()=>send(viewer,{type:'agentResult',id:message.id,result:[]}));
        return;
      }
      if (external && message.method==='sites/search') {
        void searchVisitedSites(message.params?.query).then(result=>send(viewer,{type:'agentResult',id:message.id,result}),
          ()=>send(viewer,{type:'agentResult',id:message.id,result:[]}));
        return;
      }
      if (external && message.method==='sites/icons') {
        void siteIcons(message.params?.urls).then(result=>send(viewer,{type:'agentResult',id:message.id,result}),
          ()=>send(viewer,{type:'agentResult',id:message.id,result:{}}));
        return;
      }
      if (external && message.method==='sites/historyStatus') {
        void chrome.permissions.contains({permissions:['history']}).then(result=>
          send(viewer,{type:'agentResult',id:message.id,result}),
          error=>send(viewer,{type:'agentResult',id:message.id,error:error.message}));
        return;
      }
      if (external && message.method==='sites/settings') {
        void chrome.runtime.openOptionsPage().then(()=>send(viewer,{type:'agentResult',id:message.id,result:true}),
          error=>send(viewer,{type:'agentResult',id:message.id,error:error.message}));
        return;
      }
      void sendAgentRequest(state.windowId, message, async (result, error) => {
        if (!error && message.method==='list') result = await withSessionGroups(result).catch(()=>result);
        send(viewer, {type: 'agentResult', id: message.id, result, error});
        if (!error && message.method==='bundle/save') {
          for (const current of windows.values()) for (const other of current.viewers.values()) {
            if (other !== viewer && other.kind==='portal') send(other,{type:'bundlesChanged'});
          }
        }
        if (!error && (['openGroup','reference/open'].includes(message.method) || groupActions.has(message.method) && message.method!=='bundle/save')) {
          scheduleSessionGroups();
          for (const current of windows.values()) for (const other of current.viewers.values()) {
            if (other !== viewer && other.kind === 'portal' && other.sessionId === message.params?.id) {
              send(other,{type:'groupChanged'});
            }
          }
        }
      });
    } else if (message.type === 'visibility') {
      viewer.visible = Boolean(message.visible);
      if (external && viewer.visible) state.portal = viewer;
      if (external) syncHighlight(state);
      else if (viewer.visible) void refreshOwner(state);
      scheduleRefresh(state);
    } else if (message.type === 'visiblePreviews') {
      updateViewport(state,viewer,message.groupId,message.ids);
    } else if (external && message.type === 'scope') {
      const groupId = Number.isInteger(message.groupId) && message.groupId >= 0 ? message.groupId : null;
      const changed = viewer.groupId !== groupId || viewer.sessionId !== message.sessionId;
      viewer.sessionId = message.sessionId;
      viewer.group = message.group;
      viewer.running = message.running === true;
      if (!changed) {
        const panel = panelViewer(state);
        if (panel && state.portal === viewer) send(panel,{type:'groupSummary',sessionId:viewer.sessionId,
          group:viewer.group,running:viewer.running});
        return;
      }
      viewer.groupId = groupId;
      viewer.picker = null;
      if (state.groupArrival?.portal === viewer) state.groupArrival = null;
      state.drawTimes.length = 0;
      if (viewer.visible) state.portal = viewer;
      syncHighlight(state);
      publish(state);
      scheduleRefresh(state);
    } else if (message.type === 'previewFrameResult') {
      const capture = captures.get(message.id);
      if (capture?.viewer !== viewer || !capture.ticket || capture.ticket !== message.ticket ||
          !capture.inFlight?.id || capture.inFlight.id !== message.frameId) return;
      if (!canCapture(state, viewer, message.id)) {
        stopCapture(message.id);
        return;
      }
      void finishFrame(message.id, capture, message.ok === true, message.drawn === true);
    } else if (message.type === 'retryCapture') {
      const capture = captures.get(message.id);
      if (capture?.viewer === viewer && capture.status === 'unavailable' && canCapture(state, viewer, message.id)) {
        stopCapture(message.id);
        scheduleRefresh(state);
      }
    } else if (message.type === 'previewSettings' && external) {
      const next = normalizePreviewSettings({...message.settings,width:message.settings?.width ?? settings.width});
      if (matchesCaptureSettings(next) && next.limit === settings.limit && next.fps === settings.fps) return;
      if (next.limit === 'auto' && settings.limit !== 'auto') {
        auto = {stage:1};
        cpuSamples.length = 0;
      }
      settings = next;
      refreshPolicy();
    } else if (message.type === 'panel' && external) {
      const operation = message.open ? chrome.sidePanel.open({windowId: state.windowId}) :
        chrome.sidePanel.close({windowId: state.windowId});
      operation.catch(error => send(viewer, {type: 'error', message: error.message}));
    } else if (message.type === 'capture' && typeof message.enabled === 'boolean') {
      capturePreferenceWrite = capturePreferenceWrite.then(async () => {
        captureEnabled = message.enabled;
        for (const current of windows.values()) scheduleRefresh(current);
        await chrome.storage.local.set({[capturePreferenceKey]: captureEnabled});
      }).catch(console.error);
    } else if (message.type === 'picker' && external) {
      const ids = Array.isArray(message.eligibleIds) ? message.eligibleIds.filter(Number.isInteger) : [];
      const previewIds = Array.isArray(message.previewIds) ? message.previewIds.filter(id => ids.includes(id)).slice(0, 5) : [];
      const expected = viewer.groupId === null ? 'arc' : 'stage';
      viewer.picker = message.mode === expected ? {mode: message.mode, ids, previewIds, selectedId: message.id} : null;
      if (viewer.visible) state.portal = viewer;
      syncHighlight(state);
      publish(state);
      scheduleRefresh(state);
    } else if (message.type === 'groupArrival' && external && viewer === state.portal && viewer.groupId === message.groupId && viewer.groupId != null) {
      const panel = panelViewer(state);
      if (panel && Array.isArray(message.ids)) {
        const startedAt = Number.isFinite(message.startedAt) ? message.startedAt : Date.now();
        state.groupArrival = message.hasSource === true ? {portal:viewer,panel,groupId:viewer.groupId,startedAt} : null;
        send(panel,{type:'groupArrival',groupId:viewer.groupId,ids:message.ids.filter(Number.isInteger).slice(0,100),
          startedAt,hasSource:message.hasSource === true});
      }
    } else if (message.type === 'groupArrivalTarget' && !external) {
      const arrival = state.groupArrival;
      const {groupId,requestAt,startedAt,offset} = message;
      if (!arrival || viewer !== arrival.panel || viewer !== panelViewer(state) || state.portal !== arrival.portal ||
          arrival.portal.groupId !== groupId || arrival.groupId !== groupId || arrival.startedAt !== requestAt ||
          !Number.isFinite(startedAt) || startedAt < requestAt || startedAt > requestAt+1000 ||
          !Number.isFinite(offset) || offset < 0 || offset > 32768) return;
      state.groupArrival = null;
      send(arrival.portal,{type:'groupArrivalTarget',groupId,requestAt,startedAt,offset});
    } else if (message.type === 'pickerKey' && !external && viewer === panelViewer(state) && state.portal?.picker?.mode === 'stage') {
      if (['ArrowUp','ArrowDown','Enter','Escape'].includes(message.key)) send(state.portal,{type:'pickerKey',key:message.key});
    } else if (message.type === 'openTabReference' && external) {
      void focusReferencedTab(state,viewer,message);
    } else if (message.type === 'tabReferenceStill' && external) {
      void showReferencedStill(state,viewer,message);
    } else if (message.type === 'openOwner' && !external && viewer === panelViewer(state)) {
      void openOwner(state,viewer,message).catch(error=>send(viewer,{type:'error',message:error.message}));
    } else if (message.type === 'choose') {
      const tab = scopedTabs(state, viewer).find(tab => tab.id === message.id);
      if (!tab) return;
      const portal = sourcePortal(state, viewer);
      if (portal.picker) send(portal, {type: 'choose', id: message.id});
      else void focusPreviewTab(tab.sessionId,tab.id,tab.groupId,()=>
        state.viewers.has(viewer.port) && portal.sessionId === tab.sessionId && portal.groupId === tab.groupId);
    } else if (message.type === 'showPortal' && !external) {
      if (state.portal) void focusPortalTab(state.portal.port.sender);
      else chrome.tabs.create({windowId: state.windowId, url: PORTAL}).catch(console.error);
    }
  });
  port.onDisconnect.addListener(() => {
    if (!viewer) return;
    state.viewers.delete(port);
    if (state.groupArrival?.portal === viewer || state.groupArrival?.panel === viewer) state.groupArrival = null;
    if (state.portal === viewer) {
      state.portal = [...state.viewers.values()].reverse().find(item => item.kind === 'portal') ?? null;
    }
    if (viewer.kind === 'portal') syncHighlight(state);
    publish(state);
    scheduleRefresh(state);
  });
}

function activeTab(windowId) {
  return chrome.tabs.query({active:true,windowId}).then(tabs=>tabs[0]);
}

function owningChat(windowId,groupId) {
  if (!Number.isInteger(groupId) || groupId < 0) return Promise.resolve(null);
  return new Promise(resolve=>{
    void sendAgentRequest(windowId,{method:'owner',params:{groupId}},(result,error)=>resolve(error ? null : result));
  });
}

async function refreshOwner(state) {
  const viewer = panelViewer(state);
  if (!viewer) return;
  const token = viewer.ownerToken = (viewer.ownerToken ?? 0)+1;
  send(viewer,{type:'groupOwner',owner:null});
  const active = await activeTab(state.windowId).catch(()=>null);
  const owner = await owningChat(state.windowId,active?.groupId);
  if (token === viewer.ownerToken && owner && panelViewer(state) === viewer) {
    send(viewer,{type:'groupOwner',owner});
  }
}

async function openOwner(state,viewer,{id}) {
  const active = await activeTab(state.windowId);
  const owner = await owningChat(state.windowId,active?.groupId);
  if (!owner || owner.id !== id || (await activeTab(state.windowId))?.groupId !== active.groupId) {
    throw Error('보고 있는 탭의 그룹이 바뀌었어요.');
  }
  const existing = [...state.viewers.values()].find(item=>item.kind === 'portal' && item.sessionId === id);
  if (existing && await focusPortalTab(existing.port.sender)) return;
  await chrome.tabs.create({windowId:state.windowId,url:PORTAL+'#chat='+encodeURIComponent(id)});
}

async function focusReferencedTab(state,viewer,{id,groupId}) {
  if (!Number.isSafeInteger(id) || !Number.isInteger(groupId) || groupId<0 || groupId!==viewer.groupId) return;
  const sessionId = viewer.sessionId;
  if (await focusPreviewTab(sessionId,id,groupId,()=>
    state.viewers.has(viewer.port) && viewer.sessionId === sessionId && viewer.groupId === groupId)) return;
  send(viewer,{type:'error',message:'탭이 닫혔거나 그룹에서 빠졌어요.'});
  scheduleRefresh(state);
}

async function showReferencedStill(state,viewer,{id,groupId,requestId}) {
  if (!Number.isSafeInteger(id) || !Number.isInteger(groupId) || groupId<0 || !Number.isSafeInteger(requestId)) return;
  const sessionId=viewer.sessionId;
  const current=()=>captureEnabled && viewer.visible && !state.minimized && !state.occluded &&
    state.viewers.has(viewer.port) && viewer.sessionId===sessionId && viewer.groupId===groupId &&
    scopedTabs(state,viewer).some(tab=>tab.id===id);
  if (!current()) return;
  let frame;
  try {
    const nativeId=await nativeTabId(sessionId,id);
    if ((await chrome.tabs.get(nativeId)).groupId!==groupId || !current()) return;
    const live=captures.get(id);
    const saved=state.stills.get(id);
    if (live?.groupId===groupId && live.sessionId===sessionId && live.lastFrame) {
      frame={format:live.format,data:live.lastFrame};
    } else if (saved?.groupId===groupId) {
      frame={format:saved.format,data:saved.data};
    } else if (!pausedForAgent.has(id)) {
      let shot=state.referenceShots.get(id);
      if (!shot) {
        shot=captureTabStill(sessionId,id,groupId).finally(()=>state.referenceShots.delete(id));
        state.referenceShots.set(id,shot);
      }
      const data=await shot;
      if (data && current() && (await chrome.tabs.get(nativeId)).groupId===groupId) {
        frame={format:'jpeg',data};
        if (state.portal?.sessionId===sessionId && !state.stills.has(id)) {
          storeStill(state,id,{...frame,groupId,ticket:crypto.randomUUID()});
        }
      }
    }
  } catch { /* A tab may close or become unavailable while getting its still. */ }
  if (current()) send(viewer,{type:'tabReferenceStill',requestId,...frame});
}

setRemoteDisconnectListener(()=>{
  for (const port of remoteViewers) port.disconnect();
  remoteViewers.clear();
});

if (remoteOrigin) chrome.runtime.onMessageExternal.addListener((message,sender,reply)=>{
  if (sender.frameId!==0 || !isPortal(sender.url) || message?.type!=='connectRemote' ||
      typeof message.ticket!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(message.ticket)) return;
  void connectAgent(message.ticket).then(()=>reply({connected:true}),error=>reply({error:error.message}));
  return true;
});

chrome.runtime.onConnect.addListener(port => onViewer(port, false));
chrome.runtime.onConnectExternal.addListener(port => {
  if (port.sender?.frameId !== 0 || !isPortal(port.sender.url)) { port.disconnect(); return; }
  if (remoteOrigin && port.name==='tabroom') {
    remoteViewers.add(port);
    port.onDisconnect.addListener(()=>remoteViewers.delete(port));
  }
  if (port.name === 'tabroom') return onViewer(port, true);
  if (port.name !== 'tabroom-cpu') { port.disconnect(); return; }
  const native = chrome.runtime.connectNative('com.tabroom.chrome_cpu');
  port.onMessage.addListener(msg => { if (msg?.type === 'sample') native.postMessage({type: 'sample'}); });
  native.onMessage.addListener(sample => port.postMessage(sample));
  native.onDisconnect.addListener(() => { void chrome.runtime.lastError; port.disconnect(); });
  port.onDisconnect.addListener(() => native.disconnect());
});

chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: false}).catch(console.error);
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({windowId: tab.windowId}).catch(console.error);
});
chrome.sidePanel.onOpened.addListener(({windowId}) => {
  const state = windows.get(windowId);
  if (state) { state.panelOpen = true; publish(state); scheduleRefresh(state); void refreshOwner(state); }
});
chrome.sidePanel.onClosed.addListener(({windowId}) => {
  const state = windows.get(windowId);
  if (!state) return;
  state.panelOpen = false;
  for (const viewer of state.viewers.values()) {
    if (viewer.kind === 'panel') viewer.visible = false;
  }
  publish(state);
  scheduleRefresh(state);
});

chrome.windows?.onBoundsChanged?.addListener(window => {
  const state = windows.get(window.id);
  if (!state) return;
  updateWindowBounds(state,window);
  scheduleRefresh(state);
});
chrome.windows?.onFocusChanged?.addListener(windowId => {
  const focused = windows.get(windowId);
  if (focused) {
    focused.focused = true;
    focused.occluded = false;
    focused.coverSamples = 0;
    focused.boundsRevision++;
  }
  for (const state of windows.values()) scheduleRefresh(state);
});

function refreshWindow(windowId, groupId) {
  for (const state of windows.values()) {
    const viewers = [...state.viewers.values()].filter(viewer => viewer.groupId !== null &&
      (viewer.groupId === groupId || state.tabs.some(tab => tab.windowId === windowId && tab.groupId === viewer.groupId)));
    if (state.windowId === windowId || viewers.length) scheduleRefresh(state);
  }
}

function groupChanged(groupId) {
  for (const state of windows.values()) {
    for (const viewer of state.viewers.values()) {
      if (viewer.groupId === groupId) send(viewer, {type: 'groupChanged'});
    }
  }
}

function scheduleSessionGroups() {
  if (sessionGroupsTimer) return;
  sessionGroupsTimer = setTimeout(()=>{
    sessionGroupsTimer = null;
    for (const state of windows.values()) for (const viewer of state.viewers.values()) {
      if (viewer.kind==='portal') send(viewer,{type:'sessionGroupsChanged'});
    }
  },180);
}

setSessionTitleListener((sessionId,title)=>{
  for (const state of windows.values()) for (const viewer of state.viewers.values()) {
    if (viewer.kind==='portal') send(viewer,{type:'sessionTitleChanged',sessionId,title});
  }
});

chrome.tabs.onCreated.addListener(tab => refreshWindow(tab.windowId, tab.groupId));
chrome.tabs.onActivated?.addListener(({windowId}) => {
  const state=windows.get(windowId);
  if (state) { syncHighlight(state); void refreshOwner(state); }
});
chrome.tabs.onUpdated.addListener((id, changes, tab) => {
  if (changes.url || changes.title || changes.favIconUrl || changes.status || 'discarded' in changes || 'groupId' in changes) {
    refreshWindow(tab.windowId, tab.groupId);
  }
  if ('groupId' in changes && tab.active && windows.has(tab.windowId)) void refreshOwner(windows.get(tab.windowId));
  if ('groupId' in changes || tab.groupId>=0 && (changes.title || changes.favIconUrl)) scheduleSessionGroups();
});
chrome.tabs.onRemoved.addListener((id, {windowId}) => {
  scheduleSessionGroups();
  refreshWindow(windowId);
});
chrome.tabs.onMoved.addListener((id, {windowId}) => {
  refreshWindow(windowId);
  scheduleSessionGroups();
});
chrome.tabs.onAttached.addListener((id, info) => refreshWindow(info.newWindowId));
chrome.tabs.onDetached.addListener((id, info) => refreshWindow(info.oldWindowId));
chrome.tabGroups.onRemoved.addListener(group => {
  scheduleSessionGroups();
  groupChanged(group.id);
  refreshWindow(group.windowId, group.id);
});
chrome.tabGroups.onCreated?.addListener(scheduleSessionGroups);
chrome.tabGroups.onUpdated?.addListener(group=>{
  scheduleSessionGroups();
  const state=windows.get(group.windowId);
  if (state?.portal?.picker) syncHighlight(state);
  if (state) void refreshOwner(state);
});
