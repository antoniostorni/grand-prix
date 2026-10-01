(() => {
  "use strict";

  function startCeremony() {
    const winnerSlot = document.querySelector("#podium .podium-slot.first");
    const winnerName = winnerSlot?.querySelector("b")?.textContent;
    const ceremony = document.querySelector("#awardCeremony");
    const nameTag = document.querySelector("#awardWinnerName");
    if (!winnerName || !ceremony || !nameTag || ceremony.dataset.winner === winnerName) return;

    ceremony.dataset.winner = winnerName;
    nameTag.textContent = winnerName;
    const color = winnerSlot.style.getPropertyValue("--car-color") || "#4cc9f0";
    ceremony.style.setProperty("--winner-color", color);
    ceremony.classList.remove("award-playing");
    requestAnimationFrame(() => requestAnimationFrame(() => ceremony.classList.add("award-playing")));
  }

  const results = document.querySelector("#resultsPanel");
  if (results) {
    new MutationObserver(startCeremony).observe(results, { childList: true, subtree: true, attributes: true });
  }
})();
