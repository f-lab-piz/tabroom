import {createServer} from 'node:net';
import {createInterface} from 'node:readline';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,mkdirSync,chmodSync,lstatSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppServer} from './app-server.mjs';
import {getGuide} from './aside/bridge/guide.mjs';
import {readTurnDraft,resolveTurnDraft} from './turn-message.mjs';
import {tools,instructions,getSkill,listBuiltinSkills,toolActivity} from './agent-tools.mjs';
import {contextUsage,trackText} from './context-usage.mjs';
import {chatTitle,groupView,savedTabs,snapshotTabs} from './tab-groups.mjs';
import {generateSessionTitle} from './session-title.mjs';
import {profileWorkflows} from './workflows.mjs';
import {collectReferences,referenceUrl} from '../tabroom/interactive-ui/references.js';

const dataDir=process.env.TABROOM_AGENT_DATA || join(homedir(),'Library/Application Support/Tabroom/agent');
const socketPath=process.env.TABROOM_AGENT_SOCKET || join(dirname(dataDir),'agent.sock');
const storePath=join(dataDir,'sessions.json');
const templatePath=join(dataDir,'tab-bundles.json');
const browserAccountsPath=join(dataDir,'browser-accounts.json');
const previewDir=join(dataDir,'bundle-previews');
const referenceImageDir=join(dataDir,'reference-images');
const workDir=join(dataDir,'workspace');
const model=process.env.TABROOM_MODEL || 'gpt-6-luna';
const toolSetVersion=2;
const mediaPath=fileURLToPath(new URL('./aside/bin/',import.meta.url));
const workerEnv={...process.env,PATH:(process.platform==='darwin' && process.arch==='arm64'
  ? mediaPath+delimiter : '')+(process.env.PATH || '')};
mkdirSync(workDir,{recursive:true,mode:0o700});
chmodSync(dataDir,0o700);

let sessions;
try { sessions=JSON.parse(readFileSync(storePath,'utf8')); }
catch (error) { if (error.code!=='ENOENT') throw error; sessions=[]; }
if (!Array.isArray(sessions)) throw Error('탭룸 세션 파일 형식이 올바르지 않아요.');
let templates;
try { templates=JSON.parse(readFileSync(templatePath,'utf8')); }
catch (error) { if (error.code!=='ENOENT') throw error; templates=[]; }
if (!Array.isArray(templates)) throw Error('탭 묶음 파일 형식이 올바르지 않아요.');
let browserAccounts;
try { browserAccounts=JSON.parse(readFileSync(browserAccountsPath,'utf8')); }
catch (error) { if (error.code!=='ENOENT') throw error; browserAccounts={}; }
const profiles=new Map(), runs=new Map(), loadedThreads=new Set();
const openedDrafts=new WeakMap();
let groupQueue=Promise.resolve();

function save(path=storePath,rows=sessions) {
  const temporary=path+'.tmp';
  writeFileSync(temporary,JSON.stringify(rows),{mode:0o600});
  renameSync(temporary,path);
}

function addMessage(session,role,text,fields={}) {
  session.messages.push({id:randomUUID(),role,text,at:Date.now(),...fields});
  session.updatedAt=Date.now();
  save();
}

// The transcript is also stored by Codex. This index keeps Tabroom history available offline.
let removedPassages=false;
for (const session of sessions) {
  for (const message of session.messages ?? []) {
    for (const reference of message.references ?? []) {
      if (!Object.hasOwn(reference,'passage')) continue;
      delete reference.passage;
      removedPassages=true;
    }
  }
}
if (removedPassages) save();

for (const session of sessions) {
  if (session.running) {
    session.running=false;
    addMessage(session,'status','이전 작업이 실행기 종료로 중단됐어요.');
  }
}

function send(socket,message) {
  if (socket.destroyed) return;
  const line=JSON.stringify(message)+'\n';
  if (Buffer.byteLength(line)>1024*1024) throw Error('브라우저 요청 크기를 초과했어요.');
  socket.write(line);
}

