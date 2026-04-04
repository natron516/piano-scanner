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
  const SYSTEM_PROMPT = `You are an expert music transcription AI. Your job is to read sheet music from an image and output precise note data.

STEP 1 — Analyze the score:
- Identify the clef (treble/bass), key signature, and time signature FIRST.
- Note the key signature sharps/flats and apply them throughout unless a natural sign overrides.
- For grand staff (treble + bass), read treble clef (right hand) first, then bass clef (left hand) separately.

STEP 2 — Read each measure left to right:
- Identify each note's pitch using the staff lines and spaces. Remember:
  - Treble clef lines bottom to top: E4 G4 B4 D5 F5. Spaces: F4 A4 C5 E5.
  - Bass clef lines bottom to top: G2 B2 D3 F3 A3. Spaces: A2 C3 E3 G3.
  - Middle C (C4) is one ledger line below treble staff or one above bass staff.
- Identify duration from note appearance: whole (open, no stem), half (open, stem), quarter (filled, stem), eighth (filled, stem, 1 flag/beam), sixteenth (filled, stem, 2 flags/beams).
- Dotted notes: "dotted-half" = 3 beats, "dotted-quarter" = 1.5 beats.
- Rests: do NOT emit a note, but advance startBeat by the rest's duration.
- Ties: combine tied notes into one longer note.

STEP 3 — Calculate startBeat:
- Beat 0 = the very first note.
- Each subsequent note's startBeat = previous note's startBeat + previous note's duration in beats.
- Quarter = 1 beat, half = 2, whole = 4, eighth = 0.5, sixteenth = 0.25, dotted-half = 3, dotted-quarter = 1.5.
- For chords (simultaneous notes), all notes share the same startBeat.

OUTPUT FORMAT — Return ONLY a raw JSON array. No markdown fences, no explanation, no thinking text.
Each element: { "note": "C4", "duration": "quarter", "startBeat": 0 }
Valid durations: whole, dotted-half, half, dotted-quarter, quarter, eighth, sixteenth
Valid notes: scientific pitch like C4, D#4, Bb3, etc.`;

  // ── Gemini Vision API ──────────────────────────────────────────────────
  async function analyzeWithGemini(base64, mimeType, apiKey, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: base64 } }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 16384,
        }
      })
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${err}`);
    }
    const data = await response.json();
    // Gemini 2.5 thinking models return multiple parts — find the text part with JSON
    const parts = data.candidates?.[0]?.content?.parts || [];
    let text = "";
    for (const part of parts) {
      if (part.text && part.text.includes("[")) {
        text = part.text;
        break;
      }
    }
    // Fallback: concatenate all text parts
    if (!text) {
      text = parts.map(p => p.text || "").join("\n");
    }
    if (!text) throw new Error("No response from Gemini. Raw: " + JSON.stringify(data).substring(0, 300));
    console.info("[SheetOCR] Gemini raw response length:", text.length);
    return parseNoteJson(text);
  }

  // ── OpenAI Vision API ──────────────────────────────────────────────────
  async function analyzeWithOpenAI(base64, mimeType, apiKey, prompt) {
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
            { type: "text", text: prompt },
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
  async function analyzeWithAnthropic(base64, mimeType, apiKey, prompt) {
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
            { type: "text", text: prompt },
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

  // ── JSON parser (tolerant of markdown, extra text, truncation) ─────────
  function parseNoteJson(text) {
    let cleaned = text.trim();

    // Strip markdown code fences
    cleaned = cleaned.replace(/```(?:json)?\s*/gi, "").replace(/\s*```/gi, "");
    cleaned = cleaned.trim();

    // Extract JSON array from any surrounding text
    const arrayStart = cleaned.indexOf("[");
    if (arrayStart === -1) {
      throw new Error("No JSON array found in AI response. Got: " + cleaned.substring(0, 200));
    }
    const arrayEnd = cleaned.lastIndexOf("]");
    if (arrayEnd === -1 || arrayEnd <= arrayStart) {
      // Truncated response — no closing bracket. Try to salvage.
      cleaned = cleaned.substring(arrayStart);
      const lastBrace = cleaned.lastIndexOf("}");
      if (lastBrace > 0) {
        cleaned = cleaned.substring(0, lastBrace + 1) + "]";
        console.warn("[SheetOCR] Response truncated — salvaging partial notes.");
      } else {
        throw new Error("AI response was truncated before any complete notes.");
      }
    } else {
      cleaned = cleaned.substring(arrayStart, arrayEnd + 1);
    }

    // Fix trailing commas before ]
    cleaned = cleaned.replace(/,\s*]/g, "]");

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Try to salvage truncated JSON by finding last complete object
      const lastBrace = cleaned.lastIndexOf("}");
      if (lastBrace > 0) {
        const salvaged = cleaned.substring(0, lastBrace + 1) + "]";
        try {
          parsed = JSON.parse(salvaged);
          console.warn("[SheetOCR] Salvaged truncated JSON — some notes may be missing.");
        } catch (e2) {
          throw new Error("Could not parse AI response: " + e.message);
        }
      } else {
        throw new Error("Could not parse AI response: " + e.message);
      }
    }

    if (!Array.isArray(parsed)) throw new Error("Expected a JSON array from AI response");

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

  // ── Build context-enhanced prompt ─────────────────────────────────────
  function buildPrompt(scoreInfo) {
    let extra = "";
    if (scoreInfo.key) extra += `\nThe key signature is ${scoreInfo.key} major. Apply the correct sharps/flats throughout.`;
    if (scoreInfo.time) extra += `\nThe time signature is ${scoreInfo.time}. Each measure has ${scoreInfo.time === "3/4" ? "3" : scoreInfo.time === "6/8" ? "6 eighth-note" : scoreInfo.time.split("/")[0]} beats.`;
    if (scoreInfo.tempo) extra += `\nThe tempo marking is ${scoreInfo.tempo} BPM (for reference only — does not affect beat positions).`;
    if (scoreInfo.clef === "treble") extra += `\nThis is a single treble clef staff (melody line only). Read only the treble staff.`;
    if (scoreInfo.clef === "grand") extra += `\nThis is a grand staff (treble + bass). Read the treble clef (right hand melody) first. Then read bass clef notes with the same startBeat positions for chords/accompaniment.`;
    if (scoreInfo.clef === "bass") extra += `\nThis is a bass clef staff only.`;
    return SYSTEM_PROMPT + extra;
  }

  // ── Detection prompt (pass 1) ────────────────────────────────────────
  const DETECT_PROMPT = `Look at this sheet music image. Identify ONLY the following metadata. Return a JSON object (no markdown, no explanation):
{
  "key": "<key signature, e.g. C, G, D, F, Bb, Eb, etc.>",
  "timeSignature": "<e.g. 4/4, 3/4, 6/8>",
  "tempo": <number or null if not marked>,
  "clef": "<treble, bass, or grand>",
  "title": "<title if visible, or null>"
}
Return ONLY the raw JSON object. No markdown fences.`;

  async function detectScoreInfo(base64, mimeType, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: DETECT_PROMPT },
            { inlineData: { mimeType, data: base64 } }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
      })
    });
    if (!response.ok) {
      console.warn("[SheetOCR] Score info detection failed, continuing without.");
      return {};
    }
    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    let text = "";
    for (const part of parts) {
      if (part.text && part.text.includes("{")) { text = part.text; break; }
    }
    if (!text) text = parts.map(p => p.text || "").join("\n");
    try {
      // Extract JSON object
      let cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/\s*```/gi, "").trim();
      const objStart = cleaned.indexOf("{");
      const objEnd = cleaned.lastIndexOf("}");
      if (objStart >= 0 && objEnd > objStart) {
        cleaned = cleaned.substring(objStart, objEnd + 1);
      }
      const info = JSON.parse(cleaned);
      console.info("[SheetOCR] Detected score info:", info);
      return info;
    } catch (e) {
      console.warn("[SheetOCR] Could not parse score info:", e.message);
      return {};
    }
  }

  // ── Main analyze function (two-pass) ─────────────────────────────────
  async function analyzeImage(file, scoreInfo = {}) {
    const apiKey  = getApiKey();
    const provider = getProvider();

    if (!apiKey) {
      throw new Error("No API key set. Open Settings (⚙️) and enter your API key.");
    }

    const base64   = await fileToBase64(file);
    const mimeType = file.type || "image/jpeg";

    // Pass 1: Auto-detect score info (merge with any user overrides)
    let detected = {};
    if (provider === "gemini") {
      detected = await detectScoreInfo(base64, mimeType, apiKey);
    }
    const mergedInfo = {
      key:   scoreInfo.key   || detected.key   || "",
      time:  scoreInfo.time  || detected.timeSignature || "",
      tempo: scoreInfo.tempo || detected.tempo || "",
      clef:  scoreInfo.clef  || detected.clef  || "treble",
    };

    // Emit detected info so UI can display it
    document.dispatchEvent(new CustomEvent("ocr:detected", { detail: { ...mergedInfo, title: detected.title } }));

    console.info(`[SheetOCR] Pass 2: reading notes with ${provider}...`, mergedInfo);
    const prompt = buildPrompt(mergedInfo);

    switch (provider) {
      case "gemini":
        return analyzeWithGemini(base64, mimeType, apiKey, prompt);
      case "openai":
        return analyzeWithOpenAI(base64, mimeType, apiKey, prompt);
      case "anthropic":
        return analyzeWithAnthropic(base64, mimeType, apiKey, prompt);
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
