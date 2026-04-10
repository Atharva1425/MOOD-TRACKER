import json
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "sessions.db"


def get_connection():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with get_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                duration INTEGER NOT NULL,
                focus_score INTEGER NOT NULL,
                distraction_time INTEGER NOT NULL,
                phone_detections INTEGER NOT NULL,
                minutes_tracked INTEGER NOT NULL,
                minute_data TEXT NOT NULL
            )
            """
        )
        connection.commit()


def _serialize_row(row, include_minute_data=False):
    if row is None:
        return None

    payload = {
        "id": row["id"],
        "date": row["date"],
        "duration": row["duration"],
        "focus_score": row["focus_score"],
        "distraction_time": row["distraction_time"],
        "phone_detections": row["phone_detections"],
        "minutes_tracked": row["minutes_tracked"],
    }

    if include_minute_data:
        try:
            payload["minute_data"] = (
                json.loads(row["minute_data"]) if row["minute_data"] else []
            )
        except json.JSONDecodeError:
            payload["minute_data"] = []

    return payload


def list_sessions(limit=50):
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, date, duration, focus_score, distraction_time,
                   phone_detections, minutes_tracked
            FROM sessions
            ORDER BY date DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [_serialize_row(row) for row in rows]


def get_session(session_id):
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT id, date, duration, focus_score, distraction_time,
                   phone_detections, minutes_tracked, minute_data
            FROM sessions
            WHERE id = ?
            """,
            (session_id,),
        ).fetchone()

    return _serialize_row(row, include_minute_data=True)


def create_session(payload):
    with get_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO sessions (
                date,
                duration,
                focus_score,
                distraction_time,
                phone_detections,
                minutes_tracked,
                minute_data
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["date"],
                payload["duration"],
                payload["focus_score"],
                payload["distraction_time"],
                payload["phone_detections"],
                payload["minutes_tracked"],
                json.dumps(payload["minute_data"]),
            ),
        )
        connection.commit()
        session_id = cursor.lastrowid

    return get_session(session_id)


def clear_sessions():
    with get_connection() as connection:
        cursor = connection.execute("DELETE FROM sessions")
        connection.commit()
        return cursor.rowcount


def get_stats():
    with get_connection() as connection:
        totals = connection.execute(
            """
            SELECT
                COUNT(*) AS total_sessions,
                COALESCE(SUM(duration - distraction_time), 0) AS total_focus_time_ms,
                COALESCE(SUM(distraction_time), 0) AS total_distraction_time_ms,
                COALESCE(ROUND(AVG(focus_score), 2), 0) AS avg_focus_score,
                COALESCE(SUM(phone_detections), 0) AS total_phone_detections
            FROM sessions
            """
        ).fetchone()

        best_row = connection.execute(
            """
            SELECT id, date, duration, focus_score, distraction_time,
                   phone_detections, minutes_tracked
            FROM sessions
            ORDER BY focus_score DESC, duration DESC, date DESC
            LIMIT 1
            """
        ).fetchone()

        worst_row = connection.execute(
            """
            SELECT id, date, duration, focus_score, distraction_time,
                   phone_detections, minutes_tracked
            FROM sessions
            ORDER BY focus_score ASC, duration DESC, date DESC
            LIMIT 1
            """
        ).fetchone()

    return {
        "total_sessions": totals["total_sessions"],
        "total_focus_time_ms": totals["total_focus_time_ms"],
        "total_distraction_time_ms": totals["total_distraction_time_ms"],
        "avg_focus_score": totals["avg_focus_score"],
        "total_phone_detections": totals["total_phone_detections"],
        "best_session": _serialize_row(best_row),
        "worst_session": _serialize_row(worst_row),
    }
