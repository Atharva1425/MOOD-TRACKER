const API_BASE = "";

const STORAGE_KEY = "deskfocus-local-history-v1";
const DETECTION_INTERVAL_MS = 250;
const UI_REFRESH_MS = 250;
const MINUTE_MS = 60_000;
const TIMELINE_BLOCK_MS = 10_000;
const MODEL_BASE = "mobilenet_v2";
const MODEL_MAX_BOXES = 40;
const MODEL_MIN_SCORE = 0.01;
const DEFAULT_PHONE_SCORE_THRESHOLD = 0.12;
const PERSON_SCORE_THRESHOLD = 0.35;
const DETECTION_CROPS = [
  { ratio: 0.74, anchorX: 0.5, anchorY: 0.5 },
  { ratio: 0.56, anchorX: 0.5, anchorY: 0.5 },
  { ratio: 0.58, anchorX: 0.5, anchorY: 0.66 },
];
const COLORS = {
  focused: "#22c55e",
  distracted: "#ef4444",
  waiting: "#7b7f93",
};

const detectionSurface = createDetectionSurface();

const elements = {
  webcam: document.getElementById("webcam"),
  overlay: document.getElementById("overlay"),
  loadingMask: document.getElementById("loadingMask"),
  loadingMessage: document.getElementById("loadingMessage"),
  idleMask: document.getElementById("idleMask"),
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  sessionStatus: document.getElementById("sessionStatus"),
  focusScore: document.getElementById("focusScore"),
  distractionTime: document.getElementById("distractionTime"),
  sessionDuration: document.getElementById("sessionDuration"),
  phoneDetections: document.getElementById("phoneDetections"),
  sessionNote: document.getElementById("sessionNote"),
  soundToggle: document.getElementById("soundToggle"),
  timelineStrip: document.getElementById("timelineStrip"),
  timelineCaption: document.getElementById("timelineCaption"),
  toast: document.getElementById("toast"),
  minuteChart: document.getElementById("minuteChart"),
  serverHistory: document.getElementById("serverHistory"),
  localHistory: document.getElementById("localHistory"),
  clearHistoryButton: document.getElementById("clearHistoryButton"),
  backendStatus: document.getElementById("backendStatus"),
  backendDot: document.getElementById("backendDot"),
  detectorMode: document.getElementById("detectorMode"),
  sensitivityRange: document.getElementById("sensitivityRange"),
  sensitivityValue: document.getElementById("sensitivityValue"),
};

const state = {
  model: null,
  chart: null,
  running: false,
  detecting: false,
  stream: null,
  phoneVisible: false,
  detectionTimer: null,
  uiTimer: null,
  audioContext: null,
  toastTimer: null,
  phoneVisibleUntil: 0,
  phoneScoreThreshold: DEFAULT_PHONE_SCORE_THRESHOLD,
  localHistory: [],
  serverHistory: [],
  backendReachable: false,
  session: createBlankSessionState(),
};

function createBlankSessionState() {
  return {
    startedAtIso: null,
    startTime: 0,
    lastUpdateTime: 0,
    elapsedMs: 0,
    distractionMs: 0,
    phoneDetections: 0,
    minuteBuckets: [],
    timelineBuckets: [],
  };
}

function createDetectionSurface() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return { canvas, context };
}

function bindEvents() {
  elements.startButton.addEventListener("click", startSession);
  elements.stopButton.addEventListener("click", stopSession);
  elements.clearHistoryButton.addEventListener("click", clearHistory);
  elements.soundToggle.addEventListener("change", () => {
    updateSessionNote(
      elements.soundToggle.checked
        ? "Alert sound is on. A short tone will play when the phone first appears."
        : "Alert sound is off. Visual toast alerts remain active."
    );
  });
  elements.sensitivityRange.addEventListener("input", handleSensitivityChange);

  window.addEventListener("resize", () => {
    syncCanvasDimensions();
    clearCanvas();
  });
}

