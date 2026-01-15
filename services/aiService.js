const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");

const USE_LOCAL_AI = process.env.USE_LOCAL_AI === "true";

// ==============================
// CONFIG
// ==============================
const WHISPER_URL = USE_LOCAL_AI
  ? "http://127.0.0.1:8000"
  : process.env.WHISPER_BASE_URL;

const OLLAMA_URL = "http://127.0.0.1:11434";

// ==============================
// TRANSCRIPTION
// ==============================
async function processMeetingAudio(filePath, userPrompt = "") {
  const formData = new FormData();
  formData.append("file", fs.createReadStream(filePath));

  let transcriptionPrompt = "Preserve exact names and technical terms.";
  if (userPrompt) transcriptionPrompt += `\nContext: ${userPrompt}`;

  formData.append("prompt", transcriptionPrompt);

  try {
    const res = await axios.post(
      `${WHISPER_URL}/transcribe`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: 0
      }
    );

    return {
      transcript: res.data.transcript || "",
      language: res.data.language || "unknown"
    };
  } catch (err) {
    console.error("❌ Whisper error:", err.message);
    throw new Error("Transcription failed");
  }
}

// ==============================
// MEETING ANALYSIS (OLLAMA)
// ==============================
async function analyzeMeeting(transcript) {
  if (!transcript || transcript.length < 10) {
    return {
      executiveSummary: "",
      keyDecisions: [],
      actionItems: [],
      cleanTranscript: transcript
    };
  }

  const prompt = `
You are a STRICT, EXTRACTIVE meeting parser.

RULES:
- Use ONLY exact words from transcript
- Do NOT paraphrase or invent
- Return VALID JSON ONLY

TRANSCRIPT:
"""
${transcript}
"""

RETURN:
{
  "executiveSummary": "",
  "keyDecisions": [],
  "actionItems": [
    { "task": "", "assignee": "", "deadline": "" }
  ],
  "cleanTranscript": ""
}
`;

  try {
    const res = await axios.post(
      `${OLLAMA_URL}/api/generate`,
      {
        model: "mistral",
        prompt,
        stream: false,
        options: {
          temperature: 0,
          num_ctx: 4096
        }
      },
      { timeout: 0 }
    );

    const match = res.data.response.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Invalid JSON from Ollama");

    return JSON.parse(match[0]);
  } catch (err) {
    console.error("❌ Analysis error:", err.message);
    return {
      executiveSummary: "",
      keyDecisions: [],
      actionItems: [],
      cleanTranscript: transcript
    };
  }
}

module.exports = { processMeetingAudio, analyzeMeeting };
