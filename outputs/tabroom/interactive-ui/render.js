import {splitAssistantContent} from './protocol.js';
import {appendMarkdown,codeBlock,element,link} from './markdown.js';
import {renderChart} from './chart.js';

const number = new Intl.NumberFormat('ko-KR',{maximumFractionDigits:4});
const readable = value => Array.isArray(value) ? value.map(readable).join(', ') :
  value === null || value === undefined ? '—' : typeof value === 'number' ? number.format(value) : String(value);

export async function copyText(value) {
  try { await navigator.clipboard.writeText(value); return true; }
  catch { return false; }
}

export function widgetState(initial,storageKey) {
  let saved;
  if (storageKey) {
    try { saved = JSON.parse(sessionStorage.getItem(storageKey)); } catch { /* Start with defaults. */ }
  }
  const state = new Map(Object.entries(initial));
  for (const [key,base] of state) {
    if (saved && Object.hasOwn(saved,key) && compatible(base,saved[key])) state.set(key,saved[key]);
  }
  const listeners = new Map();
  function compatible(base,value) {
    if (Array.isArray(base)) return Array.isArray(value) && value.length <= 24 && value.every(v=>
      typeof v==='string' && v.length<=2000 || typeof v==='boolean' || Number.isFinite(v) || v===null);
    const scalar = value===null || typeof value==='boolean' || Number.isFinite(value) || typeof value==='string' && value.length<=2000;
    return scalar && (base===null || typeof base===typeof value);
  }
  return {
    get: key=>state.get(key),
    set(key,value) {
      if (!Object.hasOwn(initial,key) || !compatible(initial[key],value)) return false;
      state.set(key,value);
      try { if (storageKey) sessionStorage.setItem(storageKey,JSON.stringify(Object.fromEntries(state))); }
      catch { /* The live UI still works without storage. */ }
      for (const listener of listeners.get(key) || []) listener();
      return true;
    },
    watch(key,listener) {
      if (key) {
        if (!listeners.has(key)) listeners.set(key,new Set());
        listeners.get(key).add(listener);
      }
      listener();
    },
  };
}

function renderTable(node,state) {
  const panel = element('div',undefined,'widget-table');
  const table = element('table');
  const head = table.createTHead().insertRow();
  const body = table.createTBody();
  let sort, direction = 1, filterText = '';
  const headers = node.columns.map(label=>{
    const th = element('th');
    th.scope = 'col';
    th.append(element('button',label,'widget-sort'));
    th.firstChild.type = 'button';
    head.append(th);
    return th;
  });
  headers.forEach((th,i)=>{
    th.firstChild.addEventListener('click',()=>{
      direction = sort === i ? -direction : 1;
      sort = i;
      update();
    });
  });
  const count = element('p',undefined,'widget-status');
  function update() {
    const selected = node.filter ? state.get(node.filter.state) : null;
    const rows = node.rows.filter(row=>{
      const cell = node.filter ? row[node.filter.column] : null;
      const matches = Array.isArray(selected) ? selected.length===0 || selected.includes(cell) :
        selected===null || selected==='' || selected===cell;
      return matches && (!filterText || row.some(value=>readable(value).toLowerCase().includes(filterText)));
    });
    headers.forEach((th,i)=>{
      if (sort===i) th.setAttribute('aria-sort',direction===1?'ascending':'descending');
      else th.removeAttribute('aria-sort');
    });
    if (sort !== undefined) rows.sort((a,b)=>{
      const left=a[sort], right=b[sort];
      const result = typeof left==='number' && typeof right==='number'
        ? left-right : readable(left).localeCompare(readable(right),'ko',{numeric:true});
      return direction*result;
    });
    body.replaceChildren();
    for (const row of rows) {
      const tr = body.insertRow();
      for (const value of row) tr.insertCell().textContent = readable(value);
    }
    count.textContent = rows.length ? rows.length+'개 항목' : '일치하는 항목이 없어요.';
  }
  if (node.search === true) {
    const search = element('input');
    search.type = 'search';
    search.placeholder = '표에서 찾기';
    search.setAttribute('aria-label','표에서 찾기');
    search.addEventListener('input',()=>{ filterText = search.value.trim().toLowerCase(); update(); });
    panel.append(search);
  }
  const wrap = element('div',undefined,'response-table-wrap');
  wrap.append(table);
  panel.append(wrap,count);
  state.watch(node.filter?.state,update);
  return panel;
}

