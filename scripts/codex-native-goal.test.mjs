import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readCodexNativeGoal} from './lib/codex-native-goal.mjs';

test('native goals are read without loading or mutating the live thread',async t=>{
 const account=await mkdtemp(path.join(os.tmpdir(),'native-goal-'));t.after(()=>rm(account,{recursive:true,force:true}));
 const file=path.join(account,'goals_1.sqlite'),thread='11111111-1111-4111-8111-111111111111';
 const database=new DatabaseSync(file);
 database.exec('CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY,goal_id TEXT,objective TEXT,status TEXT,created_at_ms INTEGER,updated_at_ms INTEGER)');
 database.prepare('INSERT INTO thread_goals VALUES(?,?,?,?,?,?)').run(thread,'goal','Read both packets','active',1234000,1235000);database.close();
 const before=await readFile(file);
 assert.deepEqual(readCodexNativeGoal(thread,account),{threadId:thread,id:'goal',objective:'Read both packets',status:'active',createdAt:1234,updatedAt:1235});
 assert.equal(readCodexNativeGoal('22222222-2222-4222-8222-222222222222',account),null);
 assert.deepEqual(await readFile(file),before);
 assert.throws(()=>readCodexNativeGoal('../escape',account),TypeError);
 const update=new DatabaseSync(file);update.prepare('UPDATE thread_goals SET status = ? WHERE thread_id = ?').run('unknown',thread);update.close();
 assert.throws(()=>readCodexNativeGoal(thread,account),/unsupported native goal record/);
});

test('an unavailable native store is not created or interpreted as an absent goal',async t=>{
 const account=await mkdtemp(path.join(os.tmpdir(),'native-goal-missing-'));t.after(()=>rm(account,{recursive:true,force:true}));
 assert.throws(()=>readCodexNativeGoal('11111111-1111-4111-8111-111111111111',account));
 await assert.rejects(readFile(path.join(account,'goals_1.sqlite')),{code:'ENOENT'});
});
