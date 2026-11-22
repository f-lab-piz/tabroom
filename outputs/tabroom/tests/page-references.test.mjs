import assert from 'node:assert/strict';
import {test} from 'node:test';

test('출처는 저장된 주소를 다시 열고 다른 페이지로 이동한 원래 탭과 출처 탭을 따로 유지한다',async()=>{
  const key='00000000-1111-4222-8333-444444444444';
  const other='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const url='https://example.com/article';
  const ref=10_000_000_005;
  const registry={['group:'+key]:7};
  const local={tabroomNextTabRef:ref+2};
  registry['tabroomTabRefs:'+key]={11:{ref,groupId:7},12:{ref:ref+1,groupId:7}};
  const tabs=new Map([11,12].map(id=>[id,{id,url,title:'기사',windowId:1,index:id,groupId:7}]));
  const groups=new Map([[7,{id:7,title:'업무',windowId:1,color:'blue'}]]);
  const frames=new Map([11,12].map(id=>[id,{url,id:'frame-'+id,loaderId:'original-'+id}]));
  const opened=[],focused=[],captures=[];
  let nextTab=20,nextGroup=8;
  const noop={addListener(){}};
  globalThis.chrome={
    storage:{local:{get:async()=>local,set:async value=>Object.assign(local,value)},
      session:{get:async key=>({[key]:registry[key]}),set:async value=>Object.assign(registry,value)}},
    tabGroups:{get:async id=>groups.get(id),query:async spec=>[...groups.values()].filter(row=>
      Object.entries(spec).every(([key,value])=>row[key]===value)),update:async(id,patch)=>Object.assign(groups.get(id),patch)},
    tabs:{
      get:async id=>tabs.get(id),query:async spec=>[...tabs.values()].filter(row=>
        Object.entries(spec).every(([key,value])=>row[key]===value)),
      create:async ({url,windowId})=>{
        const id=nextTab++;
        opened.push(url);
        const tab={id,url,windowId,groupId:-1,index:id};
        tabs.set(id,tab);return tab;
      },
      group:async ({groupId,tabIds,createProperties})=>{
        if (groupId===undefined) {
          groupId=nextGroup++;
          groups.set(groupId,{id:groupId,windowId:createProperties.windowId,title:''});
        }
        for (const id of tabIds) tabs.get(id).groupId=groupId;
        return groupId;
      },
      update:async id=>{focused.push(id);return tabs.get(id);},
    },
    windows:{update:async()=>{}},
    debugger:{onDetach:noop,onEvent:noop,attach:async()=>{},detach:async()=>{},sendCommand:async({tabId},method)=>{
      if (method==='Page.getFrameTree') return {frameTree:{frame:frames.get(tabId)}};
      if (method==='Page.getLayoutMetrics') return {cssVisualViewport:{clientWidth:800,clientHeight:600}};
      if (method==='Page.captureScreenshot') { captures.push(tabId); return {data:'jpeg'}; }
      assert.fail('Unexpected debugger command: '+method);
    }},
  };
  const {operation,setReferenceCapturePolicy}=await import('../agent-chrome.js');
  setReferenceCapturePolicy(()=>true);
  const record=await operation('reference/observe',{key,tabId:ref,url});
  assert.deepEqual(Object.keys(record),['tabId','url','title','document']);
  const legacyRecord={...record,passage:{selector:'p',quote:'검증한 근거 문장',unique:true}};
  assert.equal((await operation('reference/image',{key,record})).frame.data,'jpeg');
  assert.deepEqual(captures,[11]);
  await operation('reference/open',{key,record:legacyRecord,windowId:1,title:'업무'});
  assert.deepEqual(focused,[11]);
  assert.deepEqual(opened,[]);

  frames.get(11).loaderId='reloaded-same-url';
  assert.equal((await operation('reference/image',{key,record})).frame,null);
  await operation('reference/open',{key,record,windowId:1,title:'업무'});
  assert.deepEqual(opened,[]);

  tabs.get(11).url='https://example.com/next';
  const citation=await operation('reference/open',{key,record:legacyRecord,windowId:1,title:'업무'});
  assert.deepEqual(opened,[url]);
  assert.equal(tabs.get(11).url,'https://example.com/next');
  assert.notEqual(citation.referenceTabId,ref);
  assert.deepEqual(focused,[11,11,20]);
  const linked={...record,openedTabId:citation.referenceTabId};
  const reopenedCitation=await operation('reference/open',{key,record:linked,windowId:1,title:'업무'});
  assert.equal(reopenedCitation.referenceTabId,citation.referenceTabId);
  assert.deepEqual(opened,[url]);
  assert.deepEqual(focused,[11,11,20,20]);

  tabs.get(20).pendingUrl='https://example.com/another';
  const newCitation=await operation('reference/open',{key,record:linked,windowId:1,title:'업무'});
  assert.notEqual(newCitation.referenceTabId,citation.referenceTabId);
  assert.notEqual(newCitation.referenceTabId,ref);
  assert.deepEqual(focused,[11,11,20,20,21]);
  tabs.delete(20);
  tabs.delete(21);

  tabs.delete(11);
  const restored=await operation('reference/open',{key,record,windowId:1,title:'업무'});
  assert.equal(restored.referenceTabId,ref);
  assert.equal(tabs.get(22).groupId,7);
  assert.ok(restored.tabs.some(tab=>tab.id===ref && tab.url===url));
  await operation('reference/open',{key,record,windowId:1,title:'업무'});
  assert.deepEqual(opened,[url,url,url]);
  assert.deepEqual(focused,[11,11,20,20,21,22,22]);
  const sourceOnly=await operation('reference/open',{key:other,record:{url},windowId:1,title:'검색 결과'});
  assert.equal(sourceOnly.groupId,8);
  assert.equal(opened.at(-1),url);
  await operation('reference/open',{key:other,record:{url,openedTabId:sourceOnly.referenceTabId},windowId:1,title:'검색 결과'});
  assert.deepEqual(opened,[url,url,url,url]);
  const additions=['https://example.com/first','https://example.org/second'];
  const extended=await operation('group/appendSites',{key,groupId:7,urls:additions});
  assert.equal(extended.groupId,7);
  assert.deepEqual(extended.restoredTabIds.map(id=>extended.tabs.find(tab=>tab.id===id).url),additions);
  assert.deepEqual(opened.slice(-2),additions);
  await assert.rejects(operation('group/appendSites',{key,groupId:8,urls:additions}),/바뀌었어요/);
  groups.delete(7);
  for (const tab of tabs.values()) if (tab.groupId===7) tabs.delete(tab.id);
  const reopened=await operation('reference/open',{key,record,windowId:1,title:'업무'});
  assert.equal(reopened.groupId,9);
  assert.equal(reopened.referenceTabId,ref);
  assert.equal(reopened.tabs[0].id,ref);
});
