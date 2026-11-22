const validKey = /^\p{L}[\p{L}\p{M}\p{N}_-]{0,47}$/u;
const reserved = new Set(['constructor','prototype','toString','hasOwnProperty']);
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 2000) => typeof value === 'string' && value.length <= limit;
const scalar = value => value === null || text(value) || typeof value === 'boolean' || Number.isFinite(value);
const choices = value => Array.isArray(value) && value.length <= 24 && value.every(scalar);

export function safeLink(value) {
  if (!text(value,2048)) return null;
  try {
    const url = new URL(value);
    if (['http:','https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Use plain text for invalid links. */ }
  return null;
}

export function parseWidget(source) {
  if (typeof source !== 'string' || source.length > 32000) throw Error('위젯 데이터가 너무 커요.');
  const widget = JSON.parse(source);
  const require = (ok, message) => { if (!ok) throw Error(message); };
  require(record(widget) && widget.version === 1, '지원하는 UI 형식은 version 1이에요.');
  const state = widget.state ?? {};
  require(record(state) && Object.keys(state).length <= 32, '초기 상태가 올바르지 않아요.');
  for (const [key,value] of Object.entries(state)) {
    require(validKey.test(key) && !reserved.has(key) && (scalar(value) || choices(value)), '초기 상태가 올바르지 않아요.');
  }
  const keyExists = key => typeof key === 'string' && Object.hasOwn(state,key);
  const bound = value => record(value) && keyExists(value.state);
  const readable = value => scalar(value) || bound(value);
  let size = 0;

  function validateNodes(nodes,depth) {
    require(Array.isArray(nodes) && nodes.length <= 40 && depth <= 7, 'UI 배치가 너무 크거나 올바르지 않아요.');
    nodes.forEach(node=>validateNode(node,depth));
  }

  function validateAction(action) {
    require(record(action), '버튼 동작이 필요해요.');
    switch (action.type) {
      case 'copy':
        require(readable(action.value),'복사할 값이 필요해요.');
        break;
      case 'draft':
        if ('value' in action) require(readable(action.value),'입력창에 넣을 값을 확인해주세요.');
        if ('fields' in action) require(Array.isArray(action.fields) && action.fields.length > 0 &&
          action.fields.length <= 12 && action.fields.every(field=>record(field) && text(field.label,120) && keyExists(field.state)),
          '입력창에 넣을 필드를 확인해주세요.');
        require('value' in action || 'fields' in action,'입력창에 넣을 값이나 필드가 필요해요.');
        break;
      case 'set':
        require(keyExists(action.state) && (scalar(action.value) || choices(action.value)), '상태 이름과 값을 확인해주세요.');
        break;
      case 'download':
        require(readable(action.value) && typeof action.filename === 'string' &&
          /^[^/\\\x00-\x1f]{1,90}\.(txt|csv|json|md)$/i.test(action.filename),'지원하는 파일 이름과 텍스트가 필요해요.');
        break;
      case 'reset':
        break;
      default:
        throw Error('지원하지 않는 버튼 동작이에요.');
    }
  }

  function validateNode(node,depth) {
    require(record(node) && ++size <= 120, 'UI 요소가 너무 많거나 올바르지 않아요.');
    if ('when' in node) {
      require(record(node.when) && keyExists(node.when.state) && scalar(node.when.equals),'표시 조건을 확인해주세요.');
    }
    switch (node.type) {
      case 'card':
      case 'row':
      case 'column':
      case 'grid':
      case 'details':
        require(node.title === undefined || text(node.title,180), '제목을 확인해주세요.');
        if (node.type === 'details') require(text(node.title,180) && node.title.trim(), '접기·펼치기 제목이 필요해요.');
        validateNodes(node.children,depth+1);
        break;
      case 'tabs':
        require(Array.isArray(node.items) && node.items.length >= 2 && node.items.length <= 8 &&
          node.items.every(item=>record(item) && text(item.label,90) && item.label.trim()),'화면 탭에 제목이 필요해요.');
        node.items.forEach(item=>validateNodes(item.children,depth+1));
        break;
      case 'text':
      case 'heading':
      case 'badge':
        require(readable(node.value),'표시할 값이 필요해요.');
        break;
      case 'link':
        require(text(node.label,120) && safeLink(node.url),'지원하는 링크와 이름을 넣어주세요.');
        break;
      case 'code':
        require(text(node.value,12000) && (node.language === undefined || text(node.language,32)), '코드나 언어를 확인해주세요.');
        break;
      case 'divider':
        break;
      case 'input': {
        require(text(node.label,120) && node.label.trim() && keyExists(node.state),'입력 이름과 초기 상태가 필요해요.');
        switch (node.kind) {
          case 'text':
          case 'date':
            require(text(state[node.state]),'텍스트나 날짜 초기값이 필요해요.');
            break;
          case 'toggle':
            require(typeof state[node.state] === 'boolean','토글에는 true 또는 false가 필요해요.');
            break;
          case 'number':
          case 'range':
            require(Number.isFinite(state[node.state]) &&
              (!('min' in node) || Number.isFinite(node.min)) && (!('max' in node) || Number.isFinite(node.max)) &&
              (!('step' in node) || (Number.isFinite(node.step) && node.step > 0)) &&
              (node.min === undefined || node.max === undefined || node.min <= node.max), '숫자 입력 범위를 확인해주세요.');
            if (node.kind==='range') require(Number.isFinite(node.min) && Number.isFinite(node.max) && node.max>node.min,
              '슬라이더에는 최솟값과 최댓값이 필요해요.');
            require((node.min === undefined || state[node.state] >= node.min) &&
              (node.max === undefined || state[node.state] <= node.max),'숫자 초기값이 범위를 벗어났어요.');
            break;
          case 'select':
          case 'radio':
          case 'multi': {
            require(Array.isArray(node.options) && node.options.length > 0 && node.options.length <= 24 &&
              node.options.every(option=>record(option) && text(option.label,120) && typeof option.value==='string' && text(option.value,160)), '선택지를 확인해주세요.');
            const options = new Set(node.options.map(option=>option.value));
            require(options.size === node.options.length && (node.kind === 'multi'
              ? Array.isArray(state[node.state]) && state[node.state].every(value=>options.has(value))
              : options.has(state[node.state])),'선택지 값은 고유해야 하고 초기 상태와 일치해야 해요.');
            break;
          }
          default: throw Error('지원하지 않는 입력 형식이에요.');
        }
        break;
      }
      case 'metric':
        require(text(node.label,120) && (node.unit === undefined || text(node.unit,24)) &&
          ['sum','difference','product','ratio','percent'].includes(node.operation) && Array.isArray(node.values) &&
          node.values.length >= 2 && node.values.length <= 8 &&
          (['sum','product'].includes(node.operation) || node.values.length === 2) &&
          node.values.every(value=>Number.isFinite(value) || (bound(value) && Number.isFinite(state[value.state]))),
          '계산 요소의 숫자와 연산을 확인해주세요.');
        break;
      case 'table':
        require(Array.isArray(node.columns) && node.columns.length > 0 && node.columns.length <= 12 &&
          node.columns.every(value=>text(value,120)) &&
          Array.isArray(node.rows) && node.rows.length <= 80 &&
          node.rows.every(row=>Array.isArray(row) && row.length===node.columns.length && row.every(scalar)), '표의 열과 행을 확인해주세요.');
        if ('filter' in node) require(record(node.filter) && keyExists(node.filter.state) &&
          Number.isInteger(node.filter.column) && node.filter.column >= 0 && node.filter.column < node.columns.length, '표 필터를 확인해주세요.');
        break;
      case 'chart':
        require(['bar','line'].includes(node.kind) && text(node.label,120) &&
          Array.isArray(node.labels) && node.labels.length > 0 && node.labels.length <= 36 &&
          node.labels.every(value=>text(value,80)) && Array.isArray(node.series) &&
          node.series.length > 0 && node.series.length <= 5 && node.series.every(series=>
            record(series) && text(series.label,80) && Array.isArray(series.values) &&
            series.values.length === node.labels.length && series.values.every(value=>Number.isFinite(value) && Math.abs(value)<=1e12)),
          '차트의 이름과 숫자 계열을 확인해주세요.');
        break;
      case 'button':
        require(text(node.label,120) && node.label.trim(),'버튼 이름이 필요해요.');
        validateAction(node.action);
        break;
      default:
        throw Error('지원하지 않는 UI 요소예요.');
    }
  }

  validateNodes(widget.nodes,0);
  require(widget.nodes.length > 0,'UI 요소가 비어 있어요.');
  return {version:1,state,nodes:widget.nodes};
}

export function splitAssistantContent(text,{streaming = false} = {}) {
  const sections = [];
  let markdown = [];
  let fence;
  let body = [];
  let widgetCount = 0;
  function flush() {
    if (markdown.length) sections.push({type:'markdown', value:markdown.join('\n')});
    markdown = [];
  }

  for (const line of String(text).split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
    if (fence) {
      const closes = marker && marker[1][0] === fence.mark[0] && marker[1].length >= fence.mark.length && !marker[2].trim();
      if (!fence.ui) markdown.push(line);
      else if (!closes) body.push(line);
      if (!closes) continue;
      if (fence.ui) {
        flush();
        try {
          if (++widgetCount > 4) throw Error('한 메시지에서 위젯은 최대 4개까지 지원해요.');
          sections.push({type:'widget', value:parseWidget(body.join('\n'))});
        } catch {
          sections.push({type:'invalid', value:body.join('\n')});
        }
        body = [];
      }
      fence = undefined;
    } else if (marker) {
      const ui = marker[2].trim() === 'tabroom-ui';
      fence = {mark:marker[1],ui};
      if (!ui) markdown.push(line);
    } else markdown.push(line);
  }
  flush();
  if (fence?.ui) sections.push(streaming ? {type:'pending'} : {type:'invalid',value:body.join('\n')});
  return sections;
}
