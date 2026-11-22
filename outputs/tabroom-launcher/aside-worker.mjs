import {parentPort, workerData} from 'node:worker_threads';
import {createRuntime} from './aside/sdk/runtime.mjs';

const pending = new Map();
let serial = 0;
let runtime;
const transport = (operation, params) => {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id,{resolve,reject});
    parentPort.postMessage({type:'transport',id,operation,params});
  });
};

parentPort.on('message', message => {
  if (message.type === 'transportResult') {
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(Error(message.error));
    else call.resolve(message.result);
  } else if (message.type === 'event') {
    runtime?.onEvent(message.event,message.data);
  } else if (message.type === 'execute') {
    void execute(message);
  }
});

async function execute({id,code}) {
  try {
    const result = await runtime.runCode(code,{timeoutMs:120000});
    parentPort.postMessage({type:'executed',id,content:result.content,error:result.error});
  } catch (error) {
    parentPort.postMessage({type:'executed',id,content:[],error:String(error.message)});
  }
}

try {
  runtime = await createRuntime({...workerData,transport});
  parentPort.postMessage({type:'ready'});
} catch (error) {
  parentPort.postMessage({type:'initError',error:String(error.message)});
}