function callBrowser(peer,method,params,timeout=12000) {
  if (peer.socket.destroyed) return Promise.reject(Error('Chrome 연결이 끊겼어요.'));
  const id=randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      peer.pending.delete(id);
      reject(Error('Chrome 응답 시간이 초과됐어요.'));
    },timeout);
    peer.pending.set(id,{
      resolve:value=>{clearTimeout(timer);resolve(value);},
      reject:error=>{clearTimeout(timer);reject(error);},
    });
    try { send(peer.socket,{type:'call',id,method,params}); }
    catch (error) {
      peer.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

function output(text,success=true) {
  return {success,contentItems:[{type:'inputText',text}]};
}

class BrowserRun {
  constructor(run,peer) {
    this.run=run;
    this.peer=peer;
    this.serial=0;
    this.pending=new Map();
    this.tail=Promise.resolve();
  }

  start() {
    if (this.ready) return this.ready;
    this.opening=callBrowser(this.peer,'browser/open',{
      key:this.run.session.id,runId:this.run.id,windowId:this.run.windowId,bound:this.run.bound,
    });
    this.ready=this.opening.then(()=>{
      if (this.closed || this.run.stopping) throw Error('작업이 중지됐어요.');
      return this.startWorker();
    });
    return this.ready;
  }

  startWorker() {
    const worker=new Worker(new URL('./aside-worker.mjs',import.meta.url),{
      workerData:{profileId:this.peer.profile,sessionId:this.run.id,storageDir:join(dataDir,'artifacts',this.run.session.id,this.run.id)},
      stdout:true,stderr:true,env:workerEnv,
    });
    this.worker=worker;
    worker.stdout.resume();
    worker.stderr.resume();
    return new Promise((resolve,reject)=>{
      worker.on('message',message=>{
        if (message.type==='ready') resolve();
        else if (message.type==='initError') reject(Error(message.error));
        else if (message.type==='transport') void this.transport(message,worker);
        else if (message.type==='executed') {
          const task=this.pending.get(message.id);
          if (!task) return;
          this.pending.delete(message.id);
          clearTimeout(task.timer);
          task.resolve(message);
        }
      });
      const failed=error=>{
        reject(error);
        for (const call of this.pending.values()) {clearTimeout(call.timer);call.reject(error);}
        this.pending.clear();
      };
      worker.on('error',failed);
      worker.once('exit',()=>failed(Error('브라우저 REPL이 종료됐어요.')));
    });
  }

  async transport(message,worker) {
    const reply={type:'transportResult',id:message.id};
    try {
      if (this.closed || this.run.stopping || this.run.finished) throw Error('이 작업의 브라우저 요청이 아니에요.');
      if (message.operation==='group') {
        reply.result=await serializedGroup(async()=>{
          if (this.closed || this.run.stopping || this.run.finished) throw Error('작업이 중지됐어요.');
          const group=await callBrowser(this.peer,'browser/group',{runId:this.run.id,tabIds:message.params.tabIds,title:this.run.session.title});
          remember(this.peer,this.run.session,group.tabs,true);
          this.run.bound=group.open;
          return {open:group.open,title:group.title,tabs:group.tabs.map(({id,title,url})=>({id,tabId:id,title,url}))};
        });
      } else if (message.operation==='bundle') {
        reply.result=await agentBundle(this.run,message.params.action,message.params);
      } else if (message.operation==='reference') {
        if (!this.run.bound || !Number.isSafeInteger(message.params?.tabId)) throw Error('현재 그룹의 탭을 지정해주세요.');
        if (this.run.sources.size>=32) throw Error('한 요청에서 저장할 수 있는 출처 수를 넘었어요.');
        const {tabId,url}=message.params;
        const pick=await callBrowser(this.peer,'reference/observe',{key:this.run.session.id,tabId,url},5000);
        if (!pick?.url) throw Error('이 탭에서 해당 페이지를 확인하지 못했어요.');
        const id=randomUUID();
        this.run.sources.set(id,pick);
        reply.result={id,marker:`[[source:${id}]]`,tabId:pick.tabId,url:pick.url,title:pick.title};
      } else {
        if (message.operation!=='native' || message.params.method!=='cdp' ||
            message.params.browserId!==this.peer.profile) throw Error('이 작업의 브라우저 요청이 아니에요.');
        reply.result=await callBrowser(this.peer,'browser/cdp',{runId:this.run.id,command:message.params.args[0]},30000);
      }
    } catch (error) { reply.error=String(error.message); }
    if (worker===this.worker) worker.postMessage(reply);
  }

  execute(code) {
    const task=this.tail.then(async()=>{
      if (this.run.stopping) throw Error('작업이 중지됐어요.');
      await this.start();
      const id=++this.serial;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{
          this.pending.delete(id);
          reject(Error('브라우저 동작 시간이 초과됐어요. 재시도 전에 대상 화면을 확인하세요.'));
          void this.close();
        },122000);
        this.pending.set(id,{resolve,reject,timer});
        this.worker.postMessage({type:'execute',id,code});
      });
    });
    this.tail=task.catch(()=>{});
    return task;
  }

  event(event,data) { this.worker?.postMessage({type:'event',event,data}); }

  async close() {
    this.closed=true;
    const worker=this.worker;
    this.worker=undefined;
    await worker?.terminate();
    await this.opening?.catch(()=>{});
    await callBrowser(this.peer,'browser/close',{runId:this.run.id}).catch(()=>{});
  }
}

const app=new AppServer({cwd:workDir,onEvent:handleEvent,onTool:handleTool,onExit:handleExit});
const workflowsFor=peer=>profileWorkflows(dataDir,peer.accountProfile);
const skillsFor=peer=>[...listBuiltinSkills(),...workflowsFor(peer).listSkills()];

function skillInstructions(peer) {
  const skills=workflowsFor(peer).listSkills().slice(0,24);
  return skills.length ? instructions+'\n\nRegistered user skill metadata:\n'+JSON.stringify(skills) : instructions;
}

async function handleTool({threadId,turnId,tool,arguments:args={}}) {
  const run=[...runs.values()].find(item=>item.threadId===threadId);
  if (!run || run.finished || run.stopping || run.turnId && run.turnId!==turnId) return output('이 브라우저 세션에 연결된 작업이 없어요.',false);
  const custom = tool==='load_skill' && !getSkill(args?.name) ? workflowsFor(run.peer).readSkill(args?.name) : null;
  const activity = toolActivity(tool,args,custom);
  if (!activity) return output(tool==='load_skill'
    ? 'list_skills에서 확인한 스킬 이름을 지정해주세요.'
    : '지원하는 브라우저 도구와 사용자에게 보여줄 구체적인 purpose를 지정해주세요.',false);
  const source = activity.kind === 'browser' ? 'browser' : 'guides';
  trackText(run.session,source,JSON.stringify(args));
  addMessage(run.session,'tool',activity.text,{toolKind:activity.kind});
  const result = await executeTool(run,tool,args ?? {},custom);
  for (const item of result.contentItems) if (item.type==='inputText') trackText(run.session,source,item.text);
  return result;
}

