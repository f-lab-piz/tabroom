const caretMarker = '\u200B';

export function makeTabChip({tabId,bundleId,tabGroup,skillName,title=tabGroup?.title, favicon}, editable = false) {
  const chip = document.createElement('span');
  chip.className = 'inline-tab';
  if (skillName) {
    chip.dataset.skillName=skillName;
    chip.classList.add('inline-skill');
  } else if (tabGroup) {
    chip.dataset.tabGroup=JSON.stringify(tabGroup);
    chip.classList.add('inline-bundle');
  } else if (bundleId) {
    chip.dataset.bundleId = bundleId;
    chip.classList.add('inline-bundle');
  } else chip.dataset.tabId = tabId;
  chip.title = title;
  if (editable) chip.contentEditable = 'false';

  if (/^(https?:\/\/|data:image\/)/i.test(favicon || '')) {
    const icon = document.createElement('img');
    icon.alt = '';
    icon.src = favicon;
    icon.addEventListener('error', () => { icon.hidden = true; });
    chip.append(icon);
  }
  const label = document.createElement('span');
  label.textContent = title;
  chip.append(label);
  return chip;
}

export function readMessageParts(editor) {
  const parts = [];
  function addText(text) {
    text = text.replaceAll(caretMarker, '');
    if (!text) return;
    const last = parts.at(-1);
    if (last?.text !== undefined) last.text += text;
    else parts.push({text});
  }
  function walk(node) {
    if (node.nodeType === 3) { addText(node.data); return; }
    if (node.nodeType !== 1) return;
    if (node.classList.contains('inline-tab')) {
      if (node.dataset.skillName) { parts.push({skillName:node.dataset.skillName}); return; }
      if (node.dataset.tabGroup) {
        try { parts.push({tabGroup:JSON.parse(node.dataset.tabGroup)}); }
        catch { /* 손상된 칩의 위치는 일반 텍스트로 보존한다. */ addText(node.textContent); }
        return;
      }
      if (node.dataset.bundleId) { parts.push({bundleId:node.dataset.bundleId}); return; }
      const tabId = Number(node.dataset.tabId);
      if (Number.isInteger(tabId) && tabId >= 0) parts.push({tabId});
      return;
    }
    if (node.nodeName === 'BR') { addText('\n'); return; }
    const block = node !== editor && ['DIV', 'P'].includes(node.nodeName);
    if (block && parts.length && !parts.at(-1).text?.endsWith('\n')) addText('\n');
    for (const child of node.childNodes) walk(child);
  }
  walk(editor);
  if (parts[0]?.text !== undefined) parts[0].text = parts[0].text.trimStart();
  if (parts.at(-1)?.text !== undefined) parts.at(-1).text = parts.at(-1).text.trimEnd();
  return parts.filter(part => part.tabId !== undefined || part.bundleId || part.tabGroup || part.skillName || part.text);
}

export function renderMessageParts(container, parts, editable = false) {
  for (const part of parts) {
    if (typeof part.text === 'string') container.append(part.text);
    else if (Number.isInteger(part.tabId) || part.bundleId || part.tabGroup || part.skillName) container.append(makeTabChip(part,editable));
  }
}

