/**
 * Media Processing — Support Copilot
 *
 * - Image: OpenAI vision API (gpt-4o-mini) called DIRECTLY, key from .env
 *   (mirrors the audio path below). Was previously routed through the
 *   `media_describer` OpenClaw agent via the gateway, but that path broke:
 *   the agent was pinned to `gpt-5.1-codex-mini` (the box's Codex/ChatGPT
 *   auth can't serve it) AND the gateway call imports OpenClaw from a source
 *   checkout whose stricter config validator now rejects the live
 *   openclaw.json with INVALID_CONFIG. The failure text was being stored
 *   verbatim as the image "description", polluting tickets/summaries. A
 *   direct API call sidesteps both and returns null on any failure.
 * - Audio: OpenAI Whisper API via curl, key from .env
 * - Video: extract audio + keyframes → process each
 *
 * @module lib/media-processor
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { LOG_TAG } = require('./constants');

const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'db', 'media');
// Vision model for image description (OpenAI, same key as Whisper). Override
// with SUPPORT_MEDIA_VISION_MODEL. gpt-4o-mini is cheap and reads error
// screenshots / connector photos well enough for triage.
const VISION_MODEL = process.env.SUPPORT_MEDIA_VISION_MODEL || 'gpt-4o-mini';
const VISION_MAX_TOKENS = 600;
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

// ─── Image description via OpenAI vision API (direct) ────────────────────────

/**
 * Describe an image using the OpenAI vision API directly (no OpenClaw gateway).
 * Uses the same OPENAI_WHISPER_API_KEY the audio path uses. Returns the
 * description string, or null on ANY failure (missing key, non-2xx, bad
 * payload, network error) so a failed call can never be stored as a
 * "description" the way the old gateway path did.
 *
 * @param {string} filePath - Path to image file
 * @param {string} [conversationContext] - Recent conversation for context
 * @returns {Promise<string|null>}
 */
async function describeImageViaAgent(filePath, conversationContext = '') {
  const apiKey = getWhisperApiKey(); // same OpenAI key as audio transcription
  if (!apiKey) {
    console.error(`${LOG_TAG} [media] OPENAI_WHISPER_API_KEY not configured`);
    return null;
  }

  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  let base64;
  try {
    base64 = fs.readFileSync(absPath).toString('base64');
  } catch (err) {
    console.error(`${LOG_TAG} [media] Could not read image: ${err.message}`);
    return null;
  }
  const ext = path.extname(absPath).toLowerCase().replace('.', '');
  const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : `image/${ext || 'jpeg'}`;
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const systemPrompt =
    'Você é um pré-processador de visão para o suporte de uma rede de eletropostos. ' +
    'Descreva a imagem em 1-3 frases: o que se vê, qualquer texto/código de erro ' +
    'transcrito LITERALMENTE, e qualquer anomalia óbvia (tela de erro, conector, app). ' +
    'NÃO ofereça solução; apenas descreva o que está na imagem.';
  const userContent = [];
  if (conversationContext) {
    userContent.push({ type: 'text', text: `[Contexto recente da conversa]:\n${conversationContext}` });
  }
  userContent.push({ type: 'text', text: 'Descreva esta imagem.' });
  userContent.push({ type: 'image_url', image_url: { url: dataUrl } });

  console.log(`${LOG_TAG} [media] Describing image via OpenAI vision (${VISION_MODEL})`);
  try {
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: VISION_MAX_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`${LOG_TAG} [media] Image description failed (${res.status}): ${detail.slice(0, 200)}`);
      return null;
    }

    const data = await res.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      console.warn(`${LOG_TAG} [media] Vision returned no text`);
      return null;
    }

    const cleaned = text.replace(/\[\[reply_to_\w+\]\]\s*/g, '').trim();
    console.log(`${LOG_TAG} [media] Image described (${cleaned.length} chars): ${cleaned.substring(0, 120)}`);
    return cleaned;
  } catch (err) {
    console.error(`${LOG_TAG} [media] Image description failed:`, err.message);
    return null;
  }
}