async function executeTool(run,tool,args,custom) {
  const bundleAction={listTabBundles:'list',saveTabBundle:'save',loadTabBundle:'load'}[tool];
  if (bundleAction) return output(JSON.stringify(await agentBundle(run,bundleAction,args)));
  if (tool==='browser_profiles') return output(JSON.stringify({profiles:[{profileId:run.peer.profile,label:'현재 탭룸 Chrome',connected:true}]}));
  if (tool==='load_skill') {
    const skill=getSkill(args.name) ?? custom?.document;
    return output(args.name==='tabroom-browser'
      ? skill+'\n\nTab group currently open in this chat: '+(run.bound?'yes':'no')+'.'
      : skill);
  }
  if (tool==='list_skills') return output(JSON.stringify(skillsFor(run.peer)));
  if (tool==='create_skill') {
    if (getSkill(args.name)) throw Error('기본 스킬의 이름은 사용할 수 없어요.');
    return output(JSON.stringify(workflowsFor(run.peer).createSkill(args)));
  }
  if (tool==='save_quick_task') {
    return output(JSON.stringify(await serializedGroup(()=>saveQuickTask(run.peer,args))));
  }
  if (tool==='browser_guide') {
    const result=getGuide(args);
    return output(result.content[0].text,!result.isError);
  }
  if (tool!=='browser_repl' || typeof args.code!=='string' || args.code.length>24000) {
    return output('지원되는 브라우저 코드를 지정해주세요.',false);
  }
  if (args.profile_id && args.profile_id!==run.peer.profile) {
    return output('이 채팅의 Chrome 프로필은 자동으로 연결돼 있어요. profile_id를 생략하고 browser_repl을 다시 호출해주세요.',false);
  }
  run.browser ||= new BrowserRun(run,run.peer);
  const result=await run.browser.execute(args.code);
  const items=[];
  if (result.error) items.push({type:'inputText',text:String(result.error).slice(0,12000)});
  for (const item of result.content || []) {
    if (item.type==='text') items.push({type:'inputText',text:String(item.text).slice(0,40000)});
    else if (item.type==='image' && /^image\/(png|jpeg|webp)$/.test(item.mimeType) && typeof item.data==='string' && item.data.length<5000000) {
      items.push({type:'inputImage',imageUrl:'data:'+item.mimeType+';base64,'+item.data});
    }
  }
  return {success:!result.error,contentItems:items.length?items:[{type:'inputText',text:'브라우저 호출이 완료됐어요.'}]};
}

function documentKey(document) {
  return document && JSON.stringify([document.nativeId,document.frameId,document.loaderId,document.url]);
}

async function saveReplyReferences(run,text) {
  const markers=collectReferences(text).filter(ref=>ref.url || ref.sourceId);
  if (!markers.length) return [];
  const {session,peer}=run;
  const previous=session.messages.flatMap(message=>message.references ?? []);
  const shots=new Map();
  async function imageFor(record) {
    const key=documentKey(record.document);
    if (!key || !peer) return;
    if (!shots.has(key) && shots.size<8) shots.set(key,(async()=>{
      const result=await callBrowser(peer,'reference/image',{key:session.id,record},2500).catch(()=>null);
      if (!result?.enabled) return;
      const frame=result.frame;
      if (!frame) return previous.find(ref=>ref.image && documentKey(ref.document)===key)?.image;
      if (frame.format!=='jpeg' || typeof frame.data!=='string' || frame.data.length>110000) return;
      const id=randomUUID();
      mkdirSync(referenceImageDir,{recursive:true,mode:0o700});
      save(join(referenceImageDir,id+'.json'),frame);
      return id;
    })().catch(()=>undefined));
    return shots.get(key);
  }
  const records=await Promise.all(markers.map(async (marker,index)=>{
    const {key,url,tabId,sourceId}=marker;
    const prior=sourceId && previous.find(ref=>ref.key===key);
    const matching=url && tabId!==undefined ? [...run.sources.values()].filter(ref=>ref.tabId===tabId && ref.url===url) : [];
    const documents=new Set(matching.map(ref=>documentKey(ref.document)));
    let observed=sourceId ? run.sources.get(sourceId) ?? prior
      : documents.size===1 ? matching[0] : null;
    if (!observed && !documents.size && peer && url && tabId!==undefined && index<8) {
      observed=await callBrowser(peer,'reference/observe',{key:session.id,tabId,url},2000).catch(()=>null);
    }
    const destination=referenceUrl(observed?.url ?? url);
    if (!destination) return null;
    const record={key,url:destination,tabId:observed?.tabId ?? tabId,title:String(observed?.title || new URL(destination).hostname).slice(0,240),
      document:observed?.document};
    const image=await imageFor(record);
    if (image) record.image=image;
    return record;
  }));
  return records.filter(Boolean);
}

