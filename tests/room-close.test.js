'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
const a=source.indexOf('const roomSnapshotWrites =');
const b=source.indexOf('async function writeRoomSnapshot',a);
const c=source.indexOf('async function closeRoomNow(');
const d=source.indexOf('// ============================================================',c);
test('room closure drains an in-flight snapshot and blocks new writes before deleting',async()=>{
    let finishWrite;let started=0;let deleted=0;
    const r={id:'ABCDE',players:[],hostIds:[]};
    const context={ rooms:{ABCDE:r}, io:{to:()=>({emit:()=>{}}),sockets:{sockets:new Map()}},
        bumpRoomState:()=>1, pendingRemovals:{},pendingIndicators:{},pendingBrowserExits:new Map(),
        hostSocketRooms:{},hostRoomName:()=>'',ROOM_PERSISTENCE_ENABLED:true,
        deletePersistedRoom:async()=>{deleted++}, releaseRoomLease:async()=>{},clearGameOverTimer:()=>{},clearVoteTimer:()=>{},broadcastSuggestedRoom:()=>{},console,
        writeRoomSnapshot:async(room)=>{if(room.isClosing)return false;started++;await new Promise(resolve=>finishWrite=resolve);return true} };
    vm.createContext(context);vm.runInContext(source.slice(a,b)+source.slice(c,d),context);
    const writing=context.persistRoomSnapshot(r);await Promise.resolve();await Promise.resolve();
    assert.equal(started,1);
    const closing=context.closeRoomNow('ABCDE','idle_timeout');
    assert.equal(r.isClosing,true);assert.equal(deleted,0);
    assert.equal(await context.persistRoomSnapshot(r),false);
    finishWrite();await writing;await closing;
    assert.equal(deleted,1);assert.equal(context.rooms.ABCDE,undefined);
});