// ─── Audio transcription via OpenAI Whisper API ─────────────────────────────

/**
 * Load OPENAI_WHISPER_API_KEY from .env file (lazy, cached).
 */
let _whisperApiKey = null;
function getWhisperApiKey() {
  if (_whisperApiKey) return _whisperApiKey;
  
  // Check env var first (set by PM2 or export)
  if (process.env.OPENAI_WHISPER_API_KEY) {
    _whisperApiKey = process.env.OPENAI_WHISPER_API_KEY;
    return _whisperApiKey;
  }

  // Load from .env file
  const envPath = path.join(__dirname, '..', '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      if (key.trim() === 'OPENAI_WHISPER_API_KEY') {
        _whisperApiKey = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
        return _whisperApiKey;
      }
    }
  } catch (err) {
    console.warn(`${LOG_TAG} [media] Could not read .env: ${err.message}`);
  }
  return null;
}

/**
 * Transcribe audio using OpenAI Whisper API via curl.
 * Uses curl instead of Node fetch (which has FormData bugs in Node 22).
 * Reads API key from .env file. ~2s latency, ~$0.006/min.
 *
 * @param {string} filePath - Path to audio file (.ogg, .mp3, .wav, .m4a)
 * @returns {Promise<string|null>}
 */
async function transcribeAudioViaAgent(filePath) {
  const apiKey = getWhisperApiKey();
  if (!apiKey) {
    console.error(`${LOG_TAG} [media] OPENAI_WHISPER_API_KEY not configured`);
    return null;
  }

  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  console.log(`${LOG_TAG} [media] Transcribing audio via Whisper API: ${path.basename(absPath)}`);

  try {
    const result = execSync(
      `curl -s --max-time 30 -X POST https://api.openai.com/v1/audio/transcriptions ` +
      `-H "Authorization: Bearer ${apiKey}" ` +
      `-F file=@"${absPath}" ` +
      `-F model=whisper-1 ` +
      `-F language=pt ` +
      `-F response_format=text`,
      { timeout: 35_000, maxBuffer: 1024 * 1024 }
    ).toString().trim();

    if (!result) return null;

    // Check for error JSON response
    if (result.startsWith('{')) {
      try {
        const err = JSON.parse(result);
        if (err.error) {
          console.error(`${LOG_TAG} [media] Whisper API error: ${err.error.message || JSON.stringify(err.error)}`);
          return null;
        }
      } catch { /* not JSON, treat as transcription */ }
    }

    console.log(`${LOG_TAG} [media] Whisper transcribed (${result.length} chars): ${result.substring(0, 100)}`);
    return result;
  } catch (err) {
    console.error(`${LOG_TAG} [media] Whisper API error:`, err.message);
    return null;
  }
}

// ─── Video helpers ───────────────────────────────────────────────────────────

function extractAudioFromVideo(videoPath) {
  const audioPath = videoPath.replace(/\.[^.]+$/, '_audio.ogg');
  try {
    execSync(
      `ffmpeg -y -i "${videoPath}" -vn -acodec libopus -b:a 32k -ac 1 "${audioPath}" 2>/dev/null`,
      { timeout: 30_000 }
    );
    if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 500) {
      return audioPath;
    }
  } catch (err) {
    console.warn(`${LOG_TAG} [media] ffmpeg audio extract failed:`, err.message);
  }
  return null;
}