function renderInput(node,state,groupName) {
  const {kind,label,state:key} = node;
  if (kind==='radio' || kind==='multi') {
    const fieldset = element('fieldset',undefined,'widget-field');
    fieldset.append(element('legend',label));
    const group = element('div',undefined,'widget-options');
    fieldset.append(group);
    for (const option of node.options) {
      const input = element('input');
      input.type = kind==='radio' ? 'radio' : 'checkbox';
      input.name = groupName;
      input.value = option.value;
      const text = element('label');
      text.append(input,option.label);
      group.append(text);
      state.watch(key,()=>{
        const value=state.get(key);
        input.checked = kind==='multi' ? value.includes(option.value) : value===option.value;
      });
      input.addEventListener('change',()=>{
        if (kind==='radio') state.set(key,input.value);
        else {
          const values = state.get(key);
          state.set(key,input.checked ? [...values.filter(value=>value!==input.value),input.value] :
            values.filter(value=>value!==input.value));
        }
      });
    }
    return fieldset;
  }
  const field = element('label',undefined,'widget-field');
  field.append(element('span',label));
  const numeric = kind==='number' || kind==='range';
  const control = element(kind==='select'?'select':'input');
  if (kind==='select') {
    for (const option of node.options) {
      const choice = element('option',option.label);
      choice.value = option.value;
      control.append(choice);
    }
  } else {
    control.type = kind==='toggle'?'checkbox':kind;
    if (kind==='text') control.maxLength=2000;
    if (numeric) {
      control.step = String(node.step ?? 1);
      if (node.min !== undefined) control.min = String(node.min);
      if (node.max !== undefined) control.max = String(node.max);
    }
  }
  field.append(control);
  const hint = kind==='range' ? element('output') : null;
  if (hint) field.append(hint);
  const sync = ()=>{
    const value=state.get(key);
    if (kind==='toggle') control.checked=value;
    else if (control.value!==String(value)) control.value=String(value);
    if (hint) hint.textContent=readable(value);
  };
  state.watch(key,sync);
  const event=kind==='select' || kind==='toggle'?'change':'input';
  control.addEventListener(event,()=>{
    if (numeric && (!control.validity.valid || !Number.isFinite(control.valueAsNumber))) return;
    state.set(key,kind==='toggle'?control.checked:numeric?control.valueAsNumber:control.value);
  });
  if (numeric) control.addEventListener('change',sync);
  return field;
}

function calculate(operation,values) {
  const [a,b] = values;
  switch (operation) {
    case 'sum': return values.reduce((sum,value)=>sum+value,0);
    case 'product': return values.reduce((product,value)=>product*value,1);
    case 'difference': return a-b;
    case 'ratio': return b===0 ? null : a/b;
    case 'percent': return b===0 ? null : (a/b)*100;
  }
}

