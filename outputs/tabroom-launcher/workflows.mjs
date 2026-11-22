import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {snapshotTabs} from './tab-groups.mjs';

export const skillNamePattern=/^[a-z0-9][a-z0-9-]{0,47}$/;
const defaults=['이 탭들의 핵심 내용을 요약해줘','이 탭들의 공통점과 차이점을 비교해줘','다음에 할 일을 체크리스트로 정리해줘'];
const starters=prompts=>prompts.flatMap((prompt,i)=>prompt.trim() ?
  [{id:'starter-'+(i+1),title:prompt.trim(),parts:[{text:prompt.trim()}]}] : []);

function field(value,max,label) {
  const text=typeof value==='string' ? value.trim() : '';
  if (!text || [...text].length>max) throw Error(label+'을 표시된 길이 안에서 입력해주세요.');
  return text;
}

function write(path,data) {
  const temporary=path+'.tmp';
  writeFileSync(temporary,data,{mode:0o600});
  renameSync(temporary,path);
}

export function readTabGroup(value) {
  const title=field(value?.title,42,'탭그룹 이름');
  const urls=value?.urls;
  if (!Array.isArray(urls) || !urls.length || urls.length>100 ||
      urls.some(url=>typeof url!=='string' || url.length>4096)) {
    throw Error('탭그룹의 웹 주소를 확인해주세요.');
  }
  const tabs=snapshotTabs(urls.map(url=>({url})));
  if (tabs.length!==urls.length) throw Error('탭그룹에는 http 또는 https 주소를 사용해주세요.');
  return {title,urls:tabs.map(tab=>tab.url),...(value.site===true && tabs.length===1 && {site:true})};
}

function readTaskParts(input) {
  if (!Array.isArray(input) || input.length>100) throw Error('작업 문구를 확인해주세요.');
  const parts=input.map(part=>{
    if (typeof part?.text==='string') return {text:part.text};
    if (part?.tabGroup) return {tabGroup:readTabGroup(part.tabGroup)};
    throw Error('작업에는 문구와 탭그룹 칩을 넣을 수 있어요.');
  }).filter(part=>part.tabGroup || part.text);
  const text=parts.flatMap(part=>part.text===undefined ? [] : [part.text]).join('');
  const groups=parts.filter(part=>part.tabGroup);
  if (groups.length>1) throw Error('작업 하나에 탭그룹 칩 하나를 넣을 수 있어요.');
  if ((!text.trim() && !groups.length) || text.length>4000) throw Error('작업 문구를 4,000자 이내로 입력해주세요.');
  return parts;
}

export function profileWorkflows(base,profile) {
  const root=join(base,'workflows',profile);
  const taskFile=join(root,'quick-tasks.json');
  const skillRoot=join(root,'skills');
  const skillPath=name=>join(skillRoot,name,'SKILL.md');

  function tasks() {
    try { return JSON.parse(readFileSync(taskFile,'utf8')); }
    catch (error) {
      if (error.code!=='ENOENT') throw error;
      return {imported:false,tasks:starters(defaults)};
    }
  }

  function saveTasks(data) {
    mkdirSync(root,{recursive:true,mode:0o700});
    write(taskFile,JSON.stringify(data));
  }

  function readSkill(name) {
    if (typeof name!=='string'||!skillNamePattern.test(name)) return null;
    let document;
    try { document=readFileSync(skillPath(name),'utf8'); }
    catch (error) {
      if (error.code==='ENOENT') return null;
      throw error;
    }
    const meta=/^---\n([\s\S]+?)\n---\n/.exec(document)?.[1];
    if (!meta) return null;
    const fields=Object.fromEntries(meta.trim().split('\n').map(line=>{
      const colon=line.indexOf(':');
      return [line.slice(0,colon),JSON.parse(line.slice(colon+1))];
    }));
    return {name,title:fields.title,description:fields.description,automatic:false,document};
  }

  return {
    listTasks(legacy) {
      const data=tasks();
      if (!data.imported && Array.isArray(legacy) && legacy.length===3 &&
          legacy.every(value=>typeof value==='string' && value.length<=200)) {
        data.imported=true;
        data.tasks=[...starters(legacy),...data.tasks.filter(task=>!task.id.startsWith('starter-'))];
        saveTasks(data);
      }
      return data.tasks;
    },
    saveTask({id,title,parts}) {
      const data=tasks();
      const index=id ? data.tasks.findIndex(task=>task.id===id) : -1;
      if (id && index===-1) throw Error('수정할 작업을 찾을 수 없어요.');
      const task={id:id || randomUUID(),title:field(title,200,'작업 이름'),parts:readTaskParts(parts)};
      if (index===-1) data.tasks.push(task);
      else {
        data.tasks[index]=task;
        if (id.startsWith('starter-')) data.imported=true;
      }
      saveTasks(data);
      return task;
    },
    readSkill,
    listSkills() {
      let names;
      try { names=readdirSync(skillRoot,{withFileTypes:true}); }
      catch (error) {
        if (error.code==='ENOENT') return [];
        throw error;
      }
      return names.filter(entry=>entry.isDirectory()).map(entry=>readSkill(entry.name)).filter(Boolean)
        .map(({document,...meta})=>meta).sort((a,b)=>a.title.localeCompare(b.title,'ko'));
    },
    createSkill({name,title,description,body}) {
      if (typeof name!=='string'||!skillNamePattern.test(name)) throw Error('스킬 ID는 영문 소문자, 숫자와 하이픈을 사용해주세요.');
      if (readSkill(name)) throw Error('이미 같은 ID의 스킬이 있어요.');
      title=field(title,60,'스킬 이름').replace(/\s+/g,' ');
      description=field(description,200,'스킬 설명').replace(/\s+/g,' ');
      body=field(body,12000,'스킬 지침');
      const path=skillPath(name);
      mkdirSync(join(skillRoot,name),{recursive:true,mode:0o700});
      write(path,'---\n'+Object.entries({name,title,description}).map(([key,value])=>key+': '+JSON.stringify(value)).join('\n')+'\n---\n\n'+body+'\n');
      return {name,title,description,automatic:false};
    },
  };
}
