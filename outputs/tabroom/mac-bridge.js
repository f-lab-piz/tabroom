const extensionId = 'hmngikndankgldefcihbegdepaomgnlb';
const status = document.querySelector('#status');
const secret = location.hash.slice(1) || sessionStorage.getItem('tabroom-mac-bridge');

function connect() {
  const socket = new WebSocket('ws://127.0.0.1:18846/host');
  const channels = new Map();
  const send = packet => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 16 * 1024 * 1024) socket.close();
    else socket.send(JSON.stringify(packet));
  };

  socket.addEventListener('open', () => send({secret}));
  socket.addEventListener('message', ({data}) => {
    const {type,id,message} = JSON.parse(data);
    const channel = channels.get(id);
    if (type === 'ready') {
      status.textContent = '휴대폰에서 이 Mac의 Chrome에 연결할 수 있어요. 이 탭을 열어 두세요.';
    } else if (type === 'open' && !channel) {
      const port = chrome.runtime.connect(extensionId, {name:'tabroom'});
      channels.set(id, port);
      port.onMessage.addListener(message => send({type:'message',id,message}));
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (channels.delete(id)) send({type:'close',id});
      });
    } else if (type === 'message' && channel) {
      channel.postMessage(message);
    } else if (type === 'close' && channels.delete(id)) {
      channel.disconnect();
    }
  });
  socket.addEventListener('close', () => {
    const ports = [...channels.values()];
    channels.clear();
    for (const port of ports) port.disconnect();
    status.textContent = '휴대폰 연결을 다시 준비하고 있어요.';
    if (!sessionStorage.getItem('tabroom-mac-bridge')) return;
    setTimeout(connect, 2000);
  });
}

if (secret && globalThis.chrome?.runtime?.connect) {
  sessionStorage.setItem('tabroom-mac-bridge', secret);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  connect();
} else {
  status.textContent = '이 Mac의 탭룸 연결을 다시 실행해주세요.';
}
