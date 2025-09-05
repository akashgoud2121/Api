import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Allow only your dev and prod origins
const allowedOrigins = new Set<string>([
  'http://localhost:9002',
  // Add your production site(s) here, e.g.:
  // 'https://your-domain.com',
]);

function setCors(res: VercelResponse, origin?: string) {
  const allowOrigin = origin && allowedOrigins.has(origin) ? origin : 'http://localhost:9002';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '600');
}

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://your-domain.com', // replace with your site URL (optional but recommended)
    'X-Title': 'Speech Analysis Assistant',     // replace with your site title (optional)
  },
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = (req.headers.origin as string) || '';
  setCors(res, origin);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'Missing OPENROUTER_API_KEY' });
    }

    const { speechSample, mode, question, perfectAnswer } = req.body || {};
    if (!speechSample || !mode) {
      return res.status(400).json({ error: 'Missing required fields: speechSample, mode' });
    }

    let systemPrompt = '';
    if (perfectAnswer) {
      systemPrompt = `You are a professional exam evaluator. Your task is to evaluate the candidate's answer compared to the perfect answer across 15 criteria.

For EACH criterion, produce:
- Evaluation: 2–3 sentences minimum, detailed and specific.
- Comparison: 3–4 sentences minimum, comparing candidate vs. perfect answer.
- Feedback: 2–3 sentences minimum, concrete and actionable.

Single-line responses are unacceptable. Be thorough and helpful.`;
    } else {
      systemPrompt = `You are a professional speech coach. Analyze a speech sample and provide constructive feedback across 15 criteria.

For EACH criterion, produce:
- Evaluation: 2–3 sentences minimum, detailed and specific.
- Feedback: 2–3 sentences minimum, concrete and actionable.

Single-line responses are unacceptable. Be thorough and helpful.`;
    }

    systemPrompt += `

IMPORTANT:
- 'speechSample' may be text OR an audio data URI. If audio, first transcribe it, then analyze the transcription.
- Output MUST be a valid JSON object following this schema:
{
  "metadata": {
    "wordCount": number,
    "fillerWordCount": number,
    "speechRateWPM": number,
    "averagePauseDurationMs": number,
    "pitchVariance": number,
    "audioDurationSeconds": number,
    "paceScore": number,
    "clarityScore": number,
    "pausePercentage": number
  },
  "highlightedTranscription": [
    { "text": string, "type": "default" | "filler" | "pause" }
  ],
  "evaluationCriteria": [
    {
      "category": "Delivery" | "Language" | "Content",
      "criteria": "Fluency" | "Pacing" | "Clarity" | "Confidence" | "Emotional Tone" |
                  "Grammar" | "Vocabulary" | "Word Choice" | "Conciseness" | "Filler Words" |
                  "Relevance" | "Organization" | "Accuracy" | "Depth" | "Persuasiveness",
      "score": number,
      "evaluation": string,
      "feedback": string,
      "comparison": string
    }
  ],
  "totalScore": number,
  "overallAssessment": string,
  "suggestedSpeech": string
}

Requirements:
- Provide exactly 15 items in evaluationCriteria covering the listed criteria.
- highlightedTranscription must segment the full transcription: each word as 'default', filler words as 'filler', and significant silences as 'pause' like "[PAUSE: 1.2s]".
- suggestedSpeech: 1–3 sentences demonstrating an improved delivery matching the user's context.`;

    let contextText = `Context: ${mode}`;
    if (question) contextText += `\nQuestion: ${question}`;
    if (perfectAnswer) contextText += `\nPerfect Answer: ${perfectAnswer}`;

    let userMessage = `${contextText}\n\n`;
    if (typeof speechSample === 'string' && speechSample.startsWith('data:')) {
      userMessage += `Speech Sample (Audio Data URI): ${speechSample}`;
    } else {
      userMessage += `Speech Sample (Text): ${String(speechSample)}`;
    }

    const completion = await openai.chat.completions.create({
      model: 'openai/gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 4000,
      response_format: { type: 'json_object' }
    });

    const responseText = completion.choices?.[0]?.message?.content;
    if (!responseText) {
      return res.status(502).json({ error: 'No response from model' });
    }

    let parsed: any;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      return res.status(502).json({ error: 'Model returned non-JSON output' });
    }

    if (!parsed?.evaluationCriteria || !Array.isArray(parsed.evaluationCriteria) || parsed.evaluationCriteria.length !== 15) {
      return res.status(502).json({ error: 'Invalid response structure: evaluationCriteria must contain 15 items' });
    }

    return res.status(200).json(parsed);
  } catch (err: any) {
    console.error('API Error:', err);
    setCors(res, origin);
    return res.status(500).json({ error: 'Analysis failed', details: err?.message || 'unknown' });
  }
}