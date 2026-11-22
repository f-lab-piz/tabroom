import {renderMessageParts} from './composer.js';
import {renderAssistantContent} from './interactive-ui/render.js';

const formatTokens = new Intl.NumberFormat('ko-KR');
const toolLabels = {browser:'브라우저',skill:'스킬',guide:'가이드'};

export function opensGroupOnly(draft) {
  return Boolean(draft?.parts.some(part=>part.tabId!==undefined || part.bundleId || part.tabGroup) &&
    !draft.parts.some(part=>part.text?.trim() || part.skillName));
}

function renderContext(usage) {
  const value = document.querySelector('#context-value');
  const detail = document.querySelector('#context-detail');
  const meter = value.closest('.context-meter');
  const percent = usage?.window ? 100*usage.used/usage.window : null;
  meter.style.setProperty('--context-fill',(percent === null ? 0 : Math.min(percent,100))+'%');
  value.textContent = percent === null ? (usage ? formatTokens.format(usage.used) : '—') :
    (percent>0 && percent<0.1 ? '<0.1' : percent.toFixed(1).replace(/\.0$/,''))+'%';
  if (!usage) {
    detail.textContent = '이 채팅에서 답변을 받으면 사용량을 표시해요.';
    return;
  }
  const section = (title,rows)=>{
    const heading = document.createElement('strong');
    heading.textContent = title;
    const totals = document.createElement('dl');
    for (const [name,count] of rows) {
      if (count == null) continue;
      const label = document.createElement('dt');
      const number = document.createElement('dd');
      label.textContent = name;
      number.textContent = formatTokens.format(count);
      totals.append(label,number);
    }
    detail.append(heading,totals);
  };
  detail.replaceChildren();
  const summary = document.createElement('p');
  summary.textContent = formatTokens.format(usage.used) + (usage.window
    ? ' / ' + formatTokens.format(usage.window) + ' 토큰'
    : ' 토큰 · 모델 한도 정보 없음');
  detail.append(summary);
  section('최근 모델 요청 · 토큰',[
    ['입력',usage.input],['입력 중 캐시 사용',usage.cached],
    ['출력',usage.output],['출력 중 추론',usage.reasoning],
  ]);
  if (usage.estimate) {
    const {instructions,conversation,browser,guides} = usage.estimate;
    section('탭룸이 기록한 텍스트 · 추정 토큰',[
      ['초기 지침·도구 정의',instructions],['대화 메시지',conversation],
      ['브라우저 호출·결과',browser],['스킬·가이드',guides],
    ]);
    const hint = document.createElement('small');
    hint.textContent = '텍스트 크기 기준 추정이며 이미지와 App Server 내부 자료는 제외해요.';
    detail.append(hint);
  }
}

