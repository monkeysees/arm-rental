#!/usr/bin/env python3
"""Fixed local-source discovery, restart and atomic identity rejection."""

import http.server
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("RENTAL_APP_BINARY", ROOT / "experiments/rust-replay/target/debug/rental-app"))
NOW = 1790424000000  # 2026-09-26T12:00:00Z.


def card(item_id: str, title: str, date: str = "Суббота, Сентябрь 26, 2026, 10:00") -> str:
    return (f'<a class="category-data-list-card__destination" href="/ru/item/{item_id}">'
            f'<div class="dltitle">{title}</div><div class="p">150000 AMD</div>'
            '<div class="l">Кентрон</div><div class="at">2 ком. · 50 кв.м. · 2/4 этаж</div>'
            f'<div class="d">{date}</div></a>')


class CrawlBoundaries(unittest.TestCase):
    def test_discovery_restart_and_late_identity_failure_are_atomic(self):
        with tempfile.TemporaryDirectory(prefix="native-crawl-") as directory:
            root = Path(directory)
            data = root / "state"
            env = {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "TELEGRAM_BOT_TOKEN": "123:synthetic-native-test",
                "TELEGRAM_OWNER_ID": "123", "DATA_DIRECTORY": str(data),
                "CURL_IMPERSONATE_PATH": "/usr/bin/curl", "INITIAL_PAGE_COUNT": "2",
                "ADDED_CATEGORY_PAGE_COUNT": "2",
            }
            initialized = subprocess.run([str(BINARY), "state:init"], env=env,
                                         capture_output=True, text=True, timeout=15)
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            phase = [0]

            class Source(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_GET(self):
                    path = self.path.split("?", 1)[0]
                    apartment = "/56/" in path
                    page = int(path.rsplit("/", 1)[-1])
                    if page > 1:
                        html = '<div id="contentr"></div>'
                    elif phase[0] == 3 and not apartment:
                        html = ('<div id="contentr"><a class="fav-item-info-container" '
                                'href="https://evil.test/item/9">broken</a></div>')
                    elif apartment:
                        title = "Квартира" if phase[0] == 0 else "Квартира обновлена"
                        html = f'<div id="contentr">{card("1", title)}{card("2", "Без даты", "")}</div>'
                    else:
                        html = f'<div id="contentr">{card("3", "Дом")}</div>'
                    body = html.encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Source)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def rows():
                    with sqlite3.connect(data / "state.sqlite3") as connection:
                        return connection.execute(
                            "SELECT item_id,payload_json,kind,encounter_sequence,encounter_position,"
                            "last_seen_at,changed_sequence FROM apartments ORDER BY item_id"
                        ).fetchall()

                def crawl(index: int):
                    request = {"op": "crawl", "directory": str(data),
                               "endpoint": f"http://127.0.0.1:{server.server_port}",
                               "env": env, "nowMs": NOW + index * 60000, "rates": {}}
                    result = subprocess.run([str(BINARY), "contract"], env=env,
                                            input=json.dumps(request) + "\n", text=True,
                                            capture_output=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    return json.loads(result.stdout)

                phase[0] = 0
                first = crawl(0)
                self.assertNotIn("error", first)
                initial_rows = rows()
                self.assertEqual([row[0] for row in initial_rows], ["1", "2", "3"])
                self.assertEqual([row[2] for row in initial_rows], ["apartment", "apartment", "house"])
                self.assertEqual(json.loads(initial_rows[0][1])["title"], "Квартира")
                self.assertEqual(json.loads(initial_rows[1][1])["title"], "Без даты")

                phase[0] = 1
                second = crawl(1)
                self.assertNotIn("error", second)
                changed_rows = rows()
                self.assertEqual([row[0] for row in changed_rows], ["1", "2", "3"])
                self.assertEqual(json.loads(changed_rows[0][1])["title"], "Квартира обновлена")
                self.assertEqual(json.loads(changed_rows[2][1])["title"], "Дом")
                self.assertEqual([row[6] for row in changed_rows], [2, 1, 1])

                phase[0] = 2
                third = crawl(2)
                self.assertNotIn("error", third)
                before_failure = rows()
                self.assertEqual([json.loads(row[1])["title"] for row in before_failure],
                                 ["Квартира обновлена", "Без даты", "Дом"])

                phase[0] = 3
                rejected = crawl(3)
                self.assertIn("IDENTITY_REJECTION", rejected["error"])
                self.assertEqual(rows(), before_failure, "late house rejection changed apartment rows")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
