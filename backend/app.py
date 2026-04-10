from datetime import datetime
from http import HTTPStatus

from flask import Flask, jsonify, request
from flask_cors import CORS

from models import clear_sessions, create_session, get_session, get_stats, init_db, list_sessions

app = Flask(__name__)
CORS(app)

init_db()


def json_error(message, status=HTTPStatus.BAD_REQUEST, details=None):
    payload = {"error": message}
    if details is not None:
        payload["details"] = details
    return jsonify(payload), status


def to_int(value, field_name):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValueError(f"'{field_name}' must be an integer.")


def normalize_payload(data):
    if not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object.")

    minute_data = data.get("minute_data", [])
    if not isinstance(minute_data, list):
        raise ValueError("'minute_data' must be an array.")

    normalized_minutes = []
    for index, item in enumerate(minute_data):
        if not isinstance(item, dict):
            raise ValueError("Each 'minute_data' entry must be an object.")

        normalized_minutes.append(
            {
                "minute": to_int(item.get("minute", index + 1), "minute"),
                "focused_seconds": max(
                    0, to_int(item.get("focused_seconds", 0), "focused_seconds")
                ),
                "distracted_seconds": max(
                    0,
                    to_int(item.get("distracted_seconds", 0), "distracted_seconds"),
                ),
            }
        )

    payload = {
        "date": data.get("date") or datetime.utcnow().isoformat(),
        "duration": max(0, to_int(data.get("duration"), "duration")),
        "focus_score": to_int(data.get("focus_score"), "focus_score"),
        "distraction_time": max(
            0, to_int(data.get("distraction_time"), "distraction_time")
        ),
        "phone_detections": max(
            0, to_int(data.get("phone_detections"), "phone_detections")
        ),
        "minutes_tracked": max(
            len(normalized_minutes),
            to_int(data.get("minutes_tracked", len(normalized_minutes)), "minutes_tracked"),
        ),
        "minute_data": normalized_minutes,
    }

    if payload["focus_score"] < 0 or payload["focus_score"] > 100:
        raise ValueError("'focus_score' must be between 0 and 100.")

    if payload["distraction_time"] > payload["duration"]:
        raise ValueError("'distraction_time' cannot exceed 'duration'.")

    try:
        datetime.fromisoformat(payload["date"].replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("'date' must be a valid ISO 8601 timestamp.") from error

    return payload


@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({"status": "ok"}), HTTPStatus.OK


@app.route("/api/sessions", methods=["GET"])
def get_sessions():
    return jsonify(list_sessions()), HTTPStatus.OK


@app.route("/api/sessions/<int:session_id>", methods=["GET"])
def get_single_session(session_id):
    session = get_session(session_id)
    if session is None:
        return json_error("Session not found.", HTTPStatus.NOT_FOUND)
    return jsonify(session), HTTPStatus.OK


@app.route("/api/sessions", methods=["POST"])
def post_session():
    data = request.get_json(silent=True)

    try:
        payload = normalize_payload(data)
    except ValueError as error:
        return json_error(str(error), HTTPStatus.BAD_REQUEST)

    session = create_session(payload)
    return jsonify(session), HTTPStatus.CREATED


@app.route("/api/sessions", methods=["DELETE"])
def delete_sessions():
    deleted = clear_sessions()
    return jsonify({"status": "cleared", "deleted": deleted}), HTTPStatus.OK


@app.route("/api/stats", methods=["GET"])
def stats():
    return jsonify(get_stats()), HTTPStatus.OK


@app.errorhandler(404)
def not_found(_error):
    return json_error("Route not found.", HTTPStatus.NOT_FOUND)


@app.errorhandler(405)
def method_not_allowed(_error):
    return json_error("Method not allowed.", HTTPStatus.METHOD_NOT_ALLOWED)


@app.errorhandler(Exception)
def handle_unexpected_error(error):
    app.logger.exception("Unexpected server error: %s", error)
    return json_error(
        "Unexpected server error.",
        HTTPStatus.INTERNAL_SERVER_ERROR,
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