function handleEvent(method,params) {
  const run=[...runs.values()].find(item=>item.threadId===params?.threadId);
  if (!run) return;
  if (method==='turn/started') {
    run.turnId=params.turn.id;
    if (run.stopping) void interrupt(run);
  } else if (method==='thread/tokenUsage/updated') {
    if (run.turnId && params.turnId!==run.turnId) return;
    const usage = contextUsage(params.tokenUsage,run.session.contextText);
    if (usage) run.session.contextUsage=usage;
  } else if (method==='thread/compacted' || method==='item/completed' && params.item.type==='contextCompaction') {
    delete run.session.contextText;
    if (run.session.contextUsage) run.session.contextUsage.estimate=null;
  } else if (method==='item/agentMessage/delta') {
    run.drafts.set(params.itemId,(run.drafts.get(params.itemId)||'')+params.delta);
  } else if (method==='item/completed' && params.item.type==='agentMessage') {
    const {id,text}=params.item;
    run.replyQueue=(run.replyQueue ?? Promise.resolve()).then(async()=>{
      const references=text ? await saveReplyReferences(run,text).catch(()=>[]) : [];
      run.drafts.delete(id);
      if (text) {
        trackText(run.session,'conversation',text);
        addMessage(run.session,'assistant',text,references.length ? {references} : {});
      }
    }).catch(error=>console.warn('Tabroom response save:',error.code || 'failed'));
  } else if (method==='turn/completed') {
    const {status,error}=params.turn;
    if (status==='failed') addMessage(run.session,'status',error?.message || 'Codex 작업에 실패했어요.');
    if (status==='interrupted') addMessage(run.session,'status','작업을 중지했어요.');
    void finish(run);
  }
}

function handleExit(error) {
  loadedThreads.clear();
  for (const run of runs.values()) {
    addMessage(run.session,'status',String(error.message));
    void finish(run);
  }
}

async function authorizedAccount() {
  const account=await app.account();
  if (!account.signedIn) throw Error('현재 Codex에 로그인된 ChatGPT 계정을 확인할 수 없어요.');
  return account;
}

function owns(peer,profile) {
  return (browserAccounts[profile] ?? profile)===peer.accountProfile;
}

function sessionFor(peer,id) {
  const session=sessions.find(item=>item.id===id);
  if (!session || !owns(peer,session.profile)) throw Error('이 계정에 저장된 채팅을 찾을 수 없어요.');
  return session;
}

function publicSession(session) {
  const run=runs.get(session.id);
  return {id:session.id,title:session.title,updatedAt:session.updatedAt,group:session.group ? {title:session.title} : null,
    messages:session.messages.map(message=>message.references ? {...message,references:message.references.map(
      ({key,url,tabId,title,image})=>({key,url,tabId,title,hasImage:Boolean(image)}))} : message),
    running:!!run,progress:run?.progress,contextUsage:session.contextUsage ?? null,
    draft:run ? [...run.drafts.values()].join('\n') : ''};
}

async function refreshGroup(peer,session,commit=false) {
  if (!session.group) return groupView(session);
  const previous=savedTabs(session.group);
  const legacyIds=previous.length>0 && previous.every(tab=>tab.refId===undefined);
  const group=await callBrowser(peer,'group/read',{key:session.id,title:session.title,legacyIds});
  if (group.open && (commit || (session.group.device ?? session.profile)===peer.profile)) {
    remember(peer,session,group.tabs);
  }
  return groupView(session,group);
}

function remember(peer,session,tabs,replace=false,persist=true) {
  const previous=savedTabs(session.group);
  const legacyByRef=new Map(previous.filter(tab=>tab.legacyId!==undefined).map(tab=>[tab.refId,tab.legacyId]));
  const snapshot=tabs.flatMap(tab=>{
    const [saved]=snapshotTabs([{...tab,refId:tab.id}]);
    if (!saved) return [];
    const legacyId=legacyByRef.get(saved.refId) ?? tab.legacyId;
    return [legacyId===undefined ? saved : {...saved,legacyId}];
  }).slice(0,100);
  const saved=snapshot.length || replace ? snapshot : savedTabs(session.group);
  const next={title:session.title,urls:saved.map(tab=>tab.url),savedTabs:saved,device:peer.profile};
  if (JSON.stringify(session.group)!==JSON.stringify(next)) {
    session.group=next;
    if (persist) save();
  }
}

function serializedGroup(action) {
  const task=groupQueue.then(action);
  groupQueue=task.catch(()=>{});
  return task;
}

async function updateFirstTitle(session,parts) {
  const title=await generateSessionTitle(parts,dataDir);
  if (!title || title===session.title) return;
  await serializedGroup(async()=>{
    const previous={title:session.title,group:session.group};
    session.title=title;
    if (session.group) session.group={...session.group,title};
    try { save(); }
    catch (error) { Object.assign(session,previous); throw error; }

    await Promise.all([...profiles.values()].filter(peer=>owns(peer,session.profile)).map(async peer=>{
      send(peer.socket,{type:'sessionTitleChanged',sessionId:session.id,title});
      if (session.group) await callBrowser(peer,'group/read',{key:session.id,title},4000).catch(()=>{});
    }));
  });
}

async function finish(run) {
  if (run.finished) return;
  run.finished=true;
  await run.replyQueue;
  await run.browser?.close().catch(()=>{});
  run.session.running=false;
  runs.delete(run.session.id);
  save();
  await serializedGroup(()=>refreshGroup(run.peer,run.session,true)).catch(()=>{});
}

async function interrupt(run) {
  run.stopping=true;
  run.progress='중지 중';
  if (run.turnId && run.threadId) {
    try { await app.request('turn/interrupt',{threadId:run.threadId,turnId:run.turnId}); }
    catch (error) {
      addMessage(run.session,'status',String(error.message));
      await finish(run);
    }
  }
}

