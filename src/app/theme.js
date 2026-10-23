// Tema claro, oscuro o automático.

// Preferencia: "auto" (sigue al sistema), "light" o "dark". El tema efectivo vive en <html data-theme>.
const THEMES = { auto: ["◐", "Automático (sigue al sistema)"], light: ["☀", "Claro"], dark: ["☾", "Oscuro"] };

const themeQuery = matchMedia("(prefers-color-scheme: light)");

function applyTheme(pref) {
  if (!THEMES[pref]) pref = "auto";
  const effective = pref === "auto" ? (themeQuery.matches ? "light" : "dark") : pref;
  document.documentElement.dataset.theme = effective;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", effective === "light" ? "#eceef5" : "#0e1015");
  els["theme-btn"].textContent = THEMES[pref][0];
  els["theme-btn"].title = `Tema: ${THEMES[pref][1]} (clic para cambiar)`;
  els["theme-btn"].dataset.pref = pref;
}

// Botón de tema y cambios del tema del sistema.
function wireTheme() {
  els["theme-btn"].addEventListener("click", () => {
    const order = Object.keys(THEMES);
    const next = order[(order.indexOf(els["theme-btn"].dataset.pref) + 1) % order.length];
    store.set("theme", next);
    applyTheme(next);
    toast(`Tema: ${THEMES[next][1]}`, 1500);
  });

  themeQuery.addEventListener("change", () => applyTheme(store.get("theme") || "auto"));

  applyTheme(store.get("theme") || "auto");
}
