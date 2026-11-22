// A single native host lives for the lifetime of this portal page.
export function createNativeSampler() {
  let port, pending;

  function disconnect(current) {
    if (current !== port) return;
    port = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(Error('CPU helper disconnected'));
      pending = null;
    }
  }

  return function sample() {
    if (!port) {
      const current = chrome.runtime.connect('hmngikndankgldefcihbegdepaomgnlb', {name:'tabroom-cpu'});
      port = current;
      current.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        disconnect(current);
      });
      current.onMessage.addListener(value => {
        if (current !== port || !pending) return;
        clearTimeout(pending.timer);
        pending.resolve(value);
        pending = null;
      });
    }
    return new Promise((resolve, reject) => {
      const current = port;
      const timer = setTimeout(() => {
        disconnect(current);
        current.disconnect();
      }, 4000);
      pending = {resolve, reject, timer};
      try { current.postMessage({type: 'sample'}); }
      catch { disconnect(current); }
    });
  };
}
