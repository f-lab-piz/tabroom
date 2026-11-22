import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as settle, setTimeout as wait} from 'node:timers/promises';

function event() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => { for (const listener of listeners) listener(...args); },
  };
}

const portalUrl = 'http://127.0.0.1:18840/';
const tabs = [
  {id: 1, windowId: 1, groupId: 10, url: 'https://example.com/alpha', title: '그룹 A'},
  {id: 2, windowId: 2, groupId: 20, url: 'https://example.com/beta', title: '그룹 B'},
  {id: 3, windowId: 1, groupId: -1, url: 'https://example.com/unlinked', title: '연결 전'},
  {id: 4, windowId: 1, groupId: -1, url: 'https://example.com/another', title: '미그룹'},
  {id: 90, windowId: 1, groupId: -1, url: portalUrl, title: '탭룸'},
];

const requested = [];
const formats = [];
const widths = [];
const attached = [];
const detached = [];
const focusChanges = [];
const activatedTabs = [];
const capturedStills = [];
const saved = {};
const groupCache = {};
const states = new Map();
const workKey = '00000000-1111-2222-3333-444444444444';
const stops = [];
const ref = id=>10_000_010_000+id;
const registry = 'tabroomTabRefs:'+workKey;
function sessionRows(key) {
  if (key === registry) {
    const rows = groupCache[key] ??= {};
    for (const tab of tabs) rows[tab.id] ??= {ref:ref(tab.id),groupId:tab.groupId};
  }
  return {[key]:groupCache[key]};
}
globalThis.chrome = {
  runtime: {onConnect: event(), onConnectExternal: event()},
  storage: {
    local: {get: async key => ({[key]: saved[key]}), set: async changes => Object.assign(saved, changes)},
    session: {get: async key => sessionRows(key), set: async changes => Object.assign(groupCache, changes)},
  },
  sidePanel: {onOpened: event(), onClosed: event(), setPanelBehavior: async () => {}},
  action: {onClicked: event()},
  windows: {get: async id => ({id,state:states.get(id) ?? 'normal'}),update:async()=>{},onBoundsChanged:event(),onFocusChanged:event()},
  tabs: {
    get: async id => tabs.find(tab => tab.id === id),
    update:async id=>{activatedTabs.push(id);return tabs.find(tab=>tab.id===id);},
    query: async query => tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value)),
    onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event(), onAttached: event(), onDetached: event(),
  },
  tabGroups: {
    onRemoved:event(),
    get:async id=>({id,windowId:1,title:'탭룸 · '+workKey.slice(0,12)}),
    query:async()=>[{id:10,windowId:1,title:'탭룸 · '+workKey.slice(0,12)}],
  },
  debugger: {
    onDetach: event(), onEvent: event(),
    getTargets: async()=>tabs.map(tab=>({id:'target-'+tab.id,tabId:tab.id,type:'page'})),
    async attach({tabId}) {
      attached.push(tabId);
      if (tabId === 3) throw Error('Another debugger is already attached');
    },
    async detach({tabId}) { detached.push(tabId); },
    async sendCommand(source, method, params) {
      if (method === 'Page.stopScreencast') stops.push(source.tabId);
      if (method === 'Emulation.setFocusEmulationEnabled') focusChanges.push([source.tabId, params.enabled]);
      if (method === 'Page.startScreencast') {
        widths.push(params.maxWidth);
        formats.push(params.format);
        requested.push(source);
      }
      if (method === 'Page.getLayoutMetrics') return {cssVisualViewport:{pageX:0,pageY:0,clientWidth:1024,clientHeight:768}};
      if (method === 'Page.captureScreenshot') {
        capturedStills.push(source.tabId);
        return {data:'test-jpeg'};
      }
      return {};
    },
  },
};

await import('../capture-worker.js');
const {acquireTabDebugger} = await import('../debugger-connection.js');
const {scopedBackend} = await import('../agent-chrome.js');

