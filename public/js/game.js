// === Globals ===
let fishData = {};           // โหลดจาก API
let recentCatches = [];
let inventory = [];
let currentLocation = localStorage.getItem("lastLocation") || "river";
let catchAttemptCount = 0;
let requiredHits = 1;
let currentFish = null;
let totalCasts = { value: 0 };
let totalWeight = { value: 0 };
let heaviestFish = { value: null };
let museum = {};
let money = 0;
let playerId = null;
let isFishing = false;
let barAnimationId = null;
let lastBarPos = 0;
let targetPos = 0;
let targetWidth = 0;
let lastEscapedFish = null;
let preGeneratedFishQueue = [];
let lastFishLocation = null;

// === Bootstrap: โหลด locations จาก API แล้วโหลดเกม ===
async function initGame() {
  try {
    // โหลด location list
    const locRes = await fetch("/api/locations");
    const locations = await locRes.json();
    const select = document.getElementById("location");
    select.innerHTML = "";
    locations.forEach(loc => {
      const opt = document.createElement("option");
      opt.value = loc.id;
      opt.textContent = loc.name;
      if (loc.id === currentLocation) opt.selected = true;
      select.appendChild(opt);
    });

    // โหลด fishData ของ location ปัจจุบัน
    await loadFishForLocation(currentLocation);

    loadGameData();
    updateMoneyUI();
    updateStats();
    updateInventory(recentCatches);
    generatePreCachedFish(10);
  } catch (e) {
    console.error("initGame error:", e);
  }
}

async function loadFishForLocation(location) {
  if (fishData[location]) return; // cache แล้ว
  try {
    const res = await fetch(`/api/fish?location=${location}`);
    fishData[location] = await res.json();
  } catch (e) {
    console.error("loadFishForLocation error:", e);
    fishData[location] = [];
  }
}

// === Save / Load ===
function saveGameData() {
  const data = { money, totalCasts, totalWeight, heaviestFish, inventory, recentCatches, museum, playerId };
  localStorage.setItem("gameData", JSON.stringify(data));
}

function loadGameData() {
  const raw = localStorage.getItem("gameData");
  if (!raw) {
    playerId = "P" + Math.floor(Math.random() * 1e8).toString().padStart(8, "0");
    saveGameData();
    return;
  }
  try {
    const data = JSON.parse(raw);
    money = typeof data.money === "number" ? data.money : 0;
    totalCasts = data.totalCasts || { value: 0 };
    totalWeight = data.totalWeight || { value: 0 };
    heaviestFish = data.heaviestFish || { value: null };
    inventory = Array.isArray(data.inventory) ? data.inventory : [];
    recentCatches = Array.isArray(data.recentCatches) ? data.recentCatches : [];
    museum = data.museum || {};
    playerId = data.playerId || ("P" + Math.floor(Math.random() * 1e8).toString().padStart(8, "0"));
  } catch (e) {
    console.error("Failed to parse gameData:", e);
    playerId = "P" + Math.floor(Math.random() * 1e8).toString().padStart(8, "0");
    saveGameData();
  }
}

// === UI Updaters ===
function updateStats() {
  const castsEl = document.getElementById("totalCasts");
  if (castsEl) castsEl.textContent = `🎣 จำนวนปลาที่ตกได้: ${totalCasts.value}`;
  const weightEl = document.getElementById("totalWeight");
  if (weightEl) weightEl.textContent = `🎯 น้ำหนักรวม: ${totalWeight.value.toFixed(2)} กก.`;
  const heaviestEl = document.getElementById("heaviestFish");
  if (heaviestEl && heaviestFish.value) {
    heaviestEl.textContent = `🏆 ตัวหนักสุด: ${heaviestFish.value.name} (${heaviestFish.value.weight} กก.)`;
  }
}

function updateInventory(list) {
  const inventoryList = document.getElementById("inventoryList");
  if (!inventoryList) return;
  inventoryList.innerHTML = "";
  list.forEach(fish => {
    const li = document.createElement("li");
    const statusText = fish.status && fish.status !== "ธรรมดา"
      ? ` <span class="status ${fish.status}">✦${fish.status}</span>` : "";
    li.innerHTML = `${fish.name} (${fish.weight} กก.) [${fish.rarity}]${statusText}`;
    inventoryList.appendChild(li);
  });
}

