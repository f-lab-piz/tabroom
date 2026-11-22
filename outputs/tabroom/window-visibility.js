export function createWindowVisibilitySampler(runtime,readWindows,apply) {
  let port;
  let clock;
  let request;
  let deadline;
  let retryAfter = 0;

  function close(retry) {
    const previous = port;
    port = null;
    request = null;
    clearTimeout(deadline);
    if (retry) retryAfter = Date.now()+20000;
    apply([],[]);
    previous?.disconnect();
  }

  function sample() {
    if (request || Date.now()<retryAfter) return;
    const windows = readWindows();
    if (!windows.length) return;
    if (!port) {
      try { port = runtime.connectNative('com.tabroom.window_visibility'); }
      catch { close(true); return; }
      const connection = port;
      connection.onDisconnect.addListener(()=>{
        void runtime.lastError;
        if (port === connection) close(true);
      });
      connection.onMessage.addListener(message=>{
        if (port !== connection || !request) return;
        const windows = request;
        request = null;
        clearTimeout(deadline);
        apply(windows, Array.isArray(message?.covered) ? message.covered : []);
      });
    }
    request = windows;
    deadline = setTimeout(()=>close(true),2500);
    try { port.postMessage({type:'visibility',windows}); }
    catch { close(true); }
  }

  return enabled=>{
    if (!runtime.connectNative) return;
    if (enabled && !clock) {
      clock = setInterval(sample,1000);
      sample();
    } else if (!enabled && clock) {
      clearInterval(clock);
      clock = null;
      close(false);
    }
  };
}