function connect(kind, viewport = false) {
  const messages = [];
  const port = {
    name: 'tabroom',
    sender: {frameId: 0, url: portalUrl, tab: {id: 90, windowId: 1}},
    onDisconnect: event(), onMessage: event(), postMessage: message => messages.push(message),
  };
  chrome.runtime[kind === 'portal' ? 'onConnectExternal' : 'onConnect'].emit(port);
  const post = message => port.onMessage.emit(message.type === 'scope' ? {sessionId:workKey,...message} : message);
  post({type: 'hello', kind, windowId: 1,viewport});
  if (kind === 'portal') post({type:'scope',groupId:null});
  return {
    messages, post, close: () => port.onDisconnect.emit(),
    get state() { return messages.findLast(message => message.type === 'state'); },
    accept(id) {
      const source = requested.findLast(item => item.tabId === id);
      assert.ok(source);
      chrome.debugger.onEvent.emit(source, 'Page.screencastFrame', {sessionId:1, data:'test-png'});
      const offer = messages.findLast(message => message.type === 'previewFrame' && message.id === ref(id));
      assert.equal(offer?.data, 'test-png');
      post({type: 'previewFrameResult', id:ref(id), ticket: offer.ticket, frameId: offer.frameId, ok: true, drawn: true});
    },
  };
}

test('탭 클릭 없이 연결된 그룹만 캡처하고 패널과 범위를 공유한다', async () => {
  const portal = connect('portal');
  portal.post({type:'previewSettings',settings:{format:'png',limit:'tab',fps:30}});
  await settle();
  assert.deepEqual(requested, []);
  assert.equal(portal.state.enabled, true);
  assert.equal(portal.state.groupId, null);
  assert.equal(portal.state.tabs.some(tab => tab.status !== 'paused'), false);

  portal.post({type: 'scope', groupId: 10});
  await settle();
  portal.accept(1);
  assert.deepEqual(requested.map(item => item.tabId), [1]);
  assert.deepEqual(widths, [320]);
  assert.equal(portal.state.tabs.find(tab => tab.id === ref(1)).status, 'ready');

  portal.post({type: 'scope', groupId: 20});
  assert.equal(portal.state.tabs.find(tab => tab.id === ref(1))?.previewTicket, undefined);
  await settle();
  portal.accept(2);
  assert.deepEqual(requested.map(item => item.tabId), [1, 2]);
  assert.deepEqual(portal.state.tabs.filter(tab => tab.previewTicket).map(tab => tab.id), [ref(2)]);

  const panel = connect('panel');
  await settle();
  assert.equal(panel.state.groupId, 20);
  assert.deepEqual(panel.state.tabs.filter(tab => tab.previewTicket).map(tab => tab.id), [ref(2)]);
  assert.equal(portal.state.tabs.some(tab => tab.previewTicket), false);
  assert.equal(panel.messages.findLast(message => message.type === 'previewFrame')?.data, 'test-png');
  assert.equal(requested.length, 2);

  chrome.sidePanel.onClosed.emit({windowId:1});
  await settle();
  assert.equal(portal.state.panelOpen, false);
  assert.equal(portal.messages.findLast(message => message.type === 'previewFrame')?.frameId, undefined);
  assert.equal(requested.length, 2);
  panel.close();

  portal.post({type: 'scope', groupId: null});
  await settle();
  assert.equal(portal.state.groupId, null);
  assert.equal(portal.state.tabs.some(tab => tab.previewTicket), false);
  assert.equal(portal.messages.findLast(message => message.type === 'release').id, ref(2));

  portal.close();
  await settle();
});

test('캡처를 꺼 둔 채 처음 #을 열면 보이는 카드에 첫 프레임만 보낸다', async () => {
  const portal = connect('portal');
  const first = requested.length;
  const released = detached.length;
  portal.post({type: 'capture', enabled: false});
  portal.post({type: 'previewSettings', settings:{format:'jpeg',limit:'total',fps:30}});
  portal.post({type: 'picker', mode:'arc', id:ref(4), eligibleIds:[1,4].map(ref), previewIds:[1,4].map(ref)});
  await settle();
  portal.accept(4);
  await settle();
  assert.equal(portal.state.enabled, false);
  assert.equal(saved.tabroomCaptureEnabled, false);
  assert.equal(portal.state.tabs.find(tab=>tab.id===ref(4)).status,'ready');
  assert.equal(detached.length,released+1);
  assert.deepEqual(requested.slice(first).map(item=>item.tabId),[4]);
  assert.equal(formats.at(-1),'jpeg');
  portal.post({type:'picker',mode:null});
  await settle();
  assert.equal(portal.state.tabs.find(tab=>tab.id===ref(4)).previewTicket,undefined);
  portal.close();
  await settle();
  const reopened = connect('portal');
  await settle();
  assert.equal(reopened.state.enabled, false);
  reopened.close();
  await settle();
});

