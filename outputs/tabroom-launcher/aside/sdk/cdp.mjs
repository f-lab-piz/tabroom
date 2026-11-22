// 원본 CdpClient와 같은 send/on 계약을 자체 확장 RPC에 연결한다.
export class ExtensionCdp {
  constructor(transport,profileId){this.transport=transport;this.profileId=profileId;this.listeners=new Map();this.autoAccept=new Map();this.transportEvents={on:()=>()=>{}};}
  on(name,fn){const set=this.listeners.get(name)??new Set();set.add(fn);this.listeners.set(name,set);return()=>set.delete(fn);}
  emit(name,params,meta={}){for(const fn of this.listeners.get(name)??[])fn(params,meta);}
  onEvent(name,data){if(name!=='cdp')return;this.emit(data.method,data.params??{},{sessionId:data.sessionId});if(data.method==='Page.javascriptDialogOpening'&&this.autoAccept.has(data.sessionId))this.send('Page.handleJavaScriptDialog',{accept:true},data.sessionId).catch(()=>{});}
  setDialogAutoAccept(id,enabled){const count=(this.autoAccept.get(id)??0)+(enabled?1:-1);if(count>0)this.autoAccept.set(id,count);else this.autoAccept.delete(id);}
  async send(method,params,sessionId,options){return this.transport('native',{browserId:this.profileId,method:'cdp',args:[{method,params,sessionId,options}]});}
  async discoverTargets(){return(await this.send('Target.getTargets')).targetInfos.map(t=>({...t,id:t.targetId}));}
}
