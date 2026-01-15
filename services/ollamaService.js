const axios = require("axios");

async function analyzeMeeting(transcript) {
  if (!transcript || transcript.length < 10) {
    console.warn("⚠️ Transcript too short to analyze.");
    return {
      executiveSummary: "",
      keyDecisions: [],
      actionItems: [],
      cleanTranscript: transcript
    };
  }

  const prompt = `
You are a STRICT, EXTRACTIVE meeting parser.

ABSOLUTE RULES (NO EXCEPTIONS):
- Use ONLY exact words from transcript
- DO NOT translate
- DO NOT paraphrase
- DO NOT summarize
- DO NOT invent names, roles, or structure
- DO NOT say "team", "lead", "assigned", or similar words unless spoken

ASSIGNEE RULES:
- If a PERSON NAME appears → use it EXACTLY
- If speaker says "میں" → assignee = "Speaker"
- If no name or "میں" → assignee = "Unassigned"

URDU GRAMMAR RULES (MANDATORY):
- "[Name] بنائے گا / کرے گا" → assign task to that Name
- "میں کروں گا / میں ہینڈل کروں گا" → assignee = "Speaker"

DATE RULES:
- Copy date EXACTLY as spoken (e.g. 30 جنوری)
- Do NOT convert to English

FIELD RULES:
- executiveSummary MUST be a DIRECT sentence copied from transcript
- If no single sentence fits → leave it EMPTY STRING ""
- keyDecisions MUST be exact spoken clauses
- actionItems MUST map directly to verbs spoken

TRANSCRIPT:
"""
${transcript}
"""

RETURN VALID JSON ONLY:
{
  "executiveSummary": "",
  "keyDecisions": [],
  "actionItems": [
    {
      "task": "",
      "assignee": "",
      "deadline": ""
    }
  ],
  "cleanTranscript": ""
}
`;

  try {
    const llmUrl = process.env.USE_LOCAL_AI === "true"
      ? "http://127.0.0.1:11434/api/generate"
      : process.env.LLM_API_URL; // e.g., OpenAI endpoint for remote

    const res = await axios.post(
      llmUrl,
      {
        model: "mistral",
        prompt,
        stream: false,
        options: {
          temperature: 0,
          top_p: 0.1,
          repeat_penalty: 1.3
        }
      },
      { timeout: 0 }
    );

    const text = res.data.response;

    // Robust JSON parsing
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No valid JSON found in response");

    return JSON.parse(jsonMatch[0]);

  } catch (error) {
    console.error("❌ analyzeMeeting failed:", error.message);
    return {
      executiveSummary: "",
      keyDecisions: [],
      actionItems: [],
      cleanTranscript: transcript
    };
  }
}

module.exports = { analyzeMeeting };