test('캡처가 차단되면 이유를 표시하고 권한 클릭을 요구하지 않는다', async () => {
  const portal = connect('portal');
  portal.post({type: 'capture', enabled: true});
  portal.post({type: 'picker', mode: 'arc', eligibleIds:[ref(3)], previewIds:[ref(3)], id:ref(3)});
  await settle();
  assert.equal(portal.state.tabs.find(tab => tab.id === ref(3)).status, 'unavailable');
  assert.match(portal.state.tabs.find(tab => tab.id === ref(3)).reason, /다른 개발자 도구/);
  assert.equal(portal.messages.some(message => message.type === 'previewFrame'), false);
  portal.close();
  await settle();
});

test('그룹에서 빠진 탭의 미리보기를 닫아도 에이전트의 연결은 유지된다', async () => {
  const agentConnection = await acquireTabDebugger(1);
  const firstFocus = focusChanges.length;
  const supplied = attached.filter(id => id === 1).length;
  const removed = detached.filter(id => id === 1).length;
  const portal = connect('portal');
  portal.post({type: 'scope', groupId: 10});
  portal.post({type: 'previewSettings', settings:{format:'png',limit:'tab',fps:30}});
  portal.post({type: 'capture', enabled: true});
  await settle();
  portal.accept(1);
  assert.equal(attached.filter(id => id === 1).length, supplied);
  await agentConnection.setFocus(true);
  await agentConnection.setFocus(false);
  assert.deepEqual(focusChanges.slice(firstFocus), [[1, true]]);
  await agentConnection.setFocus(true);

  const tab = tabs[0];
  tab.groupId = -1;
  chrome.tabs.onUpdated.emit(tab.id, {groupId: -1}, tab);
  chrome.tabGroups.onRemoved.emit({id: 10, windowId: 1});
  await settle();
  assert.equal(portal.state.tabs.find(item => item.id === ref(1))?.previewTicket, undefined);
  assert.equal(portal.messages.findLast(message => message.type === 'release').id, ref(1));
  assert.equal(portal.messages.some(message => message.type === 'groupChanged'), true);
  assert.equal(agentConnection.connected, true);
  assert.equal(detached.filter(id => id === 1).length, removed);
  assert.deepEqual(focusChanges.slice(firstFocus), [[1, true]]);
  await agentConnection.setFocus(false);
  assert.deepEqual(focusChanges.slice(firstFocus), [[1, true], [1, false]]);
  await agentConnection.release();
  assert.equal(detached.filter(id => id === 1).length, removed + 1);
  tab.groupId = 10;
  portal.close();
  await settle();
});

test('작업 대상이 바뀌면 이전 캡처를 종료하고 마지막 프레임을 넘긴다', async () => {
  tabs.push({id:5,windowId:1,groupId:10,url:'https://example.com/work',title:'작업 탭'});
  const portal = connect('portal');
  const backend = scopedBackend(workKey,1,true,()=>{});
  const command = (method,params,sessionId) => backend.invoke({method,params,sessionId});
  try {
    portal.post({type:'previewSettings',settings:{limit:'none',format:'png'}});
    portal.post({type:'scope',groupId:10});
    await settle();
    portal.accept(1);
    portal.accept(5);
    await settle();
    const before = stops.length;
    portal.post({type:'previewSettings',settings:{limit:'active',format:'png'}});
    await settle();
    assert.deepEqual(stops.slice(before),[1,5]);
    assert.deepEqual(portal.state.tabs.filter(tab=>tab.still).map(tab=>tab.id),[ref(1),ref(5)]);
    const first = await command('Target.attachToTarget',{targetId:'target-1'});
    const second = await command('Target.attachToTarget',{targetId:'target-5'});
    assert.equal(portal.state.tabs.find(tab=>tab.id===ref(1)).still,true);
    await command('Input.dispatchMouseEvent',{type:'mouseWheel'},first.sessionId);
    await settle();
    assert.equal(portal.state.tabs.find(tab=>tab.id===ref(1)).still,true);
    assert.equal(portal.state.tabs.find(tab=>tab.id===ref(5)).still,true);
    chrome.debugger.onEvent.emit({tabId:1},'Page.screencastFrame',{sessionId:2,data:'work-frame'});
    await wait(40);
    const frame = portal.messages.findLast(item=>item.type==='previewFrame' && item.id===ref(1));
    assert.equal(frame?.data,'work-frame');
    portal.post({type:'previewFrameResult',id:ref(1),ticket:frame.ticket,frameId:frame.frameId,ok:true,drawn:true});
    assert.equal(portal.state.tabs.find(tab=>tab.id===ref(1)).still,false);
    await command('Input.insertText',{text:'test'},second.sessionId);
    await settle();
    assert.deepEqual(portal.state.tabs.filter(tab=>tab.still).map(tab=>tab.id),[ref(1),ref(5)]);
    assert.equal(portal.messages.findLast(item=>item.type==='previewFrame'&&item.id===ref(1)).data,'work-frame');
  } finally {
    portal.post({type:'previewSettings',settings:{limit:'total',fps:30,format:'png'}});
    portal.close();
    await backend.close();
    tabs.pop();
    chrome.tabs.onRemoved.emit(5,{windowId:1});
    await settle();
  }
});