function initializeChart() {
  const context = elements.minuteChart.getContext("2d");

  state.chart = new Chart(context, {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        {
          label: "Focused",
          data: [],
          backgroundColor: "rgba(34, 197, 94, 0.75)",
          borderColor: COLORS.focused,
          borderWidth: 1,
          borderRadius: 8,
          borderSkipped: false,
        },
        {
          label: "Distracted",
          data: [],
          backgroundColor: "rgba(239, 68, 68, 0.78)",
          borderColor: COLORS.distracted,
          borderWidth: 1,
          borderRadius: 8,
          borderSkipped: false,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          labels: {
            color: "#d6d2e7",
            font: {
              family: "IBM Plex Sans",
              size: 12,
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: {
            color: "rgba(255,255,255,0.05)",
          },
          ticks: {
            color: "#8e88a4",
            font: {
              family: "IBM Plex Sans",
            },
          },
        },
        y: {
          stacked: true,
          min: 0,
          max: 60,
          ticks: {
            stepSize: 10,
            color: "#8e88a4",
            font: {
              family: "IBM Plex Sans",
            },
            callback: (value) => `${value}s`,
          },
          grid: {
            color: "rgba(255,255,255,0.05)",
          },
        },
      },
    },
  });
}

async function initializeApp() {
  bindEvents();
  initializeChart();
  renderHistoryColumns();
  updateStatus("waiting");
  updateMetrics();
  syncDetectorSettingsUI();

  await Promise.allSettled([loadModel(), loadHistory()]);
}

async function loadModel() {
  setLoadingState(true, "Loading COCO-SSD accuracy model...");

  try {
    await prepareTfBackend();
    state.model = await cocoSsd.load({ base: MODEL_BASE });
    setLoadingState(false);
    elements.startButton.disabled = false;
    elements.detectorMode.textContent = MODEL_BASE;
    updateSessionNote(
      "Accuracy-first detector ready. Start a session and hold the phone still for a beat so the model can lock on."
    );
  } catch (error) {
    console.error("Failed to load model", error);
    setLoadingState(
      true,
      "Model failed to load. Check your connection and refresh the page."
    );
    updateSessionNote(
      "The detector is unavailable right now, so camera sessions cannot start."
    );
  }
}

async function prepareTfBackend() {
  await tf.ready();

  if (tf.getBackend() === "webgl") {
    return;
  }

  try {
    await tf.setBackend("webgl");
    await tf.ready();
  } catch (error) {
    console.warn("WebGL backend unavailable, using fallback backend.", error);
  }
}

async function loadHistory() {
  loadLocalHistory();
  await loadServerHistory();
  renderHistoryColumns();
}

function loadLocalHistory() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    state.localHistory = stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error("Failed to parse local history", error);
    state.localHistory = [];
  }
}

function persistLocalHistory() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.localHistory.slice(0, 50)));
}