function extractKeyframes(videoPath, maxFrames = 3) {
  const frameDir = path.join(MEDIA_DIR, `frames_${Date.now()}`);
  fs.mkdirSync(frameDir, { recursive: true });

  try {
    let duration = 0;
    try {
      const durationStr = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
        { timeout: 10_000 }
      ).toString().trim();
      duration = parseFloat(durationStr) || 0;
    } catch { /* ignore */ }

    if (duration > 0) {
      const interval = Math.max(1, Math.floor(duration / (maxFrames + 1)));
      for (let i = 1; i <= maxFrames; i++) {
        const ts = Math.min(i * interval, duration - 0.5);
        const fp = path.join(frameDir, `frame_${i}.jpg`);
        try {
          execSync(`ffmpeg -y -ss ${ts} -i "${videoPath}" -vframes 1 -q:v 3 "${fp}" 2>/dev/null`, { timeout: 10_000 });
        } catch { /* skip */ }
      }
    } else {
      try {
        execSync(`ffmpeg -y -i "${videoPath}" -vframes 1 -q:v 3 "${path.join(frameDir, 'frame_1.jpg')}" 2>/dev/null`, { timeout: 10_000 });
      } catch { /* ignore */ }
    }

    return fs.readdirSync(frameDir)
      .filter(f => f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(frameDir, f));
  } catch (err) {
    console.warn(`${LOG_TAG} [media] Keyframe extraction failed:`, err.message);
    return [];
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Process a media file and return a text description.
 *
 * @param {string} filePath - Absolute path to the saved media file
 * @param {string} mediaType - Type: 'audio', 'image', 'video', 'document', 'sticker'
 * @param {object} [options]
 * @param {string} [options.conversationContext] - Recent conversation snippet
 * @returns {Promise<string|null>}
 */
async function processMedia(filePath, mediaType, options = {}) {
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(MEDIA_DIR, filePath);
  const context = options.conversationContext || '';

  if (!fs.existsSync(absPath)) {
    console.warn(`${LOG_TAG} [media] File not found: ${absPath}`);
    return null;
  }

  try {
    switch (mediaType) {
      case 'audio': {
        const text = await transcribeAudioViaAgent(absPath);
        return text ? `[Transcrição do áudio]: ${text}` : null;
      }

      case 'image':
      case 'sticker': {
        const description = await describeImageViaAgent(absPath, context);
        return description ? `[Descrição da imagem]: ${description}` : null;
      }

      case 'video': {
        const parts = [];

        try {
          const dur = execSync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${absPath}"`,
            { timeout: 10_000 }
          ).toString().trim();
          const secs = parseFloat(dur);
          if (!isNaN(secs)) parts.push(`Vídeo de ${Math.round(secs)}s.`);
        } catch { /* ignore */ }

        const audioPath = extractAudioFromVideo(absPath);
        if (audioPath) {
          try {
            const transcription = await transcribeAudioViaAgent(audioPath);
            if (transcription) parts.push(`Áudio: "${transcription}"`);
          } catch { /* ignore */ }
          try { fs.unlinkSync(audioPath); } catch { /* cleanup */ }
        }

        const frames = extractKeyframes(absPath, 2);
        if (frames.length > 0) {
          const frameDescriptions = [];
          for (const framePath of frames) {
            try {
              const description = await describeImageViaAgent(framePath, context);
              if (description) frameDescriptions.push(description);
            } catch (err) {
              console.warn(`${LOG_TAG} [media] Video frame description failed:`, err.message);
            }
          }
          if (frameDescriptions.length > 0) {
            parts.push(`Frames: ${frameDescriptions.join(' | ')}`);
          }
          try {
            fs.rmSync(path.dirname(frames[0]), { recursive: true, force: true });
          } catch { /* cleanup */ }
        }

        if (parts.length > 0) {
          const summary = parts.join(' ');
          console.log(`${LOG_TAG} [media] Video processed: ${summary.substring(0, 150)}...`);
          return `[Descrição do vídeo]: ${summary}`;
        }
        return null;
      }

      default:
        return null;
    }
  } catch (err) {
    console.error(`${LOG_TAG} [media] processMedia failed for ${mediaType}:`, err.message);
    return null;
  }
}

module.exports = { processMedia, describeImageViaAgent, transcribeAudioViaAgent };