test('창 최소화와 화면 숨김에서 캡처를 멈추고 수동 OFF를 유지한다', async () => {
  const portal = connect('portal');
  try {
    portal.post({type:'capture',enabled:true});
    portal.post({type:'previewSettings',settings:{limit:'none',format:'png'}});
    portal.post({type:'scope',groupId:10});
    await settle();
    assert.ok(portal.state.tabs.find(tab=>tab.id===ref(1)).previewTicket);
    states.set(1,'minimized');
    chrome.windows.onBoundsChanged.emit({id:1,state:'minimized'});
    await settle();
    assert.equal(portal.state.tabs.find(tab=>tab.id===ref(1)).previewTicket,undefined);
    states.set(1,'normal');
    chrome.windows.onFocusChanged.emit(1);
    await settle();
    assert.ok(portal.state.tabs.find(tab=>tab.id===ref(1)).previewTicket);
    portal.post({type:'capture',enabled:false});
    portal.post({type:'visibility',visible:false});
    await settle();
    portal.post({type:'visibility',visible:true});
    await settle();
    assert.equal(portal.state.enabled,false);
    assert.equal(portal.state.tabs.find(tab=>tab.id===ref(1)).previewTicket,undefined);
  } finally {
    portal.close();
    await settle();
  }
});

test('네이티브 창 가림으로 캡처가 멈추고 마지막 프레임을 남긴 뒤 다시 시작한다', async () => {
  const nativeRequests = [];
  const native = {onMessage:event(),onDisconnect:event(),disconnect(){},postMessage:msg=>nativeRequests.push(msg)};
  chrome.runtime.connectNative = name => {
    assert.equal(name,'com.tabroom.window_visibility');
    return native;
  };
  const get = chrome.windows.get;
  chrome.windows.get = async id => ({...await get(id),left:0,top:25,width:800,height:600});
  const oldStopped = stops.length;
  const portal = connect('portal');
  try {
    portal.post({type:'capture',enabled:true});
    portal.post({type:'previewSettings',settings:{limit:'none',format:'png'}});
    portal.post({type:'scope',groupId:10});
    await settle();
    portal.accept(1);
    assert.equal(nativeRequests.at(-1).windows[0].id,1);
    native.onMessage.emit({covered:[1]});
    assert.equal(stops.length,oldStopped);

    await wait(1010);
    native.onMessage.emit({covered:[1]});
    await settle();
    assert.deepEqual(stops.slice(oldStopped),[1]);
    assert.equal(portal.state.tabs.find(tab=>tab.id===ref(1)).status,'still');
    assert.ok(portal.state.tabs.find(tab=>tab.id===ref(1)).stillTicket);
    assert.equal(portal.messages.findLast(message=>message.type==='monitorStats').fps,0);

    await wait(1010);
    native.onMessage.emit({covered:[]});
    await settle();
    portal.accept(1);
    assert.equal(portal.state.tabs.find(tab=>tab.id===ref(1)).status,'ready');
  } finally {
    portal.close();
    await settle();
    chrome.windows.get = get;
    delete chrome.runtime.connectNative;
  }
});

