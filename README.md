# Piano Scanner 🎹

A single-page web app that scans sheet music photos and plays them back via Bluetooth MIDI — specifically designed for the **Yamaha MD-BT01** BLE MIDI adapter.

---

## Features

| Feature | Details |
|---|---|
| 📷 Image upload | Drag & drop, file picker, or direct camera capture |
| 🎵 Sheet music OCR | Mock demo mode (Amazing Grace) + stub for AI vision API |
| ✏️ Note editor | Editable JSON textarea for manual adjustments |
| 🎹 BLE MIDI output | Web MIDI API — connects to any visible MIDI output |
| ▶️ Playback | Play / Pause / Stop with BPM slider |
| 🌑 Dark UI | Mobile-friendly responsive design |

---

## Quick Start

1. Open `index.html` in **Chrome** or **Edge** (required for Web MIDI API).  
   You can serve locally with:
   ```bash
   npx serve .
   # or
   python3 -m http.server 8080
   ```
   Then visit `http://localhost:8080`.

2. **Connect the MD-BT01:**
   - Power on the MD-BT01 and plug it into your piano's MIDI IN jack.
   - Pair the MD-BT01 with your computer via *System Bluetooth settings* first.
   - After pairing, it appears as a MIDI output in Chrome.

3. **Load notes:**
   - Upload a photo of sheet music → click **Analyze Sheet Music**  
     *(currently returns mock data; see [Connecting a real AI API](#connecting-a-real-ai-api) below)*  
   - OR click **Load Demo (Amazing Grace)** to test playback immediately.

4. **Connect MIDI:** Select the MD-BT01 from the dropdown → **Connect**.

5. **Play:** Adjust BPM, then hit ▶️.

---

## File Structure

```
piano-app/
├── index.html   — Single-page UI
├── style.css    — Dark-theme styles
├── app.js       — Main app logic & event wiring
├── midi.js      — MIDI connection & playback engine
├── ocr.js       — Sheet music recognition (mock + TODO stub)
└── README.md    — This file
```

---

## Connecting a Real AI API

Open `ocr.js` and find the `analyzeImage()` function. The TODO block contains a ready-to-use **OpenAI GPT-4o** example. To enable it:

1. Uncomment the `fetch` block inside `analyzeImage()`.
2. Replace `YOUR_OPENAI_KEY` with your actual key (or load it from a config file / env variable via a small server proxy — never hardcode keys in client-side JS for production).
3. Remove the stub `return demoNotes()` line below it.

Other vision APIs (Google Gemini, Anthropic Claude, etc.) work the same way — convert the image to base64, POST to the API, parse the JSON response.

---

## Note JSON Format

```json
[
  { "note": "G3",  "duration": "quarter", "startBeat": 0 },
  { "note": "C4",  "duration": "half",    "startBeat": 1 },
  { "note": "E4",  "duration": "quarter", "startBeat": 3 }
]
```

| Field | Values |
|---|---|
| `note` | Scientific pitch notation: `C4`, `F#3`, `Bb5`, etc. |
| `duration` | `whole` `half` `quarter` `eighth` `sixteenth` |
| `startBeat` | Beat number (0-indexed). Quarter note = 1 beat. |

You can paste or edit note JSON directly in the **Edit raw note JSON** panel.

---

## MIDI Details

- Uses `navigator.requestMIDIAccess({ sysex: false })`.
- Sends standard **Note On** (`0x90`) / **Note Off** (`0x80`) messages on channel 1.
- Velocity is fixed at 80 (adjustable in `midi.js`).
- An **All Notes Off** CC is sent on stop/pause to prevent stuck notes.

---

## Browser Compatibility

| Browser | Web MIDI | Notes |
|---|---|---|
| Chrome 43+ | ✅ | Recommended |
| Edge 79+ | ✅ | Chromium-based |
| Firefox | ❌ | Requires extension |
| Safari | ❌ | No Web MIDI support |
| Chrome on Android | ✅ | Works with USB/BLE MIDI |
| Chrome on iOS | ❌ | iOS restricts Web MIDI |

---

## License

MIT — free to use and modify.
