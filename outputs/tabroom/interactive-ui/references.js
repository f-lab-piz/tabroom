import {splitAssistantContent} from './protocol.js';

export const inlinePattern = /\[([^\[\]\n]+)\]\(([^\s)]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[\[((?:tab:|url:|source:)[^\n]{1,3200}?)\]\]/g;

export function referenceUrl(value) {
  if (typeof value!=='string' || value.length>3000) return null;
  try {
    const url=new URL(value);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return null;
    const directive=url.hash.indexOf(':~:');
    if (directive>=0) url.hash=directive===1 ? '' : url.hash.slice(0,directive);
    return url.href;
  } catch { return null; }
}

export function parseReference(value) {
  const tab=/^tab:(\d+)(?:\s+(\S+))?$/.exec(value);
  if (tab) {
    const tabId=Number(tab[1]);
    const url=tab[2] ? referenceUrl(tab[2]) : null;
    if (!Number.isSafeInteger(tabId) || (tab[2] && !url)) return null;
    return {key:value,tabId,...(url && {url})};
  }
  const source=/^source:([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/.exec(value);
  if (source) return {key:value,sourceId:source[1]};
  const url=value.startsWith('url:') && referenceUrl(value.slice(4));
  return url ? {key:value,url} : null;
}

export function collectReferences(text) {
  const references=new Map();
  for (const part of splitAssistantContent(text)) {
    if (part.type!=='markdown') continue;
    let fence;
    for (const line of part.value.split('\n')) {
      if (fence) {
        const end=line.trim();
        if (end.length>=fence.length && [...end].every(char=>char===fence[0])) fence=null;
        continue;
      }
      fence=line.match(/^ {0,3}(`{3,}|~{3,})([\w+-]*)\s*$/)?.[1];
      if (fence) continue;
      for (const match of line.matchAll(inlinePattern)) {
        const reference=match[6] && parseReference(match[6]);
        if (reference) references.set(reference.key,reference);
      }
    }
  }
  return [...references.values()];
}
