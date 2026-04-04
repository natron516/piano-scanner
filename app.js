/**
 * app.js — Piano Scanner main application logic
 */

(function () {
  "use strict";

  // ── DOM refs ────────────────────────────────────────────────────────────
  const dropZone       = document.getElementById("drop-zone");
  const fileInput      = document.getElementById("file-input");
  const imagePreview   = document.getElementById("image-preview");
  const imagePreviewWrap = document.getElementById("image-preview-wrap");
  const btnClearImage  = document.getElementById("btn-clear-image");
  const btnAnalyze     = document.getElementById("btn-analyze");
  const btnDemo        = document.getElementById("btn-demo");
  const analyzeSpinner = document.getElementById("analyze-spinner");

  const noteVisual     = document.getElementById("note-visual");
  const jsonEditor     = document.getElementById("json-editor");
  const btnApplyJson   = document.getElementById("btn-apply-json");
  const jsonStatus     = document.getElementById("json-status");

  const midiDeviceSelect = document.getElementById("midi-device-select");
  const btnMidiConnect   = document.getElementById("btn-midi-connect");
  const btnMidiRefresh   = document.getElementById("btn-midi-refresh");
  const midiStatusBadge  = document.getElementById("midi-status");
  const midiStatusText   = document.getElementById("midi-status-text");

  const btnPlay        = document.getElementById("btn-play");
  const btnPause       = document.getElementById("btn-pause");
  const btnStop        = document.getElementById("btn-stop");
  const bpmSlider      = document.getElementById("bpm-slider");
  const bpmDisplay     = document.getElementById("bpm-display");
  const progressBar    = document.getElementById("progress-bar");
  const playbackStatus = document.getElementById("playback-status");

  // Settings
  const btnSettings      = document.getElementById("btn-settings");
  const settingsPanel    = document.getElementById("settings-panel");
  const providerSelect   = document.getElementById("provider-select");
  const apiKeyInput      = document.getElementById("api-key-input");
  const btnToggleKey     = document.getElementById("btn-toggle-key");
  const btnSaveSettings  = document.getElementById("btn-save-settings");
  const btnCloseSettings = document.getElementById("btn-close-settings");

  // ── App state ────────────────────────────────────────────────────────────
  let currentNotes   = [];
  let currentFile    = null;

  // ── Initialisation ───────────────────────────────────────────────────────
  async function init() {
    await MidiPlayer.requestAccess().catch(err => {
      setMidiStatus("error", "MIDI unavailable: " + err.message);
    });
    refreshMidiOutputs();
    wireEvents();
  }

  function wireEvents() {
    // Drop zone
    dropZone.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
    dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
    dropZone.addEventListener("drop", e => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith("image/")) loadImageFile(file);
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files[0]) loadImageFile(fileInput.files[0]);
    });

    btnClearImage.addEventListener("click", clearImage);
    btnAnalyze.addEventListener("click", runAnalysis);
    btnDemo.addEventListener("click", loadDemo);

    btnApplyJson.addEventListener("click", applyJsonEdit);

    btnMidiConnect.addEventListener("click", toggleMidiConnection);
    btnMidiRefresh.addEventListener("click", refreshMidiOutputs);

    btnPlay.addEventListener("click", handlePlay);
    btnPause.addEventListener("click", handlePause);
    btnStop.addEventListener("click", handleStop);

    bpmSlider.addEventListener("input", () => {
      bpmDisplay.textContent = bpmSlider.value;
    });

    // Part toggles
    document.querySelectorAll(".part-cb").forEach(cb => {
      cb.addEventListener("change", () => {
        cb.closest(".part-toggle").classList.toggle("active", cb.checked);
        applyPartFilter();
      });
    });

    // Score info detection
    document.addEventListener("ocr:detected", e => {
      const d = e.detail;
      const keyEl = document.getElementById("input-key");
      const timeEl = document.getElementById("input-time");
      const tempoEl = document.getElementById("input-tempo");
      const clefEl = document.getElementById("input-clef");
      if (d.key && !keyEl.value) keyEl.value = d.key;
      if (d.time && !timeEl.value) timeEl.value = d.time;
      if (d.tempo && !tempoEl.value) tempoEl.value = d.tempo;
      if (d.clef && !clefEl.value) clefEl.value = d.clef;
      setAnalysisStatus(`Detected: ${d.key || "?"} ${d.time || "?"} ${d.tempo ? d.tempo + " BPM" : ""} — Reading notes...`, "idle");
    });

    // Settings
    btnSettings.addEventListener("click", openSettings);
    btnCloseSettings.addEventListener("click", closeSettings);
    btnSaveSettings.addEventListener("click", saveSettings);
    btnToggleKey.addEventListener("click", () => {
      apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
    });
    settingsPanel.addEventListener("click", e => {
      if (e.target === settingsPanel) closeSettings();
    });

    // MIDI events
    document.addEventListener("midi:outputs-changed", refreshMidiOutputs);
    document.addEventListener("midi:connected", e => {
      setMidiStatus("ok", "Connected: " + e.detail.name);
      btnMidiConnect.textContent = "Disconnect";
      updatePlaybackButtons();
    });
    document.addEventListener("midi:disconnected", () => {
      setMidiStatus("idle", "Disconnected");
      btnMidiConnect.textContent = "Connect";
      updatePlaybackButtons();
    });
    document.addEventListener("midi:error", e => {
      setMidiStatus("error", e.detail.message);
    });
    document.addEventListener("midi:note", e => {
      highlightNote(e.detail.index);
      playbackStatus.textContent = "Playing: " + e.detail.note.note;
    });
    document.addEventListener("midi:progress", e => {
      progressBar.style.width = (e.detail.ratio * 100).toFixed(1) + "%";
    });
    document.addEventListener("midi:status", e => {
      setMidiStatus("idle", e.detail.message);
    });
    document.addEventListener("midi:ended", () => {
      setPlaybackStopped();
      playbackStatus.textContent = "Finished ✓";
      clearHighlights();
    });
  }

  // ── Image handling ───────────────────────────────────────────────────────
  function loadImageFile(file) {
    currentFile = file;
    const url   = URL.createObjectURL(file);
    imagePreview.src = url;
    imagePreviewWrap.classList.remove("hidden");
    dropZone.classList.add("hidden");
    btnAnalyze.disabled = false;
  }

  function clearImage() {
    currentFile = null;
    imagePreview.src = "";
    imagePreviewWrap.classList.add("hidden");
    dropZone.classList.remove("hidden");
    btnAnalyze.disabled = true;
    fileInput.value = "";
  }

  // ── Analysis ─────────────────────────────────────────────────────────────
  function getScoreInfo() {
    return {
      key:   document.getElementById("input-key").value,
      time:  document.getElementById("input-time").value,
      tempo: document.getElementById("input-tempo").value,
      clef:  document.getElementById("input-clef").value,
    };
  }

  async function runAnalysis() {
    if (!currentFile) return;
    setAnalyzing(true);
    const scoreInfo = getScoreInfo();
    setAnalysisStatus("Detecting key, time sig, tempo...", "idle");
    try {
      const notes = await SheetOCR.analyzeImage(currentFile, scoreInfo);
      loadNotes(notes);
      setAnalysisStatus(notes.length + " notes detected \u2713", "ok");
    } catch (err) {
      console.error("[Analysis Error]", err);
      setAnalysisStatus("Error: " + err.message, "err");
    } finally {
      setAnalyzing(false);
    }
  }

  function setAnalysisStatus(msg, type) {
    // Show status in both the visible area and JSON status
    jsonStatus.textContent = msg;
    jsonStatus.className   = "status-text " + (type || "");
    // Also show above the note visual so it's always visible
    let banner = document.getElementById("analysis-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "analysis-banner";
      banner.className = "analysis-banner";
      noteVisual.parentNode.insertBefore(banner, noteVisual);
    }
    banner.textContent = msg;
    banner.className = "analysis-banner " + (type || "");
    if (type === "ok") {
      setTimeout(() => { banner.textContent = ""; banner.className = "analysis-banner"; }, 5000);
    }
  }

  function loadDemo() {
    loadNotes(SheetOCR.demoNotes());
    playbackStatus.textContent = "Demo loaded (Amazing Grace)";
  }

  function setAnalyzing(on) {
    btnAnalyze.disabled = on;
    analyzeSpinner.classList.toggle("hidden", !on);
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  function loadNotes(notes) {
    currentNotes = notes;
    renderNoteChips(notes);
    jsonEditor.value = JSON.stringify(notes, null, 2);
    // Sync tempo from score info if set
    const tempoInput = document.getElementById("input-tempo");
    if (tempoInput && tempoInput.value) {
      bpmSlider.value = tempoInput.value;
      bpmDisplay.textContent = tempoInput.value;
    }
    jsonStatus.textContent = notes.length + " note(s) loaded";
    jsonStatus.className   = "status-text ok";
    updatePlaybackButtons();
  }

  function renderNoteChips(notes) {
    noteVisual.innerHTML = "";
    if (!notes || notes.length === 0) {
      noteVisual.innerHTML = '<p class="placeholder">No notes detected.</p>';
      return;
    }
    notes.forEach((n, i) => {
      const chip = document.createElement("div");
      const part = n.part || "melody";
      chip.className  = "note-chip";
      chip.dataset.index = i;
      chip.dataset.part = part;
      chip.innerHTML  = `<span class="pitch">${escHtml(n.note)}</span><span class="dur">${escHtml(n.duration)}</span><span class="part-label">${part[0].toUpperCase()}</span>`;
      noteVisual.appendChild(chip);
    });
    applyPartFilter();
  }

  function getActiveParts() {
    const parts = [];
    document.querySelectorAll(".part-cb").forEach(cb => {
      if (cb.checked) parts.push(cb.value);
    });
    return parts;
  }

  function applyPartFilter() {
    const active = getActiveParts();
    noteVisual.querySelectorAll(".note-chip").forEach(chip => {
      chip.classList.toggle("dimmed", !active.includes(chip.dataset.part));
    });
  }

  function getFilteredNotes() {
    const active = getActiveParts();
    return currentNotes.filter(n => active.includes(n.part || "melody"));
  }

  function highlightNote(index) {
    noteVisual.querySelectorAll(".note-chip").forEach((c, i) => {
      c.classList.toggle("active", i === index);
    });
    // Scroll active chip into view
    const active = noteVisual.querySelector(".note-chip.active");
    if (active) active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function clearHighlights() {
    noteVisual.querySelectorAll(".note-chip").forEach(c => c.classList.remove("active"));
  }

  function applyJsonEdit() {
    try {
      const parsed = JSON.parse(jsonEditor.value);
      if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
      loadNotes(parsed);
    } catch (err) {
      jsonStatus.textContent = "Invalid JSON: " + err.message;
      jsonStatus.className   = "status-text err";
    }
  }

  // ── MIDI ──────────────────────────────────────────────────────────────────
  function refreshMidiOutputs() {
    const outputs = MidiPlayer.getOutputs();
    const current = midiDeviceSelect.value;
    midiDeviceSelect.innerHTML = '<option value="">— Select MIDI output —</option>';
    outputs.forEach(o => {
      const opt  = document.createElement("option");
      opt.value  = o.id;
      opt.textContent = o.name;
      if (o.id === current) opt.selected = true;
      midiDeviceSelect.appendChild(opt);
    });
    if (outputs.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No MIDI devices found";
      opt.disabled    = true;
      midiDeviceSelect.appendChild(opt);
    }
    // Auto-select BLE if it's the only real option
    if (outputs.length === 1 && outputs[0].type === "ble") {
      midiDeviceSelect.value = "__ble__";
    }
  }

  async function toggleMidiConnection() {
    if (MidiPlayer.isConnected()) {
      MidiPlayer.disconnect();
    } else {
      const id = midiDeviceSelect.value;
      if (!id) {
        setMidiStatus("error", "Please select a MIDI device first.");
        return;
      }
      setMidiStatus("idle", "Connecting...");
      const ok = await MidiPlayer.connect(id);
      if (!ok && !MidiPlayer.isConnected()) {
        setMidiStatus("error", "Could not connect to device.");
      }
    }
  }

  function setMidiStatus(type, text) {
    midiStatusBadge.className = "status-badge status-" + type;
    midiStatusText.textContent = text;
  }

  // ── Playback ──────────────────────────────────────────────────────────────
  function handlePlay() {
    const state = MidiPlayer.getState();
    if (state === "paused") {
      MidiPlayer.resume();
    } else {
      MidiPlayer.play(getFilteredNotes(), parseInt(bpmSlider.value, 10));
    }
    btnPlay.classList.add("hidden");
    btnPause.classList.remove("hidden");
    btnStop.disabled = false;
    playbackStatus.textContent = "Playing…";
  }

  function handlePause() {
    MidiPlayer.pause();
    btnPause.classList.add("hidden");
    btnPlay.classList.remove("hidden");
    playbackStatus.textContent = "Paused";
  }

  function handleStop() {
    MidiPlayer.stop();
    setPlaybackStopped();
    clearHighlights();
    playbackStatus.textContent = "Stopped";
  }

  function setPlaybackStopped() {
    btnPause.classList.add("hidden");
    btnPlay.classList.remove("hidden");
    btnStop.disabled = true;
    progressBar.style.width = "0%";
  }

  function updatePlaybackButtons() {
    const hasNotes    = currentNotes.length > 0;
    const connected   = MidiPlayer.isConnected();
    btnPlay.disabled  = !(hasNotes && connected);
    btnStop.disabled  = true;
  }

  // ── Settings ────────────────────────────────────────────────────────────────
  function openSettings() {
    providerSelect.value = SheetOCR.getProvider();
    apiKeyInput.value    = SheetOCR.getApiKey();
    settingsPanel.classList.remove("hidden");
  }

  function closeSettings() {
    settingsPanel.classList.add("hidden");
  }

  function saveSettings() {
    SheetOCR.setProvider(providerSelect.value);
    SheetOCR.setApiKey(apiKeyInput.value.trim());
    closeSettings();
    // Update analyze button state
    btnAnalyze.disabled = !currentFile;
  }

  // ── Utils ─────────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