async function loadServerHistory() {
  if (!API_BASE) {
    setBackendStatus(false, "Backend sync disabled. Using local history only.");
    state.serverHistory = [];
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/sessions`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    state.serverHistory = await response.json();
    setBackendStatus(true, "Backend sync active.");
  } catch (error) {
    console.warn("Server history unavailable", error);
    state.serverHistory = [];
    setBackendStatus(
      false,
      "Backend unavailable. Local history is still active."
    );
  }
}

function setLoadingState(isLoading, message = "Loading...") {
  elements.loadingMessage.textContent = message;
  elements.loadingMask.classList.toggle("hidden", !isLoading);
}

function updateStatus(mode) {
  elements.sessionStatus.className = "status-pill";

  if (mode === "focused") {
    elements.sessionStatus.classList.add("focused");
    elements.sessionStatus.textContent = "Focused";
    return;
  }

  if (mode === "distracted") {
    elements.sessionStatus.classList.add("distracted");
    elements.sessionStatus.textContent = "Phone Detected!";
    return;
  }

  elements.sessionStatus.classList.add("waiting");
  elements.sessionStatus.textContent = "Waiting";
}

function updateSessionNote(message) {
  elements.sessionNote.textContent = message;
}

function setBackendStatus(isOnline, message) {
  state.backendReachable = isOnline;
  elements.backendStatus.textContent = message;
  elements.backendDot.classList.remove("online", "offline");
  elements.backendDot.classList.add(isOnline ? "online" : "offline");
}

function handleSensitivityChange() {
  const nextThreshold = Number(elements.sensitivityRange.value) / 100;
  state.phoneScoreThreshold = nextThreshold;
  syncDetectorSettingsUI();
}

function syncDetectorSettingsUI() {
  const percentage = Math.round(state.phoneScoreThreshold * 100);
  elements.sensitivityRange.value = String(percentage);
  elements.sensitivityValue.textContent = `${percentage}%`;
  elements.detectorMode.textContent = MODEL_BASE;
}

async function startSession() {
  if (state.running || !state.model) {
    return;
  }

  try {
    await ensureCameraStream();
    await primeAudioContext();
  } catch (error) {
    console.error("Unable to start session", error);
    updateSessionNote(
      "Camera access was denied or unavailable. Allow webcam permission and try again."
    );
    return;
  }

  state.session = createBlankSessionState();
  state.session.startedAtIso = new Date().toISOString();
  state.session.startTime = performance.now();
  state.session.lastUpdateTime = state.session.startTime;
  state.running = true;
  state.phoneVisible = false;
  state.phoneVisibleUntil = 0;

  elements.startButton.disabled = true;
  elements.stopButton.disabled = false;
  elements.idleMask.classList.add("hidden");

  clearCanvas();
  updateStatus("focused");
  updateSessionNote(
    "Session live. Green means focused time, red means a phone was visible."
  );

  state.detectionTimer = window.setInterval(runDetectionLoop, DETECTION_INTERVAL_MS);
  state.uiTimer = window.setInterval(updateRunningSession, UI_REFRESH_MS);

  updateMetrics();
  updateChart();
  renderTimeline();
}

async function stopSession() {
  if (!state.running) {
    return;
  }

  flushSessionTime();
  state.running = false;
  state.phoneVisible = false;

  window.clearInterval(state.detectionTimer);
  window.clearInterval(state.uiTimer);
  state.detectionTimer = null;
  state.uiTimer = null;

  stopCameraStream();
  clearCanvas();

  elements.startButton.disabled = state.model === null;
  elements.stopButton.disabled = true;
  elements.idleMask.classList.remove("hidden");
  updateStatus("waiting");

  updateMetrics();
  updateChart();
  renderTimeline();

  if (state.session.elapsedMs >= 10_000) {
    const payload = buildSessionPayload();
    await saveSession(payload);
    updateSessionNote("Session saved. History has been updated below.");
  } else {
    updateSessionNote(
      "Session stopped. Runs shorter than 10 seconds are ignored to avoid noisy history."
    );
  }
}

async function ensureCameraStream() {
  if (state.stream) {
    return;
  }

  state.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });

  elements.webcam.srcObject = state.stream;
  await elements.webcam.play();
  syncCanvasDimensions();
}

function stopCameraStream() {
  if (!state.stream) {
    return;
  }

  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  elements.webcam.srcObject = null;
}

function syncCanvasDimensions() {
  if (!elements.webcam.videoWidth || !elements.webcam.videoHeight) {
    return;
  }

  elements.overlay.width = elements.webcam.videoWidth;
  elements.overlay.height = elements.webcam.videoHeight;
}

async function runDetectionLoop() {
  if (
    !state.running ||
    !state.model ||
    state.detecting ||
    elements.webcam.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    return;
  }

  state.detecting = true;

  try {
    syncCanvasDimensions();
    const predictions = await detectRelevantPredictions();
    if (!state.running) {
      return;
    }
    drawDetections(predictions);

    const now = performance.now();
    const phoneDetected = predictions.some(
      (prediction) => prediction.class === "cell phone"
    );

    if (phoneDetected) {
      state.phoneVisibleUntil = now + DETECTION_INTERVAL_MS * 2;
    }

    const wasPhoneVisible = state.phoneVisible;
    state.phoneVisible = phoneDetected || now < state.phoneVisibleUntil;

    if (phoneDetected && !wasPhoneVisible) {
      state.session.phoneDetections += 1;
      showPhoneAlert();
    }
    updateStatus(state.phoneVisible ? "distracted" : "focused");
  } catch (error) {
    console.error("Detection loop failed", error);
    updateSessionNote(
      "Detection paused unexpectedly. Stop and restart the session to recover."
    );
  } finally {
    state.detecting = false;
  }
}

async function detectRelevantPredictions() {
  const fullFramePredictions = await detectOnSource(elements.webcam);
  const zoomPredictions = [];

  for (const crop of DETECTION_CROPS) {
    const cropPredictions = await detectZoomedPredictions(crop);
    zoomPredictions.push(...cropPredictions);
  }

  return dedupePredictions(
    [...fullFramePredictions, ...zoomPredictions].filter(isRelevantPrediction)
  );
}

async function detectOnSource(source) {
  return state.model.detect(source, MODEL_MAX_BOXES, MODEL_MIN_SCORE);
}

async function detectZoomedPredictions(cropConfig) {
  const sourceWidth = elements.webcam.videoWidth;
  const sourceHeight = elements.webcam.videoHeight;

  if (!sourceWidth || !sourceHeight) {
    return [];
  }

  detectionSurface.canvas.width = sourceWidth;
  detectionSurface.canvas.height = sourceHeight;

  const cropWidth = sourceWidth * cropConfig.ratio;
  const cropHeight = sourceHeight * cropConfig.ratio;
  const cropX = clamp(
    sourceWidth * cropConfig.anchorX - cropWidth / 2,
    0,
    sourceWidth - cropWidth
  );
  const cropY = clamp(
    sourceHeight * cropConfig.anchorY - cropHeight / 2,
    0,
    sourceHeight - cropHeight
  );

  detectionSurface.context.clearRect(0, 0, sourceWidth, sourceHeight);
  detectionSurface.context.drawImage(
    elements.webcam,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    sourceWidth,
    sourceHeight
  );

  const predictions = await detectOnSource(detectionSurface.canvas);

  return predictions.map((prediction) => ({
    ...prediction,
    bbox: remapZoomedBox(prediction.bbox, {
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      sourceWidth,
      sourceHeight,
    }),
  }));
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function remapZoomedBox(
  [x, y, width, height],
  { cropX, cropY, cropWidth, cropHeight, sourceWidth, sourceHeight }
) {
  return [
    cropX + x * (cropWidth / sourceWidth),
    cropY + y * (cropHeight / sourceHeight),
    width * (cropWidth / sourceWidth),
    height * (cropHeight / sourceHeight),
  ];
}

function isRelevantPrediction(prediction) {
  if (prediction.class === "cell phone") {
    return prediction.score >= state.phoneScoreThreshold;
  }

  if (prediction.class === "person") {
    return prediction.score >= PERSON_SCORE_THRESHOLD;
  }

  return false;
}

function dedupePredictions(predictions) {
  const deduped = [];

  predictions
    .slice()
    .sort((left, right) => right.score - left.score)
    .forEach((prediction) => {
      const alreadyCovered = deduped.some(
        (existing) =>
          existing.class === prediction.class &&
          getIntersectionOverUnion(existing.bbox, prediction.bbox) > 0.45
      );

      if (!alreadyCovered) {
        deduped.push(prediction);
      }
    });

  return deduped;
}

function getIntersectionOverUnion(firstBox, secondBox) {
  const [x1, y1, w1, h1] = firstBox;
  const [x2, y2, w2, h2] = secondBox;
  const overlapX1 = Math.max(x1, x2);
  const overlapY1 = Math.max(y1, y2);
  const overlapX2 = Math.min(x1 + w1, x2 + w2);
  const overlapY2 = Math.min(y1 + h1, y2 + h2);
  const overlapWidth = Math.max(0, overlapX2 - overlapX1);
  const overlapHeight = Math.max(0, overlapY2 - overlapY1);
  const intersection = overlapWidth * overlapHeight;

  if (!intersection) {
    return 0;
  }

  const firstArea = w1 * h1;
  const secondArea = w2 * h2;
  return intersection / (firstArea + secondArea - intersection);
}

function drawDetections(predictions) {
  const context = elements.overlay.getContext("2d");
  const { width, height } = elements.overlay;

  context.clearRect(0, 0, width, height);

  predictions.forEach((prediction) => {
    const isPhone = prediction.class === "cell phone";
    const [x, y, boxWidth, boxHeight] = prediction.bbox;
    const mirroredX = width - x - boxWidth;
    const color = isPhone ? COLORS.distracted : COLORS.focused;
    const label = `${isPhone ? "cell phone" : "person"} ${Math.round(
      prediction.score * 100
    )}%`;

    context.strokeStyle = color;
    context.lineWidth = Math.max(2, width / 260);
    context.fillStyle = color;
    context.font = `${Math.max(14, width / 42)}px "IBM Plex Sans", sans-serif`;

    context.strokeRect(mirroredX, y, boxWidth, boxHeight);

    const textWidth = context.measureText(label).width;
    const labelX = mirroredX;
    const labelY = Math.max(24, y - 10);

    context.fillRect(labelX, labelY - 20, textWidth + 18, 26);
    context.fillStyle = "#0a0a0f";
    context.fillText(label, labelX + 9, labelY - 2);
  });
}

function clearCanvas() {
  const context = elements.overlay.getContext("2d");
  context.clearRect(0, 0, elements.overlay.width, elements.overlay.height);
}

function updateRunningSession() {
  if (!state.running) {
    return;
  }

  flushSessionTime();
  updateMetrics();
  updateChart();
  renderTimeline();
}

function flushSessionTime() {
  const now = performance.now();
  const delta = now - state.session.lastUpdateTime;

  if (delta <= 0) {
    return;
  }

  accumulateTime(delta, state.phoneVisible);
  state.session.lastUpdateTime = now;
  state.session.elapsedMs = now - state.session.startTime;

  if (state.phoneVisible) {
    state.session.distractionMs += delta;
  }
}

function accumulateTime(deltaMs, distracted) {
  let remaining = deltaMs;
  let cursor = state.session.elapsedMs;

  while (remaining > 0) {
    const minuteIndex = Math.floor(cursor / MINUTE_MS);
    const timelineIndex = Math.floor(cursor / TIMELINE_BLOCK_MS);

    ensureMinuteBucket(minuteIndex);
    ensureTimelineBucket(timelineIndex);

    const minuteBoundary = (minuteIndex + 1) * MINUTE_MS;
    const timelineBoundary = (timelineIndex + 1) * TIMELINE_BLOCK_MS;
    const slice = Math.min(
      remaining,
      minuteBoundary - cursor,
      timelineBoundary - cursor
    );

    if (distracted) {
      state.session.minuteBuckets[minuteIndex].distractedMs += slice;
      state.session.timelineBuckets[timelineIndex].distractedMs += slice;
    } else {
      state.session.minuteBuckets[minuteIndex].focusedMs += slice;
      state.session.timelineBuckets[timelineIndex].focusedMs += slice;
    }

    cursor += slice;
    remaining -= slice;
  }
}

function ensureMinuteBucket(index) {
  while (state.session.minuteBuckets.length <= index) {
    state.session.minuteBuckets.push({
      focusedMs: 0,
      distractedMs: 0,
    });
  }
}

function ensureTimelineBucket(index) {
  while (state.session.timelineBuckets.length <= index) {
    state.session.timelineBuckets.push({
      focusedMs: 0,
      distractedMs: 0,
    });
  }
}

function updateMetrics() {
  const durationMs = Math.max(0, Math.round(state.session.elapsedMs));
  const distractionMs = Math.max(0, Math.round(state.session.distractionMs));
  const focusScore =
    durationMs > 0
      ? Math.round(((durationMs - distractionMs) / durationMs) * 100)
      : 100;

  elements.focusScore.textContent = `${focusScore}%`;
  elements.distractionTime.textContent = formatDuration(distractionMs);
  elements.sessionDuration.textContent = formatDuration(durationMs);
  elements.phoneDetections.textContent = String(state.session.phoneDetections);
}

function updateChart() {
  const buckets = state.session.minuteBuckets;
  const labels = buckets.map((_, index) => `Minute ${index + 1}`);
  const focusedValues = buckets.map((bucket) =>
    roundSeconds(bucket.focusedMs / 1000)
  );
  const distractedValues = buckets.map((bucket) =>
    roundSeconds(bucket.distractedMs / 1000)
  );

  state.chart.data.labels = labels;
  state.chart.data.datasets[0].data = focusedValues;
  state.chart.data.datasets[1].data = distractedValues;
  state.chart.update("none");
}

function renderTimeline() {
  const buckets = state.session.timelineBuckets;

  if (buckets.length === 0) {
    elements.timelineStrip.innerHTML =
      '<div class="history-empty">No timeline yet. Start a session to generate 10-second blocks.</div>';
    elements.timelineCaption.textContent =
      "Timeline blocks will build as the session progresses.";
    return;
  }

  elements.timelineStrip.innerHTML = buckets
    .map((bucket, index) => {
      const cssClass =
        bucket.distractedMs > bucket.focusedMs ? "distracted" : "focused";
      const distractedSeconds = roundSeconds(bucket.distractedMs / 1000);
      const focusedSeconds = roundSeconds(bucket.focusedMs / 1000);
      const title = `Block ${index + 1}: ${focusedSeconds}s focused, ${distractedSeconds}s distracted`;
      return `<div class="timeline-block ${cssClass}" title="${title}"></div>`;
    })
    .join("");

  elements.timelineCaption.textContent = `${buckets.length} block${
    buckets.length === 1 ? "" : "s"
  } recorded. Each block represents 10 seconds.`;
}

function buildSessionPayload() {
  const duration = Math.max(0, Math.round(state.session.elapsedMs));
  const distractionTime = Math.max(0, Math.round(state.session.distractionMs));
  const focusScore =
    duration > 0
      ? Math.round(((duration - distractionTime) / duration) * 100)
      : 100;
  const minuteData = state.session.minuteBuckets.map((bucket, index) => ({
    minute: index + 1,
    focused_seconds: Math.round(bucket.focusedMs / 1000),
    distracted_seconds: Math.round(bucket.distractedMs / 1000),
  }));

  return {
    date: state.session.startedAtIso,
    duration,
    focus_score: focusScore,
    distraction_time: distractionTime,
    phone_detections: state.session.phoneDetections,
    minutes_tracked: minuteData.length,
    minute_data: minuteData,
  };
}

async function saveSession(payload) {
  const localEntry = {
    ...payload,
    id: `local-${Date.now()}`,
    source: "local",
  };

  state.localHistory.unshift(localEntry);
  state.localHistory = state.localHistory.slice(0, 50);
  persistLocalHistory();

  if (API_BASE) {
    try {
      const response = await fetch(`${API_BASE}/api/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const savedSession = await response.json();
      state.serverHistory.unshift(savedSession);
      state.serverHistory = state.serverHistory.slice(0, 50);
      setBackendStatus(true, "Backend sync active.");
    } catch (error) {
      console.warn("Server save failed", error);
      setBackendStatus(
        false,
        "Server save failed. Session was kept in local history."
      );
    }
  }

  renderHistoryColumns();
}

