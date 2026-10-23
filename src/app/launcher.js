// Lanzador local («Abrir con…» sin instalar la app; sirve para Firefox): el servidor de launcher/ entrega a la página
// los archivos de audio que se abren desde el sistema. Con cualquier otro servidor (p. ej. un alojamiento estático)
// esos endpoints no existen y todo esto se desactiva solo.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Una vuelta: espera (hasta ~25 s) a que haya archivos, los descarga y los abre.
// Devuelve "items", "idle" o "unsupported". `fetchFn` se puede sustituir en las pruebas.
async function launcherStep(fetchFn = (...args) => fetch(...args)) {
  const res = await fetchFn("/__abrir/esperar", { cache: "no-store" });
  if (res.status === 404) return "unsupported";
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = await res.json();

  const files = [];
  for (const item of items) {
    try {
      const r = await fetchFn(`/__abrir/archivo/${item.id}`, { cache: "no-store" });
      if (!r.ok) continue;
      files.push(new File([await r.blob()], item.name, { type: item.type || "", lastModified: Math.round(item.mtime * 1000) }));
    } catch { /* se reintenta en la siguiente vuelta o caduca en el servidor */ }
  }
  if (files.length) await openFromSystem(files);
  return items.length ? "items" : "idle";
}

// Bucle de espera larga: no depende de temporizadores, así que una pestaña en segundo plano reacciona al instante.
async function runLauncher() {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return;
  let errors = 0;
  for (;;) {
    try {
      const result = await launcherStep();
      if (result === "unsupported") return;
      errors = 0;
      if (result === "items") await wait(300);
    } catch {
      if (++errors >= 5) return; // el servidor se apagó: no se insiste
      await wait(3000 * errors);
    }
  }
}
