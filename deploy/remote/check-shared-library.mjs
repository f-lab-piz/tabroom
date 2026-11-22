import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const agent=join(here,'../../outputs/tabroom-launcher/agent-server.mjs');
const temp=await mkdtemp(join(tmpdir(),'tabroom-shared-'));
const db=join(temp,'data');
const socketPath=join(temp,'agent.sock');
const mac=randomUUID();
const remote=randomUUID();
const previousRemoteSession=randomUUID();
const sessionId=randomUUID();
const bundleId=randomUUID();
const ref=10_000_000_017;
const firstTab={title:'Example',url:'https://example.org/',refId:ref};
const original={id:sessionId,title:'Shared fixture',profile:mac,messages:[],updatedAt:10,
  group:{title:'Shared fixture',urls:[firstTab.url],savedTabs:[firstTab]}};
const writes=[];
const sockets=[];
await mkdir(join(db,'workflows',mac),{recursive:true});
await writeFile(join(db,'sessions.json'),JSON.stringify([
  original,{id:previousRemoteSession,title:'Earlier remote fixture',profile:remote,updatedAt:5,messages:[{role:'user',text:'prior'}]},
]));
await writeFile(join(db,'tab-bundles.json'),JSON.stringify([{id:bundleId,profile:mac,name:'Saved fixture',tabs:[firstTab]}]));
await writeFile(join(db,'workflows',mac,'quick-tasks.json'),JSON.stringify({imported:true,tasks:[{id:randomUUID(),title:'Fixture task',parts:[{text:'Check'}]}]}));
const processAgent=spawn(process.execPath,[agent],{env:{...process.env,TABROOM_AGENT_DATA:db,TABROOM_AGENT_SOCKET:socketPath},stdio:['ignore','pipe','inherit']});
const done=once(processAgent,'exit');
processAgent.stdout.setEncoding('utf8');

async function peer(profile,accountProfile,device,group) {
  const socket=createConnection(socketPath);
  sockets.push(socket);
  await once(socket,'connect');
  const pending=new Map();
  function send(packet){ socket.write(JSON.stringify(packet)+'\n'); }
  createInterface({input:socket}).on('line',line=>{
    const packet=JSON.parse(line);
    if(packet.type==='result'){
      const item=pending.get(packet.id);
      if (!item) return;
      pending.delete(packet.id);
      clearTimeout(item.timer);
      if(packet.error) item.reject(Error(packet.error));
      else item.resolve(packet.result);
    }else if(packet.type==='call'){
      writes.push({device,method:packet.method,params:packet.params});
      const {method,params}=packet;
      let result;
      if(method==='group/read') result=group ?? {open:false,tabs:[]};
      else if(method==='group/restore'){
        assert.deepEqual(params.urls,[firstTab.url]);
        assert.deepEqual(params.refIds,[ref]);
        group={open:true,groupId:91,tabs:[{id:ref,title:firstTab.title,url:firstTab.url}]};
        result={...group,restoredTabIds:[ref]};
      }else if(method==='group/close'){
        const before=group.tabs;
        group={...group,tabs:[]};
        result={before,live:group};
      }else if(method==='group/bundleFrames') result=[];
      else assert.fail('Unexpected browser request '+method);
      send({type:'reply',id:packet.id,result});
    }
  });
  send({type:'hello',profile,accountProfile});
  return (method,params={})=>new Promise((resolve,reject)=>{
    const id=randomUUID();
    const timer=setTimeout(()=>reject(Error(method+' timed out')),6000);
    pending.set(id,{resolve,reject,timer});
    send({type:'api',id,method,params,windowId:device==='Mac' ? 1 : 2});
  });
}

try {
  await Promise.race([once(processAgent.stdout,'data'),done.then(()=>assert.fail('Agent exited'))]);
  const macClient=await peer(mac,undefined,'Mac',{open:true,groupId:21,tabs:[{id:ref,title:firstTab.title,url:firstTab.url}]});
  const remoteClient=await peer(remote,mac,'Remote');
  const stranger=await peer(randomUUID(),undefined,'Unrelated');
  assert.equal((await remoteClient('list')).length,2);
  assert.equal((await macClient('list')).length,2);
  assert.equal((await remoteClient('quickTasks/list'))[0].title,'Fixture task');
  assert.equal((await remoteClient('bundle/list'))[0].id,bundleId);
  assert.deepEqual(await stranger('list'),[]);
  assert.deepEqual(await stranger('bundle/list'),[]);
  await assert.rejects(stranger('read',{id:sessionId}),/찾을 수 없어요/);
  const closed=await remoteClient('group',{id:sessionId});
  assert.equal(closed.open,false);
  assert.equal(closed.canRestore,true);
  const restored=await remoteClient('restore',{id:sessionId});
  assert.equal(restored.groupId,91);
  assert.equal(restored.tabs[0].id,ref);
  const restoreCalls=writes.filter(x=>x.method==='group/restore');
  assert.deepEqual(restoreCalls.map(x=>[x.device,x.params.windowId]),[['Remote',2]]);
  await remoteClient('bundle/save',{id:sessionId,groupId:91,name:'Created on Remote'});
  assert.equal((await macClient('bundle/list'))[0].name,'Created on Remote');
  await remoteClient('closeTab',{id:sessionId,groupId:91,tabId:ref});
  await macClient('group',{id:sessionId});
  const disk=JSON.parse(await readFile(join(db,'sessions.json'),'utf8'));
  assert.deepEqual(disk.find(x=>x.id===sessionId).group.savedTabs,[]);
  console.log('Verified shared sessions, saved work, captured bundles and remote restore; unrelated profile isolated.');
} finally {
  for(const socket of sockets) socket.destroy();
  processAgent.kill();
  await done;
  await rm(temp,{recursive:true,force:true});
}