async function launchTurn(run,turnDraft) {
  try {
    await authorizedAccount();
    if (run.stopping) return await stoppedBeforeStart(run);
    if (!run.session.threadId || run.session.toolSetVersion!==toolSetVersion) {
      const developerInstructions=skillInstructions(run.peer);
      const oldThreadId=run.session.threadId;
      const history=oldThreadId ? run.session.messages
        .slice(0,run.messageIndex)
        .filter(message=>['user','assistant'].includes(message.role) && message.text)
        .map(({role,text})=>({
          type:'message',role,content:[{type:role==='user' ? 'input_text' : 'output_text',text}],
        })) : [];
      const {thread}=await app.request('thread/start',{
        cwd:workDir,model,sandbox:'read-only',approvalPolicy:'never',developerInstructions,
        config:app.threadConfig,environments:[],dynamicTools:tools,
      });
      if (history.length) await app.request('thread/inject_items',{threadId:thread.id,items:history});
      if (run.stopping) return await stoppedBeforeStart(run);
      if (oldThreadId) run.session.previousThreadId=oldThreadId;
      run.session.threadId=thread.id;
      run.session.toolSetVersion=toolSetVersion;
      run.session.contextText={instructions:Buffer.byteLength(developerInstructions)+Buffer.byteLength(JSON.stringify(tools)),
        conversation:history.reduce((size,item)=>size+Buffer.byteLength(item.content[0].text),0),browser:0,guides:0};
      loadedThreads.add(thread.id);
      save();
    } else if (!loadedThreads.has(run.session.threadId)) {
      await app.request('thread/resume',{
        threadId:run.session.threadId,excludeTurns:true,cwd:workDir,model,sandbox:'read-only',
        approvalPolicy:'never',developerInstructions:skillInstructions(run.peer),config:app.threadConfig,
      });
      loadedThreads.add(run.session.threadId);
    }
    run.threadId=run.session.threadId;
    if (run.stopping) return await stoppedBeforeStart(run);
    run.progress='Codex 응답 중';
    trackText(run.session,'conversation',turnDraft.input);
    const {turn}=await app.request('turn/start',{
      threadId:run.threadId,model,environments:[],
      input:[{type:'text',text:turnDraft.input,text_elements:[]}],
    });
    run.turnId=turn.id;
    if (run.stopping) await interrupt(run);
  } catch (error) {
    if (run.finished) return;
    addMessage(run.session,'status',run.stopping?'작업을 중지했어요.':String(error.message));
    await finish(run);
  }
}

async function stoppedBeforeStart(run) {
  if (run.finished) return;
  addMessage(run.session,'status','작업을 중지했어요.');
  await finish(run);
}

function newSession(peer,title='새 채팅',id=randomUUID()) {
  return {id,title,profile:peer.accountProfile,updatedAt:Date.now(),messages:[],threadId:null,group:null,running:false};
}

function addSession(session) {
  sessions.push(session);
  try { save(); }
  catch (error) { sessions.pop(); throw error; }
  return publicSession(session);
}

async function currentGroup(peer,session,groupId) {
  if (!session.group || !Number.isInteger(groupId)) throw Error('연결된 탭 그룹을 다시 확인해주세요.');
  const live=await callBrowser(peer,'group/read',{key:session.id,title:session.title,expectedGroupId:groupId});
  if (!live.open || live.groupId!==groupId) throw Error('연결된 탭 그룹이 바뀌었어요.');
  return live;
}

function bundlesFor(peer) {
  return templates.filter(item=>owns(peer,item.profile)).reverse();
}

function findBundle(peer,bundleId) {
  const bundle=templates.find(item=>item.id===bundleId && owns(peer,item.profile));
  if (!bundle) throw Error('이 계정에 저장된 탭그룹을 찾을 수 없어요.');
  return bundle;
}

function bundleName(nameValue) {
  const name=typeof nameValue==='string' ? nameValue.replace(/\s+/g,' ').trim() : '';
  if (!name || [...name].length>42) throw Error('탭그룹 이름을 42자 이내로 입력해주세요.');
  return name;
}

async function saveBundle(peer,session,live,nameValue) {
  const name=bundleName(nameValue);
  const tabs=[];
  const sourceIds=[];
  for (const tab of live.tabs) {
    const [saved]=snapshotTabs([tab]);
    if (saved && tabs.length<100) {
      const {refId,...details}=saved;
      tabs.push(details);
      sourceIds.push(tab.id);
    }
  }
  if (!tabs.length) throw Error('저장할 웹 탭이 없어요.');
  const frames=await callBrowser(peer,'group/bundleFrames',{key:session.id,groupId:live.groupId},10000).catch(()=>[]);
  const byId=new Map((Array.isArray(frames) ? frames : []).filter(frame=>
    ['png','jpeg'].includes(frame?.format) && typeof frame.data==='string' && frame.data.length<=80000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)).map(frame=>[frame.id,{format:frame.format,data:frame.data}]));
  return persistBundle(peer,name,tabs,sourceIds.map(id=>byId.get(id) ?? null));
}

function persistBundle(peer,name,tabs,frames=[]) {
  const id=randomUUID();
  const previewFile=join(previewDir,id+'.json');
  const hasPreviews=frames.some(Boolean);
  if (hasPreviews) {
    mkdirSync(previewDir,{recursive:true,mode:0o700});
    save(previewFile,frames);
  }
  const bundle={id,profile:peer.accountProfile,name,tabs,hasPreviews};
  const updated=[...templates,bundle];
  try { save(templatePath,updated); }
  catch (error) {
    if (hasPreviews) try { unlinkSync(previewFile); } catch {}
    throw error;
  }
  templates=updated;
  return {id,name,count:tabs.length};
}

function saveQuickTask(peer,args) {
  const parts=Array.isArray(args.parts) ? args.parts.map(part=>{
    if (!part?.bundleId) return part;
    const bundle=findBundle(peer,part.bundleId);
    return {tabGroup:{title:bundle.name,urls:bundle.tabs.map(tab=>tab.url)}};
  }) : args.parts;
  return workflowsFor(peer).saveTask({...args,parts});
}

