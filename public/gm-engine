/* =========================
   GAME STATE
========================= */

const GameState = {
  room: null
};

/* =========================
   MEMORY SYSTEM (PURE LOGIC)
========================= */

function initPlayerMemory(player){

  if(!player.memory){

    player.memory = {
      killed:false,
      protected:false,
      muted:false,
      poisoned:false,
      cursed:false,
      notes:""
    };

  }

  return player;
}

/* =========================
   STATS
========================= */

function getStats(players){

  let alive = 0;
  let dead = 0;

  players.forEach(p=>{
    if(p.alive) alive++;
    else dead++;
  });

  return { alive, dead };
}

/* =========================
   ACTION HELPERS
========================= */

function formatTarget(player){
  if(player.role === "นักล่าหัว" && player.target){
    return `🎯 ${player.target}`;
  }
  return "";
}

/* =========================
   LOGS
========================= */

function formatLogs(logs){
  return logs || [];
}