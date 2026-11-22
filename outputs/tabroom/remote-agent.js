import {remoteOrigin} from './remote-config.js';

export function openRemoteAgent(ticket, device) {
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(new URL('/browser-agent',remoteOrigin.replace(/^https:/,'wss:')));
    const messages=new Set();
    const disconnects=new Set();
    let ready=false;
    let heartbeat;
    const timeout=setTimeout(()=>socket.close(),8500);
    socket.addEventListener('open',()=>socket.send(JSON.stringify({ticket,device})));
    socket.addEventListener('message',event=>{
      let message;
      try { message=JSON.parse(event.data); } catch { return socket.close(1007); }
      if (!ready) {
        if (message.type!=='ready' || !/^[a-f0-9-]{36}$/.test(message.profile)) return socket.close(1008);
        ready=true;
        clearTimeout(timeout);
        heartbeat=setInterval(()=>socket.send('{"type":"keepalive"}'),18000);
        resolve({profile:message.profile,
          port:{postMessage:packet=>socket.send(JSON.stringify(packet)),
            onMessage:{addListener:listener=>messages.add(listener)},
            onDisconnect:{addListener:listener=>disconnects.add(listener)}},
        });
        return;
      }
      for (const listener of messages) listener(message);
    });
    socket.addEventListener('close',()=>{
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (!ready) reject(Error('원격 탭룸 서버에 연결할 수 없어요.'));
      for (const listener of disconnects) listener();
    });
  });
}
