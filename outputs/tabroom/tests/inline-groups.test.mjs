import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTabHighlight} from '../tab-highlight.js';
import {ungroupedTabs} from '../streams.js';
import {createComposer} from '../composer.js';
import {readTurnDraft,resolveTurnDraft} from '../../tabroom-launcher/turn-message.mjs';
import {opensGroupOnly} from '../agent-ui.js';

const evt = () => ({addListener(){},removeListener(){}});
const key = '12345678-1111-2222-3333-123456789012';

test('한글을 조합 중일 때 누른 Enter는 조합이 완료된 내용을 한 번 전송한다',async()=>{
  const editor=new EventTarget();
  editor.ownerDocument=Object.assign(new EventTarget(),{getSelection:()=>({rangeCount:0})});
  let refreshes=0;
  let submissions=0;
  const composer=createComposer(editor,()=>{refreshes++;});
  const finish=data=>editor.dispatchEvent(Object.assign(new Event('compositionend'),{data}));
  const submit=()=>{submissions++;};

  editor.dispatchEvent(new Event('compositionstart'));
  assert.equal(composer.handleComposition({isComposing:true,keyCode:229},submit),true);
  assert.equal(submissions,0);
  finish('녕');
  await Promise.resolve();
  assert.equal(refreshes,1);
  assert.equal(submissions,1);
  assert.equal(composer.handleComposition({isComposing:false,keyCode:13}),false);

  editor.dispatchEvent(new Event('compositionstart'));
  composer.handleComposition({isComposing:true,keyCode:229},submit);
  finish('日本語');
  editor.dispatchEvent(new Event('compositionstart'));
  finish('안녕');
  await Promise.resolve();
  assert.equal(refreshes,3);
  assert.equal(submissions,1);
});

test('직접 입력한 #이 지워지면 두 선택기에서 공유하는 기준 위치가 해제된다',()=>{
  const text={nodeType:3,data:'#'};
  let offset=1;
  const range={startContainer:text,commonAncestorContainer:text,startOffset:1,
    cloneRange:()=>range,setStart:(_node,start)=>{offset=start;},
    get collapsed(){return offset>=text.data.length;},toString:()=>text.data.slice(offset)};
  const editor=Object.assign(new EventTarget(),{contains:node=>node===text});
  editor.ownerDocument=Object.assign(new EventTarget(),{getSelection:()=>({rangeCount:1,getRangeAt:()=>range})});
  const composer=createComposer(editor,()=>{});
  composer.open(true);
  assert.equal(composer.validAnchor(),true);
  text.data='';
  assert.equal(composer.validAnchor(),false);
  composer.open(false);
  assert.equal(composer.validAnchor(),true);
});

test('반복 참조는 문장에 남고 그룹 후보 ID는 한 번만 담는다',()=>{
  assert.deepEqual(readTurnDraft({parts:[{text:'그룹 없는 대화'}]}).tabIds,[]);
  const draft=readTurnDraft({parts:[{tabId:11},{text:'과 '},{tabId:13},{text:' 비교 후 '},{tabId:11}]});
  assert.deepEqual(draft.tabIds,[11,13]);
  const resolved=resolveTurnDraft(draft,[{id:11,title:'네이버'},{id:13,title:'다른 탭'}]);
  assert.equal(resolved.input,'[[tab:11]]과 [[tab:13]] 비교 후 [[tab:11]]');
  assert.deepEqual(resolved.parts.filter(p=>p.tabId).map(p=>p.tabId),[11,13,11]);
});

