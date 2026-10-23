#!/usr/bin/env python3
"""Servidor local del reproductor.

Sirve la aplicación y entrega a la página los archivos de audio que abre el lanzador («Abrir con…»).

Seguridad (esto sirve archivos de tu disco, así que es parte del diseño):
  * escucha solo en 127.0.0.1;
  * rechaza cualquier petición cuyo encabezado Host no sea localhost / 127.0.0.1 con este puerto
    (evita ataques de DNS rebinding desde otras webs);
  * los endpoints /__abrir/* rechazan peticiones de otros sitios (Sec-Fetch-Site);
  * NO hay ningún endpoint para registrar rutas: solo se entregan archivos que el lanzador dejó en
    una carpeta privada (modo 0700) de esta persona, y solo si son de audio;
  * el id del archivo debe ser un hex de 32 caracteres: no se aceptan rutas.
"""
import argparse
import atexit
import json
import os
import re
import shutil
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from comun import PUERTO_POR_DEFECTO, TIPOS, asegurar_privado, dir_cola, dir_datos, es_audio

RAIZ = Path(__file__).resolve().parent.parent
ID_RE = re.compile(r"^[0-9a-f]{32}$")
CADUCIDAD = 300  # segundos que un archivo pedido espera a que una página lo recoja
ESPERA = float(os.environ.get("REPRODUCTOR_ESPERA", "25"))  # duración de cada espera larga


def leer_entrada(fichero: Path):
    """Valida una entrada de la cola. Devuelve un dict o None si no es válida (y entonces se descarta)."""
    try:
        if not ID_RE.match(fichero.stem):
            return None
        datos = json.loads(fichero.read_text(encoding="utf-8"))
        ruta = Path(datos["path"])
        if not ruta.is_absolute() or not isinstance(datos["name"], str) or "/" in datos["name"]:
            return None
        if time.time() - float(datos["t"]) > CADUCIDAD:
            return None
        if not es_audio(ruta) or not ruta.is_file():
            return None
        estado = ruta.stat()
        return {
            "id": fichero.stem,
            "name": datos["name"],
            "type": TIPOS.get(ruta.suffix.lower(), "application/octet-stream"),
            "size": estado.st_size,
            "mtime": estado.st_mtime,
            "t": float(datos["t"]),
            "_ruta": ruta,
        }
    except (OSError, ValueError, KeyError, TypeError):
        return None


