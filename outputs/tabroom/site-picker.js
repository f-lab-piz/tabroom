const resultLimit=8;
const requestInterval=300;
const cacheLifetime=30_000;
const normalize=value=>value.normalize('NFKC').toLowerCase().trim();
const compact=value=>normalize(value).replace(/\s+/g,'');

function safeUrl(value) {
  try {
    const url=new URL(value);
    if (['http:','https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* 검색 결과에 유효한 주소가 있어야 한다. */ }
  return '';
}

export function mergeSiteResults(query,addresses,deeplinks) {
  const needle=compact(query);
  const results=new Map();

  for (const [source,entries] of [['address',addresses],['deep',deeplinks]]) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const url=safeUrl(entry?.url);
      if (!url || typeof entry.title!=='string' || !entry.title.trim()) continue;
      const row=results.get(url) ?? {url};
      row[source] ??= entry;
      results.set(url,row);
    }
  }

  return [...results.values()].sort((a,b)=>priority(a)-priority(b)).slice(0,resultLimit).map(row=>({
    url:row.url,
    title:(row.address ?? row.deep).title,
    image:row.deep?.image,
    description:row.deep?.description,
  }));

  function priority(row) {
    if (row.address && needle) {
      const host=new URL(row.url).hostname.replace(/^www\./i,'');
      if (compact(row.address.title)===needle || host===needle || compact(row.url)===needle) return 0;
      if (!/\s/.test(query.trim()) && host.startsWith(needle)) return 1;
    }
    return row.deep ? 2 : 3;
  }
}

export function createSitePicker(element,request,choose,back) {
  const strip=element.querySelector('.site-results');
  const preview=element.querySelector('.site-result-preview');
  const picture=preview.querySelector('img');
  const title=preview.querySelector('strong');
  const address=preview.querySelector('.site-host');
  const description=preview.querySelector('.site-description');
  const status=element.querySelector('.search-status');
  const deepCache=new Map();
  const icons=new Map();
  const pendingIcons=new Set();
  let query='', rows=[], rowQuery='', pickedUrl, active, timer;
  let lastDeepStarted=-Infinity;
  const selected=()=>rows.find(row=>row.url===pickedUrl) ?? rows[0];

  function fillIcons() {
    const urls=rows.map(site=>site.url).filter(url=>!icons.has(url) && !pendingIcons.has(url));
    if (!urls.length) return;
    for (const url of urls) pendingIcons.add(url);
    void request('sites/icons',{urls}).then(result=>{
      for (const url of urls) icons.set(url,result?.[url] ?? '');
      while (icons.size>60) icons.delete(icons.keys().next().value);
      for (const button of strip.children) {
        const value=icons.get(button.dataset.url);
        if (/^data:image\/png;base64,/.test(value ?? '')) button.querySelector('.site-result-icon').src=value;
      }
    }).catch(()=>{}).finally(()=>{
      for (const url of urls) pendingIcons.delete(url);
    });
  }

  function showSelection(scroll=false) {
    const site=selected();
    preview.hidden=!site;
    if (!site) return;
    for (const button of strip.children) {
      const isSelected=button.dataset.url===site.url;
      button.setAttribute('aria-pressed',String(isSelected));
      if (isSelected && scroll) {
        const a=button.getBoundingClientRect(), b=strip.getBoundingClientRect();
        if (a.left<b.left) strip.scrollLeft-=b.left-a.left;
        else if (a.right>b.right) strip.scrollLeft+=a.right-b.right;
      }
    }
    title.textContent=site.title;
    address.textContent=site.url.replace(/^https?:\/\//,'');
    address.title=site.url;
    description.textContent=site.description || '';
    description.hidden=!site.description;
    const image=/^\/deeplinks\/[a-z0-9-]+\.jpg$/.test(site.image) ? site.image : '';
    if (image!==picture.getAttribute('src')) {
      picture.hidden=!image;
      if (image) picture.src=image;
      else picture.removeAttribute('src');
    }
  }

  function render() {
    const scroll=strip.scrollLeft;
    strip.replaceChildren(...rows.map(site=>{
      const button=document.createElement('button');
      button.type='button';
      button.className='site-result';
      button.dataset.url=site.url;
      button.title=site.title;
      const iconSlot=document.createElement('span');
      iconSlot.className='site-result-icon-slot';
      iconSlot.textContent=[...site.title.trim()][0] ?? '';
      iconSlot.setAttribute('aria-hidden','true');
      const icon=document.createElement('img');
      icon.alt='';
      icon.className='site-result-icon';
      const favicon=icons.get(site.url);
      if (/^data:image\/png;base64,/.test(favicon ?? '')) icon.src=favicon;
      iconSlot.append(icon);
      const label=document.createElement('span');
      label.textContent=site.title;
      button.append(iconSlot,label);
      button.addEventListener('mousedown',event=>event.preventDefault());
      button.addEventListener('click',()=>{
        pickedUrl=site.url;
        showSelection(true);
      });
      return button;
    }));
    strip.scrollLeft=scroll;
    strip.hidden=!rows.length;
    status.textContent=rows.length ? '' : !query ? '주소나 찾고 싶은 페이지를 입력하세요.'
      : active?.remaining ? '검색 중…' : '검색 결과가 없어요.';
    status.hidden=!status.textContent;
    showSelection(true);
    fillIcons();
  }

  function apply(search,source,result) {
    if (active!==search) return;
    search[source]=result;
    search.remaining--;
    const merged=mergeSiteResults(search.query,search.address,search.deep);
    if (merged.length || !search.remaining) {
      rows=merged;
      rowQuery=search.query;
    }
    render();
  }

  function chooseSelected(keepOpen) {
    const site=selected();
    if (site && rowQuery===query) choose({...site,favicon:icons.get(site.url)},keepOpen);
  }

  picture.addEventListener('error',()=>{picture.hidden=true;});
  preview.addEventListener('mousedown',event=>event.preventDefault());
  preview.addEventListener('click',()=>chooseSelected(false));

  return {
    set(value) {
      const next=value.trim();
      if (next===query) { render(); return; }
      clearTimeout(timer);
      active?.controller.abort();
      query=next;
      if (!query) { this.clear(); render(); return; }
      const search={query,controller:new AbortController(),remaining:2};
      active=search;
      render();
      const cacheKey=normalize(query);
      const cached=deepCache.get(cacheKey);
      if (cached && Date.now()-cached.at<cacheLifetime) {
        apply(search,'deep',cached.rows);
      } else {
        timer=setTimeout(async()=>{
          if (active!==search) return;
          lastDeepStarted=performance.now();
          try {
            const response=await fetch('/api/deeplinks',{method:'POST',signal:search.controller.signal,
              headers:{'Content-Type':'application/json'},body:JSON.stringify({query:search.query})});
            const result=response.ok ? await response.json() : [];
            if (active!==search) return;
            if (response.ok) {
              deepCache.delete(cacheKey);
              deepCache.set(cacheKey,{at:Date.now(),rows:result});
              if (deepCache.size>40) deepCache.delete(deepCache.keys().next().value);
            }
            apply(search,'deep',result);
          } catch { apply(search,'deep',[]); }
        },Math.max(0,requestInterval-(performance.now()-lastDeepStarted)));
      }
      void request('sites/search',{query:search.query}).then(
        result=>apply(search,'address',result),()=>apply(search,'address',[]));
    },
    clear() {
      clearTimeout(timer);
      active?.controller.abort();
      active=undefined;
      query=rowQuery='';
      rows=[];
      pickedUrl=undefined;
    },
    key(key,keepOpen) {
      if (key==='Enter') {
        chooseSelected(keepOpen);
        return true;
      }
      if (key==='ArrowUp' || key==='ArrowDown') {
        if (!query && key==='ArrowUp') back();
        return true;
      }
      if (!rows.length || !['ArrowLeft','ArrowRight'].includes(key)) return false;
      const next=(rows.indexOf(selected())+rows.length+(key==='ArrowLeft' ? -1 : 1))%rows.length;
      pickedUrl=rows[next].url;
      showSelection(true);
      return true;
    },
  };
}
