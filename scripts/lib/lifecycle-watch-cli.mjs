import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createWatchIO } from './lifecycle-watch-io.mjs';
import { createWatchStore, registerWatch, changeWatch } from './lifecycle-watch.mjs';
import { ensureWatchRunner } from './lifecycle-watch-runner.mjs';
import { formatCliResult } from './report.mjs';

export async function watchStateRoot({options={},cwd,io}) {
  if (options['state-root']) return path.resolve(cwd,options['state-root']);
  const result = await io.command('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd});
  if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error('watch state root unavailable');
  return path.join(result.stdout.trim(),'work-state');
}

export async function runWatchCli({positional,options,cwd,io=createWatchIO()}) {
  const [,,action,watchId,...extra] = positional;
  if (extra.length || !['add','list','pause','resume','hold','remove','reconcile','status'].includes(action)
    || (['pause','resume','hold','remove','reconcile'].includes(action) ? !watchId : watchId)) throw Object.assign(new Error('unit watch add|list|pause|resume|hold|remove|reconcile|status [id]'),{code:'CLI_USAGE'});
  const stateRoot = await watchStateRoot({options,cwd,io});
  let result, runner;
  try {
    if (action === 'add') {
      if (!options.request) throw new Error('watch add requires --request');
      result = await registerWatch({stateRoot,io,request:JSON.parse(await readFile(path.resolve(cwd,options.request),'utf8'))});
    } else if (['list','status'].includes(action)) result = await createWatchStore(stateRoot,io).read();
    else result = await changeWatch({stateRoot,io,id:watchId,action});
  } finally {
    // Read-only commands also recover an absent runner. Failed mutations preserve existing watches.
    runner = await ensureWatchRunner({stateRoot,io});
  }
  return formatCliResult({code:0,summary:`Watch ${action}`,details:{stateRoot,result,runner}});
}