let nextWidget=0;
export function renderWidget(widget,{onDraft,storageKey} = {}) {
  const root = element('section',undefined,'interactive-widget');
  root.setAttribute('aria-label','대화형 응답');
  const state = widgetState(widget.state,storageKey);
  const status = element('div','', 'widget-status');
  status.setAttribute('role','status');
  const widgetId = ++nextWidget;
  let fieldId=0;
  const reference = value => value && typeof value==='object' ? value.state : undefined;
  const read = value => reference(value) ? state.get(value.state) : value;

  async function run(action) {
    switch (action.type) {
      case 'set':
        status.textContent = state.set(action.state,action.value) ? '' : '이 상태에는 해당 값을 적용할 수 없어요.';
        return;
      case 'reset':
        for (const [key,value] of Object.entries(widget.state)) state.set(key,value);
        status.textContent = '초기값으로 되돌렸어요.';
        return;
      case 'copy':
        status.textContent = await copyText(readable(read(action.value))) ? '복사했어요.' : '복사하지 못했어요.';
        return;
      case 'draft': {
        const parts = [];
        if (action.value !== undefined) parts.push(readable(read(action.value)));
        for (const field of action.fields || []) parts.push(field.label+' '+readable(state.get(field.state)));
        const text = parts.join('\n').slice(0,7000);
        if (text.trim() && onDraft?.(text)) status.textContent = '채팅 입력창에 넣었어요.';
        else status.textContent = '지금은 채팅 입력창에 넣을 수 없어요.';
        return;
      }
      case 'download': {
        const data = new Blob([readable(read(action.value))],{type:'text/plain;charset=utf-8'});
        const url = URL.createObjectURL(data);
        const anchor = element('a');
        anchor.href = url;
        anchor.download = action.filename;
        anchor.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
        status.textContent = '다운로드를 시작했어요.';
      }
    }
  }

  function create(node) {
    let result;
    switch (node.type) {
      case 'card':
      case 'row':
      case 'column':
      case 'grid':
      case 'details':
        result = element(node.type==='details'?'details':'div',undefined,'widget-'+node.type);
        if (node.title) result.append(element(node.type==='details'?'summary':'h4',node.title));
        result.append(...node.children.map(create));
        break;
      case 'tabs': {
        result = element('section',undefined,'widget-tabs');
        const controls = element('div',undefined,'widget-tab-controls');
        controls.setAttribute('role','tablist');
        controls.setAttribute('aria-label','보기 전환');
        result.append(controls);
        const tabs = [], panels = [];
        node.items.forEach((item,i)=>{
          const tab = element('button',item.label,'response-button');
          tab.type='button';
          tab.setAttribute('role','tab');
          tab.id='widget-'+widgetId+'-tab-'+(++fieldId);
          const panel = element('div');
          panel.setAttribute('role','tabpanel');
          panel.id=tab.id+'-panel';
          panel.setAttribute('aria-labelledby',tab.id);
          tab.setAttribute('aria-controls',panel.id);
          panel.append(...item.children.map(create));
          tab.addEventListener('click',()=>select(i));
          controls.append(tab);
          result.append(panel);
          tabs.push(tab);
          panels.push(panel);
        });
        function select(i,focus=false) {
          tabs.forEach((tab,n)=>{
            tab.setAttribute('aria-selected',String(n===i));
            tab.tabIndex=n===i?0:-1;
            panels[n].hidden=n!==i;
          });
          if (focus) tabs[i].focus();
        }
        controls.addEventListener('keydown',event=>{
          const i=tabs.indexOf(event.target);
          if (i<0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
          event.preventDefault();
          const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:
            (i+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;
          select(next,true);
        });
        select(0);
        break;
      }
      case 'text':
      case 'heading':
      case 'badge':
        result = element(node.type==='heading'?'h4':node.type==='badge'?'span':'p',undefined,'widget-'+node.type);
        state.watch(reference(node.value),()=>{ result.textContent=readable(read(node.value)); });
        break;
      case 'metric': {
        result = element('div',undefined,'widget-metric');
        const output = element('output');
        result.append(element('span',node.label),output);
        const sync=()=>{
          const value=calculate(node.operation,node.values.map(read));
          output.textContent=Number.isFinite(value)?readable(value)+(node.unit?' '+node.unit:''):'—';
        };
        const keys=new Set(node.values.map(reference).filter(Boolean));
        if (keys.size) for (const key of keys) state.watch(key,sync);
        else sync();
        break;
      }
      case 'link': result=link(node.label,node.url); break;
      case 'code': result=codeBlock(node.value,node.language,copyText); break;
      case 'divider': result=element('hr',undefined,'widget-divider'); break;
      case 'input': result=renderInput(node,state,'widget-'+widgetId+'-field-'+(++fieldId)); break;
      case 'table': result=renderTable(node,state); break;
      case 'chart': result=renderChart(node); break;
      case 'button':
        result=element('button',node.label,'response-button');
        result.type='button';
        result.addEventListener('click',async ()=>{
          try { await run(node.action); }
          catch { status.textContent = '이 동작을 완료하지 못했어요.'; }
        });
        break;
    }
    if (node.when) state.watch(node.when.state,()=>{ result.hidden=state.get(node.when.state)!==node.when.equals; });
    return result;
  }

  root.append(...widget.nodes.map(create),status);
  return root;
}

export function renderAssistantContent(container,text,options={}) {
  let index=0;
  for (const part of splitAssistantContent(text,{streaming:options.streaming})) {
    if (part.type==='markdown') appendMarkdown(container,part.value,copyText,options.streaming ? undefined : options.tabReference);
    else if (part.type==='widget' && !options.streaming) {
      const storageKey=options.messageKey ? 'tabroom-ui-v1:'+options.messageKey+':'+index : undefined;
      container.append(renderWidget(part.value,{onDraft:options.onDraft,storageKey}));
      index++;
    } else if (options.streaming || part.type==='pending') container.append(element('p','화면 준비 중…','widget-status'));
    else {
      const details=element('details',undefined,'widget-invalid');
      details.append(element('summary','화면을 표시하지 못했어요. 원본 보기'),codeBlock(part.value,'tabroom-ui',copyText));
      container.append(details);
    }
  }
}
