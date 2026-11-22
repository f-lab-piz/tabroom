const connections = new Map();

chrome.debugger.onDetach.addListener(({tabId}, reason) => {
  const connection = connections.get(tabId);
  if (!connection || connection.closing) return;
  connections.delete(tabId);
  for (const owner of connection.owners) owner.onDetach?.(reason);
});

function queueFocus(connection, task) {
  const result = connection.focusQueue.then(task);
  connection.focusQueue = result.catch(() => {});
  return result;
}

async function syncFocus(connection) {
  const enabled = [...connection.owners].some(owner => owner.focus);
  if (enabled === connection.focusEnabled) return {};
  const result = await chrome.debugger.sendCommand(
    connection.target, 'Emulation.setFocusEmulationEnabled', {enabled},
  );
  connection.focusEnabled = enabled;
  return result;
}

export async function acquireTabDebugger(tabId, version = '1.3', onDetach) {
  while (connections.get(tabId)?.closing) await connections.get(tabId).closing;
  let connection = connections.get(tabId);
  if (!connection) {
    const target = {tabId};
    connection = {
      target, owners: new Set(), ready: chrome.debugger.attach(target, version),
      focusQueue: Promise.resolve(), focusEnabled: false,
    };
    connections.set(tabId, connection);
  }
  const owner = {onDetach, focus: false};
  connection.owners.add(owner);
  const connected = () => connections.get(tabId) === connection && connection.owners.has(owner);
  try {
    await connection.ready;
    if (connections.get(tabId) !== connection) throw Error('Chrome 디버거 연결이 종료됐어요.');
  } catch (error) {
    if (connections.get(tabId) === connection) connections.delete(tabId);
    throw error;
  }

  return {
    get connected() { return connected(); },
    setFocus(enabled) {
      return queueFocus(connection, async () => {
        if (!connected()) throw Error('Chrome 디버거 연결이 종료됐어요.');
        const previous = owner.focus;
        owner.focus = enabled;
        try { return await syncFocus(connection); }
        catch (error) { owner.focus = previous; throw error; }
      });
    },
    async release() {
      if (!connection.owners.delete(owner) || connections.get(tabId) !== connection) return;
      if (connection.owners.size) {
        await queueFocus(connection, () => {
          if (connections.get(tabId) === connection && !connection.closing) return syncFocus(connection);
        }).catch(() => {});
        return;
      }
      connection.closing = connection.focusQueue.then(() => chrome.debugger.detach(connection.target)).catch(() => {}).finally(() => {
        if (connections.get(tabId) === connection) connections.delete(tabId);
      });
      await connection.closing;
    },
  };
}
