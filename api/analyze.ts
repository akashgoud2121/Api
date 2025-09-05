import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Initialize OpenAI client with OpenRouter
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://your-site.com', // Replace with your actual site URL
    'X-Title': 'Speech Analysis Assistant', // Replace with your site name
  },
});

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
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Missing OPENROUTER_API_KEY' });

    const { speechSample, mode, question, perfectAnswer } = req.body || {};
    if (!speechSample || !mode) return res.status(400).json({ error: 'Missing required fields.' });

    // Build the system prompt dynamically based on the input
    let systemPrompt = '';

    if (perfectAnswer) {
      systemPrompt = `You are a professional exam evaluator. Your task is to evaluate the candidate's answer compared to the perfect answer based on the following 15 criteria. For each criterion, you must provide:
- **Evaluation:** A detailed, multi-sentence assessment (2-3 sentences minimum) of the candidate's performance on that criterion.
- **Comparison:** A comprehensive analysis (3-4 sentences minimum) of how the candidate's answer compares with the perfect answer for that criterion.
- **Feedback:** Specific, actionable suggestions for improvement (2-3 sentences minimum).

CRITICAL: Each evaluation, comparison, and feedback must be substantial and detailed. Single-line responses are not acceptable.`;
    } else {
      systemPrompt = `You are a professional speech coach. Your task is to analyze a speech sample and provide constructive feedback.

CRITICAL: Each evaluation and feedback must be detailed and comprehensive (2-3 sentences minimum). Single-line responses are not acceptable.`;
    }

    systemPrompt += `

IMPORTANT: The speech sample may be provided as text OR as an audio data URI. If the 'speechSample' field contains a data URI (e.g., 'data:audio/wav;base64,...'), you MUST first transcribe the audio into text. Then, use that transcription for the analysis below. If the 'speechSample' is already text, use it directly.

Return your answer as a valid JSON object following this schema exactly (do not include any extra text).

Follow these instructions when generating the JSON:
- Evaluate the speech sample on ALL 15 of the following criteria.
- **Delivery Criteria**: Fluency, Pacing, Clarity, Confidence, Emotional Tone. Assign the category 'Delivery' to these.
- **Language Criteria**: Grammar, Vocabulary, Word Choice, Conciseness, Filler Words. Assign the category 'Language' to these.
- **Content Criteria**: Relevance, Organization, Accuracy, Depth, Persuasiveness. Assign the category 'Content' to these.

**QUALITY REQUIREMENTS:**
- For each of the 15 criteria, provide a score from 0-10, a detailed evaluation (2-3 sentences), and comprehensive actionable feedback (2-3 sentences).
- Each evaluation must explain WHY the score was given and provide specific examples from the speech.
- Each feedback must offer concrete, actionable steps for improvement.
- Single-line or brief responses are unacceptable - be thorough and detailed.`;

    if (perfectAnswer) {
      systemPrompt += `
- For each criterion, you MUST also provide a detailed 'comparison' (3-4 sentences) of the candidate's answer to the perfect answer.`;
    }

    systemPrompt += `
- The totalScore is from 0 to 100, and should evaluate the speech sample and context as a whole.
- The wordCount, fillerWordCount, speechRateWPM, averagePauseDurationMs, and pitchVariance should be calculated or estimated from the transcription.
- The paceScore and clarityScore should be scores from 0-100 based on the analysis.
- The pausePercentage should be the estimated percentage of total time the speaker was pausing.
- **highlightedTranscription**: This is critical. You must meticulously segment the entire transcription. Create a segment for every single word or pause. A 'filler' type is ONLY for a single filler word (e.g., um, ah, like). A 'pause' type is for significant silences (e.g., '[PAUSE: 1.2s]'). All other words are 'default'. Concatenating all 'text' fields MUST reconstruct the full transcription with pause annotations. Do not leave this field empty. Be extremely thorough.
- **suggestedSpeech**: Provide a concise (1–3 sentences) rephrasing that demonstrates ideal delivery for the user's context. Keep it natural, specific, and immediately usable. Use neutral tone unless the mode implies otherwise.

**REMEMBER: Quality over brevity. Each evaluation and feedback must be substantial and helpful.**`;

    // Build context text
    let contextText = `Context: ${mode}`;
    if (question) contextText += `\nQuestion: ${question}`;
    if (perfectAnswer) contextText += `\nPerfect Answer: ${perfectAnswer}`;

    // Build the user message
    let userMessage = `${contextText}\n\n`;
    
    if (typeof speechSample === 'string' && speechSample.startsWith('data:')) {
      userMessage += `Speech Sample (Audio Data URI): ${speechSample}`;
    } else {
      userMessage += `Speech Sample (Text): ${String(speechSample)}`;
    }

    // Make API call to OpenRouter
    const completion = await openai.chat.completions.create({
      model: 'openai/gpt-4o', // Using GPT-4o for best results
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: userMessage
        }
      ],
      temperature: 0.3,
      max_tokens: 4000,
      response_format: {
        type: "json_object"
      }
    });

    const responseText = completion.choices[0]?.message?.content;
    if (!responseText) {
      return res.status(500).json({ error: 'No response from AI model' });
    }

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      console.error('Response text:', responseText);
      return res.status(500).json({ error: 'Failed to parse AI response as JSON' });
    }

    // Validate that we have the required fields
    if (!parsed.evaluationCriteria || !Array.isArray(parsed.evaluationCriteria)) {
      return res.status(500).json({ error: 'Invalid response structure from AI' });
    }

    return res.json(parsed);

  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: 'Analysis failed', 
      details: error.message 
    });
  }
});