test('해상도 설정을 바꾸면 포털과 패널이 새 가로 크기로 캡처한다', async () => {
  const portal = connect('portal');
  let panel;
  const first = widths.length;
  try {
    const settings = {format:'jpeg',limit:'none',fps:48};
    portal.post({type:'capture',enabled:true});
    portal.post({type:'previewSettings',settings});
    portal.post({type:'scope',groupId:10});
    await settle();
    portal.accept(1);
    assert.equal(portal.state.previewSettings.width,320);

    panel = connect('panel');
    await settle();
    for (const [value,width] of [['480',480],[240,240],[800,320]]) {
      portal.post({type:'previewSettings',settings:{...settings,width:value}});
      await settle();
      assert.deepEqual(panel.state.previewSettings,{...settings,width});
      panel.accept(1);
      if (width === 480) {
        portal.post({type:'previewSettings',settings});
        await settle();
        assert.equal(panel.state.previewSettings.width,480);
      }
    }
    assert.deepEqual(widths.slice(first),[320,480,240,320]);
    assert.equal(formats.at(-1),'jpeg');
  } finally {
    panel?.close();
    portal.post({type:'capture',enabled:false});
    portal.close();
    await settle();
  }
});

test('패널의 탭 순서는 Chrome 순서를 따르고 첫 연결의 모션 시점을 전달한다', async () => {
  tabs[0].index = 4;
  tabs.push({id:5,index:1,windowId:1,groupId:10,url:'https://example.com/new',title:'추가된 탭'});
  const portal = connect('portal');
  const panel = connect('panel');
  try {
    portal.post({type:'scope',groupId:10});
    await settle();
    assert.deepEqual(panel.state.tabs.filter(tab=>tab.groupId===10).map(tab=>tab.id),[ref(5),ref(1)]);
    const startedAt = Date.now();
    portal.post({type:'groupArrival',groupId:10,ids:[ref(1),ref(5)],startedAt,hasSource:true});
    assert.deepEqual(panel.messages.findLast(message=>message.type==='groupArrival'),{
      type:'groupArrival',groupId:10,ids:[ref(1),ref(5)],startedAt,hasSource:true,
    });
    const target = {type:'groupArrivalTarget',groupId:10,requestAt:startedAt,startedAt:startedAt+32,offset:420};
    panel.post({...target,requestAt:startedAt-1});
    assert.equal(portal.messages.some(message=>message.type==='groupArrivalTarget'),false);
    panel.post(target);
    assert.deepEqual(portal.messages.findLast(message=>message.type==='groupArrivalTarget'),target);
    panel.post(target);
    assert.equal(portal.messages.filter(message=>message.type==='groupArrivalTarget').length,1);
  } finally {
    panel.close();
    portal.close();
    tabs.pop();
    delete tabs[0].index;
    await settle();
  }
});

test('10개 중 보이는 탭만 캡처하고 스크롤 후 마지막 화면에서 재개한다', async () => {
  const groupId = 30;
  const ids = Array.from({length:10},(_,i)=>100+i);
  for (const id of ids) tabs.push({id,index:id,windowId:1,groupId,url:'https://example.com/viewport',title:'미리보기 탭'});
  const portal = connect('portal',true);
  const start = requested.length;
  let panel;
  const view = (viewer,ids)=>viewer.post({type:'visiblePreviews',groupId,ids:ids.map(ref)});
  try {
    portal.post({type:'capture',enabled:true});
    portal.post({type:'previewSettings',settings:{limit:'none',format:'png'}});
    portal.post({type:'scope',groupId});
    await settle();
    assert.equal(requested.length,start);
    view(portal,[100,101,102]);
    await settle();
    assert.deepEqual(requested.slice(start).map(tab=>tab.tabId),[100,101,102]);
    portal.accept(100);
    const oldTicket = portal.state.tabs.find(tab=>tab.id===ref(100)).previewTicket;
    view(portal,[101,102,103]);
    await settle();
    assert.equal(requested.at(-1).tabId,103);
    assert.equal(stops.includes(100),false);
    await wait(225);
    assert.ok(stops.includes(100));
    assert.equal(portal.state.tabs.find(tab=>tab.id===ref(100)).still,true);
    view(portal,[100,101,102,103]);
    await settle();
    const resuming = portal.state.tabs.find(tab=>tab.id===ref(100));
    assert.notEqual(resuming.previewTicket,oldTicket);
    assert.equal(resuming.stillTicket,oldTicket);
    portal.accept(100);
    assert.equal(portal.state.tabs.find(tab=>tab.id===ref(100)).still,false);

    panel = connect('panel',true);
    await settle();
    const beforePanel = requested.length;
    view(panel,[100,105]);
    await settle();
    assert.deepEqual(requested.slice(beforePanel).map(tab=>tab.tabId),[100,105]);
    assert.equal(panel.messages.findLast(message=>message.type==='previewFrame' && message.id===ref(100))?.data,'test-png');
  } finally {
    panel?.close();
    portal.post({type:'capture',enabled:false});
    portal.close();
    tabs.splice(-ids.length);
    await settle();
  }
});

