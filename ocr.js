/**
 * ocr.js — Sheet Music Recognition Module
 *
 * Public API:
 *   SheetOCR.analyzeImage(file)   → Promise<NoteEvent[]>
 *   SheetOCR.demoNotes()          → NoteEvent[]
 *   SheetOCR.getApiKey()          → string|null
 *   SheetOCR.setApiKey(key)       → void
 *   SheetOCR.getProvider()        → string
 *   SheetOCR.setProvider(p)       → void
 *
 * NoteEvent: { note: string, duration: string, startBeat: number }
 */

const SheetOCR = (() => {

  // ── Duration beat-lengths map ──────────────────────────────────────────
  const DURATION_BEATS = {
    whole:     4,
    half:      2,
    "dotted-half": 3,
    quarter:   1,
    "dotted-quarter": 1.5,
    eighth:    0.5,
    sixteenth: 0.25,
  };

  // ── Storage keys ───────────────────────────────────────────────────────
  const STORAGE_KEY     = "piano-scanner-api-key";
  const STORAGE_PROVIDER = "piano-scanner-provider";

  function getApiKey()  { return localStorage.getItem(STORAGE_KEY) || ""; }
  function setApiKey(k) { localStorage.setItem(STORAGE_KEY, k); }
  function getProvider() { return localStorage.getItem(STORAGE_PROVIDER) || "gemini"; }
  function setProvider(p) { localStorage.setItem(STORAGE_PROVIDER, p); }

  // ── Demo melody: Amazing Grace (first verse) ───────────────────────────
  const AMAZING_GRACE = [
    { note: "G3",  duration: "quarter",  startBeat: 0   },
    { note: "C4",  duration: "half",     startBeat: 1   },
    { note: "E4",  duration: "quarter",  startBeat: 3   },
    { note: "C4",  duration: "half",     startBeat: 4   },
    { note: "E4",  duration: "quarter",  startBeat: 6   },
    { note: "G4",  duration: "half",     startBeat: 7   },
    { note: "E4",  duration: "half",     startBeat: 9   },
    { note: "C4",  duration: "half",     startBeat: 11  },
    { note: "E4",  duration: "quarter",  startBeat: 13  },
    { note: "C4",  duration: "half",     startBeat: 14  },
    { note: "A3",  duration: "quarter",  startBeat: 16  },
    { note: "G3",  duration: "whole",    startBeat: 17  },
    { note: "G3",  duration: "quarter",  startBeat: 21  },
    { note: "C4",  duration: "half",     startBeat: 22  },
    { note: "E4",  duration: "quarter",  startBeat: 24  },
    { note: "C4",  duration: "half",     startBeat: 25  },
    { note: "E4",  duration: "quarter",  startBeat: 27  },
    { note: "G4",  duration: "half",     startBeat: 28  },
    { note: "A4",  duration: "half",     startBeat: 30  },
    { note: "G4",  duration: "whole",    startBeat: 32  },
  ];

  function demoNotes() {
    return JSON.parse(JSON.stringify(AMAZING_GRACE));
  }

  // ── MIDI note number helper ───────────────────────────────────────────
  function noteToMidi(noteStr) {
    const NOTES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const match = noteStr.match(/^([A-Ga-g][b#]?)(\d)$/);
    if (!match) return null;
    let name = match[1].toUpperCase();
    const octave = parseInt(match[2], 10);
    const FLAT_MAP = { "DB":"C#","EB":"D#","FB":"E","GB":"F#","AB":"G#","BB":"A#","CB":"B" };
    if (name.endsWith("B") && name.length === 2) name = FLAT_MAP[name] || name;
    const idx = NOTES.indexOf(name);
    if (idx === -1) return null;
    return (octave + 1) * 12 + idx;
  }

  function beatsForDuration(duration) {
    return DURATION_BEATS[duration.toLowerCase()] ?? 1;
  }

  // ── The prompt sent to the AI vision model ─────────────────────────────
  const SYSTEM_PROMPT = `You are an expert music transcription assistant. Analyze sheet music images with extreme precision.

Rules:
- Extract EVERY note visible in the image, in order from left to right, top staff first.
- For chords (multiple notes at the same beat), list each note separately with the same startBeat.
- Use scientific pitch notation: C4 = middle C. Include sharps (#) and flats (b) as written.
- Identify note durations from their visual appearance (filled/hollow heads, stems, flags, beams, dots).
- Track the cumulative beat position. Beat 0 = first note. Quarter note = 1 beat.
- Account for time signature: 4/4 = 4 beats/measure, 3/4 = 3 beats/measure, 6/8 = 6 eighth-note beats, etc.
- Handle rests by advancing startBeat without emitting a note.
- For tied notes, combine into a single longer duration.
- For dotted notes, use "dotted-half" (3 beats) or "dotted-quarter" (1.5 beats).
- If key signature has sharps/flats, apply them to all relevant notes unless a natural sign overrides.

Return ONLY a valid JSON array. No markdown, no explanation, no code fences.
Each element: { "note": "<pitch>", "duration": "<whole|dotted-half|half|dotted-quarter|quarter|eighth|sixteenth>", "startBeat": <number> }`;

  // ── Gemini Vision API ──────────────────────────────────────────────────
  async function analyzeWithGemini(base64, mimeType, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: SYSTEM_PROMPT },
            { inlineData: { mimeType, data: base64 } }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
        }
      })
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${err}`);
    }
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("No response from Gemini");
    return parseNoteJson(text);
  }

  // ── OpenAI Vision API ──────────────────────────────────────────────────
  async function analyzeWithOpenAI(base64, mimeType, apiKey) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: SYSTEM_PROMPT },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }
          ],
        }],
        max_tokens: 8192,
        temperature: 0.1,
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${err}`);
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("No response from OpenAI");
    return parseNoteJson(text);
  }

  // ── Anthropic Vision API ───────────────────────────────────────────────
  async function analyzeWithAnthropic(base64, mimeType, apiKey) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8192,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: SYSTEM_PROMPT },
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } }
          ],
        }],
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${err}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (!text) throw new Error("No response from Anthropic");
    return parseNoteJson(text);
  }

  // ── JSON parser (tolerant of markdown fences) ──────────────────────────
  function parseNoteJson(text) {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    cleaned = cleaned.trim();

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error("Expected a JSON array from AI response");

    // Validate & normalize each note
    return parsed.map((n, i) => {
      if (!n.note || n.startBeat === undefined) {
        throw new Error(`Invalid note at index ${i}: missing 'note' or 'startBeat'`);
      }
      return {
        note:      String(n.note),
        duration:  String(n.duration || "quarter"),
        startBeat: Number(n.startBeat),
      };
    });
  }

  // ── Main analyze function ─────────────────────────────────────────────
  async function analyzeImage(file) {
    const apiKey  = getApiKey();
    const provider = getProvider();

    if (!apiKey) {
      throw new Error("No API key set. Open Settings (⚙️) and enter your API key.");
    }

    const base64   = await fileToBase64(file);
    const mimeType = file.type || "image/jpeg";

    console.info(`[SheetOCR] Analyzing with ${provider}...`);

    switch (provider) {
      case "gemini":
        return analyzeWithGemini(base64, mimeType, apiKey);
      case "openai":
        return analyzeWithOpenAI(base64, mimeType, apiKey);
      case "anthropic":
        return analyzeWithAnthropic(base64, mimeType, apiKey);
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  return {
    analyzeImage, demoNotes, noteToMidi, beatsForDuration, DURATION_BEATS,
    getApiKey, setApiKey, getProvider, setProvider,
  };
})();
