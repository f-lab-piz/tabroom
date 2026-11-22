import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chatTitle,groupView,savedTabs,snapshotTabs} from '../../tabroom-launcher/tab-groups.mjs';

test('첫 요청의 문구와 탭 제목에서 읽을 수 있는 채팅 제목을 만든다',()=>{
  assert.equal(chatTitle({parts:[{tabId:1,title:'사이트'},{text:'  가격을  비교해줘\n'}]}),'가격을 비교해줘');
  assert.equal(chatTitle({parts:[{tabId:1,title:'사이트'}]}),'사이트');
  assert.equal(chatTitle({parts:[{text:'🍎'.repeat(43)}]}),'🍎'.repeat(41)+'…');
});

test('예전 URL 목록을 복원 카드에 표시하고 새 저장에는 웹 주소와 순서를 보존한다',()=>{
  const first = {url:'https://example.org/one',title:'하나',favicon:'data:image/png;base64,test'};
  const second = {url:'https://example.com/two',title:'둘'};
  const tabs = snapshotTabs([first,{url:'about:blank'},{url:'https://user:pass@example.com/'},second]);
  assert.deepEqual(tabs.map(tab=>tab.url),[first.url,second.url]);
  assert.equal(tabs[0].favicon,'');
  const session = {title:'업무',group:{urls:[first.url]}};
  assert.equal(groupView(session).canRestore,true);
  assert.deepEqual(groupView(session).savedTabs,savedTabs(session.group));
  assert.deepEqual(groupView(session,{open:true,tabs}).savedTabs,[]);
  assert.equal(groupView({group:{urls:[],savedTabs:[]}}).canRestore,false);
});

test('같은 표시 제목의 그룹을 따로 식별하고 다른 그룹의 탭을 닫지 않는다',async()=>{
  const keyA = '00000000-1111-2222-3333-444444444444';
  const keyB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const tab = (id,groupId,index) => ({id,groupId,index,windowId:1,url:'https://example.com/'+id});
  let rows = [tab(11,2,0),tab(12,2,1),tab(21,3,2),tab(31,-1,3)];
  const groups = new Map([
    [2,{id:2,windowId:1,color:'green',title:'탭룸 · '+keyA.slice(0,12)}],
    [3,{id:3,windowId:1,color:'blue',title:'탭룸 · '+keyB.slice(0,12)}],
  ]);
  const cache = {};
  let nextGroup=4, nextTab=40;
  globalThis.chrome = {
    debugger:{onDetach:{addListener(){}},onEvent:{addListener(){}}},
    storage:{
      local:{get:async key=>({[key]:cache[key]}),set:async values=>Object.assign(cache,values)},
      session:{get:async key=>({[key]:cache[key]}),set:async values=>Object.assign(cache,values)},
    },
    tabGroups:{
      get:async id=>{
        if (!groups.has(id)) throw Error('No group');
        return groups.get(id);
      },
      query:async query=>[...groups.values()].filter(group=>Object.entries(query).every(([key,value])=>group[key]===value)),
      update:async (id,changes)=>Object.assign(groups.get(id),changes),
    },
    tabs:{
      get:async id=>rows.find(tab=>tab.id===id),
      query:async query=>rows.filter(tab=>Object.entries(query).every(([key,value])=>tab[key]===value)),
      create:async ({url})=>{
        const created={...tab(nextTab++,-1,rows.length),url};
        rows.push(created);
        return created;
      },
      group:async ({tabIds})=>{
        const id=nextGroup++;
        groups.set(id,{id,windowId:1,title:''});
        for (const tab of rows) if (tabIds.includes(tab.id)) tab.groupId=id;
        return id;
      },
      remove:async ids=>{
        rows=rows.filter(tab=>!ids.includes(tab.id));
        for (const id of groups.keys()) if (!rows.some(tab=>tab.groupId===id)) groups.delete(id);
      },
    },
  };
  const {operation} = await import('../agent-chrome.js');
  const title = '같은 채팅 제목';
  assert.deepEqual(await operation('group/identity',{groupId:2}),{legacyPrefix:keyA.slice(0,12)});
  const a=await operation('group/read',{key:keyA,title,legacyIds:true});
  const b=await operation('group/read',{key:keyB,title});
  assert.equal(a.tabs[0].legacyId,11);
  assert.notEqual(a.tabs[0].id,11);
  assert.deepEqual(await operation('group/identity',{groupId:2}),{key:keyA});
  assert.deepEqual(await operation('group/identity',{groupId:3}),{key:keyB});
  assert.equal(groups.get(2).title,groups.get(3).title);
  await assert.rejects(operation('group/close',{key:keyA,groupId:3}),/바뀌었어요/);
  await assert.rejects(operation('group/close',{key:keyA,groupId:2,tabId:b.tabs[0].id}),/연결되어 있지/);
  const first = await operation('group/close',{key:keyA,groupId:2,tabId:a.tabs[0].id});
  assert.deepEqual(first.live.tabs.map(tab=>tab.id),[a.tabs[1].id]);
  const all = await operation('group/close',{key:keyA,groupId:2});
  assert.deepEqual(all.before.map(tab=>tab.id),[a.tabs[1].id]);
  assert.equal(all.live.open,false);
  const restored = await operation('group/restore',{key:keyA,title,windowId:1,
    urls:[all.before[0].url,all.before[0].url],refIds:[all.before[0].id]});
  assert.equal(restored.groupId,4);
  assert.equal(groups.get(4).color,'orange');
  assert.equal(restored.tabs[0].id,all.before[0].id);
  assert.notEqual(restored.tabs[1].id,restored.tabs[0].id);
  assert.deepEqual(restored.restoredTabIds,restored.tabs.map(tab=>tab.id));
  await operation('group/close',{key:keyA,groupId:4});
  const [candidate]=await operation('browser/references',{key:keyA,windowId:1});
  const replacement=await operation('group/bind',{key:keyA,title,windowId:1,tabIds:[candidate.id]});
  assert.equal(replacement.groupId,5);
  assert.equal(replacement.tabs[0].id,candidate.id);
  assert.notEqual(replacement.tabs[0].id,restored.tabs[0].id);
  assert.equal((await operation('group/read',{key:keyB,title})).groupId,3);
});

