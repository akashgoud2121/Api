import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';
import cors from 'cors';

const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

function parseDataUri(dataUri: string) {
  const m = dataUri.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] };
}

// Minimal CORS wrapper
const allowCors = (handler: any) => async (req: VercelRequest, res: VercelResponse) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin as string);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return handler(req, res);
};

export default allowCors(async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if (!GOOGLE_AI_API_KEY) return res.status(500).json({ error: 'Missing GOOGLE_AI_API_KEY' });

    const { speechSample, mode, question, perfectAnswer } = req.body || {};
    if (!speechSample || !mode) return res.status(400).json({ error: 'Missing required fields.' });

    let systemPrompt = perfectAnswer
      ? `You are a professional exam evaluator. Your task is to evaluate the candidate's answer compared to the perfect answer based on the following 15 criteria. For each criterion, provide Evaluation, Comparison, and Feedback.`
      : `You are a professional speech coach. Analyze the sample and provide constructive feedback.`;

    systemPrompt += `
IMPORTANT: The speech sample may be provided as TEXT or as AUDIO. If audio is provided, first TRANSCRIBE it exactly to text.

Return ONLY a valid JSON object with this shape:
{
  "metadata": {
    "wordCount": number,
    "fillerWordCount": number,
    "speechRateWPM": number,
    "averagePauseDurationMs": number,
    "pitchVariance": number,
    "audioDurationSeconds"?: number,
    "paceScore": number,
    "clarityScore": number,
    "pausePercentage": number
  },
  "highlightedTranscription": [{"text": string, "type": "default"|"filler"|"pause"}],
  "evaluationCriteria": [{
    "category": "Delivery"|"Language"|"Content",
    "criteria": "Fluency"|"Pacing"|"Clarity"|"Confidence"|"Emotional Tone"|"Grammar"|"Vocabulary"|"Word Choice"|"Conciseness"|"Filler Words"|"Relevance"|"Organization"|"Accuracy"|"Depth"|"Persuasiveness",
    "score": number,
    "evaluation": string,
    "comparison"?: string,
    "feedback": string
  }],
  "totalScore": number,
  "overallAssessment": string,
  "suggestedSpeech"?: string
}

Rules:
- Provide EXACTLY those 15 criteria with correct categories.
- highlightedTranscription must reconstruct the full text when concatenated.
- suggestedSpeech: 2–3 sentences users could say verbatim, tailored to context.`;

    let contextText = `Context: ${mode}`;
    if (question) contextText += `\nQuestion: ${question}`;
    if (perfectAnswer) contextText += `\nPerfect Answer: ${perfectAnswer}`;

    const parts: any[] = [{ text: systemPrompt }, { text: contextText }];
    if (typeof speechSample === 'string' && speechSample.startsWith('data:')) {
      const audio = parseDataUri(speechSample);
      if (!audio) return res.status(400).json({ error: 'Invalid audio data URI.' });
      parts.push({ inlineData: { mimeType: audio.mimeType, data: audio.base64 } });
    } else {
      parts.push({ text: `Speech Sample (Candidate's Answer): ${String(speechSample)}` });
    }

    const r = await fetch(`${GEMINI_URL}?key=${GOOGLE_AI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.3, topK: 40, topP: 0.9, maxOutputTokens: 8192 }
      })
    });

    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(502).json({ error: 'Model did not return JSON.' });

    const parsed = JSON.parse(match[0]);
    return res.json(parsed);
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: 'Analysis failed.' });
  }
});