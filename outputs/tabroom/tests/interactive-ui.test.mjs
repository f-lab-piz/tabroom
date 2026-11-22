import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseWidget,safeLink,splitAssistantContent} from '../interactive-ui/protocol.js';
import {widgetState} from '../interactive-ui/render.js';
import {appendMarkdown} from '../interactive-ui/markdown.js';
import {collectReferences,referenceUrl} from '../interactive-ui/references.js';
import {getSkill} from '../../tabroom-launcher/agent-tools.mjs';

const example = {version:1,state:{quantity:2},nodes:[{type:'text',value:{state:'quantity'}}]};
const block = '```tabroom-ui\n'+JSON.stringify(example)+'\n```';

test('답변 출처는 탭과 URL 조합을 보존하고 코드나 유효하지 않은 링크를 건너뛴다',()=>{
  const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const text=`문장 [[tab:17 https://example.com/a#part]] [[url:https://example.org/b]] [[source:${id}]] [[tab:17]]\n\n`+
    '\`[[url:https://example.com/code]]\`\n\n\`\`\`text\n[[url:https://example.com/fenced]]\n\`\`\`\n[[url:javascript:alert(1)]]';
  assert.deepEqual(collectReferences(text),[
    {key:'tab:17 https://example.com/a#part',tabId:17,url:'https://example.com/a#part'},
    {key:'url:https://example.org/b',url:'https://example.org/b'},
    {key:'source:'+id,sourceId:id},{key:'tab:17',tabId:17},
  ]);
  assert.equal(referenceUrl('https://example.com/a#part:~:text=quote'),'https://example.com/a#part');
  assert.equal(referenceUrl('https://example.com/a#:~:text=quote'),'https://example.com/a');
});

test('일반 답변의 탭 참조는 문장에 칩으로 남기고 코드 예시는 보존한다',()=>{
  const createElement = tag=>({tag,children:[],append(...nodes){ this.children.push(...nodes); }});
  const previous = globalThis.document;
  globalThis.document = {createElement};
  try {
    const container=createElement('div'),ids=[];
    appendMarkdown(container,'이 탭 [[tab:17]]을 확인해주세요.\n\n[[tab:19]]\n\n`[[tab:21]]`\n\n```txt\n[[tab:25]]\n```',null,id=>{
      ids.push(id);
      return createElement('button');
    });
    assert.deepEqual(ids,[17,19]);
    assert.deepEqual(container.children[0].children.map(node=>node.tag ?? node),['이 탭 ','button','을 확인해주세요.']);
    assert.ok(container.children[1].children.some(node=>node.tag==='button'));
    assert.ok(container.children[2].children.some(node=>node.tag==='code' && node.textContent==='[[tab:21]]'));
  } finally { globalThis.document=previous; }
});

test('일반 Markdown과 여러 UI를 순서대로 읽고 코드 예시는 실행하지 않는다',()=>{
  const sections=splitAssistantContent('## 안내\n'+block+'\n다음 항목\n'+block);
  assert.deepEqual(sections.map(section=>section.type),['markdown','widget','markdown','widget']);
  assert.deepEqual(sections[1].value,example);
  assert.deepEqual(splitAssistantContent('````markdown\n'+block+'\n````').map(section=>section.type),['markdown']);
});

test('아직 끝나지 않은 UI와 유효하지 않은 UI는 대체 표시된다',()=>{
  const partial='```tabroom-ui\n{"version":1';
  assert.deepEqual(splitAssistantContent(partial,{streaming:true}),[{type:'pending'}]);
  assert.deepEqual(splitAssistantContent(partial),[{type:'invalid',value:'{"version":1'}]);
  assert.equal(splitAssistantContent(Array(5).fill(block).join('\n')).at(-1).type,'invalid');
});

test('규격에 없는 동작, 위험한 링크, 없는 상태 참조를 거부한다',()=>{
  const invalidNodes=[
    {type:'button',label:'실행',action:{type:'execute',value:'alert(1)'}},
    {type:'button',label:'입력',action:{type:'draft',value:'예시',fields:[{label:'무효',state:'absent'}]}},
    {type:'button',label:'저장',action:{type:'download',value:'예시',filename:'../data.txt'}},
    {type:'link',label:'열기',url:'javascript:alert(1)'},
    {type:'text',value:{state:'absent'}},
    {type:'metric',label:'합계',operation:'sum',values:[1,{state:'absent'}]},
  ];
  for (const node of invalidNodes) assert.throws(()=>parseWidget(JSON.stringify({...example,nodes:[node]})));
  assert.equal(safeLink('https://user:password@example.test'),null);
  assert.equal(safeLink('file:///tmp/example'),null);
  assert.equal(safeLink('https://example.test/data'),'https://example.test/data');
});

test('초기 상태 타입을 지키고 참조하는 요소만 상태 변경을 받는다',()=>{
  const state=widgetState({count:2,group:'',choices:[]});
  const observed=[];
  state.watch('count',()=>observed.push(state.get('count')));
  assert.equal(state.set('group','A'),true);
  assert.equal(state.set('choices',['A','B']),true);
  assert.equal(state.set('count','3'),false);
  assert.equal(state.set('unknown',null),false);
  assert.equal(state.set('count',3),true);
  assert.deepEqual(observed,[2,3]);
});

test('인터랙티브 UI 스킬에 포함된 작성 예시는 같은 파서를 통과한다',()=>{
  const skill=getSkill('tabroom-interactive-ui');
  assert.match(skill,/Component catalog/);
  const widget=splitAssistantContent(skill).find(section=>section.type==='widget');
  assert.equal(widget.value.state.quantity,2);
  assert.deepEqual(widget.value.nodes[0].children.map(node=>node.type),['input','table','input','metric','button']);
});

test('답변 언어로 작성한 상태 이름을 입력과 연결할 수 있다',()=>{
  const widget={version:1,state:{값:3},nodes:[{type:'input',kind:'range',label:'값',state:'값',min:1,max:5}]};
  assert.deepEqual(parseWidget(JSON.stringify(widget)),widget);
  assert.throws(()=>parseWidget(JSON.stringify({...widget,state:{['__proto__']:3}})));
});
