# DeskFocus

DeskFocus is a lightweight full-stack distraction tracker that uses your webcam plus the TensorFlow.js COCO-SSD model to detect when a phone is visible while you work. All object detection happens in the browser; the Flask backend only stores session history and aggregated stats.

## Tech Stack

- Frontend: HTML, CSS, vanilla JavaScript
- ML: TensorFlow.js + COCO-SSD (`lite_mobilenet_v2`) from CDN
- Charts: Chart.js from CDN
- Backend: Flask REST API with SQLite
- Deployment: GitHub Pages for the frontend, Render for the backend

## Project Structure

```text
pbl_project/
├── index.html
├── css/
│   └── style.css
├── js/
│   └── app.js
├── backend/
│   ├── app.py
│   ├── models.py
│   ├── requirements.txt
│   └── render.yaml
└── README.md
```

## Frontend Setup

1. Open `index.html` directly in a browser, or use a local static server such as VS Code Live Server.
2. If your backend is running somewhere else, update the `API_BASE` constant at the top of `js/app.js`.
3. Allow webcam access when prompted.

The frontend still works if the backend is offline. It automatically keeps local session history in `localStorage`.

## Backend Setup

From the `pbl_project/backend` directory:

```bash
pip install -r requirements.txt
python app.py
```

The API starts on `http://127.0.0.1:5000` by default and creates `sessions.db` automatically.

## Available Endpoints

- `GET /health`
- `GET /api/sessions`
- `GET /api/sessions/<id>`
- `POST /api/sessions`
- `DELETE /api/sessions`
- `GET /api/stats`

## Deployment

### GitHub Pages

- Push the contents of `pbl_project/` to a GitHub repository.
- Enable GitHub Pages for the repository branch that contains `index.html`.
- Update `API_BASE` in `js/app.js` to your deployed Render backend URL.

### Render

- Create a new Blueprint deployment in Render.
- Point Render at the repository and use `backend/render.yaml`.
- Render will install dependencies, start Gunicorn, and expose the Flask API.

## Notes

- TensorFlow.js detection runs entirely in the browser, not on the server.
- Session history is saved locally and, when reachable, sent to the Flask API.
- The dashboard is responsive and switches from a two-column layout to a single column on smaller screens.