class Manejador(SimpleHTTPRequestHandler):
    server_version = "ReproductorLocal/1"
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
        ".svg": "image/svg+xml",
        **TIPOS,
    }

    # --- seguridad ---

    def _host_valido(self) -> bool:
        puerto = self.server.server_address[1]
        return (self.headers.get("Host") or "").lower() in {
            f"localhost:{puerto}", f"127.0.0.1:{puerto}", f"[::1]:{puerto}",
        }

    def _mismo_origen(self) -> bool:
        return self.headers.get("Sec-Fetch-Site", "same-origin") in ("same-origin", "none")

    # --- respuestas ---

    def _json(self, datos, codigo=200):
        cuerpo = json.dumps(datos).encode()
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def _pendientes(self):
        cola = dir_cola()
        if not cola.is_dir():
            return []
        entradas = []
        for fichero in cola.glob("*.json"):
            e = leer_entrada(fichero)
            if e is None:
                fichero.unlink(missing_ok=True)  # inválida, caducada o con el archivo borrado
            else:
                entradas.append(e)
        return sorted(entradas, key=lambda e: e["t"])

    def _esperar(self):
        srv = self.server
        with srv.cerrojo:
            srv.esperando += 1
        try:
            limite = time.time() + ESPERA
            while True:
                srv.ultimo = time.time()
                entradas = self._pendientes()
                if entradas or time.time() >= limite:
                    break
                time.sleep(0.25)
            self._json([{k: v for k, v in e.items() if not k.startswith("_")} for e in entradas])
        finally:
            with srv.cerrojo:
                srv.esperando -= 1

    def _archivo(self, id_):
        if not ID_RE.match(id_):
            return self.send_error(404)
        fichero = dir_cola() / f"{id_}.json"
        e = leer_entrada(fichero)
        if e is None:
            return self.send_error(404)
        try:
            with open(e["_ruta"], "rb") as f:
                self.send_response(200)
                self.send_header("Content-Type", e["type"])
                self.send_header("Content-Length", str(e["size"]))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                shutil.copyfileobj(f, self.wfile)
        except OSError:
            return
        fichero.unlink(missing_ok=True)  # entregado: ya no está pendiente

    def _abrir(self, ruta):
        if not self._mismo_origen():
            return self.send_error(403, "Petición de otro sitio")
        if ruta == "/__abrir/esperar":
            return self._esperar()
        if ruta.startswith("/__abrir/archivo/"):
            return self._archivo(ruta[len("/__abrir/archivo/"):])
        self.send_error(404)

    # --- método GET / HEAD ---

    def do_GET(self):
        self.server.ultimo = time.time()
        if not self._host_valido():
            return self.send_error(403, "Host no permitido")
        ruta = urlsplit(self.path).path
        if ruta == "/__reproductor":
            with self.server.cerrojo:
                conectada = self.server.esperando > 0
            return self._json({"app": "reproductor-mp3", "version": 1, "pagina_conectada": conectada})
        if ruta.startswith("/__abrir/"):
            return self._abrir(ruta)
        super().do_GET()

    def do_HEAD(self):
        if not self._host_valido():
            return self.send_error(403, "Host no permitido")
        super().do_HEAD()

    def log_message(self, *args):
        if self.server.verboso:
            super().log_message(*args)


class Servidor(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, direccion, raiz, verboso):
        super().__init__(direccion, partial(Manejador, directory=str(raiz)))
        self.cerrojo = threading.Lock()
        self.esperando = 0  # páginas con una espera larga en curso = páginas conectadas
        self.ultimo = time.time()
        self.verboso = verboso


def vigilar_inactividad(servidor, minutos):
    def bucle():
        while True:
            time.sleep(15)
            with servidor.cerrojo:
                ocupado = servidor.esperando > 0
            if not ocupado and time.time() - servidor.ultimo > minutos * 60:
                servidor.shutdown()
                return
    threading.Thread(target=bucle, daemon=True).start()


def main():
    ap = argparse.ArgumentParser(description="Servidor local del reproductor MP3")
    ap.add_argument("--port", type=int, default=int(os.environ.get("REPRODUCTOR_PORT", PUERTO_POR_DEFECTO)))
    ap.add_argument("--raiz", default=str(RAIZ), help="carpeta que se sirve (por defecto, la del proyecto)")
    ap.add_argument("--salir-inactivo", type=float, default=0, metavar="MINUTOS",
                    help="se apaga solo tras estos minutos sin páginas conectadas ni peticiones (0 = nunca)")
    ap.add_argument("--verboso", action="store_true")
    args = ap.parse_args()

    asegurar_privado(dir_cola())
    try:
        servidor = Servidor(("127.0.0.1", args.port), Path(args.raiz), args.verboso)
    except OSError as e:
        print(f"No se pudo abrir el puerto {args.port}: {e}. ¿Hay otro servidor en marcha?", file=sys.stderr)
        return 2

    pid = asegurar_privado(dir_datos()) / "servidor.pid"
    pid.write_text(str(os.getpid()))
    atexit.register(lambda: pid.unlink(missing_ok=True))

    puerto = servidor.server_address[1]
    print(f"Reproductor en http://localhost:{puerto}  (Ctrl+C para parar)", flush=True)
    print(f"PUERTO={puerto}", flush=True)
    if args.salir_inactivo > 0:
        vigilar_inactividad(servidor, args.salir_inactivo)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        servidor.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
