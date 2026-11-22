import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSitePicker,mergeSiteResults} from '../site-picker.js';
import {readTurnDraft,resolveTurnDraft} from '../../tabroom-launcher/turn-message.mjs';

test('사이트 결과에서 잘못된 주소와 중복을 빼고 표시 개수를 제한한다',()=>{
  const good={title:'사이트',url:'https://example.com'};
  const invalid={title:'링크',url:'javascript:alert(1)'};
  const match={url:'https://example.com/',title:'원문 제목',image:'/deeplinks/example.jpg',description:'페이지 설명'};
  assert.deepEqual(mergeSiteResults('사이트',[good,good,invalid,null],[match]),[{...match,title:good.title}]);
  const pages=Array.from({length:10},(_,i)=>({...good,url:'https://example.com/'+i}));
  assert.equal(mergeSiteResults('사이트',pages,[]).length,8);
  assert.equal(mergeSiteResults('사이트',pages.slice(0,2),[]).length,2);
});

test('사이트 이름이나 도메인이 딱 맞으면 먼저 보여주고 문장 검색에서는 딥링크를 먼저 보여준다',()=>{
  const address={title:'네이버',url:'https://www.naver.com/'};
  const deep={title:'네이버 쇼핑',url:'https://shopping.naver.com/'};
  for (const query of ['네이버','naver']) {
    assert.equal(mergeSiteResults(query,[address],[deep])[0].url,address.url);
  }
  assert.equal(mergeSiteResults('생활용품을 사고 싶어',[address],[deep])[0].url,deep.url);
});

test('검색어가 있으면 상하 키를 소비하고 빈 검색에서는 위 키로 이전 메뉴에 돌아간다',()=>{
  const element={children:[],replaceChildren(){},querySelector(){return element;},addEventListener(){}};
  let backs=0;
  const picker=createSitePicker(element,async()=>[],()=>{},()=>backs++);
  assert.equal(picker.key('ArrowUp'),true);
  assert.equal(backs,1);
  picker.set('영화 예매');
  assert.equal(picker.key('ArrowUp'),true);
  assert.equal(picker.key('ArrowDown'),true);
  assert.equal(backs,1);
  picker.clear();
});

test('검색 사이트 칩과 저장된 그룹 칩은 순서를 보존하면서 선택한 탭룸 ID로 풀린다',()=>{
  const site={title:'영화',urls:['https://example.com/'],site:true};
  const group={title:'업무',urls:['https://example.org/','https://example.net/']};
  const draft=readTurnDraft({parts:[{tabGroup:site},{text:'랑 '},{tabGroup:group}]});
  assert.equal(draft.parts[0].tabGroup.site,true);
  assert.equal(draft.parts[2].tabGroup.site,undefined);
  const found=new Map([[0,{tabIds:[100]}],[2,{tabIds:[101,102]}]]);
  assert.equal(resolveTurnDraft(draft,[],found).input,'[[tab:100]]랑 [[tab:101]] [[tab:102]]');
  assert.equal(readTurnDraft({parts:[{tabGroup:{...group,site:true}}]}).parts[0].tabGroup.site,undefined);
});
