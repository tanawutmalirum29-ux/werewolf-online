// ป้องกันการซูมทุกทาง — บีบนิ้ว (pinch), ดับเบิลแตะ (double-tap), ปุ่มลัดคีย์บอร์ด (ctrl +/-),
// และ ctrl+scroll บนเดสก์ท็อป กันเผื่อ viewport meta/touch-action ไม่ถูกเคารพในบางเบราว์เซอร์
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("gesturechange", (e) => e.preventDefault());
document.addEventListener("gestureend", (e) => e.preventDefault());
document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
let __wwLastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - __wwLastTouchEnd <= 350) e.preventDefault();
    __wwLastTouchEnd = now;
}, false);
document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "0"].includes(e.key)) {
        e.preventDefault();
    }
}, false);
