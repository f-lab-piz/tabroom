import {createAgentUi} from './agent-ui.js';
import {createComposer} from './composer.js';
import {acceptPreviewFrame, releasePreviews, drawPreview, samplePreviewFps, groupPreviewTabs, ungroupedTabs, normalizePreviewSettings} from './streams.js';
import {attachMonitor} from './monitor.js';
import {createSitePicker} from './site-picker.js';
const isPanel = document.body.classList.contains('panel');
const isRemote = document.body.dataset.remote === 'true';
const usesHomeMac = isRemote && (navigator.userAgentData?.mobile || /Android|iPhone|iPod|iPad/.test(navigator.userAgent) ||
  navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const rail = document.querySelector('#rail');
const extensionId = 'hmngikndankgldefcihbegdepaomgnlb';
const windowId = isPanel ? (await chrome.windows.getCurrent()).id : null;
const macConnect = document.querySelector('#mac-connect');
const macConnectButton = document.querySelector('#mac-connect-button');
const macConnectStatus = document.querySelector('#mac-connect-status');
let mobileRailOpen = false;
const cards = new Map();
const arcCards = new Map();
const savedArcCards = new Map();
let savedGroups = [];
let groupsRequest = 0;
let quickTasks = [];
let skillCatalog = [];
let catalogRequest = 0;
let skillSelecting = false;
let selectedSkill = null;
const libraryKey = 'tabroom-library-updated';
let pickerKind = 'current';
let bundleIndex = 0;
let bundlePage = 0;
let welcomePreviewId = null;
const bundleFrames = new Map();
const inlineReferences = new Map();
let referenceAnchor, referenceTimer, referenceRequest = 0;
const arrivals = new Map();
const groupFlightDuration = 350;
const panelAnchorWait = 180;
let panelArrival;
let panelDeparture;
const visibleCards = new Set();
let lastViewport;
let reportedScope;
let owner;
let groupBusy = false;
let railMembers = {groupId:null,ids:new Set()};
let state = {tabs: [], enabled: false, panelOpen: false, groupId: null};
let port;
const monitor = isPanel || usesHomeMac ? null : attachMonitor();
let selecting = false;
let selectedId = null;
const agentRequests = new Map();
let agent;
let pickerLoading = false;
let pickerVersion = 0;
const previewSettingsKey = 'tabroom-preview-settings';

function readPreviewSettings() {
  try {
    const legacyLimit = localStorage.getItem('stream-fps');
    return normalizePreviewSettings(JSON.parse(localStorage.getItem(previewSettingsKey)) ||
      (legacyLimit ? {limit:'tab',fps:legacyLimit} : undefined));
  } catch {
    return normalizePreviewSettings();
  }
}

function renderPreviewSettings(settings) {
  document.querySelector('#preview-format').value = settings.format;
  document.querySelector('#preview-width').value = settings.width;
  document.querySelector('#preview-limit').value = settings.limit;
  document.querySelector('#stream-fps').value = settings.fps;
  document.querySelector('#fps-row').hidden = !['tab','total'].includes(settings.limit);
}

rail.innerHTML = `
  <header class="rail-head">
    <div class="rail-title">
      <span class="panel-icon" aria-hidden="true"></span>
      <h2>탭 그룹</h2><span class="rail-count" id="tab-count">0</span>
      <div class="group-actions" hidden>
        <span class="group-action" data-label="탭 묶음으로 저장">
          <button class="icon-button" type="button" id="save-bundle" aria-label="탭 묶음으로 저장">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 4h10v13l-5-3-5 3z"/></svg>
          </button>
        </span>
        <span class="group-action" data-label="그룹 닫기">
          <button class="icon-button" type="button" id="close-group" aria-label="그룹 닫기">
            <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="3" width="11" height="11" rx="2"/><path d="M13 17H5a2 2 0 0 1-2-2V7m7 0 4 4m0-4-4 4"/></svg>
          </button>
        </span>
      </div>
      ${isPanel ? '<button class="icon-button close-panel" type="button" title="사이드 패널 닫기" aria-label="사이드 패널 닫기">×</button>' : ''}
    </div>
    ${isPanel ? '<button class="owner-chat" id="owner-chat" type="button" hidden><span>연결된 채팅 열기</span><strong></strong><span class="owner-arrow" aria-hidden="true">↗</span></button>' : ''}
    <div class="rail-controls">
      <span class="capture-status"><i></i><span></span></span>
      <button class="button small" type="button" role="switch" aria-label="탭 캡처" id="capture"></button>
    </div>
  </header>
  <section class="restore-card" hidden aria-label="저장된 탭 그룹">
    <strong class="restore-title"></strong>
    <div class="saved-sites"></div>
    <button class="button primary small" id="group-restore" type="button">그룹 다시 열기</button>
    ${isPanel ? '' : '<small>#으로 새 그룹을 만들 수도 있어요.</small>'}
  </section>
  <div class="tab-list" id="tab-list"></div>
  <p class="rail-empty" hidden></p>
  <p class="rail-feedback group-feedback" role="status" hidden></p>
  ${isPanel ? '<footer class="rail-footer"><button class="button" type="button" id="back">채팅 열기 <span aria-hidden="true">↗</span></button></footer>' : ''}
  <dialog class="group-dialog" id="bundle-save-dialog" aria-labelledby="bundle-save-title">
    <header><h2 id="bundle-save-title">탭 묶음으로 저장</h2><form method="dialog"><button class="icon-button" aria-label="닫기">×</button></form></header>
    <form id="bundle-save-form">
      <label for="bundle-name">묶음 이름</label>
      <input type="text" id="bundle-name" maxlength="84" required />
      <p class="group-feedback" role="status" hidden></p>
      <button class="button primary" type="submit">저장</button>
    </form>
  </dialog>
`;
const tabsEl = rail.querySelector('#tab-list');
const tray = document.querySelector('#picker-tray');
const message = document.querySelector('#message');
const taskPrompt = document.querySelector('#task-prompt');
const taskComposer = taskPrompt && createComposer(taskPrompt,()=>{},{singleGroup:true});
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const listSizes = new ResizeObserver(updateScrollEdges);
listSizes.observe(tabsEl);
tabsEl.addEventListener('scroll',updateScrollEdges,{passive:true});
const railVisibility = new IntersectionObserver(entries=>{
  for (const entry of entries) {
    const id = Number(entry.target.dataset.tabId);
    if (cards.get(id)?.element !== entry.target) continue;
    if (entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0) visibleCards.add(id);
    else visibleCards.delete(id);
  }
  reportRailViewport();
},{root:tabsEl,threshold:[0,.001]});
const history = document.querySelector('#messages');
const historySetup=document.querySelector('#history-setup');
const historySetupKey='tabroom-history-setup-seen';
const extensionOrigin='chrome-extension://'+extensionId;
const historySetupFrame=historySetup?.querySelector('iframe');
const referencePreview = document.querySelector('#tab-reference-preview');
const referenceImage = referencePreview?.querySelector('img');
const referenceFrame = referencePreview?.querySelector('.reference-preview-frame');
const referenceStatus = referencePreview?.querySelector('.reference-preview-status');
const referenceDetail = referencePreview?.querySelector('.reference-preview-detail');
const searchElement = document.querySelector('#site-picker');
const sitePicker = searchElement && createSitePicker(searchElement,callAgent,insertSearchSite,()=>changePickerKind(pickerMode()==='arc' ? 'saved' : 'current'));
const composer = message ? createComposer(message,event => {
  agent?.render();
  if (!event.isComposing && event.type === 'input' && event.data === '#') void openPicker(true);
  else if (!event.isComposing && event.type === 'input' && event.data === '/') openSkillPicker(true);
  else if (selecting) {
    const region=composer.queryRange({composing:event.isComposing});
    if (region) paintPickerQuery(region.range);
    if (!region) {
      if (!event.isComposing) closePicker();
    }
    else if (region.query.trim()) {
      if (pickerKind!=='search') changePickerKind('search');
      sitePicker.set(region.query);
    } else if (!event.isComposing && pickerKind==='search') changePickerKind('current');
  } else if (!event.isComposing && skillSelecting && !composer.validAnchor()) closePicker();
}) : null;

function pickerMode() { return agent?.group?.open ? 'stage' : 'arc'; }

function paintPickerQuery(range) {
  const highlights=globalThis.CSS?.highlights;
  if (!highlights || typeof Highlight!=='function') return;
  if (range && !range.collapsed) highlights.set('tabroom-picker-query',new Highlight(range));
  else highlights.delete('tabroom-picker-query');
}

function finishPickerSelection(keepOpen) {
  if (keepOpen) paintPickerQuery();
  else closePicker();
}

function updateScrollEdges() {
  const top = tabsEl.scrollTop;
  const remaining = tabsEl.scrollHeight - tabsEl.clientHeight - top;
  tabsEl.classList.toggle('has-more-above',top > 3);
  tabsEl.classList.toggle('has-more-below',remaining > 3);
}

function post(data) {
  if (port) port.postMessage(data);
}

function reportRailViewport() {
  if (!port) return;
  const groupId = isPanel ? state.groupId : activeGroupId();
  const ids = rail.hidden || document.hidden ? [] : [...visibleCards].sort((a,b)=>a-b);
  const key = JSON.stringify([groupId,ids]);
  if (key === lastViewport) return;
  lastViewport = key;
  post({type:'visiblePreviews',groupId,ids});
}

function callAgent(method, params) {
  if (!port) return Promise.reject(Error('Chrome의 탭룸 확장에 연결할 수 없어요.'));
  const id = crypto.randomUUID();
  return new Promise((resolve,reject)=>{
    const timer = setTimeout(()=>{
      agentRequests.delete(id);
      reject(Error('탭룸 실행기 응답 시간이 초과됐어요.'));
    },28000);
    agentRequests.set(id,{
      resolve(value) { clearTimeout(timer); resolve(value); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    try { post({type:'agent',id,method,params}); }
    catch {
      agentRequests.get(id).reject(Error('Chrome의 탭룸 확장 연결이 끊겼어요.'));
      agentRequests.delete(id);
    }
  });
}

function pickerTabs() {
  if (!agent?.session || pickerLoading) return [];
  if (!agent.group?.open) return ungroupedTabs(state.tabs,state.windowId);
  return groupPreviewTabs(state.tabs, activeGroupId());
}

function activeGroupId() {
  return agent?.group?.open ? agent.group.groupId ?? null : null;
}

function refreshPickerSelection() {
  const choices = pickerTabs();
  if (!choices.some(tab=>tab.id === selectedId)) selectedId = choices[0]?.id ?? null;
  if (selecting) syncPicker();
}

function makeIcon() {
  const icon = document.createElement('span');
  icon.className = 'favicon';
  icon.setAttribute('aria-hidden', 'true');
  const image = document.createElement('img');
  image.alt = '';
  image.addEventListener('load', () => { image.hidden = false; });
  image.addEventListener('error', () => { image.hidden = true; });
  image.hidden = true;
  icon.append(image);
  return icon;
}

function updateIcon(icon, url) {
  const image = icon.firstElementChild;
  if (url && image.getAttribute('src') !== url) {
    image.hidden = true;
    image.src = url;
  } else if (!url) {
    image.hidden = true;
    image.removeAttribute('src');
  }
}

function siteIcon(site) {
  const icon = makeIcon();
  updateIcon(icon,site.favicon);
  return icon;
}

async function reloadPopularSites() {
  if (isPanel) return;
  const host = document.querySelector('#welcome-sites');
  let sites;
  try { sites = await callAgent('sites/list'); }
  catch { sites = []; }
  if (!sites.length) {
    const empty = document.createElement('p');
    empty.textContent = '표시할 사이트가 없어요.';
    host.replaceChildren(empty);
    return;
  }
  host.replaceChildren(...sites.map(site=>{
    const button = document.createElement('button');
    button.type='button';
    button.className='popular-site';
    button.title=site.title;
    const label=document.createElement('span');
    label.textContent=site.title;
    button.append(siteIcon(site),label);
    button.addEventListener('mousedown',event=>event.preventDefault());
    button.addEventListener('click',()=>{
      if (!agent?.session?.provisional || agent.group?.open) return;
      closePicker();
      const title=[...site.title.trim()].slice(0,42).join('').trimEnd();
      composer.insert({tabGroup:{title,urls:[site.url]},favicon:site.favicon});
      agent.render();
    });
    return button;
  }));
}

async function refreshHistorySetup() {
  if (usesHomeMac || !historySetup || localStorage.getItem(historySetupKey)) return;
  try {
    const granted=await callAgent('sites/historyStatus');
    if (typeof granted!=='boolean' || localStorage.getItem(historySetupKey)) return;
    historySetup.hidden=granted;
    if (!granted && !historySetupFrame.hasAttribute('src')) {
      historySetupFrame.src=extensionOrigin+'/history-options.html?compact=1';
    }
  } catch { /* 확장 연결이 없는 화면에서는 권한 안내를 열지 않는다. */ }
}

if (historySetup) {
  function finishHistorySetup() {
    localStorage.setItem(historySetupKey,'1');
    historySetup.hidden=true;
    historySetupFrame.removeAttribute('src');
  }
  document.querySelector('#history-later').addEventListener('click',finishHistorySetup);
  window.addEventListener('message',event=>{
    if (event.origin!==extensionOrigin || event.source!==historySetupFrame.contentWindow ||
        event.data?.type!=='tabroom-history-setup') return;
    finishHistorySetup();
  });
}

function renderSavedSites(container,tabs) {
  const key = JSON.stringify(tabs);
  if (container.dataset.sites === key) return;
  container.dataset.sites = key;
  const icons = tabs.slice(0,5).map(tab=>{
    const icon = makeIcon();
    icon.title = tab.title || tab.url;
    icon.firstElementChild.referrerPolicy = 'no-referrer';
    icon.append((tab.title || '웹').charAt(0));
    updateIcon(icon,tab.favicon);
    return icon;
  });
  const count = document.createElement('span');
  count.textContent = '탭 '+tabs.length+'개';
  container.replaceChildren(...icons,count);
}

function railContext() {
  return isPanel
    ? {id:state.sessionId,group:state.group,running:state.running}
    : {id:agent?.session?.id,group:agent?.group,running:agent?.session?.running || agent?.busy};
}

function publishScope() {
  const {id,group,running} = railContext();
  const message = {type:'scope',sessionId:id,groupId:activeGroupId(),group,running:Boolean(running)};
  const key = JSON.stringify(message);
  if (key === reportedScope) return;
  reportedScope = key;
  post(message);
  renderRail();
}

function groupFeedback(message = '') {
  const feedback = rail.querySelector('.rail-feedback');
  feedback.textContent = message;
  feedback.hidden = !message;
}

async function changeGroup(method,extra={},context=railContext()) {
  const {id,group,running} = context;
  if (!id || groupBusy || method !== 'bundle/save' && running) return false;
  groupBusy = true;
  groupFeedback();
  renderRail();
  try {
    const next = await callAgent(method,{id,groupId:group?.groupId,...extra});
    if (railContext().id !== id) return true;
    if (method === 'bundle/save') {
      groupFeedback('탭 묶음을 저장했어요.');
      if (!isPanel) void reloadSavedGroups();
    }
    else if (!isPanel) agent.applyGroup(id,next);
    else state = {...state,group:next,groupId:next.open ? next.groupId : null};
    return true;
  } finally { groupBusy = false; renderRail(); }
}

function runGroupAction(method,extra) {
  const context = railContext();
  void changeGroup(method,extra,context).catch(error=>{
    if (railContext().id === context.id) groupFeedback(error.message);
  });
}

function hideReferencePreview() {
  clearTimeout(referenceTimer);
  referenceRequest++;
  referenceAnchor?.element.removeAttribute('aria-describedby');
  referenceAnchor = undefined;
  referencePreview.hidePopover();
  referenceImage.removeAttribute('src');
}

function showReferenceFrame(frame) {
  if (frame?.data) referenceImage.src='data:image/'+(frame.format==='jpeg' ? 'jpeg' : 'png')+';base64,'+frame.data;
  else referenceStatus.textContent='미리보기 없음';
}

function showReferencePreview(reference) {
  if (reference.element.disabled || !reference.element.isConnected || document.hidden) return;
  referenceAnchor = reference;
  referenceImage.hidden = true;
  referenceStatus.hidden = false;
  const {record}=reference;
  referenceFrame.hidden = Boolean(record && !record.hasImage);
  referenceStatus.textContent = record || (state.enabled && reference.hasPreview) ? '' : state.enabled ? '미리보기 없음' : '캡처 꺼짐';
  referenceDetail.hidden = !record;
  if (record) {
    referenceDetail.querySelector('strong').textContent=record.title;
    referenceDetail.querySelector('small').textContent=new URL(record.url).hostname;
  }
  referencePreview.showPopover();
  const anchor = reference.element.getBoundingClientRect();
  const {width,height} = referencePreview.getBoundingClientRect();
  const top = anchor.bottom+6+height<=innerHeight-8 ? anchor.bottom+6 : anchor.top-height-6;
  referencePreview.style.left = Math.max(8,Math.min(anchor.left,innerWidth-width-8))+'px';
  referencePreview.style.top = Math.max(8,Math.min(top,innerHeight-height-8))+'px';
  reference.element.setAttribute('aria-describedby',referencePreview.id);
  if (record) {
    if (!record.hasImage) return;
    const token=++referenceRequest;
    void callAgent('reference/image',{id:reference.sessionId,messageId:reference.messageId,key:record.key})
      .catch(()=>null).then(frame=>{
        if (referenceAnchor===reference && token===referenceRequest) showReferenceFrame(frame);
      });
  } else if (state.enabled && reference.hasPreview) post({type:'tabReferenceStill',id:reference.id,groupId:activeGroupId(),requestId:++referenceRequest});
}

function scheduleReferencePreview(reference) {
  clearTimeout(referenceTimer);
  if (referenceAnchor===reference) return;
  hideReferencePreview();
  referenceTimer = setTimeout(()=>showReferencePreview(reference),160);
}

function deferReferencePreviewHide() {
  clearTimeout(referenceTimer);
  if (referenceAnchor) referenceTimer=setTimeout(hideReferencePreview,140);
}

if (referencePreview) {
  referencePreview.addEventListener('pointerenter',()=>clearTimeout(referenceTimer));
  referencePreview.addEventListener('pointerleave',deferReferencePreviewHide);
  referenceImage.addEventListener('load',()=>{
    if (!referenceAnchor) return;
    referenceImage.hidden=false;
    referenceStatus.hidden=true;
  });
  referenceImage.addEventListener('error',()=>{
    if (referenceAnchor) referenceStatus.textContent = '미리보기 없음';
  });
  history.addEventListener('scroll',hideReferencePreview,{passive:true});
  window.addEventListener('resize',hideReferencePreview);
  document.addEventListener('keydown',event=>{
    if (event.key==='Escape') hideReferencePreview();
  });
}

function makeInlineTabChip(id,marker,messageId,record) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'chat-tab-reference';
  if (id!==undefined) element.dataset.tabId=id;
  element.disabled = true;
  element.innerHTML = `<span class="chat-tab-reference-title">참조한 탭</span>
    <span class="chat-tab-reference-arrow" aria-hidden="true">↗</span>`;
  const icon = makeIcon();
  element.prepend(icon);
  const reference = {refId:id,id:undefined,record,messageId,sessionId:agent?.session?.id,element,icon,
    label:element.querySelector('.chat-tab-reference-title')};
  if (record) reference.label.textContent=record.title;
  else if (marker.sourceId) reference.label.textContent='출처';
  inlineReferences.set(element,reference);
  element.addEventListener('pointerenter',event=>{
    if (event.pointerType!=='touch') scheduleReferencePreview(reference);
  });
  element.addEventListener('pointerleave',deferReferencePreviewHide);
  element.addEventListener('focus',()=>{
    if (element.matches(':focus-visible')) scheduleReferencePreview(reference);
  });
  element.addEventListener('blur',hideReferencePreview);
  element.addEventListener('click',()=>{
    hideReferencePreview();
    if (element.disabled) return;
    if (record && !element.dataset.opening) {
      element.dataset.opening='true';
      void callAgent('reference/open',{id:reference.sessionId,messageId,key:record.key}).then(next=>{
        agent.applyGroup(reference.sessionId,next);
        void agent.refreshList().catch(()=>{});
      }).catch(error=>{
        if (agent.session?.id===reference.sessionId) agent.say(error.message);
      }).finally(()=>delete element.dataset.opening);
    } else if (!record && Number.isInteger(reference.id)) {
      post({type:'openTabReference',id:reference.id,groupId:activeGroupId()});
    }
  });
  return element;
}

function syncInlineReferences() {
  const groupId = activeGroupId();
  const tabs = new Map(groupPreviewTabs(state.tabs,groupId).map(tab=>[tab.id,tab]));
  const groupTabs = agent?.group?.tabs ?? [];
  const legacyIds = new Map(groupTabs.filter(tab=>tab.legacyId!==undefined)
    .map(tab=>[tab.legacyId,tab.id]));
  const activeTabs = new Map(groupId===null ? [] : groupTabs.map(tab=>[tab.id,tab]));
  const saved = new Map((agent?.group?.savedTabs ?? []).map(tab=>[tab.refId,tab]));
  for (const [element,reference] of inlineReferences) {
    if (!element.isConnected) {
      if (referenceAnchor===reference) hideReferencePreview();
      inlineReferences.delete(element);
      continue;
    }
    const currentId = legacyIds.get(reference.refId) ?? reference.refId;
    const preview = tabs.get(currentId);
    const tab = preview ?? activeTabs.get(currentId);
    if (!reference.record && referenceAnchor===reference && (!tab || reference.id!==tab.id)) hideReferencePreview();
    reference.id = tab?.id;
    reference.hasPreview=Boolean(preview);
    element.disabled = !tab && !reference.record;
    const known = tab ?? saved.get(reference.refId);
    if (known) {
      if (!reference.record) reference.label.textContent = known.title;
      const host=known.domain || (known.url ? new URL(known.url).hostname : '');
      updateIcon(reference.icon,!reference.record || host===new URL(reference.record.url).hostname ? known.favicon : '');
    }
    if (reference.record) {
      element.setAttribute('aria-label',reference.record.title+' 출처 열기');
      continue;
    }
    if (!tab) element.title = '탭이 닫혔거나 그룹에서 빠졌어요.';
    else element.removeAttribute('title');
    element.setAttribute('aria-label',tab ? tab.title+' 탭으로 이동' : `${reference.label.textContent} · ${element.title}`);
  }
}

function makeCard(id, isArc, isSaved = false) {
  const element = document.createElement('div');
  element.className = isArc ? 'tab-card arc-card' : 'tab-card';
  if (isSaved) element.classList.add('saved-arc-card');
  element.dataset.tabId = id;
  element.innerHTML = `
    <span class="preview">
      <canvas width="1" height="1" aria-hidden="true"></canvas>
      <span class="preview-empty">
        <span class="preview-message" aria-live="polite"></span>
        <button type="button" class="button small preview-retry" hidden>다시 연결</button>
      </span>
      <span class="preview-still" hidden>마지막 화면</span>
    </span>
    <span class="tab-caption"><span class="tab-name"></span><span class="tab-domain"></span><span class="fps" title="최근 2초간 미리보기 갱신 속도">0 FPS</span></span>
    <span class="selected-banner">↵ 참조</span>
    <button type="button" class="tab-card-select"></button>
    ${isArc ? '' : '<button type="button" class="tab-close" title="탭 닫기">×</button>'}
  `;
  const icon = makeIcon();
  const select = element.querySelector('.tab-card-select');
  const retry = element.querySelector('.preview-retry');
  const close = element.querySelector('.tab-close');
  element.querySelector('.tab-caption').prepend(icon);
  select.addEventListener('click', () => {
    if (isSaved) return;
    if (!isPanel && selecting && pickerKind==='current') choose(id);
    else post({type: 'choose', id});
  });
  retry.addEventListener('click', () => post({type: 'retryCapture', id}));
  close?.addEventListener('click',()=>runGroupAction('closeTab',{tabId:id}));
  return {
    id, element, select, retry, close, icon,
    message: element.querySelector('.preview-message'),
    canvas: element.querySelector('.preview canvas'),
    stillLabel: element.querySelector('.preview-still'),
    bitmap: null,
    drawTimes: [],
    badge: element.querySelector('.fps'),
  };
}

setInterval(() => {
  for (const collection of [cards, arcCards]) {
    for (const card of collection.values()) {
      const fps = samplePreviewFps(card);
      const label = fps.toFixed(1) + ' FPS';
      if (card.badge.textContent !== label) card.badge.textContent = label;
    }
  }
}, 500);

function updateCard(card, tab, highlighted) {
  const visible = !rail.hidden || card.element.classList.contains('arc-card');
  drawCardFrame(card, visible ? tab.previewTicket : undefined, tab.still,visible ? tab.stillTicket : undefined);
  card.stillLabel.hidden = !tab.still;
  card.element.querySelector('.tab-name').textContent = tab.title;
  card.element.querySelector('.tab-domain').textContent = tab.domain;
  const failed = tab.status === 'unavailable';
  card.message.textContent = tab.reason || (tab.status === 'still' ? '미리보기 대기 중' :
    tab.status === 'paused' ? '미리보기 꺼짐' : '화면 연결 중');
  card.retry.hidden = !failed;
  card.retry.setAttribute('aria-label', tab.title + ' 다시 연결');
  card.element.classList.toggle('has-preview-error', failed);
  if (failed) card.message.title = tab.reason || '';
  else card.message.removeAttribute('title');
  updateIcon(card.icon, tab.favicon);
  card.select.setAttribute('aria-label', tab.title);
  if (card.close) card.close.setAttribute('aria-label',tab.title+' 탭 닫기');
  card.element.classList.toggle('is-selected', highlighted);
  card.select.setAttribute('aria-pressed', String(highlighted));
}

function drawCardFrame(card, ticket, still, stillTicket, keepLast) {
  const drawn = drawPreview(card, ticket, still, stillTicket, keepLast);
  if (drawn && !card.hasDrawnFrame) {
    card.hasDrawnFrame = true;
    if (!reduceMotion.matches && !card.element.classList.contains('arc-card')) {
      card.canvas.animate([{opacity:0},{opacity:1}],{duration:150,easing:'ease-out'});
    }
  }
  return drawn;
}

function reconcile(collection, container, tabs, update) {
  const wanted = new Set(tabs.map(tab => tab.id));
  for (const [id, card] of collection) {
    if (!wanted.has(id)) {
      if (collection === cards) {
        listSizes.unobserve(card.element);
        railVisibility.unobserve(card.element);
        visibleCards.delete(id);
      }
      card.element.remove();
      collection.delete(id);
    }
  }
  for (const [index, tab] of tabs.entries()) {
    if (!collection.has(tab.id)) {
      const card = makeCard(tab.id,collection === arcCards || collection === savedArcCards,collection === savedArcCards);
      collection.set(tab.id,card);
      if (collection === cards) {
        listSizes.observe(card.element);
        railVisibility.observe(card.element);
      }
    }
    const card = collection.get(tab.id);
    if (container.children[index] !== card.element) {
      container.insertBefore(card.element, container.children[index] ?? null);
    }
    update(card, tab, index);
  }
}

function renderRail() {
  const {id,group,running} = railContext();
  const groupId = isPanel ? state.groupId : activeGroupId();
  const stageSelected = isPanel ? state.selectedId : selectedId;
  const stage = isPanel ? state.mode === 'stage' : selecting && pickerKind!=='search' && pickerMode() === 'stage';
  const railTabs = groupPreviewTabs(state.tabs,groupId);
  const canRestore = Boolean(id && group?.canRestore && !group.open);
  const available = groupId != null || canRestore;
  rail.hidden = !isPanel && (!available || (usesHomeMac ? !mobileRailOpen && !stage : state.panelOpen));
  if (usesHomeMac) {
    const button = document.querySelector('#open-panel');
    button.disabled = !port || !available;
    button.setAttribute('aria-expanded', String(!rail.hidden));
  }
  let added = [];
  if (groupId === state.groupId) {
    const ids = new Set(railTabs.map(tab=>tab.id));
    if (!rail.hidden && !document.hidden && !reduceMotion.matches && railMembers.groupId === groupId && railMembers.ids.size) {
      added = [...ids].filter(id=>!railMembers.ids.has(id) && !arrivals.has(id));
    }
    railMembers = {groupId,ids};
  }
  const oldPositions = added.length ? [...cards.values()].map(card=>[card.element,card.element.offsetTop]) : [];
  const heading = rail.querySelector('h2');
  heading.textContent = stage && groupId != null ? '참조할 탭' : group?.open ? group.title || '탭 그룹' : '탭 그룹';
  heading.title = heading.textContent;
  const live = state.enabled && railTabs.some(tab => tab.status === 'ready');
  const failed = railTabs.some(tab => tab.status === 'unavailable');
  const status = rail.querySelector('.capture-status');
  status.classList.toggle('live', live);
  status.lastElementChild.textContent = !state.enabled ? '미리보기 일시정지' : live ? '실시간 미리보기' : failed ? '미리보기 연결 실패' : '미리보기 연결 중';
  const toggle = rail.querySelector('#capture');
  toggle.textContent = state.enabled ? '캡처 ON' : '캡처 OFF';
  toggle.setAttribute('aria-checked', String(state.enabled));
  toggle.disabled = !railTabs.length;
  rail.querySelector('#tab-count').textContent = railTabs.length;
  rail.querySelector('#tab-count').hidden = groupId == null;
  rail.querySelector('.rail-controls').hidden = !railTabs.length;
  rail.querySelector('.group-actions').hidden = !id || groupId == null;
  rail.querySelector('#close-group').disabled = groupBusy || !group?.open || Boolean(running);
  rail.querySelector('#save-bundle').disabled = groupBusy || !group?.open || !railTabs.length;
  const restore = rail.querySelector('.restore-card');
  restore.hidden = !canRestore;
  if (canRestore) {
    restore.querySelector('.restore-title').textContent = group.title;
    renderSavedSites(restore.querySelector('.saved-sites'),group.savedTabs);
    restore.querySelector('#group-restore').disabled = groupBusy || Boolean(running);
  }
  const empty = rail.querySelector('.rail-empty');
  empty.hidden = canRestore || railTabs.length > 0;
  empty.textContent = groupId == null ? '채팅에서 탭 그룹을 연결하면 여기에 표시돼요.' : '연결된 그룹에 열린 웹 탭이 없어요.';
  tabsEl.hidden = !railTabs.length;
  tabsEl.classList.toggle('stage-list', stage);
  reconcile(cards,tabsEl,rail.hidden ? [] : railTabs,(card,tab)=>{
    card.close.disabled = groupBusy || Boolean(running);
    card.close.hidden = stage;
    updateCard(card,tab,stage && tab.id === stageSelected);
  });
  reportRailViewport();
  if (added.length) animateAddedTabs(added, oldPositions);
  if (stage && stageSelected !== null && rail.dataset.focusId !== String(stageSelected)) {
    const element = cards.get(stageSelected)?.element;
    if (element) {
      const selected = element.getBoundingClientRect();
      const bounds = tabsEl.getBoundingClientRect();
      const inset = 25 + element.offsetHeight*.025;
      const offset = selected.top < bounds.top + inset ? selected.top - bounds.top - inset :
        selected.bottom > bounds.bottom - inset ? selected.bottom - bounds.bottom + inset : 0;
      if (offset) tabsEl.scrollBy({top:offset,behavior:reduceMotion.matches ? 'instant' : 'smooth'});
    }
  }
  rail.dataset.focusId = stage ? String(stageSelected) : '';
  updateScrollEdges();
  if (isPanel) playPanelArrival();
  animateGroupArrivals(groupId);
}

function animateAddedTabs(added, oldPositions) {
  const {top,bottom} = tabsEl.getBoundingClientRect();
  const visible = element => {
    const bounds = element.getBoundingClientRect();
    return bounds.bottom > top && bounds.top < bottom;
  };
  for (const [element,oldTop] of oldPositions) {
    const shift = oldTop - element.offsetTop;
    if (!element.isConnected || !shift || !visible(element)) continue;
    element.getAnimations().find(animation=>animation.id==='tab-list-shift')?.cancel();
    element.animate([{translate:`0 ${shift}px`},{translate:'0 0'}],{
      id:'tab-list-shift',duration:190,easing:'ease-out',
    });
  }
  added.map(id=>cards.get(id)?.element).filter(element=>element && visible(element)).forEach((element,index)=>{
    element.animate([{opacity:.35,translate:'0 6px'},{opacity:1,translate:'0 0'}],{
      id:'tab-added',duration:240,delay:Math.min(index,3)*28,easing:'ease-out',fill:'backwards',
    });
  });
}

function arcPositions(choices) {
  const center = choices.findIndex(tab => tab.id === selectedId);
  const positions = new Map();
  const count = choices.length;
  for (const [index, tab] of choices.entries()) {
    let offset = index - Math.max(center, 0);
    if (offset > count / 2) offset -= count;
    if (offset < -count / 2) offset += count;
    if (Math.abs(offset) <= 2) positions.set(tab.id, offset);
  }
  return positions;
}

function setArcPosition(card,offset) {
  const distance = Math.abs(offset);
  card.element.style.setProperty('--slot',offset);
  card.element.style.setProperty('--drop',distance >= 2 ? '35px' : distance ? '12px' : '0px');
  card.element.style.setProperty('--tilt',(offset * 6) + 'deg');
  card.element.style.setProperty('--scale',distance >= 2 ? '.72' : distance ? '.86' : '1');
  card.element.style.zIndex = 6 - Math.ceil(distance * 2);
}

async function reloadSavedGroups() {
  const token = ++groupsRequest;
  let rows;
  try { rows = await callAgent('bundle/list'); }
  catch { return; }
  if (token !== groupsRequest) return;
  const selected = savedGroups[bundleIndex]?.id;
  savedGroups = rows;
  bundleIndex = Math.max(0,rows.findIndex(row=>row.id===selected));
  renderWelcomeGroups();
  renderTasks();
  if (selecting && pickerKind==='saved') renderPicker();
}

function announceLibraryChange() {
  localStorage.setItem(libraryKey,crypto.randomUUID());
}

async function reloadWorkflows() {
  if (isPanel) return;
  const serial=++catalogRequest;
  let legacy;
  try { legacy=JSON.parse(localStorage.getItem('tabroom-quick-tasks')); }
  catch { /* 로컬 설정이 없으면 기본 작업을 쓴다. */ }
  const [tasks,skills]=await Promise.allSettled([callAgent('quickTasks/list',{legacy}),callAgent('skills/list')]);
  if (serial!==catalogRequest) return;
  if (tasks.status==='fulfilled' && Array.isArray(tasks.value)) {
    quickTasks=tasks.value;
    renderTasks();
  }
  if (skills.status==='fulfilled' && Array.isArray(skills.value)) {
    skillCatalog=skills.value;
    if (!skillCatalog.some(skill=>skill.name===selectedSkill && !skill.automatic)) {
      selectedSkill=skillCatalog.find(skill=>!skill.automatic)?.name;
    }
    renderSkillPicker();
  }
}

function insertBundle(bundle,keepOpen=false) {
  if (!bundle || !agent?.session || agent.group?.open) return;
  composer.insert({bundleId:bundle.id,title:bundle.name},{keepOpen,range:selecting ? composer.queryRange()?.range : undefined});
  finishPickerSelection(keepOpen);
  agent.render();
}

function insertSearchSite(site,keepOpen=false) {
  const region=composer.queryRange();
  if (!region || !selecting || pickerKind!=='search') return;
  const title=[...site.title.trim()].slice(0,42).join('').trimEnd();
  if (!title) return;
  composer.insert({tabGroup:{title,urls:[site.url],site:true},favicon:site.favicon},{keepOpen,range:region.range});
  finishPickerSelection(keepOpen);
  agent.render();
  document.querySelector('#announcement').textContent=title+' 참조 추가됨';
}

function renderTasks() {
  const host=document.querySelector('#welcome-tasks');
  if (!host) return;
  host.replaceChildren(...quickTasks.map(task=>{
    const row=document.createElement('div');
    row.className='quick-task-row';
    const choose=document.createElement('button');
    choose.type='button';
    const title=document.createElement('span');
    title.textContent=task.title;
    choose.append(title);
    for (const {tabGroup} of task.parts) {
      if (!tabGroup) continue;
      const chip=document.createElement('span');
      chip.className='inline-tab quick-task-chip';
      chip.textContent=tabGroup.title;
      choose.append(chip);
    }
    choose.addEventListener('click',()=>{
      if (!agent?.session) return;
      closePicker();
      composer.appendParts(task.parts);
    });
    row.append(choose);
    return row;
  }));
}

function fillTaskEditor() {
  const task=quickTasks.find(item=>item.id===document.querySelector('#task-select').value);
  document.querySelector('#task-title').value=task?.title ?? '';
  taskComposer.replaceParts(task?.parts ?? []);
  document.querySelector('#task-error').textContent='';
}

function editTask(id=quickTasks[0]?.id) {
  const select=document.querySelector('#task-select');
  select.replaceChildren(...quickTasks.map(task=>new Option(task.title,task.id)),new Option('새 작업',''));
  select.value=id ?? '';
  document.querySelector('#task-bundle').replaceChildren(new Option('저장된 탭그룹 선택',''),
    ...savedGroups.map(bundle=>new Option(bundle.name,bundle.id)));
  fillTaskEditor();
  document.querySelector('#task-editor').showModal();
}

function chooseBundle(index) {
  if (index===bundleIndex && bundlePage===0) return;
  bundleIndex=index;
  bundlePage=0;
  renderPicker();
}

function changePickerKind(kind) {
  if (!selecting || kind===pickerKind || kind==='saved' && pickerMode()!=='arc') return;
  pickerKind=kind;
  if (kind==='search') sitePicker.set(composer.queryRange()?.query ?? '');
  else sitePicker.clear();
  syncPicker();
  if (kind==='current') announce();
  else if (kind==='saved') document.querySelector('#announcement').textContent=savedGroups[bundleIndex]?.name || '저장된 탭그룹이 없어요.';
}

function setWelcomePreview(id) {
  if (id !== null && (selecting || document.hidden || !agent?.session || agent.group?.open ||
      agent.session.running || agent.session.messages.length || agent.session.draft)) return;
  if (id === welcomePreviewId) return;
  welcomePreviewId=id;
  renderPicker();
}

function renderWelcomeGroups() {
  const host=document.querySelector('#welcome-groups');
  if (!host) return;
  document.querySelector('#welcome-start').hidden=Boolean(agent?.group?.open);
  const rows=savedGroups.map(bundle=>{
    const button=document.createElement('button');
    button.type='button';
    const title=document.createElement('span');
    title.textContent=bundle.name;
    const count=document.createElement('small');
    count.textContent='탭 '+bundle.tabs.length+'개';
    button.append(title,count);
    button.addEventListener('pointerenter',event=>{
      if (event.pointerType!=='touch') setWelcomePreview(bundle.id);
    });
    button.addEventListener('pointerleave',()=>{
      if (welcomePreviewId===bundle.id && !button.matches(':focus-visible')) setWelcomePreview(null);
    });
    button.addEventListener('focus',()=>setWelcomePreview(bundle.id));
    button.addEventListener('blur',()=>{
      if (welcomePreviewId===bundle.id && !button.matches(':hover')) setWelcomePreview(null);
    });
    button.addEventListener('click',()=>insertBundle(bundle));
    const row=document.createElement('div');
    row.className='saved-group-row';
    const remove=document.createElement('button');
    remove.type='button';
    remove.className='saved-group-remove';
    remove.textContent='×';
    remove.setAttribute('aria-label',bundle.name+' 저장된 탭그룹 삭제');
    remove.addEventListener('click',async()=>{
      remove.disabled=true;
      try {
        await callAgent('bundle/delete',{bundleId:bundle.id});
        for (const key of bundleFrames.keys()) if (key.startsWith(bundle.id+':')) bundleFrames.delete(key);
        await reloadSavedGroups();
        announceLibraryChange();
      } catch (error) {
        agent?.say(error.message);
        remove.disabled=false;
      }
    });
    row.append(button,remove);
    return row;
  });
  if (!rows.length) {
    const empty=document.createElement('p');
    empty.textContent='저장된 탭그룹이 없어요.';
    rows.push(empty);
  }
  setWelcomePreview(null);
  host.replaceChildren(...rows);
}

function renderSavedGroupNames(bundle) {
  const strip = document.querySelector('#picker-group-names');
  if (strip.dataset.groups !== JSON.stringify(savedGroups.map(({id,name})=>[id,name]))) {
    strip.dataset.groups = JSON.stringify(savedGroups.map(({id,name})=>[id,name]));
    strip.replaceChildren(...savedGroups.map((row,i)=>{
      const button = document.createElement('button');
      button.type='button';
      button.textContent=row.name;
      button.addEventListener('mousedown',event=>event.preventDefault());
      button.addEventListener('click',()=>{chooseBundle(i); message.focus();});
      return button;
    }));
  }
  for (const [i,button] of [...strip.children].entries()) button.setAttribute('aria-pressed',String(i===bundleIndex));
  if (strip.dataset.selected !== bundle?.id) {
    strip.dataset.selected=bundle?.id ?? '';
    strip.children[bundleIndex]?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
}

function renderSavedArc(bundle, page = 0) {
  if (!bundle) { reconcile(savedArcCards,tray,[],()=>{}); return; }
  const start = page*5;
  const tabs = bundle.tabs.slice(start,start+5).map((tab,i)=>({...tab,index:start+i,id:bundle.id+':'+(start+i)}));
  const cacheKey = bundle.id+':'+page;
  if (bundle.hasPreviews && !bundleFrames.has(cacheKey)) {
    bundleFrames.set(cacheKey,null);
    void callAgent('bundle/frames',{bundleId:bundle.id,indexes:tabs.map(tab=>tab.index)}).then(frames=>{
      bundleFrames.set(cacheKey,new Map(frames.map(frame=>[frame.index,frame])));
      if (bundleFrames.size>12) bundleFrames.delete(bundleFrames.keys().next().value);
      if (selecting ? pickerKind==='saved' && savedGroups[bundleIndex]?.id===bundle.id : welcomePreviewId===bundle.id) {
        renderPicker();
      }
    }).catch(()=>bundleFrames.delete(cacheKey));
  }
  reconcile(savedArcCards,tray,tabs,(card,tab,i)=>{
    setArcPosition(card,i-(tabs.length-1)/2);
    card.select.hidden=true;
    card.element.querySelector('.tab-name').textContent=tab.title;
    updateIcon(card.icon,tab.favicon);
    const frame=bundleFrames.get(cacheKey)?.get(tab.index);
    let image=card.element.querySelector('.saved-arc-image');
    if (!image && frame) {
      image=document.createElement('img');
      image.className='saved-arc-image';
      image.alt='저장 당시 화면';
      card.element.querySelector('.preview').prepend(image);
      image.src='data:image/'+frame.format+';base64,'+frame.data;
    }
  });
}

function renderPicker() {
  if (isPanel) return;
  const picker = document.querySelector('#picker');
  const search = selecting && pickerKind==='search';
  const arc = selecting && !search && pickerMode() === 'arc';
  const saved = arc && pickerKind==='saved';
  const choices = pickerTabs();
  const bundle = saved ? savedGroups[bundleIndex] : null;
  const passive = selecting ? null : savedGroups.find(bundle=>bundle.id===welcomePreviewId);
  const kinds = document.querySelector('#picker-kinds');
  const groupHeader = document.querySelector('#picker-group-header');
  const groupNext = document.querySelector('#picker-group-next');
  const help = document.querySelector('#picker-help');
  const mobileControls = document.querySelector('#mobile-picker-controls');
  const empty = document.querySelector('#picker-empty');
  kinds.hidden=!selecting || pickerMode()!=='arc';
  searchElement.hidden=!search;
  groupHeader.hidden=!saved || !savedGroups.length;
  groupNext.hidden=!(bundle?.tabs.length>5);
  help.hidden=Boolean(passive);
  if (usesHomeMac) mobileControls.hidden = !arc || !(saved ? bundle : choices.length);
  empty.hidden=true;
  const vertical=selecting && !arc && !search;
  help.firstElementChild.textContent=vertical ? '↑' : '←';
  help.firstElementChild.nextElementSibling.textContent=vertical ? '↓' : '→';
  for (const button of kinds.children) button.setAttribute('aria-pressed',String(button.dataset.kind===pickerKind));
  // Keep the transcript anchored when the picker takes up space or folds away.
  const wasInline=picker.matches('.is-arc,.is-search');
  const layoutChanged = (arc || search)!==wasInline && !history.hidden;
  const scrollTop = layoutChanged ? history.scrollTop : 0;
  const followLatest = layoutChanged && history.scrollHeight - history.clientHeight - scrollTop < 72;
  picker.classList.toggle('is-arc',arc);
  picker.classList.toggle('is-search',search);
  picker.classList.toggle('is-passive-preview',Boolean(passive));
  if (passive) picker.setAttribute('aria-hidden','true');
  else picker.removeAttribute('aria-hidden');
  picker.hidden = !selecting && !passive;
  if (layoutChanged) history.scrollTop = followLatest ? history.scrollHeight : scrollTop;
  if (search) {
    reconcile(arcCards,tray,[],()=>{});
    reconcile(savedArcCards,tray,[],()=>{});
    tray.hidden=true;
    return;
  }
  if (passive) {
    reconcile(arcCards,tray,[],()=>{});
    tray.hidden=!passive.tabs.length;
    renderSavedArc(passive);
    return;
  }
  if (!saved) reconcile(savedArcCards,tray,[],()=>{});
  if (!selecting) { reconcile(arcCards, tray, [], () => {}); return; }
  if (saved) {
    reconcile(arcCards,tray,[],()=>{});
    tray.hidden=!bundle?.tabs.length;
    if (!bundle) {
      empty.textContent='저장된 탭그룹이 없어요.';
      empty.hidden=false;
    }
    renderSavedGroupNames(bundle);
    renderSavedArc(bundle,bundlePage);
    return;
  }
  tray.hidden = !arc || !choices.length;
  if (!choices.length) {
    empty.textContent = pickerLoading ? '탭 그룹을 확인하는 중…' : '이 창에 선택할 웹 탭이 없어요.';
    empty.hidden=false;
  }
  if (!arc || !choices.length) { reconcile(arcCards, tray, [], () => {}); return; }
  const positions = arcPositions(choices);
  const cardsInView = choices.filter(tab => positions.has(tab.id));
  reconcile(arcCards, tray, cardsInView, (card, tab) => {
    const offset = positions.get(tab.id);
    setArcPosition(card,offset);
    updateCard(card, tab, tab.id === selectedId);
  });
}

function renderSkillPicker() {
  const host=document.querySelector('#skill-picker');
  if (!host) return;
  host.hidden=!skillSelecting;
  document.querySelector('#mention-skill').setAttribute('aria-expanded',String(skillSelecting));
  if (!skillSelecting) return;
  host.replaceChildren(...skillCatalog.map(skill=>{
    const button=document.createElement('button');
    button.type='button';
    button.dataset.skill=skill.name;
    button.title=skill.description;
    button.textContent=skill.title;
    button.disabled=skill.automatic;
    if (skill.automatic) {
      const hint=document.createElement('small');
      hint.textContent='자동';
      button.append(hint);
    } else {
      button.setAttribute('aria-pressed',String(skill.name===selectedSkill));
      button.addEventListener('mousedown',event=>event.preventDefault());
      button.addEventListener('click',()=>chooseSkill(skill));
    }
    return button;
  }));
  const selected=[...host.children].find(button=>button.dataset.skill===selectedSkill);
  if (selected && (selected.offsetTop<host.scrollTop ||
      selected.offsetTop+selected.offsetHeight>host.scrollTop+host.clientHeight)) {
    selected.scrollIntoView({block:'nearest',inline:'nearest'});
  }
}

function openSkillPicker(typed=false) {
  if (!agent?.session) return;
  closePicker();
  if (!composer.open(typed,'/')) return;
  skillSelecting=true;
  selectedSkill=skillCatalog.find(skill=>!skill.automatic)?.name;
  renderSkillPicker();
  void reloadWorkflows();
}

function chooseSkill(skill) {
  if (!skillSelecting || !skill || skill.automatic) return;
  composer.insert({skillName:skill.name,title:'$'+skill.name});
  closePicker();
  agent.render();
}

function handleSkillKey(key) {
  if (!['Escape','Enter','ArrowUp','ArrowDown'].includes(key)) return false;
  if (key==='Escape') closePicker();
  else if (key==='Enter') chooseSkill(skillCatalog.find(skill=>skill.name===selectedSkill));
  else {
    const choices=skillCatalog.filter(skill=>!skill.automatic);
    if (choices.length) {
      const current=choices.findIndex(skill=>skill.name===selectedSkill);
      selectedSkill=choices[(Math.max(0,current)+(key==='ArrowDown' ? 1 : -1)+choices.length)%choices.length].name;
      renderSkillPicker();
    }
  }
  return true;
}

function syncPicker() {
  const live = selecting && pickerKind==='current';
  const choices = live ? pickerTabs() : [];
  const mode = live ? pickerMode() : null;
  post({type:'picker',mode,id:selecting ? selectedId : null,
    eligibleIds:choices.map(tab=>tab.id),previewIds:mode === 'arc' ? [...arcPositions(choices).keys()] : []});
  renderRail();
  renderPicker();
}

async function openPicker(typed = false) {
  if (!agent?.session) return;
  if (skillSelecting) closePicker();
  const version = ++pickerVersion;
  if (!composer.open(typed)) return;
  paintPickerQuery(composer.queryRange()?.range);
  selecting = true;
  welcomePreviewId = null;
  pickerKind = 'current';
  sitePicker.clear();
  bundleIndex = bundlePage = 0;
  if (!agent.group?.open) void reloadSavedGroups();
  pickerLoading = Boolean(agent.session.group && !agent.group?.open);
  selectedId = pickerTabs()[0]?.id ?? null;
  syncPicker();
  if (pickerLoading) {
    try { await agent.reloadGroup(); }
    catch (error) {
      if (version === pickerVersion) {
        closePicker();
        agent.say(error.message);
      }
      return;
    }
    if (version !== pickerVersion) return;
    pickerLoading = false;
    refreshPickerSelection();
  }
  announce();
}

function closePicker() {
  ++pickerVersion;
  pickerLoading = false;
  selecting = false;
  skillSelecting = false;
  welcomePreviewId = null;
  selectedId = null;
  sitePicker?.clear();
  composer?.close();
  paintPickerQuery();
  syncPicker();
  renderSkillPicker();
}

function announce() {
  const tab = pickerTabs().find(item => item.id === selectedId);
  document.querySelector('#announcement').textContent = tab ? tab.title + ', Enter로 참조' : '선택할 탭이 없어요';
}

function choose(id,keepOpen=false) {
  const tab = pickerTabs().find(item=>item.id === id);
  if (!tab || !selecting) return;
  const fromArc = pickerMode() === 'arc' && !reduceMotion.matches;
  const snapshots = fromArc ? snapshotArcCards() : [];
  const chip = composer.insert(tab,{keepOpen,range:composer.queryRange()?.range});
  finishPickerSelection(keepOpen);
  agent.render();
  const selected = snapshots.find(card=>card.id === id);
  if (selected) animateArcSelection(selected, snapshots, chip);
  document.querySelector('#announcement').textContent = tab.title + ' 참조 추가됨';
}

function snapshotArcCards() {
  return [...arcCards.values()].map(({id,element,canvas}) => {
    const from = element.getBoundingClientRect();
    const ghost = element.cloneNode(true);
    ghost.classList.remove('arc-card');
    ghost.classList.add('arc-pick-flight');
    ghost.inert = true;
    ghost.setAttribute('aria-hidden','true');
    delete ghost.dataset.tabId;
    for (const control of ghost.querySelectorAll('button,.selected-banner')) control.remove();
    ghost.style.removeProperty('z-index');
    Object.assign(ghost.style,{left:from.left+'px',top:from.top+'px',width:from.width+'px',height:from.height+'px'});
    if (canvas.width > 1) ghost.querySelector('canvas').getContext('2d')?.drawImage(canvas,0,0);
    return {id,from,ghost};
  }).filter(({from})=>from.width && from.height);
}

function animateArcSelection(selected, snapshots, chip) {
  const to = chip.getBoundingClientRect();
  if (!to.width || !to.height || to.bottom <= 0 || to.top >= innerHeight) return;
  const {from,ghost} = selected;
  const dx = to.left-from.left;
  const dy = to.top-from.top;
  const bend = dx > 0 ? -22 : 22;
  const duration = 450;
  const path = Array.from({length:13},(_,index)=>{
    const t = index/12;
    const x = dx*t + bend*4*t*(1-t);
    const sx = 1+(to.width/from.width-1)*t;
    const sy = 1+(to.height/from.height-1)*t;
    return {transform:`translate(${x}px,${dy*t}px) scale(${sx},${sy})`};
  });
  const outline = document.createElement('span');
  outline.className = 'arc-flight-outline';
  ghost.classList.remove('is-selected');
  ghost.append(outline);
  document.body.append(...snapshots.map(card=>card.ghost));
  ghost.style.zIndex = '13';
  for (const peer of snapshots) {
    if (peer === selected) continue;
    peer.ghost.animate([{opacity:1},{opacity:0}],{duration:115,easing:'ease-out',fill:'forwards'})
      .finished.catch(()=>{}).finally(()=>peer.ghost.remove());
  }
  const flight = ghost.animate(path,{id:'arc-chip-flight',duration,easing:'cubic-bezier(.25,.1,.25,1)',fill:'forwards'});
  outline.animate([{opacity:1},{opacity:1,offset:.1},{opacity:0,offset:.72},{opacity:0}],{duration});
  ghost.querySelector('.preview').animate([{opacity:1},{opacity:1,offset:.28},{opacity:0,offset:.79},{opacity:0}],{duration});
  ghost.animate([{opacity:1},{opacity:1,offset:.86},{opacity:0}],{duration,fill:'forwards'});
  chip.animate([
    {opacity:0},
    {opacity:0,offset:.86},
    {opacity:1},
  ],{duration});
  flight.finished.catch(()=>{}).finally(()=>ghost.remove());
}

function queueGroupArrival(groupId, ids, startedAt, origin, viaPanel = false, hasSource = Boolean(origin)) {
  if (reduceMotion.matches) return;
  for (const [index,id] of ids.entries()) arrivals.set(id,{groupId,index,startedAt,viaPanel,hasSource,
    origin:index === 0 ? origin : undefined});
  animateGroupArrivals(groupId);
}

function animateGroupArrivals(groupId) {
  if (rail.hidden) return;
  for (const [id,arrival] of arrivals) {
    const card = cards.get(id);
    if (Date.now()-arrival.startedAt > 1200) { arrivals.delete(id); continue; }
    if (!card || arrival.groupId !== groupId || reduceMotion.matches) continue;
    arrivals.delete(id);
    const elapsed = Date.now()-arrival.startedAt;
    const handoff = arrival.viaPanel ? groupFlightDuration-50 : 240;
    const delay = Math.max(0,(arrival.hasSource ? handoff : 0)+Math.min(arrival.index,4)*32-elapsed);
    const entering = arrival.viaPanel ? '-18px 0' : '0 8px';
    card.element.animate([{opacity:.2,translate:entering},{opacity:1,translate:'0 0'}],{
      id:'group-arrival',duration:205,delay,easing:'ease-out',fill:'backwards',
    });
    if (arrival.origin && elapsed < 450) animateGroupChip(arrival.origin,card.element);
  }
}

function animateGroupChip({chip,from,fontSize}, target, edge) {
  const to = target?.getBoundingClientRect();
  if (to) {
    const view = tabsEl.getBoundingClientRect();
    if (to.bottom < view.top || to.top > view.bottom) return;
  }
  const clone = chip.cloneNode(true);
  clone.classList.add('tab-flight');
  clone.inert = true;
  clone.setAttribute('aria-hidden','true');
  Object.assign(clone.style,{left:from.left+'px',top:from.top+'px',width:from.width+'px',fontSize});
  document.body.append(clone);
  const dx = to ? to.left-from.left+10 : Math.max(28,document.documentElement.clientWidth-from.right+8);
  const dy = (to ? to.top+14 : edge.top)-from.top;
  const delay = edge ? Math.max(0,edge.startedAt-Date.now()) : 0;
  clone.animate([
    {transform:'translate(0,0)',opacity:.9},
    {transform:`translate(${dx*.66}px,${dy*.66}px) scale(.95)`,opacity:.68,offset:.57},
    {transform:`translate(${dx}px,${dy}px) scale(.9)`,opacity:0},
  ],{id:'group-chip-flight',duration:groupFlightDuration,delay,fill:'backwards',easing:'cubic-bezier(.25,.1,.25,1)'})
    .finished.catch(()=>{}).finally(()=>clone.remove());
}

function playPanelArrival() {
  if (!panelArrival) return;
  const {groupId,ids,startedAt:requestAt} = panelArrival;
  if (Date.now()-requestAt > 650 || reduceMotion.matches) { panelArrival=null; return; }
  if (state.groupId !== groupId) return;
  const view = tabsEl.getBoundingClientRect();
  let target;
  for (const [id,card] of cards) {
    const bounds = card.element.getBoundingClientRect();
    if (bounds.bottom > view.top && bounds.top < view.bottom && (!target || bounds.top < target.top)) {
      target = {id,top:bounds.top};
    }
  }
  if (!target) return;
  panelArrival = null;
  const anchor = Math.min(view.bottom,Math.max(view.top,target.top)+14);
  const offset = (document.documentElement.clientHeight-anchor)*window.devicePixelRatio;
  const startedAt = Math.min(Date.now()+32,requestAt+panelAnchorWait);
  post({type:'groupArrivalTarget',groupId,requestAt,startedAt,offset});
  queueGroupArrival(groupId,[target.id,...ids.filter(id=>id!==target.id)],startedAt,null,true,true);
}

function clearPanelDeparture() {
  clearTimeout(panelDeparture?.timeout);
  panelDeparture = null;
}

function playPanelDeparture({groupId,requestAt,startedAt,offset}) {
  if (panelDeparture?.groupId !== groupId || panelDeparture.requestAt !== requestAt) return;
  const {origin,ids} = panelDeparture;
  clearPanelDeparture();
  if (reduceMotion.matches || activeGroupId() !== groupId) return;
  if (!state.panelOpen) {
    queueGroupArrival(groupId,ids,Date.now(),origin);
    return;
  }
  const height = document.documentElement.clientHeight;
  const top = offset === undefined ? Math.min(142,height/3) :
    Math.max(14,Math.min(height-14,height-offset/window.devicePixelRatio));
  animateGroupChip(origin,null,{top,startedAt});
}

function snapshotGroupChips() {
  if (reduceMotion.matches || agent?.group?.open) return [];
  const view = message.getBoundingClientRect();
  return [...message.querySelectorAll('[data-tab-id],[data-bundle-id],[data-tab-group]')].flatMap(chip=>{
    const from = chip.getBoundingClientRect();
    if (!from.width || from.bottom <= view.top || from.top >= view.bottom) return [];
    return [{chip:chip.cloneNode(true),from,fontSize:getComputedStyle(chip).fontSize,
      id:chip.dataset.tabId===undefined ? null : Number(chip.dataset.tabId)}];
  });
}

function firstGroupArrival(group, sources = []) {
  if (reduceMotion.matches) return;
  const ids = group.tabs.map(tab=>tab.id);
  const restored = group.restoredTabIds?.find(id=>ids.includes(id));
  const origin = sources.find(source=>source.id === null ? restored !== undefined : ids.includes(source.id));
  const targetId = origin?.id ?? restored;
  const ordered = targetId === undefined ? ids : [targetId,...ids.filter(id=>id!==targetId)];
  const startedAt = Date.now();
  if (!usesHomeMac && state.panelOpen) {
    if (origin) {
      clearPanelDeparture();
      const deadline = {groupId:group.groupId,requestAt:startedAt,startedAt:startedAt+panelAnchorWait};
      panelDeparture = {...deadline,ids:ordered,origin,timeout:setTimeout(()=>playPanelDeparture(deadline),panelAnchorWait)};
    }
    post({type:'groupArrival',groupId:group.groupId,ids:ordered,startedAt,hasSource:Boolean(origin)});
  } else queueGroupArrival(group.groupId,ordered,startedAt,origin);
}

function move(step) {
  const options = pickerTabs();
  if (!options.length) return;
  const index = options.findIndex(tab => tab.id === selectedId);
  const next = (Math.max(0,index) + step + options.length) % options.length;
  selectedId = options[next].id;
  syncPicker();
  announce();
}

async function connectMac() {
  const status = await fetch('/mac-status');
  if (status.status === 401) {
    location.reload();
    throw Error('탭룸에 다시 로그인해주세요.');
  }
  if (!status.ok) throw Error('집 Mac의 Chrome에서 탭룸 연결 탭을 열어주세요.');
  const address = new URL('/mac-viewer', location.href);
  address.protocol = 'wss:';
  const socket = new WebSocket(address);
  await new Promise((resolve,reject) => {
    const timeout = setTimeout(() => socket.close(), 6500);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, {once:true});
    socket.addEventListener('close', () => {
      clearTimeout(timeout);
      reject(Error('집 Mac의 Chrome에 연결하지 못했어요.'));
    }, {once:true});
  });
  return {
    onMessage:{addListener:callback => socket.addEventListener('message',({data}) => callback(JSON.parse(data)))},
    onDisconnect:{addListener:callback => socket.addEventListener('close',callback,{once:true})},
    postMessage:message => {
      if (socket.readyState !== WebSocket.OPEN) throw Error('집 Mac 연결이 끊겼어요.');
      socket.send(JSON.stringify(message));
    },
  };
}

async function connect() {
  const install = document.querySelector('#remote-install');
  if (usesHomeMac) {
    macConnectButton.disabled = true;
    macConnectStatus.textContent = '연결 중…';
    try {
      port = await connectMac();
      macConnect.hidden = true;
    } catch (error) {
      macConnect.hidden = false;
      macConnectButton.disabled = false;
      macConnectStatus.textContent = error.message;
      return;
    }
  } else if (!globalThis.chrome?.runtime?.connect) {
    if (isRemote) install.hidden=false;
    agent?.disconnected('이 Chrome에서 탭룸 확장에 연결할 수 없어요.');
    return;
  }
  if (isRemote && !usesHomeMac) {
    try {
      const response=await fetch('/browser/connect',{method:'POST'});
      if (response.status===401) return location.reload();
      if (!response.ok) throw Error('원격 탭룸 연결을 준비할 수 없어요.');
      const {ticket}=await response.json();
      const result=await new Promise((resolve,reject)=>{
        chrome.runtime.sendMessage(extensionId,{type:'connectRemote',ticket},reply=>{
          const error=chrome.runtime.lastError;
          if (error) reject(Error(error.message));
          else resolve(reply);
        });
      });
      if (!result?.connected) throw Error(result?.error || '이 Chrome의 탭룸 확장을 확인해주세요.');
      install.hidden=true;
    } catch (error) {
      install.hidden=false;
      agent?.disconnected(error.message);
      return;
    }
  }
  if (!usesHomeMac) port = isPanel ? chrome.runtime.connect({name:'tabroom'}) : chrome.runtime.connect(extensionId, {name:'tabroom'});
  port.onMessage.addListener(event => {
    if (event.type === 'agentResult') {
      const call = agentRequests.get(event.id);
      if (!call) return;
      agentRequests.delete(event.id);
      if (event.error) call.reject(Error(event.error));
      else call.resolve(event.result);
    } else if (event.type === 'previewFrame') {
      const isCurrent = () => state.tabs.some(tab => tab.id === event.id &&
        (tab.previewTicket === event.ticket || tab.stillTicket === event.ticket));
      void acceptPreviewFrame(event, isCurrent, () => {
        const card = cards.get(event.id);
        const arcCard = arcCards.get(event.id);
        const tab = state.tabs.find(tab => tab.id === event.id);
        const still = tab?.stillTicket === event.ticket || event.frameId === undefined && tab?.still;
        const railDrawn = card && drawCardFrame(card, event.ticket, still);
        const arcDrawn = arcCard && drawCardFrame(arcCard, event.ticket, still);
        return railDrawn || arcDrawn;
      }, post);
    } else if (event.type === 'tabReferenceStill' && !isPanel) {
      if (referenceAnchor && event.requestId===referenceRequest && state.enabled) {
        showReferenceFrame(event);
      }
    } else if (event.type === 'release') {
      releasePreviews(event.id, event.ticket);
      const card = cards.get(event.id);
      const arcCard = arcCards.get(event.id);
      const tab = state.tabs.find(tab => tab.id === event.id);
      if (card) drawCardFrame(card,tab?.previewTicket,tab?.still,tab?.stillTicket);
      if (arcCard) drawCardFrame(arcCard,tab?.previewTicket,tab?.still,tab?.stillTicket);
    } else if (event.type === 'monitorStats') {
      monitor?.previewStats(event);
    } else if (event.type === 'error') {
      const label = document.querySelector('#announcement');
      if (isPanel) groupFeedback(event.message);
      else if (label) label.textContent = event.message;
    } else if (event.type === 'state') {
      if (isPanel && event.sessionId !== state.sessionId) groupFeedback();
      if (!isPanel && state.enabled!==event.enabled && !referenceAnchor?.record) hideReferencePreview();
      if (usesHomeMac && event.previewSettings && JSON.stringify(event.previewSettings) !== JSON.stringify(state.previewSettings)) {
        renderPreviewSettings(event.previewSettings);
      }
      state = event;
      monitor?.captureChanged(event.enabled);
      if (!isPanel && selecting && !pickerTabs().some(tab=>tab.id === selectedId)) {
        const next = pickerTabs()[0]?.id ?? null;
        if (next !== selectedId) { selectedId = next; syncPicker(); }
      }
      renderRail();
      renderPicker();
      if (!isPanel) syncInlineReferences();
      if (!isPanel && !usesHomeMac) {
        const button = document.querySelector('#open-panel');
        button.setAttribute('aria-pressed', String(state.panelOpen));
        button.lastElementChild.textContent = state.panelOpen ? '패널 닫기' : '사이드 패널';
      }
    } else if (event.type === 'groupSummary' && isPanel && event.sessionId === state.sessionId) {
      state = {...state,group:event.group,running:event.running};
      renderRail();
    } else if (event.type === 'groupOwner' && isPanel) {
      owner = event.owner;
      const button = rail.querySelector('#owner-chat');
      button.hidden = !owner;
      button.querySelector('strong').textContent = owner?.title || '';
    } else if (event.type === 'groupArrival' && isPanel) {
      panelArrival = event.hasSource ? event : null;
      if (panelArrival) playPanelArrival();
      else queueGroupArrival(event.groupId,event.ids,event.startedAt,null,true);
    } else if (event.type === 'groupArrivalTarget' && !isPanel) {
      playPanelDeparture(event);
    } else if (event.type === 'pickerKey' && !isPanel) {
      handlePickerKey(event.key);
    } else if (event.type === 'bundlesChanged' && !isPanel) {
      void reloadSavedGroups();
    } else if (event.type === 'sessionTitleChanged' && !isPanel) {
      agent.applyTitle(event.sessionId,event.title);
    } else if (event.type === 'sessionGroupsChanged' && !isPanel) {
      void agent.refreshList().catch(()=>{});
    } else if (event.type === 'groupChanged' && !isPanel) {
      void agent.reloadGroup().catch(error => agent.say(error.message));
    } else if (event.type === 'choose' && !isPanel) choose(event.id);
  });
  port.onDisconnect.addListener(() => {
    void globalThis.chrome?.runtime?.lastError;
    port = null;
    lastViewport = undefined;
    reportedScope = undefined;
    panelArrival = null;
    clearPanelDeparture();
    releasePreviews();
    state = {tabs: [], enabled: false, panelOpen: false, groupId: null};
    monitor?.previewStats({});
    if (isPanel) {
      owner = null;
      rail.querySelector('#owner-chat').hidden = true;
      renderRail();
    }
    else {
      closePicker();
      hideReferencePreview();
      syncInlineReferences();
    }
    for (const call of agentRequests.values()) call.reject(Error('탭룸 확장 연결이 끊겼어요.'));
    agentRequests.clear();
    rail.hidden = !isPanel;
    if (usesHomeMac) {
      macConnect.hidden = false;
      macConnectStatus.textContent = '집 Mac 연결이 끊겼어요.';
      macConnectButton.disabled = false;
      agent?.disconnected('집 Mac 연결이 끊겼어요.');
    } else {
      agent?.disconnected();
      setTimeout(connect, 1200);
    }
  });
  post({type: 'hello', kind: isPanel ? 'panel' : 'portal', windowId, visible:!document.hidden,viewport:true});
  if (!isPanel && !usesHomeMac) {
    post({type:'previewSettings',settings:readPreviewSettings()});
  }
  if (selecting) syncPicker();
  if (!isPanel) {
    void agent.connect();
    void reloadSavedGroups();
    void reloadWorkflows();
    void refreshHistorySetup();
  }
}

document.addEventListener('visibilitychange', () => {
  post({type:'visibility',visible:!document.hidden});
  reportRailViewport();
  if (document.hidden) {
    setWelcomePreview(null);
    if (!isPanel) hideReferencePreview();
  }
  else if (!isPanel && port) {
    void reloadSavedGroups();
    void reloadWorkflows();
    void refreshHistorySetup();
  }
});
window.addEventListener('pagehide', () => post({type:'visibility',visible:false}));
window.addEventListener('pageshow', () => post({type:'visibility',visible:!document.hidden}));

function changePanel(open) {
  if (!isPanel) { post({type:'panel', open}); return; }
  const result = open ? chrome.sidePanel.open({windowId}) : chrome.sidePanel.close({windowId});
  result.catch(error => {
    const live = document.querySelector('#announcement');
    if (live) live.textContent = error.message;
  });
}

rail.querySelector('#capture').addEventListener('click', () => post({type: 'capture', enabled: !state.enabled}));
const saveDialog = rail.querySelector('#bundle-save-dialog');
const saveName = saveDialog.querySelector('#bundle-name');
const saveForm = saveDialog.querySelector('#bundle-save-form');
let saveContext;
rail.querySelector('#group-restore').addEventListener('click',()=>runGroupAction('restore'));
rail.querySelector('#close-group').addEventListener('click',()=>runGroupAction('closeGroup'));
rail.querySelector('#save-bundle').addEventListener('click',()=>{
  saveContext = railContext();
  saveName.value = saveContext.group.title;
  saveForm.querySelector('[role=status]').hidden = true;
  saveDialog.showModal();
  saveName.select();
});
saveForm.addEventListener('submit',async event=>{
  event.preventDefault();
  const submit = saveForm.querySelector('[type=submit]');
  const feedback = saveForm.querySelector('[role=status]');
  submit.disabled = true;
  try {
    if (await changeGroup('bundle/save',{name:saveName.value},saveContext)) saveDialog.close();
  } catch (error) {
    feedback.textContent = error.message;
    feedback.hidden = false;
  } finally { submit.disabled = false; }
});
if (isPanel) {
  rail.querySelector('.close-panel').addEventListener('click', () => changePanel(false));
  rail.querySelector('#back').addEventListener('click', () => post({type: 'showPortal'}));
  rail.querySelector('#owner-chat').addEventListener('click',()=>{
    if (owner) post({type:'openOwner',id:owner.id});
  });
  document.addEventListener('keydown',event=>{
    if (event.target.closest('dialog,.group-actions')) return;
    if (state.mode !== 'stage' || !['ArrowUp','ArrowDown','Enter','Escape'].includes(event.key)) return;
    if (event.key === 'Enter' && event.target.closest('button:not(.tab-card-select)')) return;
    if (event.key === 'Enter' && event.target.closest('.tab-card-select')) return;
    event.preventDefault();
    post({type:'pickerKey',key:event.key});
  });
} else {
  agent = createAgentUi({
    request:callAgent,
    siteIcon,
    onState() {
      publishScope();
      document.querySelector('#welcome-start').hidden=Boolean(agent?.group?.open);
      const running=agent?.session?.running;
      if (running || agent?.group?.open || agent?.session?.messages.length) setWelcomePreview(null);
      if (wasRunning && !running) {
        void reloadSavedGroups();
        void reloadWorkflows();
        announceLibraryChange();
      }
      wasRunning=running;
    },
    tabReference:makeInlineTabChip,
    onHistoryChange:syncInlineReferences,
    onDraft(text) {
      closePicker();
      composer.appendText(text);
      return true;
    },
    onChange(switched) {
      publishScope();
      if (switched) {
        hideReferencePreview();
        if (agent?.session?.provisional) void reloadPopularSites();
        clearPanelDeparture();
        groupFeedback();
        if (saveDialog.open) saveDialog.close();
        releasePreviews();
        closePicker();
        arrivals.clear();
        composer.clear();
      } else if (selecting) refreshPickerSelection();
      else renderRail();
      syncInlineReferences();
    },
    onBeforeSend:snapshotGroupChips,
    onSend(draft) {
      if (JSON.stringify(composer.draft()?.parts) === JSON.stringify(draft.parts)) {
        closePicker();
        composer.clear();
      }
    },
    onGroup:firstGroupArrival,
    readDraft:()=>composer.draft(),
  });
  let wasRunning;
  const taskEditor=document.querySelector('#task-editor');
  document.querySelector('#edit-tasks').addEventListener('click',()=>editTask());
  document.querySelector('#task-select').addEventListener('change',fillTaskEditor);
  const addTaskChip=document.querySelector('#add-task-chip');
  addTaskChip.addEventListener('mousedown',event=>event.preventDefault());
  addTaskChip.addEventListener('click',()=>{
    const bundle=savedGroups.find(group=>group.id===document.querySelector('#task-bundle').value);
    if (!bundle) return;
    taskComposer.insert({tabGroup:{title:bundle.name,urls:bundle.tabs.map(tab=>tab.url)}});
  });
  document.querySelector('#task-editor-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const submit=event.currentTarget.querySelector('button[type=submit]');
    submit.disabled=true;
    try {
      await callAgent('quickTasks/save',{
        id:document.querySelector('#task-select').value,
        title:document.querySelector('#task-title').value,
        parts:taskComposer.draft()?.parts ?? [],
      });
      taskEditor.close();
      void reloadWorkflows();
      announceLibraryChange();
    } catch (error) { document.querySelector('#task-error').textContent=error.message; }
    finally { submit.disabled=false; }
  });
  window.addEventListener('storage',event=>{
    if (event.key===libraryKey) {
      void reloadSavedGroups();
      void reloadWorkflows();
    }
  });
  renderTasks();
  renderWelcomeGroups();
  document.addEventListener('keydown',event=>{
    if (event.key==='Escape' && welcomePreviewId!==null) {
      setWelcomePreview(null);
      event.preventDefault();
    }
  });
  for (const button of document.querySelector('#picker-kinds').children) {
    button.addEventListener('mousedown',event=>event.preventDefault());
    button.addEventListener('click',()=>{
      changePickerKind(button.dataset.kind);
      if (!usesHomeMac || button.dataset.kind==='search') message.focus();
    });
  }
  const pagedTabs=document.querySelector('#picker-group-next');
  pagedTabs.addEventListener('mousedown',event=>event.preventDefault());
  pagedTabs.addEventListener('click',()=>{
    const count=savedGroups[bundleIndex]?.tabs.length ?? 0;
    if (count<=5) return;
    bundlePage=(bundlePage+1)%Math.ceil(count/5);
    renderPicker();
    message.focus();
  });
  renderPreviewSettings(readPreviewSettings());
  document.querySelector('#history-options').addEventListener('click',()=>{
    void callAgent('sites/settings').catch(error=>agent.say(error.message));
  });
  document.querySelector('#preferences').addEventListener('change', event => {
    if (!['preview-format','preview-width','preview-limit','stream-fps'].includes(event.target.id)) return;
    const fps = document.querySelector('#stream-fps');
    const limit = document.querySelector('#preview-limit').value;
    if (['tab','total'].includes(limit) && !fps.reportValidity()) return;
    const settings = normalizePreviewSettings({
      format:document.querySelector('#preview-format').value,
      width:document.querySelector('#preview-width').value,
      limit,
      fps:fps.valueAsNumber,
    });
    localStorage.setItem(previewSettingsKey, JSON.stringify(settings));
    renderPreviewSettings(settings);
    post({type:'previewSettings',settings});
  });
  window.addEventListener('storage', event => {
    if (event.key === previewSettingsKey) renderPreviewSettings(readPreviewSettings());
  });
  const panelButton = document.querySelector('#open-panel');
  if (usesHomeMac) {
    document.body.classList.add('remote-mac');
    panelButton.lastElementChild.textContent = '탭';
    panelButton.setAttribute('aria-controls','rail');
    panelButton.setAttribute('aria-label','집 Mac 탭 미리보기');
    panelButton.addEventListener('click', () => {
      mobileRailOpen = rail.hidden;
      if (selecting && !mobileRailOpen) closePicker();
      else renderRail();
    });
    macConnect.hidden = false;
    macConnectButton.addEventListener('click',connect);
    document.querySelector('#mobile-picker-controls').addEventListener('click', event => {
      const key = event.target.closest('button')?.dataset.pickerKey;
      if (key) handlePickerKey(key);
    });
    renderRail();
  } else panelButton.addEventListener('click', () => changePanel(!state.panelOpen));
  document.querySelector('#mention').addEventListener('click', () => {
    if (selecting) closePicker();
    else void openPicker();
    if (!usesHomeMac) message.focus();
  });
  document.querySelector('#mention-skill').addEventListener('click',()=>{
    if (skillSelecting) closePicker();
    else openSkillPicker();
    message.focus();
  });
  message.addEventListener('keydown', event => {
    const enter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
    const sendOnCommit = enter && !event.shiftKey && !event.repeat && !selecting && !skillSelecting;
    const sessionId = agent.session?.id;
    if (composer.handleComposition(event,sendOnCommit ? ()=>{
      if (agent.session?.id === sessionId) void agent.submit();
    } : null)) return;
    if (skillSelecting) {
      if (handleSkillKey(event.key)) event.preventDefault();
      return;
    }
    if (!selecting) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void agent.submit();
      }
      return;
    }
    if (handlePickerKey(event.key,event.shiftKey)) event.preventDefault();
  });
}

function handlePickerKey(key,keepOpen=false) {
  if (!selecting) return false;
  if (key==='Escape') { closePicker(); return true; }
  if (pickerKind==='search') return sitePicker.key(key,keepOpen);
  const arc = pickerMode() === 'arc';
  if (arc && ['ArrowUp','ArrowDown'].includes(key)) {
    if (key==='ArrowDown') changePickerKind(pickerKind==='current' ? 'saved' : 'search');
    else changePickerKind('current');
    return true;
  }
  if (arc && pickerKind==='saved' && ['ArrowLeft','ArrowRight','Enter'].includes(key)) {
    if (key==='Enter') insertBundle(savedGroups[bundleIndex],keepOpen);
    else if (savedGroups.length) chooseBundle((bundleIndex+(key==='ArrowRight' ? 1 : -1)+savedGroups.length)%savedGroups.length);
    return true;
  }
  const back = arc ? 'ArrowLeft' : 'ArrowUp';
  const forward = arc ? 'ArrowRight' : 'ArrowDown';
  if (![back,forward,'Enter'].includes(key)) return false;
  if (key === 'Enter') choose(selectedId,keepOpen);
  else move(key === back ? -1 : 1);
  return true;
}
if (!usesHomeMac) connect();
