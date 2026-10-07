const test = require('node:test');
const assert = require('node:assert/strict');
const {createBugReportStore} = require('../utils/bug-report-store');
class QueryCommand {constructor(input){this.input=input;}}
class PutCommand extends QueryCommand {}
class DeleteCommand extends QueryCommand {}
class GetCommand extends QueryCommand {}
function fixture(){
 const items=new Map();const key=k=>k.playerName+'|'+k.statKey;
 const client=async()=>({send:async command=>{
  const i=command.input;
  if(command instanceof PutCommand){items.set(key(i.Item),structuredClone(i.Item));return {};}
  if(command instanceof DeleteCommand){items.delete(key(i.Key));return {};}
  if(command instanceof GetCommand)return {Item:structuredClone(items.get(key(i.Key)))};
  const rows=[...items.values()].filter(x=>x.playerName===i.ExpressionAttributeValues[':partition']).sort((a,b)=>b.statKey.localeCompare(a.statKey));
  const start=i.ExclusiveStartKey?rows.findIndex(x=>x.statKey===i.ExclusiveStartKey.statKey)+1:0;
  const batch=rows.slice(start,start+Math.min(2,i.Limit));
  return {Items:structuredClone(batch),LastEvaluatedKey:start+batch.length<rows.length?{playerName:batch.at(-1).playerName,statKey:batch.at(-1).statKey}:undefined};
 }});
 const store=()=>createBugReportStore({client,table:'local-test',QueryCommand,PutCommand,DeleteCommand,GetCommand});
 return {store,items};
}
test('inbox survives a new store instance, paginates and shares edits/deletions',async()=>{
 const {store,items}=fixture(),first=store();
 for(let n=0;n<5;n++)await first.save({id:'r'+n,createdAt:`2026-10-07T00:00:0${n}.000Z`,message:'report '+n,status:'new'});
 const second=store();const list=await second.list(5);assert.equal(list.length,5);assert.equal(list[0].id,'r4');
 const report=list[0];report.status='closed';await second.save(report);assert.equal((await first.find(report)).status,'closed');assert.equal(items.size,5,'retry uses the same item');
 await second.remove(report);assert.equal(await first.find(report),null);assert.equal((await first.list()).length,4);
});
test('storage failures propagate so HTTP callers can retry rather than acknowledge',async()=>{
 const s=createBugReportStore({client:async()=>({send:async()=>{throw new Error('offline')}}),table:'test',QueryCommand,PutCommand,DeleteCommand,GetCommand});
 await assert.rejects(s.save({id:'x',createdAt:new Date().toISOString()}),/offline/);await assert.rejects(s.list(),/offline/);
});