function updateHitCounter() {
  const counter = document.getElementById("hitCounter");
  if (!counter) return;
  const rarityClass = (currentFish && currentFish.rarity) || "common";
  let stars = "";
  for (let i = 0; i < requiredHits; i++) {
    const starType = i < catchAttemptCount ? "★" : "☆";
    stars += `<span class="star ${rarityClass}">${starType}</span>`;
  }
  counter.innerHTML = `ความสำเร็จ: ${stars}`;
}

function updateMoneyUI() {
  const moneyDisplay = document.getElementById("moneyAmount");
  if (moneyDisplay) moneyDisplay.textContent = money.toFixed(2);
}

// === Rarity & Status ===
const rarityRates = {
  river:      { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  sea:        { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  lava:       { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  candyland:  { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  deepsea:    { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  ancientsea: { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  bonerealm:  { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  skyrealm:   { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  toxicmarsh: { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  frostlake:  { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  mooncrater: { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  clocktower: { common: 40.9, rare: 35.19, epic: 13.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 },
  dreamgrove: { common: 40.9, rare: 35.19, epic: 15.9, legendary: 5, mythical: 2.9, secret: 0.1, cosmic: 0.01 }
};

const statusChances = [
  { name: "ธรรมดา",  weightMultiplier: 5,  chance: 80 },
  { name: "ทอง",     weightMultiplier: 10, chance: 6 },
  { name: "มรกต",    weightMultiplier: 15, chance: 5 },
  { name: "เพชร",    weightMultiplier: 20, chance: 3.999 },
  { name: "คริสตัล", weightMultiplier: 25, chance: 1 },
  { name: "สายรุ้ง", weightMultiplier: 50, chance: 0.001 }
];

function assignStatus() {
  const rand = Math.random() * 100;
  let acc = 0;
  for (let s of statusChances) {
    acc += s.chance;
    if (rand <= acc) return s;
  }
  return statusChances[0];
}

// === Fish helpers ===
function getFishByLocation(location) {
  return fishData[location] || [];
}

function getRandomFishWeighted(fishList) {
  if (!Array.isArray(fishList) || fishList.length === 0) return null;
  const ratesForLocation = rarityRates[currentLocation] || {};
  const weighted = [];
  for (let fish of fishList) {
    const rate = ratesForLocation[fish.rarity] || 0;
    if (rate > 0) weighted.push({ fish, weight: rate });
  }
  if (weighted.length === 0) return fishList[0];
  const total = weighted.reduce((s, e) => s + e.weight, 0);
  const r = Math.random() * total;
  let acc = 0;
  for (let entry of weighted) {
    acc += entry.weight;
    if (r <= acc) return entry.fish;
  }
  return weighted[0].fish;
}

function generateWeight(min, max) {
  let w;
  do {
    w = Math.random() * (max - min) + min;
  } while (Math.random() < Math.min(0.1, w / 9999));
  return w;
}

function generatePreCachedFish(count = 20) {
  if (lastFishLocation !== currentLocation) {
    lastFishLocation = currentLocation;
    preGeneratedFishQueue = [];
  }
  const possibleFish = getFishByLocation(currentLocation);
  for (let i = 0; i < count; i++) {
    const fish = getRandomFishWeighted(possibleFish);
    if (!fish) continue;
    const clonedFish = { ...fish };
    const baseWeight = generateWeight(clonedFish.minWeight, clonedFish.maxWeight);
    const statusObj = assignStatus();
    const finalWeight = parseFloat((baseWeight * statusObj.weightMultiplier).toFixed(2));
    const barBaseSpeed = 200 + Math.min(clonedFish.maxWeight ? clonedFish.maxWeight * 0.5 : 0, 500);
    preGeneratedFishQueue.push({ fish: clonedFish, weight: finalWeight, status: statusObj.name, barSpeed: barBaseSpeed });
  }
}

// === Fishing gameplay ===
function startFishing(forced = null) {
  if (isFishing) return;
  const fishingCost = 300;
  if (!subtractMoney(fishingCost)) {
    alert("เงินไม่พอที่จะตกปลา (ต้องใช้ 300G)");
    return;
  }

  const btn = document.getElementById("startFishingBtn");
  if (btn) btn.style.display = "none";

  isFishing = true;
  document.getElementById("minigame").style.display = "block";

  let fishDataSet;
  if (forced) {
    fishDataSet = forced.fish ? forced : {
      fish: forced, weight: forced._precalcWeight || forced.weight || 0,
      status: forced._precalcStatus || forced.status || '', barSpeed: forced.barSpeed || 1
    };
  } else {
    if (preGeneratedFishQueue.length === 0) generatePreCachedFish(10);
    fishDataSet = preGeneratedFishQueue.shift();
    if (preGeneratedFishQueue.length < 3) generatePreCachedFish(5);
  }

  currentFish = { ...fishDataSet.fish };
  currentFish._precalcWeight = fishDataSet.weight;
  currentFish._precalcStatus = fishDataSet.status;
  currentFish.barSpeed = fishDataSet.barSpeed;

  const hitsByRarity = { common: 2, rare: 3, epic: 4, legendary: 5, mythical: 6, secret: 8, cosmic: 9 };
  requiredHits = hitsByRarity[currentFish.rarity] || 1;
  catchAttemptCount = 0;
  updateHitCounter();

  const bar = document.getElementById("movingBar");
  const barContainer = document.getElementById("barContainer");
  const target = document.getElementById("targetZone");

  const maxLeftTarget = barContainer.clientWidth * 0.82;
  targetPos = Math.random() * maxLeftTarget;
  targetWidth = target.offsetWidth;
  target.style.left = `${targetPos}px`;

  lastBarPos = 0;
  bar.style.left = "0px";

  const barBaseSpeed = currentFish.barSpeed;
  let direction = 1;
  let lastTime = performance.now();

  function animateBar(timestamp) {
    if (!isFishing) return;
    const delta = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    const steps = 60;
    const stepDelta = delta / steps;
    for (let i = 0; i < steps; i++) {
      lastBarPos += direction * barBaseSpeed * stepDelta;
      const maxLeft = barContainer.clientWidth - bar.offsetWidth;
      if (lastBarPos <= 0) { lastBarPos = 0; direction = 1; }
      else if (lastBarPos >= maxLeft) { lastBarPos = maxLeft; direction = -1; }
    }
    bar.style.left = `${lastBarPos}px`;
    barAnimationId = requestAnimationFrame(animateBar);
  }

  cancelAnimationFrame(barAnimationId);
  barAnimationId = requestAnimationFrame(animateBar);
}

function tryCatchFish() {
  const padding = 10;
  const bar = document.getElementById("movingBar");
  const barWidth = bar.offsetWidth;

  if (lastBarPos + barWidth >= targetPos - padding && lastBarPos <= targetPos + targetWidth + padding) {
    catchAttemptCount++;
    updateHitCounter();

    const barContainer = document.getElementById("barContainer");
    const maxLeftTarget = barContainer.clientWidth * 0.82;
    targetPos = Math.random() * maxLeftTarget;
    const target = document.getElementById("targetZone");
    target.style.left = `${targetPos}px`;

    if (catchAttemptCount >= requiredHits) {
      cancelAnimationFrame(barAnimationId);
      document.getElementById("minigame").style.display = "none";
      catchFish();
    }
  } else {
    endFailCatch();
  }
}

function endFailCatch() {
  cancelAnimationFrame(barAnimationId);
  document.getElementById("minigame").style.display = "none";
  const btn = document.getElementById("startFishingBtn");
  if (btn) btn.style.display = "inline-block";
  lastEscapedFish = {
    fish: { ...currentFish }, name: currentFish.name || "ไม่ทราบชื่อ",
    weight: currentFish._precalcWeight, status: currentFish._precalcStatus, barSpeed: currentFish.barSpeed
  };
  isFishing = false;
  offerReCatchOption();
}

function catchFish() {
  totalCasts.value++;
  isFishing = false;
  if (!currentFish) return;

  const finalWeight = parseFloat(currentFish._precalcWeight.toFixed(2));
  const statusName = currentFish._precalcStatus;
  const caughtFish = { name: currentFish.name, weight: finalWeight, rarity: currentFish.rarity, status: statusName };

  const btn = document.getElementById("startFishingBtn");
  if (btn) btn.style.display = "inline-block";

  inventory.push(caughtFish);
  recentCatches.unshift(caughtFish);
  if (recentCatches.length > 3) recentCatches.pop();

  totalWeight.value += finalWeight;
  if (!heaviestFish.value || finalWeight > parseFloat(heaviestFish.value.weight)) {
    heaviestFish.value = caughtFish;
  }

  if (!museum[caughtFish.name]) museum[caughtFish.name] = { count: 0, heaviest: 0, lastCaught: null };
  museum[caughtFish.name].count += 1;
  if (finalWeight > museum[caughtFish.name].heaviest) {
    museum[caughtFish.name].heaviest = finalWeight;
    museum[caughtFish.name].lastCaught = new Date().toISOString();
  }

  saveGameData();
  updateStats();
  updateInventory(recentCatches);
}

function offerReCatchOption() {
  const reCatchCost = 1500;
  if (!lastEscapedFish) return;
  if (money >= reCatchCost) {
    const confirmPay = confirm(`ปลา ${lastEscapedFish.name} หลุด! ต้องการจ่าย ${reCatchCost}G เพื่อตกใหม่ตัวเดิมหรือไม่?`);
    if (confirmPay) { subtractMoney(reCatchCost); startFishing(lastEscapedFish); }
  }
}

// === Money functions ===
function addMoney(amount) { money += amount; saveGameData(); updateMoneyUI(); }
function subtractMoney(amount) {
  if (money >= amount) { money -= amount; updateMoneyUI(); saveGameData(); return true; }
  return false;
}

// === Change Location ===
async function changeLocation(selectOrId) {
  const val = (typeof selectOrId === "string") ? selectOrId : (selectOrId && selectOrId.value);
  if (!val) return;
  currentLocation = val;
  localStorage.setItem("lastLocation", currentLocation);
  preGeneratedFishQueue = [];
  await loadFishForLocation(currentLocation);
  generatePreCachedFish(20);
}

// === Profile modal ===
function openProfile() {
  const elName = document.getElementById("profileName");
  if (elName) elName.textContent = "Player";
  const elMoney = document.getElementById("profileMoney");
  if (elMoney) elMoney.textContent = money.toFixed(2);
  const elTotalWeight = document.getElementById("profileTotalWeight");
  if (elTotalWeight) elTotalWeight.textContent = totalWeight.value.toFixed(2);
  const elProfileId = document.getElementById("profileId");
  if (elProfileId) elProfileId.textContent = playerId || "-";
  const elBiggest = document.getElementById("profileBiggestFish");
  if (elBiggest) elBiggest.textContent = heaviestFish.value
    ? `${heaviestFish.value.name} (${heaviestFish.value.weight} กก.)` : "-";
  const elFishTypes = document.getElementById("profileFishTypes");
  if (elFishTypes) elFishTypes.textContent = museum ? Object.keys(museum).length : 0;
  const modal = document.getElementById("profileModal");
  if (modal) modal.style.display = "block";
}

function closeProfile() {
  const modal = document.getElementById("profileModal");
  if (modal) modal.style.display = "none";
}

// === Fish info popup ===
const rarityOrder = ["common", "rare", "epic", "legendary", "mythical", "secret", "cosmic"];

document.addEventListener("DOMContentLoaded", () => {
  const fishInfoBtn = document.getElementById("fishInfoBtn");
  if (!fishInfoBtn) return;
  fishInfoBtn.addEventListener("click", () => {
    const popup = document.getElementById("fishInfoPopup");
    if (popup.style.display === "block") { popup.style.display = "none"; return; }
    const fishList = getFishByLocation(currentLocation);
    const grouped = {};
    fishList.forEach(fish => {
      const r = fish.rarity || "common";
      if (!grouped[r]) grouped[r] = [];
      grouped[r].push(fish.name);
    });
    let html = `<h3>${currentLocation}</h3>`;
    rarityOrder.forEach(r => {
      if (grouped[r] && grouped[r].length) {
        html += `<div class="rarity-block ${r}">
          <div class="rarity-title">${r}</div>
          <div class="rarity-list">${grouped[r].map(name => `<span>${name}</span>`).join("")}</div>
        </div>`;
      }
    });
    popup.innerHTML = html;
    popup.style.display = "block";
  });
});

// Expose globals
window.startFishing = startFishing;
window.tryCatchFish = tryCatchFish;
window.changeLocation = changeLocation;
window.openProfile = openProfile;
window.closeProfile = closeProfile;

// Start
initGame();