async function openBundle(peer,session,bundle,windowId,title,tabIds=[]) {
  const before=session.group ? await callBrowser(peer,'group/read',{key:session.id}) : null;
  if (before?.open) throw Error('이 채팅에 이미 열린 탭그룹이 있어요.');
  if (tabIds.length+bundle.tabs.length>100) throw Error('한 그룹에 최대 100개 탭을 열 수 있어요.');
  const live=await callBrowser(peer,'group/restore',{key:session.id,title,windowId,tabIds,
    urls:bundle.tabs.map(tab=>tab.url)},22000);
  if (!live.open || !Array.isArray(live.restoredTabIds)) throw Error('저장된 탭그룹을 열 수 없었어요.');
  return live;
}

function agentBundle(run,action,args) {
  return serializedGroup(async()=>{
    if (run.stopping || run.finished) throw Error('이미 종료된 작업이에요.');
    const {peer,session,windowId}=run;
    if (action==='list') return bundlesFor(peer).map(({id,name,tabs})=>({id,name,count:tabs.length}));
    if (action==='save') {
      const live=await callBrowser(peer,'group/read',{key:session.id,title:session.title});
      if (!live.open) throw Error('저장할 열린 탭그룹이 없어요.');
      return saveBundle(peer,session,live,args.name);
    }
    if (action!=='load') throw Error('지원하지 않는 탭그룹 요청이에요.');
    const bundle=findBundle(peer,args.bundleId);
    const live=await openBundle(peer,session,bundle,windowId,session.title);
    remember(peer,session,live.tabs,true);
    run.bound=true;
    if (run.browser?.opening) {
      await run.browser.opening;
      await callBrowser(peer,'browser/bound',{runId:run.id});
    }
    return {name:bundle.name,tabs:live.tabs.map(({id,title,url})=>({tabId:id,title,url}))};
  });
}

