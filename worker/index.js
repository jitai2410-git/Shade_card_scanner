const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_IMAGES_PER_REQUEST = 60;
const MAX_IMAGE_LENGTH = 2_000_000;
const SHADE_REGEX = /^[1-9]\d{2}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/detect-shades' && request.method === 'POST') {
      return handleDetectShades(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleDetectShades(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError('Invalid JSON body', 400);
  }

  const images = body.images;
  if (!Array.isArray(images) || images.length === 0) {
    return jsonError('Missing "images" array', 400);
  }
  if (images.length > MAX_IMAGES_PER_REQUEST) {
    return jsonError(`Too many images: max ${MAX_IMAGES_PER_REQUEST} per request`, 400);
  }
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (typeof img !== 'string' || img.length === 0) {
      return jsonError('Each image must be a non-empty base64 string', 400);
    }
    if (img.length > MAX_IMAGE_LENGTH) {
      return jsonError(`Image at index ${i} exceeds the maximum allowed size`, 400);
    }
  }

  const parts = [{ text: buildPrompt(images.length) }];
  images.forEach((b64, i) => {
    parts.push({ text: `frame index ${i}:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
  });

  let geminiRes;
  try {
    geminiRes = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
  } catch (e) {
    return jsonError('Could not reach the shade-detection service. Check your internet connection.', 502);
  }

  if (!geminiRes.ok) {
    const text = await geminiRes.text().catch(() => '');
    return jsonError(`Shade-detection service error (${geminiRes.status}): ${text.slice(0, 300)}`, 502);
  }

  const data = await geminiRes.json();
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text || '';
  const shades = parseShadesResponse(text, images.length);

  return new Response(JSON.stringify({ shades }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildPrompt(frameCount) {
  return `You will see a numbered sequence of frames (frame index 0 to ${frameCount - 1}, in order) from a video where someone flips through a fabric swatch book. Each product shows its fabric first, then a printed label with "SR.NO : NNN" (a 3-digit number) appears later for that same product. Find every distinct SR.NO number visible anywhere in the sequence. For each one, report the number and the index of whichever frame in this sequence best shows the FABRIC of that same product clearly (in focus, unobstructed, well-lit) — not necessarily the frame with the number itself. Reply with ONLY a JSON array like [{"shadeNumber":"502","imageIndex":2}], no other text, no markdown formatting.`;
}

function parseShadesResponse(text, frameCount) {
  // Gemini sometimes wraps JSON in markdown code fences (confirmed in manual testing); strip them.
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set();
  const result = [];
  for (const item of parsed) {
    const number = String((item && item.shadeNumber) || '').trim();
    const imageIndex = Number(item && item.imageIndex);
    if (!SHADE_REGEX.test(number)) continue;
    if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= frameCount) continue;
    if (seen.has(number)) continue;
    seen.add(number);
    result.push({ shadeNumber: number, imageIndex });
  }
  return result;
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
