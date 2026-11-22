import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';

export class AppServer {
  constructor({cwd,onEvent,onTool,onExit}) {
    this.cwd=cwd;
    this.onEvent=onEvent;
    this.onTool=onTool;
    this.onExit=onExit;
    this.pending=new Map();
    this.serial=0;
  }

  async connect() {
    if (!this.ready) this.ready=this.start();
    return this.ready;
  }

  async start() {
    const executable=process.env.TABROOM_CODEX || ['/opt/homebrew/bin/codex','/usr/local/bin/codex'].find(existsSync) || 'codex';
    const env={...process.env};
    // Use the existing managed ChatGPT login even if the launch terminal exports an API key.
    delete env.OPENAI_API_KEY;
    const child=spawn(executable,[
      'app-server','--listen','stdio://',
      '-c','web_search="disabled"',
      '--disable','plugins','--disable','computer_use','--disable','apps',
    ],{cwd:this.cwd,env,stdio:['pipe','pipe','pipe']});
    this.child=child;
    createInterface({input:child.stdout}).on('line',line=>this.receive(line,child));
    child.stderr.resume();
    child.stdin.on('error',()=>{});
    const closed=error=>{
      if (this.child !== child) return;
      this.child=undefined;
      this.ready=undefined;
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
      this.onExit(error);
    };
    child.once('error',()=>closed(Error('Codex App Server 실행 파일을 열 수 없어요.')));
    child.once('exit',()=>closed(Error('Codex App Server 연결이 종료됐어요.')));
    try {
      await this.request('initialize',{
        clientInfo:{name:'tabroom',title:'Tabroom',version:'0.6.2'},
        capabilities:{experimentalApi:true,requestAttestation:false},
      });
      this.write({method:'initialized'});
      const {config}=await this.request('config/read',{cwd:this.cwd});
      // 빈 테이블은 사용자의 설정과 병합되므로 각 MCP 서버를 채팅별로 끈다.
      this.threadConfig=Object.fromEntries(Object.keys(config?.mcp_servers ?? {}).map(name=>[
        'mcp_servers.'+name+'.enabled',false,
      ]));
      return this;
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  write(value, child=this.child) {
    if (!child || child !== this.child || child.stdin.destroyed) return false;
    child.stdin.write(JSON.stringify(value)+'\n');
    return true;
  }

  request(method,params={},timeout=25000) {
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(id);
        reject(Error('Codex 응답 시간이 초과됐어요. '+method));
      },timeout);
      this.pending.set(id,{
        resolve:result=>{clearTimeout(timer);resolve(result);},
        reject:error=>{clearTimeout(timer);reject(error);},
      });
      if (!this.write({id,method,params})) {
        this.pending.get(id).reject(Error('Codex App Server에 연결되지 않았어요.'));
        this.pending.delete(id);
      }
    });
  }

  receive(line,child) {
    if (child!==this.child) return;
    let message;
    try { message=JSON.parse(line); } catch { return; }
    if (message.method && message.id != null) {
      if (message.method==='item/tool/call') {
        Promise.resolve().then(()=>this.onTool(message.params)).then(
          result=>this.write({id:message.id,result},child),
          error=>this.write({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:String(error.message)}]}},child),
        );
      } else {
        this.write({id:message.id,error:{code:-32601,message:'이 요청은 탭룸 브라우저 도구의 범위 밖입니다.'}},child);
      }
    } else if (message.method) this.onEvent(message.method,message.params);
    else {
      const call=this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      if (message.error) call.reject(Error(message.error.message || 'Codex 요청 실패'));
      else call.resolve(message.result);
    }
  }

  async account() {
    await this.connect();
    const {account}=await this.request('account/read',{refreshToken:false});
    return {signedIn:account?.type==='chatgpt',plan:account?.type==='chatgpt'?account.planType:undefined};
  }

  close() { this.child?.kill(); }
}