export function createComposer(editor, onInput, {singleGroup=false}={}) {
  let savedRange;
  let anchor;
  let typedAnchor;
  let composing = false;
  let afterComposition;
  const selection = editor.ownerDocument.getSelection();
  const inside = range => range && editor.contains(range.commonAncestorContainer);
  function currentRange() {
    const current = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (inside(current)) return current.cloneRange();
    if (inside(savedRange)) return savedRange.cloneRange();
    const end = document.createRange();
    end.selectNodeContents(editor);
    end.collapse(false);
    return end;
  }
  editor.ownerDocument.addEventListener('selectionchange', () => {
    if (selection.rangeCount && inside(selection.getRangeAt(0))) savedRange = selection.getRangeAt(0).cloneRange();
  });
  function place(range, node, offset) {
    range.setStart(node, offset);
    range.collapse(true);
    editor.focus({preventScroll:true});
    selection.removeAllRanges();
    selection.addRange(range);
    savedRange = range.cloneRange();
  }
  function insertText(text,range = currentRange()) {
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    place(range,node,text.length);
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
  }
  function deletePreviousChip(event) {
    const range = currentRange();
    if (!range.collapsed) return;
    const {startContainer: node,startOffset: offset} = range;
    let previous;
    if (node.nodeType === 3) {
      if (node.data.slice(0,offset).replaceAll(caretMarker,'')) return;
      previous = node.previousSibling;
    } else {
      previous = node.childNodes[offset-1];
    }
    while (previous?.nodeType === 3 && !previous.data.replaceAll(caretMarker,'')) {
      previous = previous.previousSibling;
    }
    if (!previous?.classList?.contains('inline-tab')) return;
    event.preventDefault();
    range.setStartBefore(previous);
    range.deleteContents();
    place(range,range.startContainer,range.startOffset);
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:event.inputType}));
  }
  editor.addEventListener('beforeinput',event => {
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault();
      insertText('\n');
    } else if (event.inputType === 'deleteContentBackward' && !event.isComposing) deletePreviousChip(event);
  });
  editor.addEventListener('paste',event => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain');
    if (text) insertText(text);
  });
  editor.addEventListener('drop',event => event.preventDefault());
  editor.addEventListener('input',onInput);
  editor.addEventListener('compositionstart',()=>{
    composing = true;
    afterComposition = null;
  });
  editor.addEventListener('compositionend',event=>{
    composing = false;
    const submit = afterComposition;
    afterComposition = null;
    onInput(event);
    if (submit && /\p{Script=Hangul}/u.test(event.data)) queueMicrotask(submit);
  });
  return {
    appendText(text) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      insertText((readMessageParts(editor).length ? '\n' : '') + text,range);
    },
    appendParts(parts) {
      if (singleGroup && parts.some(part=>part.bundleId || part.tabGroup)) {
        editor.querySelector('[data-bundle-id],[data-tab-group]')?.remove();
      }
      const nodes=document.createDocumentFragment();
      if (readMessageParts(editor).length) nodes.append('\n');
      renderMessageParts(nodes,parts,true);
      const tail=document.createTextNode(caretMarker);
      nodes.append(tail);
      editor.append(nodes);
      const range=document.createRange();
      place(range,tail,tail.length);
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));
    },
    replaceParts(parts) {
      editor.replaceChildren();
      savedRange=anchor=afterComposition=null;
      renderMessageParts(editor,parts,true);
    },
    handleComposition(event, submit) {
      if (!composing && !event.isComposing && event.keyCode !== 229) return false;
      if (composing && submit) afterComposition = submit;
      return true;
    },
    open(typed,trigger='#') {
      const range=currentRange();
      const text=range.startContainer.nodeType===3 ? range.startContainer.data : '';
      const offset=range.startOffset;
      const hasTrigger=range.collapsed && text[offset-1]===trigger;
      if (typed && trigger==='/' && (!hasTrigger || offset>1 && !/[\s\u200B]/.test(text[offset-2]))) return false;
      if (typed && !hasTrigger) return false;
      typedAnchor=typed ? trigger : null;
      anchor=range;
      if (typed && hasTrigger) {
        anchor.setStart(anchor.startContainer,offset-1);
      }
      return true;
    },
    validAnchor() {
      return inside(anchor) && (typedAnchor ? anchor.toString()===typedAnchor : anchor.collapsed);
    },
    queryRange({composing=false}={}) {
      const cursor=currentRange();
      if (!inside(anchor) || !cursor.collapsed && !composing || anchor.comparePoint(cursor.endContainer,cursor.endOffset)<0) return null;
      const range=anchor.cloneRange();
      range.setEnd(cursor.endContainer,cursor.endOffset);
      const text=range.toString();
      if (typedAnchor && !text.startsWith(typedAnchor)) return null;
      const query=text.slice(typedAnchor ? 1 : 0).replaceAll(caretMarker,'');
      if (/[#\r\n]/.test(query) || query.length>200 || range.cloneContents().querySelector('.inline-tab,br,div,p')) return null;
      return {query,range};
    },
    close() { anchor = null; },
    insert(tab, {keepOpen=false,range:queryRange}={}) {
      const previous = singleGroup && (tab.bundleId || tab.tabGroup) && editor.querySelector('[data-bundle-id],[data-tab-group]');
      const range = queryRange ?? (inside(anchor) ? anchor.cloneRange() : currentRange());
      range.deleteContents();
      if (previous?.isConnected) previous.remove();
      const chip = makeTabChip({...tab,tabId:tab.id}, true);
      const tail = document.createTextNode(caretMarker);
      const nodes = document.createDocumentFragment();
      nodes.append(chip,tail);
      range.insertNode(nodes);
      place(range,tail,tail.length);
      if (keepOpen) {
        anchor=currentRange();
        typedAnchor=null;
      }
      return chip;
    },
    clear() { editor.replaceChildren(); savedRange = anchor = afterComposition = null; },
    draft() {
      const parts = readMessageParts(editor);
      if (parts.length) return {parts,tabIds:[...new Set(parts.flatMap(part=>part.tabId === undefined ? [] : [part.tabId]))]};
      return null;
    },
  };
}
