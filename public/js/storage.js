const rarityRates = {
  common:    { base: 6,  power: 0.85 },
  rare:      { base: 8,  power: 0.83 },
  epic:      { base: 12, power: 0.80 },
  legendary: { base: 18, power: 0.78 },
  mythical:  { base: 24, power: 0.75 },
  secret:    { base: 34, power: 0.73 },
  cosmic:    { base: 5,  power: 0.85 }
};

let money = 0;
let inventory = [];

function loadGameData() {
  const saved = localStorage.getItem("gameData");
  if (saved) {
    try {
      const data = JSON.parse(saved);
      money = typeof data.money === "number" ? data.money : 0;
      inventory = Array.isArray(data.inventory) ? data.inventory : [];
    } catch (e) { money = 0; inventory = []; }
  }
}

function saveGameData() {
  const saved = localStorage.getItem("gameData");
  let data = {};
  if (saved) { try { data = JSON.parse(saved); } catch (e) { data = {}; } }
  data.money = money;
  data.inventory = inventory;
  localStorage.setItem("gameData", JSON.stringify(data));
}

function updateMoneyUI() {
  document.getElementById("moneyAmount").textContent = money.toFixed(2);
}

function addMoney(amount) { money += amount; }

function calcPrice(fish) {
  const rarity = rarityRates[fish.rarity] || rarityRates.common;
  return rarity.base * Math.pow(fish.weight, rarity.power);
}

function loadStorage() {
  const gridEl = document.getElementById("storageGrid");
  gridEl.innerHTML = "";
  if (!Array.isArray(inventory) || inventory.length === 0) {
    gridEl.innerHTML = "<p>ไม่มีปลาในคลัง</p>";
    return;
  }
  const sorted = inventory.slice().sort((a, b) => calcPrice(b) - calcPrice(a));
  sorted.forEach((fish, idx) => {
    const realIdx = inventory.indexOf(fish);
    const card = document.createElement("div");
    card.className = "fish-card";
    card.innerHTML = `
      <h4><span class="star ${fish.rarity}">★</span> ${fish.name}</h4>
      <p>น้ำหนัก: ${fish.weight} กก.</p>
      <p>ระดับ: <span class="star ${fish.rarity}">${fish.rarity}</span></p>
      ${fish.status ? `<p>สถานะ: <span class="status ${fish.status}">✦${fish.status}</span></p>` : ""}
      <p>ราคา: ${calcPrice(fish).toFixed(2)} G</p>
    `;
    const sellBtn = document.createElement("button");
    sellBtn.textContent = "ขาย";
    sellBtn.onclick = () => sellFishByIndex(realIdx);
    card.appendChild(sellBtn);
    gridEl.appendChild(card);
  });
}

function sellFishByIndex(index) {
  if (index < 0 || index >= inventory.length) return;
  const fish = inventory[index];
  const price = calcPrice(fish);
  addMoney(price);
  alert(`ขาย ${fish.name} ได้ ${price.toFixed(2)} G`);
  inventory.splice(index, 1);
  saveGameData();
  loadStorage();
  updateMoneyUI();
}

function sellByRarity(rarity) {
  let totalEarned = 0;
  inventory = inventory.filter(fish => {
    if (fish.rarity === rarity) { totalEarned += calcPrice(fish); return false; }
    return true;
  });
  if (totalEarned > 0) {
    addMoney(totalEarned);
    alert(`ขายปลาระดับ ${rarity} ได้ ${totalEarned.toFixed(2)} G`);
    saveGameData(); loadStorage(); updateMoneyUI();
  } else {
    alert(`ไม่มีปลาระดับ ${rarity} ในคลัง`);
  }
}

function renderRarityButtons() {
  const btnContainer = document.getElementById("rarityButtons");
  if (!btnContainer) return;
  btnContainer.innerHTML = "";
  const container = document.createElement("div");
  container.className = "sell-all-buttons";
  Object.keys(rarityRates).forEach(rarity => {
    const btn = document.createElement("button");
    btn.textContent = `ขาย ${rarity} ทั้งหมด`;
    btn.className = "sell-button";
    btn.onclick = () => sellByRarity(rarity);
    container.appendChild(btn);
  });
  btnContainer.appendChild(container);
}

function prepareSellAll() {
  if (!inventory || inventory.length === 0) { alert("ไม่มีปลาในคลัง"); return; }
  document.getElementById("sellAllBtn").style.display = "none";
  document.getElementById("confirmSellBtn").style.display = "inline-block";
  alert("กด 'ยืนยันการขาย' เพื่อขายปลาทั้งหมด");
}

function confirmSellAll() {
  if (!inventory || inventory.length === 0) { alert("ไม่มีปลาในคลัง"); return; }
  let totalEarned = 0;
  inventory.forEach(fish => { totalEarned += calcPrice(fish); });
  addMoney(totalEarned);
  alert(`ขายปลาทั้งหมด ${inventory.length} ตัว ได้ ${totalEarned.toFixed(2)} G`);
  inventory = [];
  saveGameData(); loadStorage(); updateMoneyUI();
  document.getElementById("sellAllBtn").style.display = "inline-block";
  document.getElementById("confirmSellBtn").style.display = "none";
}

// Init
loadGameData();
loadStorage();
updateMoneyUI();
renderRarityButtons();

document.getElementById("sellAllBtn").addEventListener("click", prepareSellAll);
document.getElementById("confirmSellBtn").addEventListener("click", confirmSellAll);
