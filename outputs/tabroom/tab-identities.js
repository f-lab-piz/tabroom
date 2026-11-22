import {remoteOrigin} from './remote-config.js';

export const firstTabRef = 10_000_000_000;
const registryKey = key => 'tabroomTabRefs:'+key;
const counterKey = remoteOrigin ? 'tabroomNextRemoteTabRef' : 'tabroomNextTabRef';
let queue = Promise.resolve();

function startCounter() {
  if (!remoteOrigin) return firstTabRef;
  // New refs on different PCs use independent ranges. Restored refs stay intact.
  const deviceRange=crypto.getRandomValues(new Uint32Array(1))[0];
  return 1_000_000_000_000_000 + deviceRange*1_000_000;
}

// Live associations expire with the Chrome session. Only the counter persists here.
export function identifyTabs(key,tabs,assignments = new Map()) {
  const task = queue.then(async()=>{
    if (!tabs.length) return [];
    const storageKey = registryKey(key);
    const rows = (await chrome.storage.session.get(storageKey))[storageKey] ?? {};
    const reserved = new Set([...Object.values(rows).map(row=>row.ref),...assignments.values()]);
    let next;
    let changed = false;
    const refs = [];
    for (const tab of tabs) {
      const previous = rows[tab.id];
      let ref = assignments.get(tab.id);
      if (!Number.isSafeInteger(ref) || ref < firstTabRef) {
        if (previous) ref = previous.ref;
        else {
          next ??= (await chrome.storage.local.get(counterKey))[counterKey] ?? startCounter();
          while (reserved.has(next)) next++;
          ref = next++;
        }
      }
      if (previous?.ref !== ref || previous?.groupId !== tab.groupId) {
        for (const [id,row] of Object.entries(rows)) if (id !== String(tab.id) && row.ref === ref) delete rows[id];
        rows[tab.id] = {ref,groupId:tab.groupId};
        changed = true;
      }
      refs.push(ref);
    }
    if (next !== undefined) await chrome.storage.local.set({[counterKey]:next});
    if (changed) await chrome.storage.session.set({[storageKey]:rows});
    return refs;
  });
  queue = task.catch(()=>{});
  return task;
}

export async function nativeTabId(key,ref) {
  if (!Number.isSafeInteger(ref) || ref < firstTabRef) throw Error('현재 탭 목록에서 탭룸 ID를 다시 확인해주세요.');
  const storageKey = registryKey(key);
  const rows = (await chrome.storage.session.get(storageKey))[storageKey] ?? {};
  const match = Object.entries(rows).find(([,row])=>row.ref === ref);
  const tab = match && await chrome.tabs.get(Number(match[0])).catch(()=>null);
  if (!tab || tab.groupId !== match[1].groupId) throw Error('이 탭은 현재 연결되어 있지 않아요.');
  return tab.id;
}
