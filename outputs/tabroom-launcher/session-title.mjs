import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function apiKey(dataDir) {
  try {
    const source = process.env.TABROOM_TITLE_API_KEY_FILE || readFileSync(join(dataDir,'title-api-key-file'),'utf8').trim();
    return /^(?:[ \t]*export[ \t]+)?[ \t]*OPENAI_API_KEY[ \t]*=[ \t]*['"]?(sk-[A-Za-z0-9_-]{20,})/m.exec(readFileSync(source,'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

export async function generateSessionTitle(parts,dataDir) {
  const query = parts.map(part=>part.text ?? ' ').join('').trim().slice(0,3000);
  const key = query && apiKey(dataDir);
  if (!key) return null;

  try {
    const response = await fetch('https://api.openai.com/v1/responses',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'gpt-6-luna',store:false,reasoning:{effort:'none'},max_output_tokens:100,
        instructions:'Write a short chat title in the language of the user’s first request. Describe its main goal in at most 42 characters. Do not answer the request or include URLs or sensitive identifiers.',
        input:query,
        text:{format:{type:'json_schema',name:'session_title',strict:true,schema:{
          type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false,
        }}},
      }),
    });
    if (!response.ok) {
      console.warn('Tabroom title request failed (HTTP %d)',response.status);
      await response.body?.cancel();
      return null;
    }
    const result = await response.json();
    if (result.status!=='completed') return null;
    const output = result.output.find(item=>item.type==='message')?.content.find(item=>item.type==='output_text');
    const title = JSON.parse(output?.text ?? '{}').title;
    if (typeof title!=='string') return null;
    return [...title.replace(/[\s\u0000-\u001f\u007f]+/g,' ').trim()].slice(0,42).join('').trimEnd() || null;
  } catch {
    return null;
  }
}
