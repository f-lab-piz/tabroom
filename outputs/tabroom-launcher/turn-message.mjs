import {readTabGroup,skillNamePattern} from './workflows.mjs';

export function readTurnDraft(params) {
  if (Array.isArray(params.parts)) {
    if (params.parts.length > 1000) throw Error('메시지가 너무 길어요.');
    const parts = params.parts.map(part => {
      if (typeof part?.text === 'string') return {text:part.text};
      if (Number.isInteger(part?.tabId) && part.tabId >= 0) return {tabId:part.tabId};
      if (typeof part?.bundleId === 'string' && /^[a-f0-9-]{36}$/.test(part.bundleId)) return {bundleId:part.bundleId};
      if (part?.tabGroup) return {tabGroup:readTabGroup(part.tabGroup)};
      if (typeof part?.skillName === 'string' && skillNamePattern.test(part.skillName)) return {skillName:part.skillName};
      throw Error('탭 참조를 다시 선택해주세요.');
    });
    const tabIds = [...new Set(parts.flatMap(part => part.tabId === undefined ? [] : [part.tabId]))];
    const bundles = parts.filter(part=>part.bundleId || part.tabGroup);
    const size = parts.reduce((length, part) => length + (part.text?.length ?? 1), 0);
    if (size > 24000 || (!bundles.length && !tabIds.length && !parts.some(part => part.skillName || part.text?.trim()))) {
      throw Error('24,000자 이내로 메시지를 입력해주세요.');
    }
    if (tabIds.length > 100) throw Error('한 메시지에서 최대 100개 탭을 참조할 수 있어요.');
    return {parts,tabIds};
  }
  const text = typeof params.text === 'string' ? params.text.trim() : '';
  if (!text || text.length > 24000) throw Error('24,000자 이내로 메시지를 입력해주세요.');
  const tabIds = Array.isArray(params.tabIds) ? [...new Set(params.tabIds)] : [];
  if (tabIds.length > 100 || tabIds.some(id=>!Number.isInteger(id) || id < 0)) throw Error('탭 참조를 다시 선택해주세요.');
  return {parts:[{text}],tabIds};
}

export function resolveTurnDraft(draft, tabs, bundles=new Map()) {
  const catalog = new Map(tabs.map(tab=>[tab.id,tab]));
  if (draft.tabIds.some(id => !catalog.has(id))) throw Error('탭 목록이 바뀌었어요. #으로 다시 선택해주세요.');
  const parts = draft.parts.map((part,index) => {
    if (part.text !== undefined) return part;
    if (part.skillName) return {skillName:part.skillName,title:'$'+part.skillName};
    if (part.bundleId) return {bundleId:part.bundleId,title:bundles.get(index)?.name || '저장된 탭그룹'};
    if (part.tabGroup) return {tabGroup:part.tabGroup,title:part.tabGroup.title};
    const tab = catalog.get(part.tabId);
    return {tabId:tab.id,title:String(tab.title || '탭').slice(0,240),favicon:String(tab.favicon || '').slice(0,4096)};
  });
  const marker = id => '[[tab:'+id+']]';
  return {
    parts,
    text:parts.map(part => part.text ?? '['+part.title+']').join(''),
    input:parts.map((part,index) => {
      if (part.text!==undefined) return part.text;
      if (part.skillName) return ' $'+part.skillName+' ';
      if (part.bundleId || part.tabGroup) return (bundles.get(index)?.tabIds ?? []).map(marker).join(' ');
      return marker(part.tabId);
    }).join('').trim(),
    tabIds:draft.tabIds.length ? draft.tabIds : tabs.map(tab=>tab.id),
  };
}
