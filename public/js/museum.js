const rarityOrder = { common: 7, rare: 6, epic: 5, legendary: 4, mythical: 3, secret: 2, cosmic: 1 };

async function initMuseum() {
  // ดึงรายชื่อ locations ทั้งหมด แล้วโหลด fishData ทุก location เพื่อสร้าง rarityMap
  const locRes = await fetch("/api/locations");
  const locations = await locRes.json();

  const fishRarityMap = {};
  await Promise.all(locations.map(async loc => {
    const res = await fetch(`/api/fish?location=${loc.id}`);
    const fishList = await res.json();
    fishList.forEach(f => { fishRarityMap[f.name] = f.rarity; });
  }));

  const gameData = JSON.parse(localStorage.getItem("gameData")) || {};
  const museum = gameData.museum || {};
  const tbody = document.querySelector("#museumTable tbody");

  const fishList = Object.entries(museum).map(([name, data]) => ({
    name, count: data.count, heaviest: data.heaviest,
    lastCaught: data.lastCaught, rarity: fishRarityMap[name] || "common"
  }));

  fishList.sort((a, b) => {
    if (rarityOrder[a.rarity] !== rarityOrder[b.rarity]) return rarityOrder[a.rarity] - rarityOrder[b.rarity];
    return b.heaviest - a.heaviest;
  });

  function renderTable(list) {
    tbody.innerHTML = "";
    list.forEach(fish => {
      const row = document.createElement("tr");
      row.className = fish.rarity;
      row.innerHTML = `<td>${fish.name}</td><td>${fish.count}</td><td>${fish.heaviest.toFixed(2)}</td>`;
      row.dataset.name = fish.name;
      row.dataset.weight = fish.heaviest.toFixed(2);
      row.dataset.date = fish.lastCaught || "";
      row.addEventListener("click", () => {
        if (!row.dataset.date) return;
        const dateStr = new Date(row.dataset.date).toLocaleDateString("th-TH", {
          year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit"
        });
        alert(`ปลา: ${row.dataset.name}\nน้ำหนักมากสุด: ${row.dataset.weight} กก.\nจับได้เมื่อ: ${dateStr}`);
      });
      tbody.appendChild(row);
    });
  }

  window.filterFish = function(rarity) {
    renderTable(rarity === "all" ? fishList : fishList.filter(f => f.rarity === rarity));
  };

  renderTable(fishList);
}

initMuseum();
