export function chatTitle(draft) {
  const request = draft.parts.map(part => part.text ?? ' ').join('').replace(/\s+/g,' ').trim();
  const title = request || draft.parts.find(part => part.title)?.title || '새 채팅';
  const characters = [...title];
  return characters.length > 42 ? characters.slice(0,41).join('').trimEnd()+'…' : title;
}

export function snapshotTabs(tabs) {
  return tabs.flatMap(tab => {
    try {
      const url = new URL(tab.url);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return [];
      return [{
        url:tab.url, title:String(tab.title || url.hostname).slice(0,240),
        favicon:/^https?:\/\//.test(tab.favicon) ? tab.favicon.slice(0,1500) : '',
        ...(Number.isSafeInteger(tab.refId) && {refId:tab.refId}),
      }];
    } catch { return []; }
  }).slice(0,100);
}

export function savedTabs(group) {
  return group?.savedTabs ?? snapshotTabs((group?.urls ?? []).map(url => ({url})));
}

export function groupView(session, live = {open:false,tabs:[]}) {
  const saved = savedTabs(session.group);
  const legacy = new Map(saved.flatMap(tab=>tab.legacyId===undefined ? [] : [[tab.refId,tab.legacyId]]));
  const tabs = live.tabs.map(tab=>legacy.has(tab.id) ? {...tab,legacyId:legacy.get(tab.id)} : tab);
  return {...live,tabs,title:session.title,bound:Boolean(session.group),canRestore:saved.length > 0,
    savedTabs:live.open ? [] : saved};
}