export function createAgentUi({request,onChange,onState,onBeforeSend,onSend,readDraft,onGroup,onDraft,tabReference,onHistoryChange,siteIcon}) {
  const list = document.querySelector('#session-list');
  const groupTooltip = document.querySelector('#session-tabs-tooltip');
  const history = document.querySelector('#messages');
  const welcome = document.querySelector('.welcome');
  const label = document.querySelector('#session-title');
  const groupStatus = document.querySelector('#group-status');
  const status = document.querySelector('#agent-status');
  const send = document.querySelector('#send');
  const sendLabel = send.querySelector('.send-label');
  const stop = document.querySelector('#stop');
  const create = document.querySelector('#session-new');
  const homeButton = document.querySelector('#session-home');
  const listStatus = document.querySelector('#sessions-status');
  const openList = document.querySelector('#sessions-open');
  let session;
  let group;
  let generation = 0;
  let groupRequest = 0;
  let listRequest = 0;
  let selectedId = null;
  let polling;
  let busy = false;
  let showingError = false;
  let renderKey;
  let historySession;
  let renderedIds = [];
  let draftNode;
  let contextKey;
  const groupTitles = new WeakMap();
  let tooltipAnchor;
  let tooltipTimer;

  function hideGroupTooltip() {
    clearTimeout(tooltipTimer);
    tooltipAnchor?.closest('.session-entry').removeAttribute('aria-describedby');
    tooltipAnchor = null;
    groupTooltip.hidePopover();
  }

  function showGroupTooltip(indicator) {
    const titles = groupTitles.get(indicator);
    if (!titles?.length) return;
    hideGroupTooltip();
    const items = document.createElement('ul');
    for (const title of titles) {
      const item = document.createElement('li');
      item.textContent = title;
      items.append(item);
    }
    groupTooltip.replaceChildren(items);
    groupTooltip.showPopover();
    const anchor = indicator.getBoundingClientRect();
    const {width,height} = groupTooltip.getBoundingClientRect();
    groupTooltip.style.left = Math.max(8,Math.min(anchor.right + 6,innerWidth - width - 8))+'px';
    groupTooltip.style.top = Math.max(8,Math.min(anchor.top,innerHeight - height - 8))+'px';
    tooltipAnchor = indicator;
    indicator.closest('.session-entry').setAttribute('aria-describedby',groupTooltip.id);
  }

  function deferGroupTooltipHide() {
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(hideGroupTooltip,160);
  }

  groupTooltip.addEventListener('pointerenter',()=>clearTimeout(tooltipTimer));
  groupTooltip.addEventListener('pointerleave',deferGroupTooltipHide);
  list.addEventListener('scroll',hideGroupTooltip,{passive:true});
  window.addEventListener('resize',hideGroupTooltip);

  function say(message) {
    showingError = Boolean(message);
    status.textContent = message || '';
    status.classList.toggle('agent-error',showingError);
  }

  function render() {
    label.textContent = session?.title || '채팅';
    const nextContext = JSON.stringify(session?.contextUsage ?? null);
    if (nextContext !== contextKey) {
      contextKey = nextContext;
      renderContext(session?.contextUsage);
    }
    groupStatus.textContent = group?.open
      ? '탭 그룹 · '+group.tabs.length+'개'
      : group?.canRestore ? '탭 그룹 닫힘 · #으로 새로 선택' : '탭 그룹 연결 전';
    if (!showingError) status.textContent = session?.running ? (session.progress || 'Codex 응답 중') : '';
    const draft = readDraft();
    const action=opensGroupOnly(draft) ? '탭그룹 열기' : '보내기';
    if (sendLabel.textContent!==action) sendLabel.textContent=action;
    send.disabled = !session || busy || session.running || !draft;
    stop.hidden = !session?.running;
    onState?.();
    for (const row of list.children) {
      row.setAttribute('aria-current', String(row.dataset.id === selectedId));
    }
    const messages = session?.messages || [];
    const key = JSON.stringify([session?.id,messages.length,messages.at(-1)?.id,session?.draft]);
    const hasHistory = Boolean(messages.length || session?.draft);
    welcome.hidden = hasHistory;
    history.hidden = !hasHistory;
    if (key === renderKey) return;
    renderKey = key;
    const follow = history.scrollHeight - history.scrollTop - history.clientHeight < 72;
    if (historySession !== session?.id || renderedIds.length > messages.length ||
        !renderedIds.every((id,index)=>id===messages[index].id)) {
      history.replaceChildren();
      renderedIds = [];
      historySession = session?.id;
      draftNode = undefined;
    }
    draftNode?.remove();
    draftNode = undefined;
    for (const message of messages.slice(renderedIds.length)) {
      history.append(makeMessage(message));
      renderedIds.push(message.id);
    }
    if (session?.draft) {
      draftNode = makeMessage({role:'assistant',text:session.draft},true);
      history.append(draftNode);
    }
    if (follow) history.scrollTop = history.scrollHeight;
    onHistoryChange?.();
  }

  function makeMessage({id,role,text,parts,toolKind,references=[]},streaming=false) {
    const item = document.createElement('article');
    item.className = 'chat-message chat-'+role;
    const heading = document.createElement('span');
    heading.className = 'chat-speaker';
    heading.textContent = role === 'tool' ? (toolLabels[toolKind] || '도구') :
      role === 'user' ? '나' : role === 'assistant' ? 'Codex' : '탭룸';
    const paragraph = document.createElement('div');
    paragraph.className = 'chat-text';
    if (role === 'assistant') {
      const sessionId = session?.id;
      renderAssistantContent(paragraph,text,{
        streaming,
        messageKey:id,
        tabReference:(tabId,marker)=>tabReference(tabId,marker,id,references.find(ref=>ref.key===marker.key)),
        onDraft:value=>session?.id===sessionId && Boolean(session) && onDraft?.(value),
      });
    } else if (Array.isArray(parts)) renderMessageParts(paragraph,parts);
    else paragraph.textContent = text;
    item.append(heading,paragraph);
    return item;
  }

  async function refreshList() {
    const token = ++listRequest;
    const rows = await request('list');
    if (token !== listRequest) return rows;
    const existing = new Map([...list.children].map(button => [button.dataset.id, button]));
    for (const [index, row] of rows.entries()) {
      let button = existing.get(row.id);
      if (!button) {
        button = document.createElement('button');
        button.className = 'session-entry';
        button.type = 'button';
        button.dataset.id = row.id;
        button.innerHTML = '<span class="session-icon" aria-hidden="true"></span><span class="session-entry-title"></span><span class="session-group"></span>';
        const badge = button.querySelector('.session-group');
        badge.addEventListener('pointerenter',event=>{
          if (event.pointerType!=='touch') showGroupTooltip(badge);
        });
        badge.addEventListener('pointerleave',deferGroupTooltipHide);
        button.addEventListener('focus',()=>{
          if (button.matches(':focus-visible')) showGroupTooltip(badge);
        });
        button.addEventListener('blur',()=>{
          if (tooltipAnchor===badge) hideGroupTooltip();
        });
      }
      button.querySelector('.session-entry-title').textContent = row.title;
      const indicator = button.querySelector('.session-group');
      const preview = row.group?.count ? row.group : null;
      const groupKey = JSON.stringify(preview);
      if (indicator.dataset.group !== groupKey) {
        indicator.dataset.group = groupKey;
        indicator.hidden = !preview;
        indicator.replaceChildren();
        if (preview) {
          const {color,count,status,tabs} = preview;
          indicator.dataset.state = status;
          indicator.dataset.color = status==='open' ? color || 'grey' : 'grey';
          const titles = tabs.map(tab=>tab.title);
          if (count>titles.length) titles.push(`외 ${count-titles.length}개`);
          groupTitles.set(indicator,titles);
          const icons = document.createElement('span');
          icons.className = 'session-group-icons';
          icons.append(...tabs.slice(0,3).map(siteIcon));
          const detail = document.createElement('small');
          detail.textContent = String(count);
          detail.setAttribute('aria-label',`${status==='open' ? '열린' : '저장된'} 탭 ${count}개`);
          indicator.append(icons,detail);
          if (tooltipAnchor===indicator) showGroupTooltip(indicator);
        } else {
          groupTitles.delete(indicator);
          if (tooltipAnchor===indicator) hideGroupTooltip();
        }
      }
      button.setAttribute('aria-current', String(row.id === selectedId));
      existing.delete(row.id);
      if (list.children[index] !== button) list.insertBefore(button, list.children[index] || null);
    }
    for (const button of existing.values()) {
      if (button.contains(tooltipAnchor)) hideGroupTooltip();
      button.remove();
    }
    listStatus.textContent = rows.length ? '' : '저장된 채팅이 없어요.';
    listStatus.hidden = Boolean(rows.length);
    return rows;
  }

  function showHome() {
    if (!session?.provisional) {
      ++generation;
      clearTimeout(polling);
      selectedId = null;
      session = {id:crypto.randomUUID(),title:'새 채팅',messages:[],provisional:true,running:false};
      group = null;
      window.history.replaceState(null,'',location.pathname+location.search);
      say('');
      onChange(true);
    }
    render();
  }

  async function open(id) {
    const token = ++generation;
    selectedId = id;
    clearTimeout(polling);
    if (session?.id !== id) {
      session = null;
      group = null;
      onChange(true);
      render();
    }
    say('');
    try {
      const current = await request('read',{id});
      if (token !== generation) return;
      session = current;
      selectedId = current.id;
      localStorage.setItem('tabroom-session',current.id);
      window.history.replaceState(null,'','#chat='+current.id);
      group = current.group ? {bound:true,open:false,tabs:[],canRestore:false} : {bound:false,open:false,tabs:[]};
      render();
      await reloadGroup();
      if (token !== generation) return;
      poll();
      await refreshList();
    } catch (error) {
      if (token === generation) say(error.message);
    }
  }

  async function reloadGroup(announceArrival = false) {
    const id = session?.id;
    if (!id || session.provisional) return null;
    const version = generation;
    const token = ++groupRequest;
    const next = await request('group',{id});
    if (version !== generation || token !== groupRequest) return null;
    const created = announceArrival && !group?.open && next.open;
    group = next;
    render();
    onChange(false);
    if (created) onGroup(group);
    return group;
  }

  function poll() {
    clearTimeout(polling);
    if (!session?.running) return;
    const id = session.id;
    const version = generation;
    polling = setTimeout(async()=>{
      try {
        const next = await request('read',{id});
        if (version !== generation) return;
        session = next;
        render();
        if (next.group && !group?.open) {
          await reloadGroup(true);
          if (version !== generation) return;
          void refreshList().catch(()=>{});
        }
        if (next.running) poll();
        else {
          await reloadGroup();
          await refreshList();
        }
      } catch (error) {
        if (version !== generation) return;
        say(error.message);
        polling = setTimeout(poll,1200);
      }
    },550);
  }

  async function submit() {
    const draft = readDraft();
    if (!session || !draft || busy || session.running) return;
    busy = true;
    say('');
    render();
    const id = session.id;
    const version = generation;
    const arrival = onBeforeSend?.();
    const provisional = session.provisional === true;
    const previousGroupId = group?.open ? group.groupId : null;
    try {
      const params={id,...draft,...(provisional && {provisional})};
      const {turnGroup,...next} = await request(opensGroupOnly(draft) ? 'openGroup' : 'turn',params);
      if (version !== generation) { void refreshList().catch(()=>{}); return; }
      session = next;
      if (provisional) {
        selectedId = next.id;
        localStorage.setItem('tabroom-session',next.id);
        window.history.replaceState(null,'','#chat='+next.id);
      }
      onSend(draft);
      if (turnGroup) {
        ++groupRequest;
        group = turnGroup;
        render();
        onChange(false);
        if (group.open && group.groupId!==previousGroupId) onGroup(group,arrival);
      } else if (provisional && next.group) {
        void reloadGroup().catch(()=>{});
      }
      poll();
      void refreshList().catch(()=>{});
    } catch (error) {
      if (version === generation) say(error.message);
    } finally { busy = false; render(); }
  }

  function toggleList(open) {
    if (!open) hideGroupTooltip();
    document.body.classList.toggle('sessions-visible',open);
    openList.setAttribute('aria-expanded',String(open));
    if (open) document.querySelector('#sessions-close').focus();
    else if (document.activeElement?.closest('#sessions') && openList.getClientRects().length) openList.focus();
  }
  openList.addEventListener('click',()=>toggleList(true));
  document.querySelector('#sessions-close').addEventListener('click',()=>toggleList(false));
  document.addEventListener('keydown',event=>{
    if (event.key !== 'Escape') return;
    if (tooltipAnchor) hideGroupTooltip();
    else if (document.body.classList.contains('sessions-visible')) toggleList(false);
  });
  function homeAction() {
    toggleList(false);
    showHome();
    document.querySelector('#message').focus();
  }
  create.addEventListener('click',homeAction);
  homeButton.addEventListener('click',homeAction);
  list.addEventListener('click',event=>{
    const row = event.target.closest('.session-entry');
    if (!row) return;
    toggleList(false);
    if (row.dataset.id !== selectedId || !session) void open(row.dataset.id);
  });
  send.addEventListener('click',()=>void submit());
  stop.addEventListener('click',async()=>{
    if (!session) return;
    stop.disabled = true;
    try { await request('stop',{id:session.id}); }
    catch (error) { say(error.message); }
    finally { stop.disabled = false; }
  });

  return {
    get group() { return group; },
    get session() { return session; },
    get busy() { return busy; },
    render, say, submit, reloadGroup, refreshList,
    applyTitle(id,title) {
      if (session?.id === id) {
        session = {...session,title};
        if (group) group = {...group,title};
        render();
      }
      void refreshList().catch(()=>{});
    },
    applyGroup(id,next) {
      if (session?.id !== id) return;
      ++groupRequest;
      group = next;
      render();
      onChange(false);
    },
    async connect() {
      try {
        create.disabled = homeButton.disabled = true;
        if (session) {
          if (session.provisional) {
            render();
            await refreshList();
          } else await open(session.id);
        } else {
          const route = new URLSearchParams(location.hash.slice(1)).get('chat');
          const rows = await refreshList();
          if (route && rows.some(row=>row.id===route)) await open(route);
          else showHome();
        }
        create.disabled = homeButton.disabled = false;
      } catch (error) {
        listStatus.textContent = error.message;
        listStatus.hidden = false;
        say(error.message);
      }
    },
    disconnected(message = '탭룸 확장에 연결 중…') {
      create.disabled = homeButton.disabled = true;
      listStatus.textContent = message;
      listStatus.hidden = false;
    },
  };
}
