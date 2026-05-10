on("roomCreated", (data)=>{
  sessionStorage.setItem("roomCode", data.roomCode);
  location.href = "host-lobby.html";
});

on("errorMessage", alert);

function createRoom(){
  emit("createRoom", getRoomData());
}