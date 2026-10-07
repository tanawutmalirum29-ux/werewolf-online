'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'../public/js/host.main.js'),'utf8');
const begin = source.indexOf('let hostRecoveryTimer = null;');
const end = source.indexOf('// DISCONNECT',begin);
function harness() {
    let ack; const calls = []; const timers = [];
    const socket = { connected:true, timeout:()=>socket, emit:(event,...args)=>{calls.push(event); if(event==='host_login')ack=args.at(-1)} };
    const c = { socket, roomId:'ABCDE', hostToken:'secret', getSavedRoomPassword:()=>'', getPersistedHostName:()=>'', showHostRecoveryNotice:()=>{}, clearTimeout:()=>{}, setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length}, document:{ createElement:()=>({style:{},remove:()=>{}}),body:{appendChild:()=>{}} }, hostStorage:{removeItem:()=>{}}, wwHostLoginFailText:()=>'', returnFromHostScreen:()=>{} };
    vm.createContext(c);vm.runInContext(source.slice(begin,end),c);
    return { c, calls, timers, reply:(err,res)=>ack(err,res), run:(code)=>vm.runInContext(code,c) };
}
test('successful rejoin requests full sync without missing UI function',()=>{
    const h=harness();h.run('wwHostRelogin(0)');h.reply(null,{ok:true,roomData:{}});
    assert.deepEqual(h.calls,['host_login','request_sync']);
});
test('missing acknowledgement retries and keeps the room identity',()=>{
    const h=harness();h.run('wwHostRelogin(0)');h.reply(new Error('timeout'));
    assert.equal(h.c.roomId,'ABCDE');assert.equal(h.timers.length,1);assert.ok(h.timers[0].ms<=4000);
});
test('transient recovery continues beyond the former twenty retry limit',()=>{
    const h=harness();h.run('wwHostRelogin(25)');h.reply(null,{code:'ROOM_FAILOVER_WAIT'});
    assert.equal(h.timers.length,1);h.timers[0].fn();assert.equal(h.calls.length,2);
});
test('wake triggers cannot issue concurrent rejoin requests',()=>{
    const h=harness();h.run('wwHostRelogin(0);wwHostRelogin(0);');assert.equal(h.calls.length,1);
});
test('an acknowledgement for an old room cannot affect the current room',()=>{
    const h=harness();h.run('wwHostRelogin(0)');h.c.roomId='OTHER';h.reply(null,{ok:true});
    assert.deepEqual(h.calls,['host_login']);
});
test('offline mutation is rejected without entering the socket send buffer',()=>{
    const calls=[];const socket={connected:false,emit:(...args)=>{calls.push(args);return socket}};
    const c={socket,roomId:'ABCDE',hostControlReady:false,document:{getElementById:()=>null},result:null};
    vm.createContext(c);const a=source.indexOf('const hostRecoveryActions =');const b=source.indexOf('function showHostRecoveryNotice',a);
    vm.runInContext(source.slice(a,b),c);vm.runInContext('socket.emit("start_game",{},r=>result=r)',c);
    assert.equal(c.result.code,'HOST_RECONNECTING');assert.equal(calls.length,0);
    vm.runInContext('socket.emit("host_login",{})',c);assert.equal(calls.length,1);
});