async function api(peer,{method,params,windowId}) {
  if (!peer.profile || !Number.isInteger(windowId)) throw Error('잘못된 Chrome 연결입니다.');
  if (method==='account') return app.account();
  if (method==='list') return sessions.filter(session=>owns(peer,session.profile) &&
      (session.messages.length || session.group))
    .map(({id,title,updatedAt,group})=>{
      const tabs=savedTabs(group);
      return {id,title,updatedAt,bound:!!group,group:group ? {
        status:'saved',count:tabs.length,tabs:tabs.slice(0,8).map((tab,index)=>({
          title:String(tab.title || '').slice(0,90),...(index<3 && {url:tab.url}),
        })),
      } : null};
    }).sort((a,b)=>b.updatedAt-a.updatedAt);
  if (method==='new') return addSession(newSession(peer));
  if (method==='skills/list') return skillsFor(peer);
  if (method==='quickTasks/list') return workflowsFor(peer).listTasks(params.legacy);
  if (method==='quickTasks/save') return serializedGroup(()=>saveQuickTask(peer,params));
  if (method==='bundle/list') return bundlesFor(peer).map(({id,name,tabs,hasPreviews})=>({id,name,tabs,hasPreviews}));
  if (method==='bundle/delete') return serializedGroup(()=>{
    const bundle=findBundle(peer,params.bundleId);
    const updated=templates.filter(item=>item!==bundle);
    save(templatePath,updated);
    templates=updated;
    if (bundle.hasPreviews) {
      try { unlinkSync(join(previewDir,bundle.id+'.json')); }
      catch (error) { if (error.code!=='ENOENT') console.error('Tabroom bundle preview cleanup:',error.code); }
    }
    return {id:bundle.id};
  });
  if (method==='bundle/frames') {
    const bundle=findBundle(peer,params.bundleId);
    if (!bundle.hasPreviews) return [];
    const indexes=Array.isArray(params.indexes) ? [...new Set(params.indexes)].filter(i=>Number.isInteger(i) && i>=0 && i<bundle.tabs.length).slice(0,5) : [];
    try {
      const frames=JSON.parse(readFileSync(join(previewDir,bundle.id+'.json'),'utf8'));
      return indexes.flatMap(index=>frames[index] ? [{index,...frames[index]}] : []);
    } catch { return []; }
  }
  if (method==='owner') return serializedGroup(async()=>{
    const identity=await callBrowser(peer,'group/identity',{groupId:params.groupId});
    if (!identity) return null;
    const candidates=sessions.filter(item=>owns(peer,item.profile) && item.group &&
      (identity.key ? item.id===identity.key : item.id.slice(0,12)===identity.legacyPrefix));
    if (candidates.length!==1) return null;
    const session=candidates[0];
    const live=await callBrowser(peer,'group/read',{key:session.id,title:session.title,expectedGroupId:params.groupId});
    return live.open && live.groupId===params.groupId ? {id:session.id,title:session.title} : null;
  });
  if (method==='turn' || method==='openGroup') return serializedGroup(async()=>{
    const draft=readTurnDraft(params);
    const groupOnly=method==='openGroup';
    if (groupOnly && draft.parts.some(part=>part.text?.trim() || part.skillName)) throw Error('탭만 골라 그룹을 열 수 있어요.');
    const existing=sessions.find(item=>item.id===params.id);
    const provisional=params.provisional===true && !existing;
    if (provisional && (typeof params.id!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(params.id))) {
      throw Error('새 채팅을 다시 열어주세요.');
    }
    const session=provisional ? newSession(peer,'새 채팅',params.id) : sessionFor(peer,params.id);
    if (!groupOnly && params.provisional===true && session.messages.some(item=>item.role==='user')) return publicSession(session);
    if (runs.has(session.id)) throw Error('이 채팅에서 이미 작업이 진행 중이에요.');
    for (const {skillName} of draft.parts) {
      if (skillName && !getSkill(skillName) && !workflowsFor(peer).readSkill(skillName)) throw Error('스킬을 다시 골라주세요.');
    }
    const live=session.group || groupOnly && provisional
      ? await callBrowser(peer,'group/read',{key:session.id,...(session.group && {title:session.title})}) : null;
    const bundles=new Map(draft.parts.flatMap((part,index)=>part.bundleId
      ? [[index,findBundle(peer,part.bundleId)]]
      : part.tabGroup ? [[index,{name:part.tabGroup.title,tabs:part.tabGroup.urls.map(url=>({url}))}]] : []));
    const signature=groupOnly ? JSON.stringify(draft.parts) : null;
    if (groupOnly && live?.open && (openedDrafts.get(session)===signature ||
      !provisional && params.provisional===true && !session.messages.length)) {
      return {...publicSession(session),turnGroup:groupView(session,live)};
    }
    if (live?.open && [...bundles.keys()].some(index=>draft.parts[index].tabGroup?.site!==true)) {
      throw Error('이 채팅에 이미 열린 탭그룹이 있어요.');
    }
    const tabs=live?.open ? live.tabs : draft.tabIds.length
      ? await callBrowser(peer,'browser/references',{key:session.id,windowId,bound:false,tabIds:draft.tabIds}) : [];
    let turnDraft=resolveTurnDraft(draft,tabs,bundles);
    const first=!session.messages.some(item=>item.role==='user');
    const title=first && (!groupOnly || provisional) ? chatTitle(turnDraft) : session.title;
    let group;
    if (bundles.size) {
      const requestedTabs=[...bundles.values()].flatMap(bundle=>bundle.tabs);
      group=live?.open
        ? await callBrowser(peer,'group/appendSites',{key:session.id,groupId:live.groupId,
          urls:requestedTabs.map(tab=>tab.url)},22000)
        : await openBundle(peer,session,{tabs:requestedTabs},windowId,title,draft.tabIds);
      if (!group.open || !Array.isArray(group.restoredTabIds)) throw Error('선택한 사이트를 열 수 없었어요.');
      const currentIds=new Set(group.tabs.map(tab=>tab.id));
      let offset=0;
      for (const [index,bundle] of bundles) {
        const end=offset+bundle.tabs.length;
        const tabIds=group.restoredTabIds.slice(offset,end).filter(id=>currentIds.has(id));
        bundles.set(index,{...bundle,tabIds});
        offset=end;
      }
      turnDraft=resolveTurnDraft(draft,group.tabs,bundles);
    } else if (!live?.open && draft.tabIds.length) {
      group=await callBrowser(peer,'group/bind',{key:session.id,title,windowId,tabIds:draft.tabIds});
      if (!group.open) throw Error('선택한 탭의 그룹을 만들 수 없었어요.');
      turnDraft=resolveTurnDraft(draft,group.tabs);
    } else if (live?.open && title!==session.title) {
      await callBrowser(peer,'group/read',{key:session.id,title,expectedGroupId:live.groupId});
    }
    if (groupOnly) {
      const opened=group ?? live;
      if (!opened?.open) throw Error('먼저 열 탭을 골라주세요.');
      if (provisional || group) {
        const previous={title:session.title,group:session.group,updatedAt:session.updatedAt};
        if (provisional) session.title=title;
        session.updatedAt=Date.now();
        remember(peer,session,opened.tabs,true,false);
        try {
          if (provisional) addSession(session);
          else save();
        } catch (error) { Object.assign(session,previous); throw error; }
      }
      openedDrafts.set(session,signature);
      return {...publicSession(session),turnGroup:groupView(session,opened)};
    }
    const before={title:session.title,group:session.group,updatedAt:session.updatedAt,running:session.running};
    session.title=title;
    if (group || live?.open) remember(peer,session,(group ?? live).tabs,true,false);
    else if (session.group && title!==before.title) session.group={...session.group,title};
    const run={id:randomUUID(),session,peer,windowId,bound:Boolean(group?.open || live?.open),drafts:new Map(),sources:new Map(),
      messageIndex:session.messages.length,progress:'Codex 연결 중'};
    session.running=true;
    if (provisional) sessions.push(session);
    try { addMessage(session,'user',turnDraft.text,{parts:turnDraft.parts}); }
    catch (error) {
      if (provisional) sessions.pop();
      Object.assign(session,before);
      session.messages.length=run.messageIndex;
      throw error;
    }
    runs.set(session.id,run);
    if (first) void updateFirstTitle(session,turnDraft.parts).catch(()=>{});
    void launchTurn(run,turnDraft);
    return {...publicSession(session),...(group ? {turnGroup:groupView(session,group)} : {})};
  });
  const session=sessionFor(peer,params.id);
  if (method==='reference/open' || method==='reference/image') {
    const record=session.messages.find(message=>message.id===params.messageId)?.references?.find(ref=>ref.key===params.key);
    if (!record) throw Error('저장된 출처를 찾을 수 없어요.');
    if (method==='reference/image') {
      if (!/^[a-f\d-]{36}$/.test(record.image ?? '')) return null;
      try { return JSON.parse(readFileSync(join(referenceImageDir,record.image+'.json'),'utf8')); }
      catch { return null; }
    }
    return serializedGroup(async()=>{
      const live=await callBrowser(peer,'reference/open',{key:session.id,windowId,title:session.title,record},22000);
      if (!live?.open) throw Error('출처를 탭그룹에서 열 수 없었어요.');
      const linked=Number.isSafeInteger(live.referenceTabId) &&
        live.referenceTabId!==record.tabId && live.referenceTabId!==record.openedTabId;
      if (linked) record.openedTabId=live.referenceTabId;
      remember(peer,session,live.tabs,false,!linked);
      if (linked) save();
      return groupView(session,live);
    });
  }
  if (method==='read') return publicSession(session);
  if (method==='group') return serializedGroup(()=>refreshGroup(peer,session));
  if (method==='restore') return serializedGroup(async()=>{
    if (runs.has(session.id)) throw Error('채팅 작업이 끝난 뒤 그룹을 다시 열어주세요.');
    if (!session.group) throw Error('이 채팅에 연결된 탭 그룹이 없어요.');
    const snapshot=savedTabs(session.group);
    const result=await callBrowser(peer,'group/restore',{key:session.id,title:session.title,
      urls:snapshot.map(tab=>tab.url),refIds:snapshot.map(tab=>tab.refId),windowId},22000);
    if (!result.open) throw Error('그룹을 다시 열 수 없었어요.');
    remember(peer,session,result.tabs);
    return groupView(session,result);
  });
  if (method==='closeGroup' || method==='closeTab') return serializedGroup(async()=>{
    if (runs.has(session.id)) throw Error('채팅 작업이 끝난 뒤 탭을 닫아주세요.');
    const live=await currentGroup(peer,session,params.groupId);
    const tabId=method==='closeTab' ? params.tabId : undefined;
    if (method==='closeTab' && (!Number.isInteger(tabId) || !live.tabs.some(tab=>tab.id===tabId))) {
      throw Error('이미 닫혔거나 그룹에서 이동한 탭이에요.');
    }
    if (method==='closeGroup') remember(peer,session,live.tabs,true);
    const closed=await callBrowser(peer,'group/close',{key:session.id,groupId:live.groupId,tabId});
    remember(peer,session,method==='closeGroup' ? closed.before : closed.live.tabs,true);
    return groupView(session,closed.live);
  });
  if (method==='bundle/save') return serializedGroup(async()=>{
    return saveBundle(peer,session,await currentGroup(peer,session,params.groupId),params.name);
  });
  if (method==='stop') {
    const run=runs.get(session.id);
    if (run) void interrupt(run);
    return publicSession(session);
  }
  throw Error('지원하지 않는 탭룸 요청입니다.');
}

