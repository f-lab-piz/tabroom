import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tools,instructions,getSkill,listBuiltinSkills,toolActivity} from '../../tabroom-launcher/agent-tools.mjs';
import {contextUsage,trackText} from '../../tabroom-launcher/context-usage.mjs';
import {getGuide} from '../../tabroom-launcher/aside/bridge/guide.mjs';

test('브라우저 도구는 호출 목적을 받고 스킬 로더는 이름만 받는다',()=>{
  for (const {name,inputSchema} of tools) {
    if (name==='load_skill') {
      assert.deepEqual(Object.keys(inputSchema.properties),['name']);
      assert.deepEqual(inputSchema.required,['name']);
      assert.equal(inputSchema.additionalProperties,false);
      continue;
    }
    if (name==='list_skills') {
      assert.deepEqual(inputSchema.properties,{});
      assert.deepEqual(inputSchema.required,[]);
      continue;
    }
    assert.ok(inputSchema.required.includes('purpose'),name);
    assert.equal(toolActivity(name,{}),null);
    assert.equal(toolActivity(name,{purpose:'  \n  '}),null);
  }
  assert.deepEqual(toolActivity('browser_repl',{purpose:' 검색어를\n 입력하기 '}),{kind:'browser',text:'검색어를 입력하기'});
  assert.equal(toolActivity('browser_guide',{api:'snapshot',purpose:'화면 읽기 도움말'}).kind,'guide');
  assert.equal(toolActivity('unsupported',{purpose:'작업하기'}),null);
  assert.equal(toolActivity('browser_repl',{purpose:'a'.repeat(141)}),null);
});

test('메인 MD는 스킬 로드 조건을 안내하고 이름으로 활동 문구를 만든다',()=>{
  assert.deepEqual(tools.map(tool=>tool.name),
    ['browser_profiles','browser_repl','browser_guide','listTabBundles','saveTabBundle','loadTabBundle','load_skill','list_skills','create_skill','save_quick_task']);
  assert.deepEqual(toolActivity('load_skill',{name:'tabroom-browser'}),{kind:'skill',text:'브라우저 스킬 로드하기'});
  assert.deepEqual(toolActivity('load_skill',{name:'tabroom-interactive-ui'}),{kind:'skill',text:'인터랙티브 UI 스킬 로드하기'});
  assert.equal(toolActivity('load_skill',{name:'unknown'}),null);
  assert.equal(toolActivity('load_skill',{name:'review'},{title:'검토'}).text,'검토 스킬 로드하기');
  assert.deepEqual(listBuiltinSkills().filter(skill=>skill.automatic).map(skill=>skill.name),['tabroom-browser','tabroom-interactive-ui']);
  assert.match(instructions,/load_skill\(\{name:"tabroom-browser"\}\)/);
  assert.match(instructions,/load_skill\(\{name:"tabroom-interactive-ui"\}\)/);
  assert.match(getSkill('tabroom-browser'),/createTabGroup/);
  assert.match(getSkill('tabroom-browser'),/Use plain text for routine progress and completion summaries/);
  assert.equal(getSkill('tabroom-ui'),undefined);
  assert.equal(getGuide({topic:'api'}).structuredContent.apis.length,215);
  for (const api of ['skill.tabroom-browser','skill.tabroom-interactive-ui','tabroom-ui']) {
    assert.equal(getGuide({api}).isError,true);
  }
});

test('컨텍스트 수치는 마지막 요청의 실측값을 쓰고 텍스트 추정값을 별도로 표시한다',()=>{
  const session={contextText:{instructions:0,conversation:0,browser:0,guides:0}};
  trackText(session,'guides','테스트');
  const usage={modelContextWindow:128000,total:{totalTokens:345000},
    last:{totalTokens:6730,inputTokens:6680,cachedInputTokens:400,outputTokens:50,reasoningOutputTokens:20}};
  assert.deepEqual(contextUsage(usage,session.contextText),{
    used:6730,window:128000,input:6680,cached:400,output:50,reasoning:20,
    estimate:{instructions:0,conversation:0,browser:0,guides:3},
  });
  assert.equal(contextUsage({...usage,modelContextWindow:null}).window,null);
  assert.equal(contextUsage(usage).estimate,null);
  assert.equal(contextUsage({total:usage.total}),null);
});
