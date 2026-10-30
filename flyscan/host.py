"""Production web entry point; unlike the desktop sidecar, uses the host's PORT."""

import os
from pathlib import Path

from waitress import serve

from .scheduler import default_scheduler
from .web import create_app


def main():
    data = Path(os.environ.get("FLYSCAN_DATA_DIR", "/data"))
    data.mkdir(parents=True, exist_ok=True)
    os.chdir(data)
    default_scheduler(db_path=str(data / "flights.db"), max_workers=4, max_pending=128)
    serve(
        create_app(),
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8080")),
        threads=32,
        channel_timeout=120,
    )


if __name__ == "__main__":
    main()
