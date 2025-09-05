import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';

const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  return handler(req, res);
};

export default allowCors(async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (!GOOGLE_AI_API_KEY) {
      return res.status(500).json({ error: 'Missing GOOGLE_AI_API_KEY' });
    }

    const { speechSample, mode, question, perfectAnswer } = req.body || {};

    if (!speechSample || !mode) {
      return res.status(400).json({ error: 'Missing required fields: speechSample and mode are required.' });
    }

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

    // Build the prompt parts (matching analyze-speech.ts structure)
    const parts: any[] = [];

    // Add the context information
    let contextText = `Context: ${mode}`;

    if (question) {
      contextText += `\nQuestion: ${question}`;
    }

    if (perfectAnswer) {
      contextText += `\nPerfect Answer: ${perfectAnswer}`;
    }

    parts.push({ text: contextText });

    // Add the speech sample (either as media or text)
    if (typeof speechSample === 'string' && speechSample.startsWith('data:')) {
      // It's an audio data URI
      const audioData = parseDataUri(speechSample);
      if (!audioData) {
        return res.status(400).json({ error: 'Invalid audio data URI format.' });
      }
      parts.push({
        inlineData: {
          mimeType: audioData.mimeType,
          data: audioData.base64
        }
      });
    } else {
      // It's text
      parts.push({
        text: `Speech Sample (Candidate's Answer): ${String(speechSample)}`
      });
    }

    // Make the API call to Gemini
    const geminiResponse = await fetch(`${GEMINI_URL}?key=${GOOGLE_AI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.3,
          topK: 40,
          topP: 0.9,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error('Gemini API error:', errorText);
      return res.status(geminiResponse.status).json({ 
        error: `Gemini API error: ${geminiResponse.status}` 
      });
    }

    const geminiData = await geminiResponse.json() as any;
    const responseText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!responseText) {
      return res.status(502).json({ 
        error: 'No response text from Gemini API' 
      });
    }

    // Parse the JSON response
    let parsedOutput;
    try {
      // Try to parse the response directly
      parsedOutput = JSON.parse(responseText);
    } catch (parseError) {
      // If direct parsing fails, try to extract JSON from the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('No JSON found in response:', responseText);
        return res.status(502).json({ 
          error: 'Model did not return valid JSON format' 
        });
      }
      
      try {
        parsedOutput = JSON.parse(jsonMatch[0]);
      } catch (secondParseError) {
        console.error('Failed to parse extracted JSON:', jsonMatch[0]);
        return res.status(502).json({ 
          error: 'Failed to parse JSON response from model' 
        });
      }
    }

    // Validate the required structure (basic validation)
    if (!parsedOutput.metadata || !parsedOutput.evaluationCriteria || !parsedOutput.totalScore) {
      return res.status(502).json({ 
        error: 'Invalid response structure from model' 
      });
    }

    // Ensure we have exactly 15 evaluation criteria
    if (!Array.isArray(parsedOutput.evaluationCriteria) || parsedOutput.evaluationCriteria.length !== 15) {
      console.warn('Expected 15 evaluation criteria, got:', parsedOutput.evaluationCriteria?.length);
    }

    return res.status(200).json(parsedOutput);

  } catch (error: any) {
    console.error('Analysis error:', error);
    return res.status(500).json({ 
      error: 'Analysis failed due to server error' 
    });
  }
});