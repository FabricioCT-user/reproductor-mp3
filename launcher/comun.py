"""Constantes y rutas compartidas por el servidor local y el lanzador."""
import os
from pathlib import Path

PUERTO_POR_DEFECTO = 8000

# Solo se sirven (y solo se aceptan) archivos de audio de estos tipos.
EXTENSIONES = {".mp3", ".flac", ".m4a", ".ogg", ".oga", ".opus", ".aac", ".wav"}

TIPOS = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
}


def es_audio(ruta) -> bool:
    return Path(ruta).suffix.lower() in EXTENSIONES


def dir_datos() -> Path:
    """Carpeta privada del reproductor (cola, registro, pid): ~/.cache/reproductor-mp3."""
    base = os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache")
    return Path(base) / "reproductor-mp3"


def dir_cola() -> Path:
    """Aquí el lanzador deja un .json por cada archivo que se quiere abrir; el servidor los entrega."""
    return Path(os.environ.get("REPRODUCTOR_COLA") or (dir_datos() / "cola"))


def asegurar_privado(ruta: Path) -> Path:
    """Crea la carpeta solo para esta persona: otros usuarios del equipo no pueden encolar archivos."""
    ruta.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        ruta.chmod(0o700)
    except OSError:
        pass
    return ruta
