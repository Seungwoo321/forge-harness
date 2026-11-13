import {chmod,cp,lstat,mkdtemp,readdir,readFile,readlink,realpath,rm,writeFile,mkdir,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAdapters} from './lib/adapters.mjs';
import {executeCapturedGate,capturedGateReport,persistCapturedReport} from './lib/gate-execution.mjs';
import {parseGateReport} from './lib/evidence.mjs';

export async function describeRepositorySelfTests({cwd=process.cwd(),command=createAdapters().command}={}) {
  const listed=await command('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd});
  if(listed.exitCode!==0)throw new Error(listed.stderr);
  const files=[];
  for(const name of [...new Set(listed.stdout.split('\0').filter(Boolean))].sort()){
    const file=path.join(cwd,name),stat=await lstat(file);
    if(!stat.isFile() && !stat.isSymbolicLink())throw new Error(`unsupported repository input: ${name}`);
    files.push({path:name,content:stat.isSymbolicLink() ? await readlink(file) : await readFile(file),mode:stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644'});
  }
  const version=await command('pnpm',['--version'],{cwd});
  const manifest=JSON.parse(await readFile(path.join(cwd,'package.json'),'utf8'));
  if(manifest.packageManager!==`pnpm@${version.stdout.trim()}`)throw new Error('installed pnpm does not match the repository packageManager');
  const launcher=await command('which',['pnpm'],{cwd});
  const manager=await command('pnpm',['exec','node','-p','process.env.npm_execpath'],{cwd});
  if([version,launcher,manager].some(result=>result.exitCode!==0))throw new Error('pnpm runtime discovery failed');
  const pnpmExecutable=await realpath(manager.stdout.trim().split('\n').at(-1));
  const runtimePaths=[path.dirname(path.dirname(await realpath(launcher.stdout.trim()))),path.dirname(path.dirname(path.dirname(path.dirname(pnpmExecutable))))];
  if(process.platform==='darwin'){
    const developer=await command('xcode-select',['-p'],{cwd});
    if(developer.exitCode!==0)throw new Error(developer.stderr);
    runtimePaths.push(path.dirname(await realpath(developer.stdout.trim())));
  }
  return {id:'tests',format:'tap',acPattern:'AC-[0-9]+',command:[process.execPath,'scripts/verify-self-tests.mjs','--inside',pnpmExecutable],
    files,config:{nestedIsolation:'sibling-sandbox',runtimePaths},outputDirectories:['work'],toolVersions:{node:process.version,pnpm:version.stdout.trim()}};
}

export async function prepareSelfTestEnvironment(pnpmExecutable){
  await writeFile(path.join(process.env.TMPDIR,'package.json'),JSON.stringify({}));
  const home=path.join(process.env.TMPDIR,'home'),bin=path.join(process.env.TMPDIR,'runtime/pnpm/current/bin');
  await mkdir(home);await mkdir(bin,{recursive:true});await symlink(pnpmExecutable,path.join(bin,'pnpm'));
  Object.assign(process.env,{HOME:home,PNPM_HOME:path.join(home,'pnpm'),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',pnpm_config_pm_on_fail:'ignore'});
  process.env.PATH=`${bin}${path.delimiter}${process.env.PATH}`;
  if(process.platform==='darwin'){
    const developer=await createAdapters().command('xcode-select',['-p']);
    if(developer.exitCode!==0)throw new Error(developer.stderr);
    process.env.PATH=`${path.join(developer.stdout.trim(),'usr/bin')}${path.delimiter}${process.env.PATH}`;
  }
}

async function runInside(pnpmExecutable){
  await prepareSelfTestEnvironment(pnpmExecutable);
  const root=process.cwd(),work=path.join(root,'work');
  for(const name of await readdir(root)){
    if(name!=='work' && name!=='.forge-gate-tmp')await cp(path.join(root,name),path.join(work,name),{recursive:true});
  }
  async function writable(directory){
    await chmod(directory,0o700);
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())await writable(file);
      else if(entry.isFile())await chmod(file,(await lstat(file)).mode & 0o111 ? 0o700 : 0o600);
    }
  }
  await writable(work);
  const result=await createAdapters().command(process.execPath,['--test','--test-concurrency=4','--test-reporter=tap','scripts/**/*.test.mjs'],{cwd:work});
  process.stdout.write(result.stdout);process.stderr.write(result.stderr);
  process.exitCode=Number.isInteger(result.exitCode) && !result.signal ? result.exitCode : 2;
}

async function main(){
  if(process.argv[2]==='--inside'){
    if(process.argv.length!==4 || !path.isAbsolute(process.argv[3]))throw new Error('self-test bootstrap requires the captured pnpm executable');
    return runInside(process.argv[3]);
  }
  if(process.argv.length!==2)throw new Error('usage: node scripts/verify-self-tests.mjs');
  const sourceRoot=await realpath(process.cwd()),gate=await describeRepositorySelfTests({cwd:sourceRoot});
  const directory=await mkdtemp(path.join(os.tmpdir(),'repository-self-tests-'));
  try{
    const execution=await executeCapturedGate({gate,sourceRoot,directory,command:createAdapters().command});
    const reportPath=await persistCapturedReport({stateRoot:path.join(sourceRoot,'.local/verification'),unit:'self-tests',content:execution.stdout});
    const result=capturedGateReport({gate,execution,reportPath});
    const parsed=parseGateReport({...gate,...result,result});
    const {report,...summary}=result;
    console.log(JSON.stringify({...summary,ok:parsed.ok,inputCount:gate.files.length,toolVersions:gate.toolVersions,
      digest:parsed.digest,tests:parsed.tests?.length ?? 0,...(parsed.reason ? {reason:parsed.reason} : {}),stderr:execution.stderr},null,2));
    process.exitCode=parsed.ok ? 0 : 1;
  }finally{await rm(directory,{recursive:true,force:true});}
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
