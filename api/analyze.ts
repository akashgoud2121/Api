import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';

const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent'; // Changed to pro

function parseDataUri(dataUri: string) {
  const match = dataUri.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

// CORS wrapper
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

    // Build the system prompt dynamically based on the input (matching analyze-speech.ts logic)
    let systemPrompt = '';

    if (perfectAnswer) {
      systemPrompt = `You are a professional exam evaluator. Your task is to evaluate the candidate's answer compared to the perfect answer based on the following 15 criteria. For each criterion, you must provide:
- **Evaluation:** A brief assessment of the candidate's performance on that criterion.
- **Comparison:** A detailed analysis of how the candidate's answer compares with the perfect answer for that criterion.
- **Feedback:** Specific, actionable suggestions for improvement.
`;
    } else {
      systemPrompt = `You are a professional speech coach. Your task is to analyze a speech sample and provide constructive feedback.
`;
    }

    systemPrompt += `
IMPORTANT: The speech sample may be provided as text OR as an audio data URI. If the 'speechSample' field contains a data URI (e.g., 'data:audio/wav;base64,...'), you MUST first transcribe the audio into text. Then, use that transcription for the analysis below. If the 'speechSample' is already text, use it directly.

Return your answer as a valid JSON object following this schema exactly (do not include any extra text).

Follow these instructions when generating the JSON:
- Evaluate the speech sample on ALL 15 of the following criteria.
- **Delivery Criteria**: Fluency, Pacing, Clarity, Confidence, Emotional Tone. Assign the category 'Delivery' to these.
- **Language Criteria**: Grammar, Vocabulary, Word Choice, Conciseness, Filler Words. Assign the category 'Language' to these.
- **Content Criteria**: Relevance, Organization, Accuracy, Depth, Persuasiveness. Assign the category 'Content' to these.
- For each of the 15 criteria, provide a score from 0-10, an evaluation, and actionable feedback.`;

    if (perfectAnswer) {
      systemPrompt += `
- For each criterion, you MUST also provide a 'comparison' of the candidate's answer to the perfect answer.`;
    }

    systemPrompt += `
- The totalScore is from 0 to 100, and should evaluate the speech sample and context as a whole.
- The wordCount, fillerWordCount, speechRateWPM, averagePauseDurationMs, and pitchVariance should be calculated or estimated from the transcription.
- The paceScore and clarityScore should be scores from 0-100 based on the analysis.
- The pausePercentage should be the estimated percentage of total time the speaker was pausing.
- **highlightedTranscription**: This is critical. You must meticulously segment the entire transcription. Create a segment for every single word or pause. A 'filler' type is ONLY for a single filler word (e.g., um, ah, like). A 'pause' type is for significant silences (e.g., '[PAUSE: 1.2s]'). All other words are 'default'. Concatenating all 'text' fields MUST reconstruct the full transcription with pause annotations. Do not leave this field empty. Be extremely thorough.
- **suggestedSpeech**: Provide a concise (1–3 sentences) rephrasing that demonstrates ideal delivery for the user's context. Keep it natural, specific, and immediately usable. Use neutral tone unless the mode implies otherwise.
`;

    // Build context text
    let contextText = `Context: ${mode}`;
    if (question) contextText += `\nQuestion: ${question}`;
    if (perfectAnswer) contextText += `\nPerfect Answer: ${perfectAnswer}`;

    // Build parts array
    const parts: any[] = [{ text: systemPrompt }, { text: contextText }];
    
    if (typeof speechSample === 'string' && speechSample.startsWith('data:')) {
      const audio = parseDataUri(speechSample);
      if (!audio) return res.status(400).json({ error: 'Invalid audio data URI.' });
      parts.push({ inlineData: { mimeType: audio.mimeType, data: audio.base64 } });
    } else {
      parts.push({ text: `Speech Sample (Candidate's Answer): ${String(speechSample)}` });
    }

    // Make API call with response schema enforcement
    const r = await fetch(`${GEMINI_URL}?key=${GOOGLE_AI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { 
          temperature: 0.3, 
          topK: 40, 
          topP: 0.9, 
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              metadata: {
                type: 'object',
                properties: {
                  wordCount: { type: 'number' },
                  fillerWordCount: { type: 'number' },
                  speechRateWPM: { type: 'number' },
                  averagePauseDurationMs: { type: 'number' },
                  pitchVariance: { type: 'number' },
                  audioDurationSeconds: { type: 'number' },
                  paceScore: { type: 'number' },
                  clarityScore: { type: 'number' },
                  pausePercentage: { type: 'number' }
                },
                required: ['wordCount','fillerWordCount','speechRateWPM','averagePauseDurationMs','pitchVariance','paceScore','clarityScore','pausePercentage']
              },
              highlightedTranscription: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    type: { type: 'string', enum: ['default','filler','pause'] }
                  },
                  required: ['text','type']
                }
              },
              evaluationCriteria: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: { type: 'string', enum: ['Delivery','Language','Content'] },
                    criteria: { type: 'string', enum: ['Fluency','Pacing','Clarity','Confidence','Emotional Tone','Grammar','Vocabulary','Word Choice','Conciseness','Filler Words','Relevance','Organization','Accuracy','Depth','Persuasiveness']},
                    score: { type: 'number' },
                    evaluation: { type: 'string' },
                    comparison: { type: 'string' },
                    feedback: { type: 'string' }
                  },
                  required: ['category','criteria','score','evaluation','feedback']
                },
                minItems: 15,
                maxItems: 15
              },
              totalScore: { type: 'number' },
              overallAssessment: { type: 'string' },
              suggestedSpeech: { type: 'string' }
            },
            required: ['metadata','evaluationCriteria','totalScore','overallAssessment']
          }
        }
      })
    });

    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json() as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // With responseMimeType: 'application/json', the response should already be valid JSON
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      // Fallback to regex extraction if needed
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return res.status(502).json({ error: 'Model did not return valid JSON.' });
      parsed = JSON.parse(match[0]);
    }

    return res.json(parsed);
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: 'Analysis failed.' });
  }
});