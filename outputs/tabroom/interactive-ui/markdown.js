import {safeLink} from './protocol.js';
import {inlinePattern,parseReference} from './references.js';

export function element(tag, label, className) {
  const node = document.createElement(tag);
  if (label !== undefined) node.textContent = String(label);
  if (className) node.className = className;
  return node;
}

export function link(label, href) {
  const url = safeLink(href);
  if (!url) return element('span',label);
  const anchor = element('a',label);
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

export function codeBlock(value,language,copy) {
  const block = element('div',undefined,'response-code');
  const header = element('div',undefined,'response-code-head');
  header.append(element('span',language || '코드'));
  if (copy) {
    const button = element('button','복사','response-button');
    button.type = 'button';
    button.addEventListener('click',async()=>{
      button.textContent = await copy(value) ? '복사됨' : '복사 실패';
    });
    header.append(button);
  }
  const pre = element('pre');
  pre.append(element('code',value));
  block.append(header,pre);
  return block;
}

function inline(parent,value,tabReference) {
  let start = 0;
  for (const match of value.matchAll(inlinePattern)) {
    parent.append(value.slice(start,match.index));
    if (match[1]) parent.append(link(match[1],match[2]));
    else if (match[3]) parent.append(element('code',match[3]));
    else if (match[4]) parent.append(element('strong',match[4]));
    else if (match[5]) parent.append(element('em',match[5]));
    else {
      const reference=parseReference(match[6]);
      parent.append((reference && tabReference?.(reference.tabId,reference)) || match[0]);
    }
    start = match.index + match[0].length;
  }
  parent.append(value.slice(start));
}

function tableCells(line) {
  return line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());
}

export function appendMarkdown(container,value,copy,tabReference) {
  const lines = value.split('\n');
  const appendInline = (parent,text)=>inline(parent,text,tabReference);
  let paragraph = [];
  let list, listKind;
  function flush() {
    if (paragraph.length) {
      const block = element('p');
      appendInline(block,paragraph.join('\n'));
      container.append(block);
    }
    paragraph = [];
  }
  for (let i=0; i<lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})([\w+-]*)\s*$/);
    const heading = line.match(/^(#{1,6})[ \t]+(.+)$/);
    const item = line.match(/^\s*(?:([-+*])|(\d+)[.)])[ \t]+(.+)$/);
    const quote = line.match(/^>\s?(.*)$/);
    const separator = lines[i+1] && tableCells(lines[i+1]);
    if (fence) {
      flush();
      list = undefined;
      const code = [];
      while (++i < lines.length) {
        const end = lines[i].trim();
        if (end.length >= fence[1].length && [...end].every(char=>char===fence[1][0])) break;
        code.push(lines[i]);
      }
      container.append(codeBlock(code.join('\n'),fence[2],copy));
    } else if (heading) {
      flush();
      list = undefined;
      const node = element('h' + Math.min(6,heading[1].length+2));
      appendInline(node,heading[2]);
      container.append(node);
    } else if (item) {
      flush();
      const kind = item[2] ? 'ol' : 'ul';
      if (!list || listKind !== kind) {
        list = element(kind);
        listKind = kind;
        if (item[2]) list.start = Number(item[2]);
        container.append(list);
      }
      const li = element('li');
      appendInline(li,item[3]);
      list.append(li);
    } else if (quote) {
      flush();
      list = undefined;
      const block = element('blockquote');
      appendInline(block,quote[1]);
      container.append(block);
    } else if (line.includes('|') && separator?.length > 1 && separator.every(cell=>/^:?-{3,}:?$/.test(cell))) {
      flush();
      list = undefined;
      const wrapper = element('div',undefined,'response-table-wrap');
      const table = element('table');
      const head = table.createTHead().insertRow();
      for (const title of tableCells(line)) {
        const th = element('th');
        th.scope = 'col';
        appendInline(th,title);
        head.append(th);
      }
      const body = table.createTBody();
      i++;
      while (lines[i+1]?.includes('|') && lines[i+1].trim()) {
        const row = body.insertRow();
        for (const cell of tableCells(lines[++i])) appendInline(row.insertCell(),cell);
      }
      wrapper.append(table);
      container.append(wrapper);
    } else {
      list = undefined;
      if (line.trim()) paragraph.push(line);
      else flush();
    }
  }
  flush();
}