test('채팅 목록은 열린 그룹과 복원할 그룹의 아이콘에 서로 다른 상태를 보낸다',async()=>{
  const live='00000000-1111-4222-8333-444444444444';
  const closed='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const state={'owner:42':live,['group:'+live]:42};
  globalThis.chrome={
    storage:{session:{get:async keys=>Object.fromEntries(keys.map(key=>[key,state[key]]))}},
    tabGroups:{query:async()=>[{id:42,color:'orange',title:'같은 표시 이름'},{id:43,color:'blue',title:'같은 표시 이름'}]},
    tabs:{query:async()=>[
      {id:1,groupId:42,index:2,title:'둘째',url:'https://example.net/b'},
      {id:2,groupId:42,index:1,title:'첫째',url:'https://example.net/a'},
      {id:3,groupId:43,index:0,title:'다른 그룹',url:'https://example.org/'},
      ...Array.from({length:8},(_,i)=>({id:10+i,groupId:42,index:3+i,title:'탭 '+(i+3)})),
    ]},
  };
  const {withSessionGroups}=await import('../agent-chrome.js');
  const saved={status:'saved',count:1,tabs:[{title:'보관',url:'https://example.com/'}]};
  const rows=await withSessionGroups([{id:live,group:saved},{id:closed,group:saved},{id:'ungrouped',group:null}]);
  assert.deepEqual(rows[0].group,{status:'open',color:'orange',count:10,tabs:[
    {title:'첫째',favicon:''},{title:'둘째',favicon:''},{title:'탭 3',favicon:''},
    ...Array.from({length:7},(_,i)=>({title:'탭 '+(i+4)})),
  ]});
  assert.deepEqual(rows[1].group,{status:'saved',count:1,tabs:[{title:'보관',favicon:''}]});
  assert.equal(rows[2].group,null);
});

test('자주 방문하는 사이트는 Chrome 집계 순서를 유지하며 호스트당 하나만 표시한다',async()=>{
  globalThis.chrome={topSites:{get:async()=>[
    {url:'chrome://settings',title:'설정'},
    {url:'https://www.example.com/one',title:'첫 방문 사이트'},
    {url:'https://example.com/two',title:'중복'},
    {url:'https://user:secret@example.io',title:'인증 URL'},
    {url:'http://127.0.0.1:18840/demo/motion.html',title:'탭룸 데모'},
    ...['.net','.org','.edu','.info'].map(suffix=>({url:'https://example'+suffix})),
  ]}};
  const {popularSites}=await import('../agent-chrome.js');
  assert.deepEqual((await popularSites()).map(site=>site.title),['첫 방문 사이트','example.net','example.org','example.edu']);
});
