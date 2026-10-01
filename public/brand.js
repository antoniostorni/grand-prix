(() => {
  "use strict";

  const cars = {
    "#ff4d6d": { name: "LA BUG HUNTER", description: "Encuentra el problema antes de que llegue a producción." },
    "#4cc9f0": { name: "LA ARQUITECTA", description: "Ve el sistema completo incluso en la curva más cerrada." },
    "#f9c74f": { name: "LA DEPLOYADORA", description: "No le teme ni al viernes a última hora." },
    "#8cff66": { name: "LA REFACTORIZADORA", description: "Toma la línea más limpia y deja la pista mejor de lo que estaba." },
    "#b388ff": { name: "LA PRODUCT OWNER", description: "Sabe qué priorizar cuando todos quieren pasar primero." },
    "#ff8c42": { name: "LA INCIDENT COMMANDER", description: "Cuando todo arde, mantiene la calma y encuentra la salida." },
    "#ffffff": { name: "LA SENIOR", description: "Pocas palabras, commits limpios y cero vueltas de más." },
    "#ff66e3": { name: "LA MULTIAGENTE", description: "Coordina al equipo entero sin perder velocidad." }
  };

  function profileFor(color) {
    return cars[String(color || "").trim().toLowerCase()] || cars["#ff4d6d"];
  }

  function selectCar(button) {
    const color = button.style.getPropertyValue("--car-color").trim().toLowerCase();
    const profile = profileFor(color);
    const preview = document.querySelector("#selectedCarPreview");
    const showcase = document.querySelector("#carShowcase");
    const name = document.querySelector("#carPersonalityName");
    const description = document.querySelector("#carPersonalityDescription");
    if (preview) {
      preview.style.setProperty("--car-color", color);
      preview.classList.remove("car-changing");
      void preview.offsetWidth;
      preview.classList.add("car-changing");
    }
    if (showcase) showcase.style.setProperty("--car-color", color);
    if (name) name.textContent = profile.name;
    if (description) description.textContent = profile.description;
  }

  function setupGarage() {
    const swatches = [...document.querySelectorAll(".color-swatch")];
    swatches.forEach((button) => {
      const color = button.style.getPropertyValue("--car-color").trim().toLowerCase();
      const profile = profileFor(color);
      button.title = `${profile.name}: ${profile.description}`;
      button.setAttribute("aria-label", profile.name);
      button.addEventListener("click", () => selectCar(button));
    });
    const selected = document.querySelector(".color-swatch.selected") || swatches[0];
    if (selected) selectCar(selected);
  }

  function decorateLobby() {
    document.querySelectorAll(".player-card").forEach((card) => {
      if (card.querySelector(".personality-tag")) return;
      const color = card.style.getPropertyValue("--car-color");
      const profile = profileFor(color);
      const info = card.querySelector(".player-info");
      if (!info) return;
      const tag = document.createElement("span");
      tag.className = "personality-tag";
      tag.textContent = profile.name;
      info.append(tag);
    });
  }

  function updateAward() {
    const winner = document.querySelector("#podium .podium-slot.first b")?.textContent;
    const message = document.querySelector("#awardMessage");
    const ceremonyText = winner
      ? `La directora le entrega la Copa a ${winner} y 1.000 requerimientos. Un señor del cliente trae 10.000 más. Una mujer de Riesgos dice que todo es muy riesgoso y que hay que borrar la mitad de lo hecho. Después vino un hombre de Integraciones y trajo 10 APIs nuevas para mapear. Por último, vino una mujer de Producto y pidió 20 pasos nuevos para el onboarding. ${winner} termina llorando de emoción.`
      : "";
    if (message && ceremonyText && message.textContent !== ceremonyText) message.textContent = ceremonyText;
  }

  setupGarage();
  const lobby = document.querySelector("#playerGrid");
  if (lobby) new MutationObserver(decorateLobby).observe(lobby, { childList: true, subtree: true });
  const results = document.querySelector("#resultsPanel");
  if (results) new MutationObserver(updateAward).observe(results, { childList: true, subtree: true, attributes: true });
})();
