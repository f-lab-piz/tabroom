import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {profileWorkflows} from '../../tabroom-launcher/workflows.mjs';
import {readTurnDraft,resolveTurnDraft} from '../../tabroom-launcher/turn-message.mjs';

test('작업의 탭그룹 칩은 주소와 순서를 본문 위치에 저장한다',t=>{
  const root=mkdtempSync(join(tmpdir(),'tabroom-workflows-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const workflows=profileWorkflows(root,'profile-one');
  const savedGroup={title:'업무',urls:['https://example.com/b','https://example.com/a']};
  const task=workflows.saveTask({title:'업무 시작',parts:[{text:'먼저 '},{tabGroup:savedGroup},{text:'을 확인해줘'}]});
  savedGroup.urls.reverse();
  const stored=workflows.listTasks(['예전 작업','','']).find(item=>item.id===task.id);
  assert.deepEqual(stored.parts,[{text:'먼저 '},{tabGroup:{title:'업무',urls:['https://example.com/b','https://example.com/a']}},{text:'을 확인해줘'}]);
  assert.equal(workflows.listTasks()[0].title,'예전 작업');
  const draft=readTurnDraft({parts:stored.parts});
  const result=resolveTurnDraft(draft,[],new Map([[1,{name:'업무',tabIds:[201,202]}]]));
  assert.equal(draft.bundleId,undefined);
  assert.equal(result.input,'먼저 [[tab:201]] [[tab:202]]을 확인해줘');
  assert.equal(result.text,'먼저 [업무]을 확인해줘');
  assert.throws(()=>workflows.saveTask({title:'오류',parts:[{tabGroup:{title:'업무',urls:['file:///tmp/x']}}]}));
});

test('새 스킬은 같은 프로필에서 목록과 본문으로 읽히고 메시지에 이름이 들어간다',t=>{
  const root=mkdtempSync(join(tmpdir(),'tabroom-skills-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const workflows=profileWorkflows(root,'profile-one');
  const definition={name:'daily-review',title:'일일 검토',description:'매일 결과를 확인',body:'## 확인\n\n변경사항을 읽는다.'};
  const created=workflows.createSkill(definition);
  assert.deepEqual(workflows.listSkills(),[created]);
  assert.ok(workflows.readSkill(definition.name).document.includes(definition.body));
  assert.throws(()=>workflows.createSkill(definition));
  assert.throws(()=>workflows.createSkill({...definition,name:'../review'}));
  assert.deepEqual(profileWorkflows(root,'profile-two').listSkills(),[]);
  assert.equal(resolveTurnDraft(readTurnDraft({parts:[{skillName:'daily-review'},{text:'오늘 내역을 정리해줘'}]}),[]).input,'$daily-review 오늘 내역을 정리해줘');
});
