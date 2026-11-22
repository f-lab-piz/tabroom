import {readFileSync} from 'node:fs';

const read = path => readFileSync(new URL(path,import.meta.url),'utf8');
const skills = new Map([
  ['tabroom-browser','브라우저','웹페이지나 탭을 조회하고 조작할 때 사용',true],
  ['tabroom-interactive-ui','인터랙티브 UI','값을 바꾸거나 옵션을 고르는 응답을 만들 때 사용',true],
  ['quick-task-creator','자주 쓰는 작업 만들기','반복 요청과 선택 사항인 탭그룹을 함께 저장',false],
  ['skill-creator','스킬 만들기','반복할 절차를 Markdown 스킬로 만들고 등록',false],
].map(([name,title,description,automatic])=>[name,{
  name,title,description,automatic,text:read('./skills/'+name+'/SKILL.md'),
}]));
const purpose = {type:'string',minLength:1,maxLength:140,
  description:"Short concrete purpose shown in chat in the user's language. Describe the intended outcome without private input values."};

export const tools = [
  {name:'browser_profiles',description:'Read the current Tabroom Chrome profile.',properties:{}},
  {name:'browser_repl',description:'Run JavaScript with the Tabroom Chrome browser tools. Use browser_guide for browser API details.',
    properties:{code:{type:'string',description:'JavaScript to run in the browser REPL.'},profile_id:{type:'string'}},required:['code']},
  {name:'browser_guide',description:'Read the browser manual or look up a browser API by name. Set topic to api for the browser API index.',
    properties:{topic:{type:'string',enum:['repl','main','api','scope']},api:{type:'string',minLength:1,maxLength:160}}},
  {name:'listTabBundles',description:'List named saved tab groups in the current Chrome profile.',properties:{}},
  {name:'saveTabBundle',description:'Save the current chat’s open group for later reuse with the supplied name.',
    properties:{name:{type:'string',minLength:1,maxLength:42}},required:['name']},
  {name:'loadTabBundle',description:'Open a saved group in this chat when it has no open group. Use the ID returned by listTabBundles.',
    properties:{bundleId:{type:'string'}},required:['bundleId']},
  {name:'load_skill',description:'Read a Tabroom skill by its registered name. Discover skills with list_skills.',
    properties:{name:{type:'string',minLength:1,maxLength:48}},required:['name'],withPurpose:false},
  {name:'list_skills',description:'List available skill names and short descriptions for this Chrome profile.',
    properties:{},withPurpose:false},
  {name:'create_skill',description:'Register a reusable Markdown skill requested by the user.',
    properties:{name:{type:'string'},title:{type:'string'},description:{type:'string'},body:{type:'string'}},
    required:['name','title','description','body']},
  {name:'save_quick_task',description:'Save an ordered draft. A tab group chip is stored as an independent copy at its position in the draft.',
    properties:{id:{type:'string'},title:{type:'string'},parts:{type:'array',minItems:1,maxItems:100,items:{anyOf:[
      {type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
      {type:'object',properties:{bundleId:{type:'string'}},required:['bundleId'],additionalProperties:false},
      {type:'object',properties:{tabGroup:{type:'object',properties:{
        title:{type:'string'},urls:{type:'array',items:{type:'string'},minItems:1,maxItems:100},
      },required:['title','urls'],additionalProperties:false}},required:['tabGroup'],additionalProperties:false},
    ]}}},required:['title','parts']},
].map(({name,description,properties,required=[],withPurpose=true})=>({type:'function',name,description,inputSchema:{
  type:'object',properties:withPurpose ? {...properties,purpose} : properties,
  required:withPurpose ? [...required,'purpose'] : required,additionalProperties:false,
}}));

export const instructions = read('./AGENT.md');

export function getSkill(name) {
  return skills.get(name)?.text;
}

export function listBuiltinSkills() {
  return [...skills.values()].map(({text,...meta})=>meta);
}

export function toolActivity(tool,args,customSkill) {
  if (!tools.some(spec=>spec.name===tool)) return null;
  if (tool==='load_skill') {
    const skill=skills.get(args?.name) ?? customSkill;
    return skill ? {kind:'skill',text:skill.title+' 스킬 로드하기'} : null;
  }
  if (tool==='list_skills') return {kind:'skill',text:'사용 가능한 스킬 확인하기'};
  const kind = tool==='browser_guide' ? 'guide' : ['create_skill','save_quick_task'].includes(tool) ? 'skill' : 'browser';
  const raw = args?.purpose;
  const text = typeof raw === 'string' && raw.trim().length <= 140 ? raw.trim().replace(/\s+/g,' ') : '';
  return text ? {kind,text} : null;
}