async function clearHistory() {
  state.localHistory = [];
  persistLocalHistory();

  if (API_BASE) {
    try {
      const response = await fetch(`${API_BASE}/api/sessions`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      state.serverHistory = [];
      setBackendStatus(true, "Server and local history cleared.");
    } catch (error) {
      console.warn("Server clear failed", error);
      state.serverHistory = [];
      setBackendStatus(
        false,
        "Local history cleared. Server could not be reached."
      );
    }
  } else {
    state.serverHistory = [];
  }

  renderHistoryColumns();
}

function renderHistoryColumns() {
  renderHistoryList(elements.serverHistory, state.serverHistory, "server");
  renderHistoryList(elements.localHistory, state.localHistory, "local");
}

function renderHistoryList(container, items, source) {
  if (!items.length) {
    container.innerHTML = `<div class="history-empty">No ${source} sessions yet.</div>`;
    return;
  }

  container.innerHTML = items
    .map(
      (session) => `
        <article class="history-card">
          <header>
            <time datetime="${session.date}">${formatDate(session.date)}</time>
            <span class="history-pill">${source}</span>
          </header>
          <ul>
            <li>Duration <strong>${formatDuration(session.duration)}</strong></li>
            <li>Focus <strong>${session.focus_score}%</strong></li>
            <li>Distraction <strong>${formatDuration(
              session.distraction_time
            )}</strong></li>
            <li>Detections <strong>${session.phone_detections}</strong></li>
          </ul>
        </article>
      `
    )
    .join("");
}

function showPhoneAlert() {
  elements.toast.classList.add("visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 2200);
  playBeep();
}

async function primeAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }

  if (!state.audioContext) {
    state.audioContext = new AudioContextClass();
  }

  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }
}

function playBeep() {
  if (!elements.soundToggle.checked || !state.audioContext) {
    return;
  }

  const now = state.audioContext.currentTime;
  const oscillator = state.audioContext.createOscillator();
  const gainNode = state.audioContext.createGain();

  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(880, now);
  oscillator.frequency.exponentialRampToValueAtTime(660, now + 0.18);

  gainNode.gain.setValueAtTime(0.0001, now);
  gainNode.gain.exponentialRampToValueAtTime(0.06, now + 0.015);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);

  oscillator.connect(gainNode);
  gainNode.connect(state.audioContext.destination);

  oscillator.start(now);
  oscillator.stop(now + 0.26);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDate(isoString) {
  if (!isoString) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(isoString));
}

function roundSeconds(seconds) {
  return Math.round(seconds * 10) / 10;
}

initializeApp();
