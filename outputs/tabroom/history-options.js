import {portalOrigin} from './remote-config.js';

const button=document.querySelector('#history-toggle');
const status=document.querySelector('#history-status');
const access={permissions:['history']};
const compact=window.parent!==window && new URLSearchParams(location.search).get('compact')==='1';
let enabled;

document.body.classList.toggle('compact-history',compact);

async function refresh() {
  enabled=await chrome.permissions.contains(access);
  button.textContent=compact ? '방문 기록 검색 켜기' : enabled ? '방문 기록 사용 끄기' : '방문 기록 사용';
  button.disabled=false;
}

button.addEventListener('click',async()=>{
  try {
    if (compact) {
      const granted=enabled || await chrome.permissions.request(access);
      window.parent.postMessage({type:'tabroom-history-setup',granted},portalOrigin);
      return;
    }
    const changed=await (enabled ? chrome.permissions.remove(access) : chrome.permissions.request(access));
    status.textContent=changed ? '저장했어요.' : '';
  } catch {
    if (compact) window.parent.postMessage({type:'tabroom-history-setup',granted:false},portalOrigin);
    else status.textContent='방문 기록 설정을 변경하지 못했어요.';
  }
  await refresh();
});
await refresh();
if (compact && enabled) window.parent.postMessage({type:'tabroom-history-setup',granted:true},portalOrigin);