test('호형은 그룹을 건너뛰고 두 선택 방식 모두 실제 탭을 강조한다',async()=>{
  const rows=[
    {id:90,windowId:1,index:0,active:true,highlighted:true,groupId:-1},
    {id:11,windowId:1,index:1,title:'네이버',groupId:-1},
    {id:12,windowId:1,index:2,groupId:7},
    {id:13,windowId:1,index:3,title:'네이버',groupId:-1},
    {id:14,windowId:2,index:0,groupId:-1},
  ];
  let collapsed=false;
  const calls=[];
  const browser={tabGroups:{get:async()=>({collapsed})},tabs:{
    query:async({windowId})=>rows.filter(tab=>tab.windowId===windowId).map(tab=>({...tab})),
    highlight:async({tabs,windowId})=>{
      calls.push(tabs);
      const current=rows.filter(tab=>tab.windowId===windowId);
      for(const tab of current) {
        tab.active=tab.index===tabs[0];
        tab.highlighted=tabs.includes(tab.index);
      }
      return {tabs:current};
    },
  }};
  assert.deepEqual(ungroupedTabs(rows.filter(tab=>tab.id!==90),1).map(tab=>tab.id),[11,13]);
  const highlight=createTabHighlight(browser,1);
  await highlight.select(90,13);
  assert.deepEqual(calls.at(-1),[0,3]);
  await highlight.select(90,12);
  assert.deepEqual(calls.at(-1),[0,2]);
  collapsed=true;
  await highlight.select(90,12);
  assert.deepEqual(calls.at(-1),[0]);
  await highlight.select(90,14);
  assert.equal(calls.length,3);
});

test('같은 브라우저 실행에서 미그룹 탭 열기, 그룹 만들기, 범위 전환과 차단을 확인한다',async()=>{
  const rows=[
    {id:90,windowId:1,groupId:-1,url:'http://127.0.0.1:18840/'},
    {id:11,windowId:1,groupId:-1,url:'https://example.com/free'},
    {id:12,windowId:1,groupId:77,url:'https://example.com/other'},
    {id:13,windowId:2,groupId:-1,url:'https://example.com/window'},
  ];
  const groups=new Map([[77,{id:77,windowId:1,title:'다른 그룹'}]]);
  let next=20;
  const cache={};
  const focusChanges=[];
  globalThis.chrome={
    storage:{
      local:{get:async name=>({[name]:cache[name]}),set:async value=>Object.assign(cache,value)},
      session:{get:async name=>({[name]:cache[name]}),set:async value=>Object.assign(cache,value)},
    },
    tabs:{
      query:async query=>rows.filter(tab=>Object.entries(query).every(([property,value])=>tab[property]===value)),
      get:async id=>rows.find(tab=>tab.id===id),
      create:async props=>{const tab={id:next++,groupId:-1,...props};rows.push(tab);return tab;},
      group:async ops=>{const id=ops.groupId??88;groups.set(id,groups.get(id)??{id,windowId:ops.createProperties.windowId});for(const tab of rows)if(ops.tabIds.includes(tab.id))tab.groupId=id;return id;},
      onCreated:evt(),onUpdated:evt(),onRemoved:evt(),
    },
    tabGroups:{
      get:async id=>{if(!groups.has(id))throw Error('gone'); return groups.get(id);},
      query:async({title})=>[...groups.values()].filter(group=>group.title===title),
      update:async(id,changes)=>Object.assign(groups.get(id),changes),
    },
    debugger:{
      attach:async()=>{},detach:async()=>{},onEvent:evt(),onDetach:evt(),
      getTargets:async()=>rows.map(tab=>({id:'target-'+tab.id,tabId:tab.id,type:'page',title:tab.title,url:tab.url})),
      sendCommand:async(target,method,params)=>{
        if (method==='Emulation.setFocusEmulationEnabled') focusChanges.push(params.enabled);
        return {target,method};
      },
    },
    runtime:{getManifest:()=>({})},
  };
  const {scopedBackend}=await import('../agent-chrome.js');
  const backend=scopedBackend(key,1,false,()=>{});
  const cdp=(method,params,sessionId)=>backend.invoke({method,params,sessionId});
  try {
    const [free]=(await cdp('Aside.listTabs')).items;
    assert.equal(free.targetId,'target-11');
    assert.notEqual(free.tabId,11);
    await assert.rejects(cdp('Target.attachToTarget',{targetId:'target-11'}),/createTabGroup/);
    const tab=await cdp('Aside.createAgentTab',{url:'about:blank'});
    const nativeId=Number(tab.targetId.slice('target-'.length));
    assert.equal(rows.find(row=>row.id===nativeId).groupId,-1);
    await assert.rejects(backend.bind([12]),/탭룸 ID/);
    await backend.bind([tab.tabId,tab.tabId]);
    assert.deepEqual((await cdp('Aside.listTabs')).items.map(row=>row.tabId),[tab.tabId]);
    const {sessionId}=await cdp('Target.attachToTarget',{targetId:tab.targetId});
    assert.equal((await cdp('Runtime.evaluate',{expression:'document.title'},sessionId)).target.tabId,nativeId);
    await cdp('Emulation.setFocusEmulationEnabled',{enabled:true},sessionId);
    await cdp('Emulation.setFocusEmulationEnabled',{enabled:true},sessionId);
    await cdp('Emulation.setFocusEmulationEnabled',{enabled:false},sessionId);
    assert.deepEqual(focusChanges,[true,false]);
    await assert.rejects(cdp('Target.attachToTarget',{targetId:'target-11'}),/Target not found/);
    assert.equal((await cdp('Aside.callExtensionMV3Api',{method:'chrome.tabs.get',args:[tab.tabId]})).id,tab.tabId);
    await assert.rejects(cdp('Aside.callExtensionMV3Api',{method:'chrome.tabs.get',args:[free.tabId]}),/속하지 않아요/);
    groups.delete(88);
    await assert.rejects(cdp('Aside.listTabs'),/다시 열어주세요/);
  } finally {await backend.close();}
});

