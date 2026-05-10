
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server,{
  cors:{origin:"*"}
});

app.use(express.static("public"));

const rooms = {};

function emitRoom(roomCode){
  io.to(roomCode).emit("roomData", rooms[roomCode]);
}

io.on("connection",(socket)=>{

  socket.on("createRoom",(data)=>{

    rooms[data.roomCode]={
      roomCode:data.roomCode,
      started:false,
      phase:"กลางคืน",
      logs:[],
      roles:data.roles || [],
      players:[]
    };

    socket.join(data.roomCode);

    socket.emit("roomCreated",rooms[data.roomCode]);
  });

  socket.on("joinRoom",({roomCode,name})=>{

    const room=rooms[roomCode];

    if(!room){
      socket.emit("errorMessage","ไม่พบห้อง");
      return;
    }

    const already=room.players.find(
      p=>p.name===name
    );

    if(already){
      already.id=socket.id;
      socket.join(roomCode);
      emitRoom(roomCode);
      return;
    }

    room.players.push({
      id:socket.id,
      name,
      role:null,
      alive:true,
      action:"-",
      target:null,
      memory:{
        killed:false,
        protected:false,
        muted:false,
        poisoned:false,
        cursed:false,
        notes:""
      }
    });

    socket.join(roomCode);

    emitRoom(roomCode);
  });

  socket.on("getRoom",(roomCode)=>{
    if(rooms[roomCode]){
      socket.emit("roomData",rooms[roomCode]);
    }
  });

  socket.on("startGame",(roomCode)=>{

    const room=rooms[roomCode];

    if(!room) return;

    const shuffled=[...room.roles]
    .sort(()=>Math.random()-0.5);

    room.players.forEach((player,index)=>{

      player.role=shuffled[index] || "Villager";

      if(player.role==="นักล่าหัว"){

        const targets=room.players.filter(
          p=>p.name!==player.name && p.role!=="หมาป่า"
        );

        if(targets.length>0){
          player.target=
          targets[
            Math.floor(Math.random()*targets.length)
          ].name;
        }
      }
    });

    room.started=true;

    emitRoom(roomCode);
  });

  socket.on("setAction",({roomCode,name,action})=>{

    const room=rooms[roomCode];
    if(!room) return;

    const player=room.players.find(
      p=>p.name===name
    );

    if(player){
      player.action=action;
      emitRoom(roomCode);
    }
  });

  socket.on("killPlayer",({roomCode,name})=>{

    const room=rooms[roomCode];
    if(!room) return;

    const player=room.players.find(
      p=>p.name===name
    );

    if(player){
      player.alive=false;
      room.logs.unshift({
        text:`${name} ถูกฆ่า`,
        time:new Date().toLocaleTimeString()
      });
      emitRoom(roomCode);
    }
  });

  socket.on("revivePlayer",({roomCode,name})=>{

    const room=rooms[roomCode];
    if(!room) return;

    const player=room.players.find(
      p=>p.name===name
    );

    if(player){
      player.alive=true;
      emitRoom(roomCode);
    }
  });

  socket.on("toggleMemory",({roomCode,name,type})=>{

    const room=rooms[roomCode];
    if(!room) return;

    const player=room.players.find(
      p=>p.name===name
    );

    if(player){
      player.memory[type]=!player.memory[type];
      emitRoom(roomCode);
    }
  });

  socket.on("updateNotes",({roomCode,name,value})=>{

    const room=rooms[roomCode];
    if(!room) return;

    const player=room.players.find(
      p=>p.name===name
    );

    if(player){
      player.memory.notes=value;
      emitRoom(roomCode);
    }
  });

  socket.on("setPhase",({roomCode,phase})=>{

    const room=rooms[roomCode];
    if(!room) return;

    room.phase=phase;

    room.logs.unshift({
      text:`เปลี่ยนเป็น${phase}`,
      time:new Date().toLocaleTimeString()
    });

    emitRoom(roomCode);
  });

});
socket.on("kickPlayer",({roomCode,name})=>{

  const room = rooms[roomCode];

  if(!room) return;

  room.players =
  room.players.filter(
    p=>p.name !== name
  );

  emitRoom(roomCode);

});

socket.on("closeRoom",(roomCode)=>{

  if(!rooms[roomCode]) return;

  io.to(roomCode).emit(
    "roomClosed"
  );

  delete rooms[roomCode];

});

socket.on("hostLeave",(roomCode)=>{

  if(!rooms[roomCode]) return;

  io.to(roomCode).emit(
    "roomClosed"
  );

  delete rooms[roomCode];

});

socket.on("disconnect",()=>{

  for(const roomCode in rooms){

    const room = rooms[roomCode];

    room.players =
    room.players.filter(
      p=>p.id !== socket.id
    );

    emitRoom(roomCode);

  }

});
socket.on(
  "kickPlayer",
  ({roomCode,name})=>{

    const room =
    rooms[roomCode];

    if(!room) return;

    const kickedPlayer =
    room.players.find(
      p=>p.name===name
    );

    if(kickedPlayer){

      io.to(
        kickedPlayer.id
      ).emit(
        "kicked"
      );

    }

    room.players =
    room.players.filter(
      p=>p.name!==name
    );

    emitRoom(roomCode);

  }
);
socket.on(
  "getAllRooms",
  ()=>{

    socket.emit(
      "allRooms",
      Object.values(rooms)
    );

  }
);
server.listen(process.env.PORT || 3000,()=>{
  console.log("Server running");
});