test('채팅 칩은 캡처 한 장만 요청하고 이동과 미리보기는 현재 그룹에만 적용한다',async()=>{
  const portal=connect('portal',true), panel=connect('panel',true);
  const start=requested.length;
  const shots=capturedStills.length;
  tabs.push({id:99,windowId:1,groupId:10,url:'https://example.com/extra',title:'추가 탭'});
  try {
    portal.post({type:'capture',enabled:true});
    portal.post({type:'previewSettings',settings:{format:'png',limit:'none'}});
    portal.post({type:'scope',groupId:10});
    await settle();
    panel.post({type:'visiblePreviews',groupId:10,ids:[ref(1)]});
    portal.post({type:'visiblePreviews',groupId:10,ids:[],inlineIds:[ref(1),ref(2)]});
    await settle();
    assert.deepEqual(requested.slice(start).map(tab=>tab.tabId),[1]);
    panel.accept(1);
    assert.equal(portal.messages.some(message=>message.type==='previewFrame'),false);
    portal.post({type:'tabReferenceStill',groupId:10,id:ref(1),requestId:1});
    portal.post({type:'tabReferenceStill',groupId:10,id:ref(2),requestId:2});
    portal.post({type:'tabReferenceStill',groupId:20,id:ref(1),requestId:3});
    await settle();
    const stills=()=>portal.messages.filter(item=>item.type==='tabReferenceStill');
    assert.deepEqual(stills(),[{type:'tabReferenceStill',requestId:1,format:'png',data:'test-png'}]);
    assert.equal(capturedStills.length,shots);

    portal.post({type:'tabReferenceStill',groupId:10,id:ref(99),requestId:4});
    portal.post({type:'tabReferenceStill',groupId:10,id:ref(99),requestId:5});
    await settle();
    assert.deepEqual(capturedStills.slice(shots),[99]);
    assert.deepEqual(stills().slice(1).map(({requestId,data})=>[requestId,data]),[[4,'test-jpeg'],[5,'test-jpeg']]);

    portal.post({type:'openTabReference',groupId:10,id:ref(2)});
    portal.post({type:'openTabReference',groupId:20,id:ref(1)});
    portal.post({type:'openTabReference',groupId:10,id:ref(1)});
    await settle();
    assert.deepEqual(activatedTabs,[1]);

    panel.post({type:'visiblePreviews',groupId:10,ids:[]});
    await wait(225);
    assert.deepEqual(requested.slice(start).map(tab=>tab.tabId),[1]);
    portal.post({type:'tabReferenceStill',groupId:10,id:ref(1),requestId:6});
    portal.post({type:'tabReferenceStill',groupId:10,id:ref(99),requestId:7});
    await settle();
    assert.deepEqual(capturedStills.slice(shots),[99]);
    assert.deepEqual(stills().slice(-2).map(({requestId,data})=>[requestId,data]),[[6,'test-png'],[7,'test-jpeg']]);
    portal.post({type:'capture',enabled:false});
    await settle();
    portal.post({type:'tabReferenceStill',groupId:10,id:ref(99),requestId:8});
    await settle();
    assert(!stills().some(item=>item.requestId===8));
  } finally {
    tabs.splice(tabs.findIndex(tab=>tab.id===99),1);
    panel.close();
    portal.post({type:'capture',enabled:false});
    portal.close();
    await settle();
  }
});