test('묶음 칩을 기록에 한 번 표시하고 에이전트에는 열린 탭룸 ID를 전달한다',()=>{
  const bundleId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const draft=readTurnDraft({parts:[{bundleId},{text:' 요약해줘'}]});
  const tabs=[{id:10000000001},{id:10000000002}];
  const result=resolveTurnDraft(draft,tabs,new Map([[0,{name:'업무 시작',tabIds:tabs.map(tab=>tab.id)}]]));
  assert.equal(result.input,'[[tab:10000000001]] [[tab:10000000002]] 요약해줘');
  assert.deepEqual(result.parts,[{bundleId,title:'업무 시작'},{text:' 요약해줘'}]);
});

test('탭 칩 사이의 공백은 그룹 열기로 처리하고 문장과 스킬은 메시지로 보낸다',()=>{
  const parts=[{tabId:11},{text:' \n\u00a0 '},{tabGroup:{title:'자주 방문한 사이트',urls:['https://example.org/']}}];
  assert.equal(opensGroupOnly({parts}),true);
  assert.equal(opensGroupOnly({parts:[...parts,{text:' 비교해줘'}]}),false);
  assert.equal(opensGroupOnly({parts:[...parts,{skillName:'daily-review'}]}),false);
  assert.equal(opensGroupOnly({parts:[{text:' \n '}]}),false);
  assert.equal(opensGroupOnly(null),false);
});

test('현재 탭, 저장된 묶음과 사이트 칩은 각각의 위치에서 같은 탭룸 참조로 펼쳐진다',()=>{
  const bundleId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const site={title:'사이트',urls:['https://example.org/']};
  const draft=readTurnDraft({parts:[{bundleId},{text:'과 '},{tabGroup:site},{text:'를 '},{tabId:13},{text:'과 비교해줘'}]});
  const bundles=new Map([[0,{name:'업무',tabIds:[21,22]}],[2,{name:'사이트',tabIds:[23]}]]);
  const result=resolveTurnDraft(draft,[{id:13,title:'현재 탭'}],bundles);
  assert.equal(result.input,'[[tab:21]] [[tab:22]]과 [[tab:23]]를 [[tab:13]]과 비교해줘');
  assert.equal(result.text,'[업무]과 [사이트]를 [현재 탭]과 비교해줘');
});
