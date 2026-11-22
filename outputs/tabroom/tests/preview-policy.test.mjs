import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cpuCounters,cpuPercent,updateAutoPreview,workPreviewDeadline} from '../preview-policy.js';

test('논리 코어의 유휴 시간 차이로 PC 전체 CPU 비율을 계산한다',()=>{
  const counters = cpuCounters({processors:[{usage:{total:100,idle:40}},{usage:{total:90,idle:55}}]});
  assert.deepEqual(counters,{total:190,idle:95});
  assert.equal(cpuPercent(counters,{total:390,idle:245}),25);
  assert.equal(cpuPercent(counters,counters),null);
  assert.equal(cpuCounters({processors:[]}),null);
});

test('60·80%에서 절전하고, 10초 연속 낮은 부하에서 한 단계 복구한다',()=>{
  let state=updateAutoPreview({stage:0},60,0);
  assert.equal(state.stage,1);
  state=updateAutoPreview(state,80,1000);
  assert.equal(state.stage,2);
  state=updateAutoPreview(state,59,2000);
  assert.equal(updateAutoPreview(state,59,11999).stage,2);
  state=updateAutoPreview(state,60,12000);
  assert.equal(state.since,12000);
  state=updateAutoPreview(state,60,22000);
  assert.equal(state.stage,1);
  state=updateAutoPreview(state,59,23000);
  assert.equal(updateAutoPreview(state,59,33000).stage,0);
});

test('작업 탭을 일반 조작 뒤 2초, 로딩 중이면 최대 8초 유지한다',()=>{
  assert.equal(workPreviewDeadline({loading:true}),null);
  assert.equal(workPreviewDeadline({endedAt:123,loading:false}),2123);
  assert.equal(workPreviewDeadline({endedAt:123,loading:true}),8123);
});
