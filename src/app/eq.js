// Ecualizador de 10 bandas con preajustes.

const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const EQ_PRESETS = {
  "Plano": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "Graves": [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  "Agudos": [0, 0, 0, 0, 0, 1, 3, 5, 6, 6],
  "Voz": [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  "Rock": [4, 3, 2, -1, -2, -1, 2, 3, 4, 4],
  "Pop": [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
  "Electrónica": [5, 4, 1, 0, -2, 2, 1, 2, 4, 5],
  "Clásica": [3, 2, 1, 1, 0, 0, -1, -1, 2, 3],
};

let eqFilters = [], eqPreamp;

const eqSaved = store.json("eq", null);

function applyEq() {
  const gains = state.eq.on ? state.eq.gains : EQ_PRESETS.Plano;
  eqFilters.forEach((f, i) => (f.gain.value = gains[i]));
  // Reduce el nivel a la mitad del mayor realce para evitar saturación.
  if (eqPreamp) eqPreamp.gain.value = 10 ** (-0.5 * Math.max(0, ...gains) / 20);
}

function saveEq() {
  store.set("eq", JSON.stringify(state.eq));
  applyEq();
  syncEqUi();
}

function syncEqUi() {
  els["eq-on"].checked = state.eq.on;
  els["eq-panel"].classList.toggle("off", !state.eq.on);
  els["eq-toggle"].setAttribute("aria-pressed", !els["eq-panel"].hidden);
  els["eq-toggle"].classList.toggle("active", state.eq.on && state.eq.gains.some((g) => g !== 0));
  const match = Object.entries(EQ_PRESETS).find(([, g]) => g.every((v, i) => v === state.eq.gains[i]));
  els["eq-preset"].value = match ? match[0] : "custom";
  els["eq-bands"].querySelectorAll(".eq-band").forEach((el, i) => {
    el.querySelector("input").value = state.eq.gains[i];
    el.querySelector(".eq-gain").textContent = fmtGain(state.eq.gains[i]);
  });
}

function buildEqUi() {
  els["eq-preset"].replaceChildren(...Object.keys(EQ_PRESETS).map((n) => new Option(n, n)), new Option("Personalizado", "custom"));
  els["eq-bands"].replaceChildren(
    ...EQ_BANDS.map((f, i) => {
      const col = document.createElement("div");
      col.className = "eq-band";
      const gain = document.createElement("span");
      gain.className = "eq-gain";
      const input = document.createElement("input");
      input.type = "range";
      input.min = -12; input.max = 12; input.step = 1;
      input.setAttribute("aria-label", `${fmtFreq(f)} Hz`);
      input.addEventListener("input", () => { state.eq.gains[i] = +input.value; saveEq(); });
      input.addEventListener("dblclick", () => { state.eq.gains[i] = 0; saveEq(); });
      const label = document.createElement("span");
      label.className = "eq-freq";
      label.textContent = fmtFreq(f);
      col.append(gain, input, label);
      return col;
    })
  );
  syncEqUi();
}

// Restaura el ajuste guardado y conecta los controles.
function wireEq() {
  state.eq = { on: eqSaved?.on ?? true, gains: eqSaved?.gains?.length === EQ_BANDS.length ? eqSaved.gains : EQ_PRESETS.Plano.slice() };

  els["eq-toggle"].addEventListener("click", () => {
    els["eq-panel"].hidden = !els["eq-panel"].hidden;
    syncEqUi();
  });

  els["eq-on"].addEventListener("change", () => { state.eq.on = els["eq-on"].checked; saveEq(); });

  els["eq-reset"].addEventListener("click", () => { state.eq.gains = EQ_PRESETS.Plano.slice(); saveEq(); });

  els["eq-preset"].addEventListener("change", () => {
    const g = EQ_PRESETS[els["eq-preset"].value];
    if (!g) return;
    state.eq.gains = g.slice();
    state.eq.on = true;
    saveEq();
  });
}