const server=createServer(socket=>{
  const peer={socket,pending:new Map(),profile:null,accountProfile:null};
  const input=createInterface({input:socket,crlfDelay:Infinity});
  socket.on('error',()=>{});
  input.on('line',line=>{
    if (Buffer.byteLength(line)>32*1024*1024) return socket.destroy();
    let request;
    try { request=JSON.parse(line); } catch { return socket.destroy(); }
    if (request.type==='hello' && !peer.profile && typeof request.profile==='string' && /^[a-f0-9-]{36}$/.test(request.profile)) {
      const {profile,accountProfile}=request;
      // Only the authenticated HTTPS gateway supplies an account profile over the private Unix socket.
      if (accountProfile!==undefined) {
        if (typeof accountProfile!=='string' || !/^[a-f0-9-]{36}$/.test(accountProfile) ||
            browserAccounts[profile] && browserAccounts[profile]!==accountProfile) return socket.destroy();
        if (accountProfile!==profile && !browserAccounts[profile]) {
          const links={...browserAccounts,[profile]:accountProfile};
          try { save(browserAccountsPath,links); }
          catch { return socket.destroy(); }
          browserAccounts=links;
        }
      }
      peer.profile=profile;
      peer.accountProfile=browserAccounts[profile] ?? profile;
      const old=profiles.get(peer.profile);
      profiles.set(peer.profile,peer);
      old?.socket.destroy();
    } else if (request.type==='reply' && peer.profile) {
      const call=peer.pending.get(request.id);
      if (!call) return;
      peer.pending.delete(request.id);
      if (request.error) call.reject(Error(request.error));
      else call.resolve(request.result);
    } else if (request.type==='event' && peer.profile) {
      const run=[...runs.values()].find(item=>item.id===request.runId && item.peer===peer);
      run?.browser?.event(request.event,request.data);
    } else if (request.type==='api' && peer.profile) {
      void api(peer,request).then(
        result=>send(socket,{type:'result',id:request.id,result}),
        error=>send(socket,{type:'result',id:request.id,error:String(error.message)}),
      ).catch(error=>{
        try { send(socket,{type:'result',id:request.id,error:String(error.message)}); } catch { socket.destroy(); }
      });
    }
  });
  socket.on('close',()=>{
    if (profiles.get(peer.profile)===peer) profiles.delete(peer.profile);
    for (const call of peer.pending.values()) call.reject(Error('Chrome 연결이 끊겼어요.'));
    peer.pending.clear();
    for (const run of runs.values()) if (run.peer===peer) void interrupt(run);
  });
});

try {
  const info=lstatSync(socketPath);
  if (!info.isSocket()) throw Error('기존 탭룸 소켓 경로가 올바르지 않아요.');
  // The HTTP portal serves as the singleton supervisor for this socket.
  unlinkSync(socketPath);
} catch (error) { if (error.code!=='ENOENT') throw error; }
server.listen(socketPath,()=>{
  chmodSync(socketPath,0o600);
  console.log('Tabroom agent ready');
});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{
  app.close();
  for (const peer of profiles.values()) peer.socket.destroy();
  server.close(()=>process.exit());
  setTimeout(()=>process.exit(),1000).unref();
});
