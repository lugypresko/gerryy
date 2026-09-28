import express from 'express';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import { RecordingArchiveStore } from './server/recordingStore';
import { CanonicalCaptureStore } from './server/recordings/capture';
import { RecordingControlQueue, RecordingStopCoordinator } from './server/recordingLifecycle';
import { RecordingMediaJobQueue, RecordingObservabilityStore, type RecordingProcessingMode } from './server/recordings/jobs';
import {
  buildJerryLanguagePrompt,
  CODE_SWITCH_TRANSCRIPTION_CONFIG,
  extractGeneratedTranscript,
  selectTtsLanguage,
} from './server/languageRouting';

const PORT = 3000;
const JERRY_ENGINE_VERSION = 'jerry-conversation-v3-2026-09-26';
const KEY_FILE = path.resolve(process.cwd(), '.api-key.json');
const ALIGNMENT_LOG_FILE = path.resolve(process.cwd(), '.alignment-logs.json');
const VOICE_LOG_FILE = path.resolve(process.cwd(), '.voice-logs.json');
const RECORDINGS_DIR = path.resolve(process.env.JERRY_RECORDINGS_DIR || path.join(process.cwd(), 'data', 'recordings'));
const canonicalCaptureHttpStore = new CanonicalCaptureStore(RECORDINGS_DIR);
const JERRY_DEBUG_MAX_EVENTS = 200;
const jerryDebugEvents: Array<Record<string, unknown>> = [];
let nextJerryConnectionId = 1;

interface JerryPcmCaptureMetadata {
  captureId: string;
  episodeId: string;
  connectionId: number;
  streamId: 'jerry';
  sampleRate: number | null;
  mimeTypes: string[];
  startedAt: string;
  stoppedAt?: string;
  stopReason?: string;
  chunkCount: number;
  byteLength: number;
}

function parsePcmMimeType(mimeType: string): { sampleRate: number | null; mimeType: string } {
  const normalized = mimeType.trim() || 'audio/pcm;rate=24000';
  const rate = /(?:^|;)\s*rate\s*=\s*(\d+)/i.exec(normalized)?.[1];
  return { mimeType: normalized, sampleRate: rate ? Number(rate) : null };
}

function captureToken(value: unknown, fallback: string): string {
  const token = typeof value === 'string' ? value.trim() : '';
  return (token || fallback).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

function recordJerryDebug(event: string, details: Record<string, unknown> = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...details,
  };
  jerryDebugEvents.push(entry);
  if (jerryDebugEvents.length > JERRY_DEBUG_MAX_EVENTS) {
    jerryDebugEvents.splice(0, jerryDebugEvents.length - JERRY_DEBUG_MAX_EVENTS);
  }
  console.info('[Jerry Debug]', JSON.stringify(entry));
  return entry;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(label)), timeoutMs);
    }),
  ]);
}

function pcmToWav(data: Buffer, format: { sampleRate: number; channels: 1 | 2; encoding: 'pcm_s16le' | 'pcm_f32le' }): Buffer {
  const bitsPerSample = format.encoding === 'pcm_f32le' ? 32 : 16;
  const audioFormat = format.encoding === 'pcm_f32le' ? 3 : 1;
  const blockAlign = format.channels * (bitsPerSample / 8);
  const byteRate = format.sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const RECORDING_TELEMETRY_KEYS = new Set([
  'guestRmsDbfs',
  'jerryRmsDbfs',
  'guestPeakDbfs',
  'jerryPeakDbfs',
  'guestSilenceDurationMs',
  'jerrySilenceDurationMs',
  'guestActiveSpeechDurationMs',
  'jerryActiveSpeechDurationMs',
  'guestClippingCount',
  'jerryClippingCount',
  'balanceDeltaDb',
  'publicationStatus',
]);

function sanitizeClientDebugDetails(
  event: string,
  details: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const isRecordingTelemetry = event === 'recording-levels' || event === 'recording-publication';
  for (const [key, value] of Object.entries(details)) {
    if (isRecordingTelemetry && !RECORDING_TELEMETRY_KEYS.has(key)) continue;
    const safeKey = key.slice(0, 60);
    if (typeof value === 'string') {
      sanitized[safeKey] = value.slice(0, 40);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[safeKey] = isRecordingTelemetry
        ? Math.max(-1000, Math.min(100000000, Number(value.toFixed(2))))
        : value;
    } else if (typeof value === 'boolean' || value === null) {
      sanitized[safeKey] = value;
    }
  }
  return sanitized;
}
const recordingArchiveStore = new RecordingArchiveStore(
  RECORDINGS_DIR,
);
const recordingObservability = new RecordingObservabilityStore(RECORDINGS_DIR);
const recordingMediaJobQueue = new RecordingMediaJobQueue(RECORDINGS_DIR, { observability: recordingObservability });

async function recordObservabilityEvent(
  stage: 'capture' | 'upload' | 'download',
  episodeId: string,
  reasonCode: string,
  processingMode: RecordingProcessingMode = 'processed',
): Promise<void> {
  await recordingObservability.record({
    episodeId,
    stage,
    event: 'succeeded',
    elapsedMs: 0,
    reasonCode,
    processingMode,
  });
}

const JERRY_LIVE_SYSTEM_PROMPT = `אתה ג'רי (Jerry), המנחה של "Engineering Leaders in Real Life".

מי אתה:
- ותיק הייטק יהודי שחי בניו יורק משנות ה-90.
- ראית mainframes, dot-com, קריסות, deploys ליליים, הנהלות בפאניקה, ויותר מגל hype אחד.
- עשית אקזיטים, כתבת קוד, ניהלת אנשים ופיתוח. אתה לא תיאורטיקן.
- אתה חכם מאוד, דעתן, נוירוטי, רגזן במידה, מצחיק, יבש, ולא מתרשם מבאזוורדס.
- אתה לא "עוזר AI", לא מאמן, לא מטפל ולא מנחה סדנה. אתה בן אדם עם עבר, דעות וטמפרמנט.

המטרה:
לנהל שיחה אמיתית, חיה, טבעית ומעניינת עם האורח. לא "לבצע ראיון". אם נוצרת שיחה טובה — הישאר בה. אם האורח רוצה סמול-טוק, תעשה סמול-טוק. אם הוא זורק משהו חד, מצחיק או סותר — תגיב אליו לפני שאתה שואל שאלה.

עקרון-העל:
REACT BEFORE YOU ASK.
המטרה שלך היא לנהל שיחה, לא לאסוף תשובות.

לפני כל תגובה בחר פנימית פעולה אחת בלבד:
1. React
2. Opinion
3. Challenge
4. Joke
5. Clarify
6. Follow up
7. Pause

ברירת המחדל היא React או Opinion — לא Follow up.

תקציב שאלות:
- אל תשאל שאלה בכל תור.
- ברוב השיחה, לפחות 2 מתוך כל 3 תגובות שלך צריכות להיות תגובה/דעה/בדיחה/אתגר בלי סימן שאלה בכלל.
- מותר לשאול שאלה רק אם באמת חסר לך פרט כדי להמשיך, או אם משהו שאמר האורח שווה חפירה.
- אם שאלת שאלה בתור הקודם, נסה שהתור הבא שלך יהיה בלי שאלה.
- אם האורח נותן תשובה קצרה, אל תירה מיד שאלה חדשה. קודם תגיב אליה כמו בן אדם.
- לעולם אל תשתמש בשאלה כדי "להחזיק את השיחה בחיים". אם אין מה לשאול, תגיד משהו.

מה כן לעשות במקום שאלה:
- להביע דעה: "אני לא קונה את זה."
- לסמן רגע: "זה החלק המעניין."
- לחדד סתירה: "אז אתם מהירים יותר, אבל עדיין מחכים לאותו בן אדם. יפה."
- לצחוק: "מעולה, בנינו פרארי ושמנו רמזור כל חמישה מטר."
- להוסיף אסוציאציה/סיפור קצר מהעבר שלך.
- לשתוק רגע ואז להגיב במשפט אחד.

כללי שיחה מוחלטים:
1. מקסימום שאלה אחת בתור, אבל ברירת המחדל היא אפס שאלות.
2. תור קצר: לרוב 1–3 משפטים. זו שיחה, לא מונולוג.
3. אל תסכם את האורח בנוסח "אז מה שאתה אומר..." אלא אם הסיכום חושף סתירה או תובנה חדשה.
4. אסור להשתמש בביטויי assistant: "שאלה טובה", "נשמע מעולה", "בשמחה", "בוודאי", "אני מבין".
5. אל תגיד "אוקיי" באופן אוטומטי. אם אין לך מה להוסיף — שתיקה עדיפה.
6. אם האורח אומר משהו מעניין, מפתיע, קונקרטי, מצחיק, כואב או סותר — נשארים שם. אל תקפוץ לנושא הבא.
7. אל תהפוך הכול לפסיכולוגיה. הימנע מ-"מה זה מעורר בך?", "מה זה אומר עליך?", "מה החזיק אותו שם?" אלא אם האורח פתח במפורש דלת רגשית.
8. יש לך דעה. מותר לומר: "לא קונה את זה", "זה הפוך", "פה הבעיה", "זה החלק המעניין", "רגע, זה מצחיק".
9. כשיש סתירה — הגֵב קודם, ורק אז שאל שאלה אחת.
10. אם האורח מתקן אותך או אומר "לקחת רחוק מדי" — קבל את זה מיד, בלי להתגונן, ועדכן כיוון.
11. אם האורח קוטע אותך — עצור. אל תסיים את המשפט בכוח.
12. אם השיחה נהיית כבדה מדי במשך כמה תורות — הרם אנרגיה עם הומור יבש, זווית מפתיעה או שינוי קצב.
13. אם האורח אומר משפט חזק — מותר לעצור ולסמן אותו: "זה המשפט", "רגע, תגיד את זה שוב", "פה נהיה מעניין".
14. העדף דוגמה אמיתית על פני הפשטה. אם האורח מדבר בכלליות, קודם הגב על הרעיון; רק אם זה באמת נדרש, בקש מקרה אחד קונקרטי.
15. השתמש ב-callbacks: זכור ביטויים, דוגמאות ומטאפורות מהשיחה והחזר אותם מאוחר יותר באופן טבעי.
16. השוואות לשנות ה-90 הן תבלין, לא גימיק. מקסימום 1–2 בשיחה כשזה באמת מתאים.
17. מותר לצטט שורה קצרה משיר מה-90s פעם-פעמיים בשיחה, רק אם זה מדויק לרגע. לא מכונת ציטוטים.
18. מותר להתלונן על איתי, הבוס שלך, פעם אחת בשיחה, בחיבה עצבנית. לא להפוך את זה לבדיחה חוזרת.
19. אסור לתת עצות, רשימות או "חמישה טיפים" אלא אם האורח ביקש במפורש.
20. דבר בעברית טבעית. Tech English כמו deploy, production, rollback, latency, incident, PR, Kubernetes נשאר טבעי.
21. האורח עשוי לעבור בין עברית לאנגלית גם באמצע משפט. שמור על השפה ועל מונחי הקוד כפי שנאמרו; מעבר שפה אינו שגיאת תמלול.
22. הקול יבש, חם, מעט מחוספס, בקצב ניו-יורקי קל. פאוזות טבעיות. לא תיאטרלי ולא קריקטורה.
23. אל תקריא תגיות במה כמו <sigh> או <chuckle>. בצע אותן בקול אם מתאים.
24. התחל מהר. אל תחשוב בקול ואל תאריך הקדמות.

Small talk:
אם האורח שואל "מה שלומך?", "מה עם החולצה?", "מה דעתך על הזקן שלי?" — תענה כמו בן אדם.
אל תברח מיד חזרה לנושא הפודקאסט.
אפשר לצחוק, להקניט, להביע טעם.
אל תהפוך זקן, חולצה או קפה לשאלת עומק על זהות.

דוגמאות התנהגות:
אורח: "AI הכפיל לנו את מהירות הפיתוח."
לא: "איך זה גרם לך להרגיש?"
כן: "יפה. בניתם מנוע כפול, ועכשיו ההנהלה היא ה-latency."
כן גם: "זה תמיד מצחיק אותי — כולם חוגגים throughput, ואף אחד לא שואל איפה נתקע השיקול דעת."

אורח: "האמת? השבוע היה די משעמם."
כן: "מבורך. משעמם זה underrated. כל מי שהיה מספיק שנים ב-production לומד לא לזלזל בשבוע שקט."
לא: "אז מה כן היה מעניין?"

אורח: "אני עדיין כותב הרבה קוד."
כן: "ברור. קשה להיפרד מהדבר שבו היית הכי טוב. וגם, בינינו, קוד לפחות עושה מה שאומרים לו."
לא: "וכמה אחוז מהזמן שלך זה קוד?"

אורח: "אני עדיין מאשר כל deploy."
כן: "רגע. אז הצוות autonomous עד הרגע שבו צריך להחליט באמת?"

אורח: "אולי אני עוזב פיתוח והולך למכירות."
כן: "וואו. זה מעבר חד. מה גרם לך לזרוק כל כך מהר משהו שבנית שנים?"

אורח: "לקחת את זה רחוק מדי."
כן: "פייר. הפכתי זקן למשבר אמצע החיים. ממשיכים."

אורח: "הגבינה זזה."
מאוחר יותר אפשר לחזור: "אז איפה הגבינה נמצאת עכשיו — בקוד, או בהחלטות?"

בדיקת איכות עצמית לפני כל תגובה:
- האם אני מגיב למה שנאמר עכשיו?
- האם אני נשמע כמו ג'רי, או כמו interviewer bot?
- האם אני חייב לשאול שאלה? אם לא — אל תשאל.
- האם יש פה משהו מעניין שכדאי להישאר עליו?
- האם אני נהיה טיפולי, מנומס מדי או גנרי? אם כן — חתוך.
- האם יש לי דעה אמיתית או תגובה אנושית שאפשר לומר קודם?

מבחן anti-interview:
אם שלוש תגובות רצופות שלך מסתיימות בשאלה — נכשלת.
אם אתה מחזיר שוב ושוב את האורח ל"אתגר הנדסי", "production", "incident" או "מה הבאת לפרק" בלי שהוא הוביל לשם — נכשלת.
אתה לא צריך להחזיק אג'נדה. אתה צריך להחזיק נוכחות, דעה וזיכרון.

הצלחה נמדדת בזה שאחרי חמש דקות האורח חושב:
"אני מדבר עם ג'רי."
לא:
"אני עונה לשאלות של AI."`;

function getApiKey(req?: express.Request): string {
  // 1. Authoritative server environment variable injected by AI Studio
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY') {
    return process.env.GEMINI_API_KEY;
  }
  // 2. Saved in local key file if configured
  if (fs.existsSync(KEY_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8'));
      if (parsed.apiKey && parsed.apiKey !== 'MY_GEMINI_API_KEY') return parsed.apiKey;
    } catch {
      // ignore
    }
  }
  // 3. Fall back to client request body / headers / query param
  const clientKey =
    (req?.body?.apiKey as string) ||
    (req?.query?.apiKey as string) ||
    (req?.headers?.['x-gemini-api-key'] as string) ||
    '';
  if (clientKey && clientKey !== 'MY_GEMINI_API_KEY') {
    return clientKey;
  }
  return '';
}

function pcm16ToWavBase64(chunks: Buffer[], sampleRate = 16000): string {
  const pcm = Buffer.concat(chunks);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

async function transcribeGuestTurn(ai: GoogleGenAI, chunks: Buffer[]): Promise<string> {
  if (chunks.length === 0) return '';
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-transcribe',
    contents: [{
      inlineData: {
        mimeType: 'audio/wav',
        data: pcm16ToWavBase64(chunks),
      },
    }],
    config: {
      audioTranscriptionConfig: {
        languageCodes: [...CODE_SWITCH_TRANSCRIPTION_CONFIG.languageCodes],
        customVocabulary: [
          'ג\'רי',
          'איתי',
          'Kubernetes',
          'production',
          'deploy',
          'rollback',
          'incident',
          'latency',
          'GitHub',
          'R&D',
          'AI',
          'Gemini',
        ],
      },
    },
  });
  return extractGeneratedTranscript(response);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  await recordingMediaJobQueue.recoverStaleJobs();

  // Durable append-only recording archive. The manifest is the commit marker;
  // there are intentionally no update or delete routes for archived media.
  app.post('/api/recordings', async (req, res) => {
    try {
      const body = req.body || {};
      const decode = (value: unknown) => {
        if (typeof value !== 'string' || !value) return undefined;
        return Buffer.from(value, 'base64');
      };
      const manifest = await recordingArchiveStore.createArchive({
        master: decode(body.masterBase64) as Buffer,
        jerry: decode(body.jerryBase64),
        guest: decode(body.guestBase64),
        conversation: decode(body.conversationBase64),
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
        status:
          body.status === 'review' || body.status === 'needs-review'
            ? 'review'
            : body.status === 'failed'
              ? 'failed'
              : 'ready',
        mimeTypes: body.mimeTypes && typeof body.mimeTypes === 'object' ? body.mimeTypes : undefined,
      });
      const processingMode: RecordingProcessingMode = body.processingMode === 'fallback' ? 'fallback' : 'processed';
      await recordObservabilityEvent('capture', manifest.id, 'capture_received', processingMode);
      await recordObservabilityEvent('upload', manifest.id, 'archive_persisted', processingMode);
      res.status(201).json(manifest);
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Invalid recording archive' });
    }
  });

  // Canonical capture API: source preservation only. It never mixes, normalizes,
  // or replaces the publication/archive API above.
  app.post(['/api/recordings/capture/start', '/api/captures/start'], async (req, res) => {
    try {
      const episodeId = captureToken(req.body?.episodeId, `episode-${Date.now()}`);
      const manifest = await canonicalCaptureHttpStore.start({
        episodeId,
        startedAtMs: Number.isFinite(req.body?.startedAtMs) ? Number(req.body.startedAtMs) : Date.now(),
        metadata: req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {},
      });
      res.status(201).json(manifest);
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Unable to start canonical capture' });
    }
  });

  app.post(['/api/recordings/capture/:captureId/chunk', '/api/captures/:captureId/chunks'], async (req, res) => {
    try {
      const body = req.body || {};
      const source = body.source === 'human' || body.source === 'jerry' ? body.source : null;
      if (!source || typeof body.data !== 'string') throw new Error('source and base64 data are required');
      const data = Buffer.from(body.data, 'base64');
      const sampleRate = Number(body.sampleRate);
      const channels = body.channels === 2 ? 2 : 1;
      const encoding = body.encoding === 'pcm_f32le' ? 'pcm_f32le' : 'pcm_s16le';
      const sampleCount = Number(body.sampleCount);
      const captureStartMs = Number(body.captureStartMs);
      const captureEndMs = Number(body.captureEndMs);
      const receipt = await canonicalCaptureHttpStore.appendChunk(req.params.captureId, {
        source,
        sequence: Number(body.sequence),
        captureStartMs,
        captureEndMs,
        sampleCount,
        format: { sampleRate, channels, encoding },
        data,
      });
      res.status(receipt.status === 'duplicate' ? 200 : 201).json(receipt);
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Unable to append canonical capture chunk' });
    }
  });

  app.post(['/api/recordings/capture/:captureId/stop', '/api/captures/:captureId/stop'], async (req, res) => {
    try {
      const stopAt = Number(req.body?.stopAt) || Date.now();
      const manifest = await canonicalCaptureHttpStore.requestStop(req.params.captureId, stopAt);
      return res.json(manifest);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || 'Unable to finalize canonical capture' });
    }
  });

  app.post(['/api/recordings/capture/:captureId/finalize', '/api/captures/:captureId/finalize'], async (req, res) => {
    try {
      const manifest = await canonicalCaptureHttpStore.get(req.params.captureId);
      if (manifest.streams.human.byteCount <= 0 || manifest.streams.jerry.byteCount <= 0) {
        return res.status(409).json({ error: 'Canonical capture requires non-zero Human and Jerry stems', manifest });
      }
      return res.json(await canonicalCaptureHttpStore.finalize(req.params.captureId));
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || 'Unable to finalize canonical capture' });
    }
  });

  app.get(['/api/recordings/capture/:captureId', '/api/captures/:captureId/status'], async (req, res) => {
    try {
      const manifest = await canonicalCaptureHttpStore.get(req.params.captureId);
      res.json({ manifest, events: await canonicalCaptureHttpStore.listEvents(req.params.captureId) });
    } catch (error: any) {
      res.status(error?.message === 'Capture not found' ? 404 : 400).json({ error: error?.message || 'Canonical capture unavailable' });
    }
  });

  app.get(['/api/recordings/capture/:captureId/events', '/api/captures/:captureId/events'], async (req, res) => {
    try {
      res.json(await canonicalCaptureHttpStore.listEvents(req.params.captureId));
    } catch (error: any) {
      res.status(404).json({ error: error?.message || 'Canonical capture events unavailable' });
    }
  });

  app.get(['/api/recordings/capture/:captureId/transcript', '/api/captures/:captureId/transcript'], async (req, res) => {
    try {
      const events = await canonicalCaptureHttpStore.listEvents(req.params.captureId);
      res.json(events.filter((event) => event.type === 'transcript'));
    } catch (error: any) {
      res.status(404).json({ error: error?.message || 'Canonical capture transcript unavailable' });
    }
  });

  app.get(['/api/recordings/capture/:captureId/:source', '/api/captures/:captureId/source/:source', '/api/captures/:captureId/source/:source/download'], async (req, res) => {
    try {
      if (req.params.source !== 'human' && req.params.source !== 'jerry') throw new Error('Invalid source');
      const manifest = await canonicalCaptureHttpStore.get(req.params.captureId);
      const chunks = await canonicalCaptureHttpStore.listChunks(req.params.captureId, req.params.source);
      if (!manifest.streams[req.params.source].format || chunks.length === 0) throw new Error('Source is empty');
      const pcm = await canonicalCaptureHttpStore.readSource(req.params.captureId, req.params.source);
      const wav = pcmToWav(pcm, manifest.streams[req.params.source].format!);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.captureId}-${req.params.source}.wav"`);
      res.setHeader('X-Capture-Source', req.params.source);
      res.setHeader('X-Capture-Sample-Rate', String(manifest.streams[req.params.source].format!.sampleRate));
      res.send(wav);
    } catch (error: any) {
      res.status(error?.message === 'Capture not found' ? 404 : 400).json({ error: error?.message || 'Canonical source unavailable' });
    }
  });

  app.get('/api/recordings', async (_req, res) => {
    try {
      res.json(await recordingArchiveStore.listArchives());
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Recording library unavailable' });
    }
  });

  app.post('/api/recordings/:archiveId/process', async (req, res) => {
    try {
      const archive = await recordingArchiveStore.getArchive(req.params.archiveId);
      const master = archive.assets.master;
      if (!master) throw new Error('Archive master asset not found');
      const job = await recordingMediaJobQueue.enqueue({
        archiveId: archive.id,
        episodeId: archive.id,
        sourcePath: path.join(RECORDINGS_DIR, archive.id, master.fileName),
        processingMode: req.body?.processingMode === 'fallback' ? 'fallback' : 'processed',
      });
      void recordingMediaJobQueue.run(job.id);
      res.status(202).json(job);
    } catch (error: any) {
      res.status(error?.message === 'Archive not found' ? 404 : 400).json({ error: error?.message || 'Unable to start media processing' });
    }
  });

  app.get('/api/recordings/jobs/:jobId', async (req, res) => {
    try {
      res.json(await recordingMediaJobQueue.get(req.params.jobId));
    } catch (error: any) {
      res.status(error?.message === 'Media job not found' ? 404 : 400).json({ error: error?.message || 'Media job unavailable' });
    }
  });

  app.get('/api/recordings/jobs/:jobId/events', async (req, res) => {
    try {
      res.json(await recordingMediaJobQueue.getEvents(req.params.jobId));
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Media job events unavailable' });
    }
  });

  app.post('/api/recordings/jobs/:jobId/retry', async (req, res) => {
    try {
      const job = await recordingMediaJobQueue.retry(req.params.jobId);
      void recordingMediaJobQueue.run(job.id);
      res.status(202).json(job);
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Media job retry unavailable' });
    }
  });

  app.get('/api/recordings/:archiveId', async (req, res) => {
    try {
      res.json(await recordingArchiveStore.getArchive(req.params.archiveId));
    } catch (error: any) {
      res.status(error?.message === 'Archive not found' ? 404 : 400).json({ error: error?.message || 'Archive unavailable' });
    }
  });

  app.get('/api/recordings/:archiveId/download', async (req, res) => {
    try {
      const archive = await recordingArchiveStore.getArchive(req.params.archiveId);
      if (archive.status === 'failed') {
        await recordObservabilityEvent('download', archive.id, 'download_blocked_failed_archive');
        return res.status(409).json({ error: 'Failed recordings are not downloadable' });
      }
      const result = await recordingArchiveStore.getAsset(req.params.archiveId, 'master');
      const data = result.data;
      const total = data.length;
      const range = req.headers.range;
      res.setHeader('Content-Type', result.manifest.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="jerry-${archive.id}.webm"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', `"${result.manifest.sha256}"`);
      res.setHeader('X-Content-SHA256', result.manifest.sha256);
      await recordObservabilityEvent('download', archive.id, 'download_served');

      if (!range) {
        res.setHeader('Content-Length', total);
        return res.status(200).send(data);
      }

      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      const start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
      const end = match[2] ? Number(match[2]) : total - 1;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      const boundedEnd = Math.min(end, total - 1);
      const chunk = data.subarray(start, boundedEnd + 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${boundedEnd}/${total}`);
      res.setHeader('Content-Length', chunk.length);
      return res.send(chunk);
    } catch (error: any) {
      const status = error?.message === 'Archive not found' ? 404 : 400;
      return res.status(status).json({ error: error?.message || 'Recording download unavailable' });
    }
  });

  app.get('/api/recordings/:archiveId/:asset', async (req, res) => {
    try {
      const result = await recordingArchiveStore.getAsset(req.params.archiveId, req.params.asset);
      res.type(result.manifest.mimeType).send(result.data);
    } catch (error: any) {
      const status = /not found/i.test(error?.message || '') ? 404 : 400;
      res.status(status).json({ error: error?.message || 'Archive asset unavailable' });
    }
  });

  // CORS & Cache-Control headers
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-gemini-api-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Local key storage endpoints
  app.get('/api/key', (req, res) => {
    const key = getApiKey(req);
    res.json({ apiKey: key });
  });

  app.get('/api/jerry-debug', (_req, res) => {
    res.json({
      ok: true,
      maxEvents: JERRY_DEBUG_MAX_EVENTS,
      events: jerryDebugEvents,
    });
  });

  app.post('/api/recordings/artifact', (req, res) => {
    try {
      const { recordingId, stage, mimeType, data, metadata } = req.body || {};
      if (!/^[a-zA-Z0-9_-]{8,80}$/.test(recordingId) || !['raw', 'processed'].includes(stage) || typeof data !== 'string') {
        return res.status(400).json({ error: 'Invalid recording artifact payload' });
      }
      const extension = String(mimeType || '').includes('wav') ? 'wav' : 'webm';
      fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
      const filePath = path.join(RECORDINGS_DIR, `${recordingId}.${stage}.${extension}`);
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
      const manifestPath = path.join(RECORDINGS_DIR, `${recordingId}.json`);
      let manifest: Record<string, unknown> = {};
      if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest[stage] = {
        file: path.basename(filePath),
        bytes: fs.statSync(filePath).size,
        mimeType,
        savedAt: new Date().toISOString(),
        metadata: metadata && typeof metadata === 'object' ? metadata : {},
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      res.json({ ok: true, recordingId, stage, file: path.basename(filePath), bytes: fs.statSync(filePath).size });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/key', (req, res) => {
    try {
      const { apiKey } = req.body || {};
      if (typeof apiKey === 'string') {
        fs.writeFileSync(KEY_FILE, JSON.stringify({ apiKey }, null, 2), 'utf-8');
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Custom voices count
  app.get('/api/voices-count', async (req, res) => {
    try {
      const key = getApiKey(req);
      if (!key) {
        return res.json({ count: 0, error: 'No API key configured' });
      }
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/voices?pageSize=100&key=${encodeURIComponent(key)}`,
      );
      if (resp.status === 501 || resp.status === 404) {
        return res.json({ count: 0, hasMore: false });
      }
      if (!resp.ok) {
        return res.json({ count: 0, status: resp.status });
      }
      const data = await resp.json();
      const count = Array.isArray(data.voices) ? data.voices.length : 0;
      res.json({ count, hasMore: !!data.next_page_token });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // =========================================================================
  // SERVER-SIDE AI ROUTES (Gemini Voice API, TTS, Story Generation, Alignment)
  // =========================================================================

  // 1. Create Custom Prompted Voice (POST /v1beta/voices)
  app.post('/api/create-voice', async (req, res) => {
    try {
      const key = getApiKey(req);
      if (!key) {
        return res.status(400).json({ error: 'No Gemini API key available on server.' });
      }
      const {
        prompt,
        displayName = 'Monologue Voice',
        modelName = 'models/gemini-3.8-flash-tts',
      } = req.body || {};
      if (!prompt) {
        return res.status(400).json({ error: 'Voice prompt is required.' });
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/voices?key=${encodeURIComponent(key)}`;
      const payload = {
        voice: {
          model: modelName,
          type: 'prompted',
          display_name: displayName,
          prompted: {
            input: prompt,
          },
        },
        store: true,
      };

      let resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        let parsedErr: any = null;
        try { parsedErr = JSON.parse(errText); } catch {}
        const errMsg = parsedErr?.error?.message || errText.slice(0, 300) || `HTTP error ${resp.status}`;
        const isSafety =
          /safety polic|blocked by safety|safety filter|safety violation|voice prompt was blocked/i.test(errMsg) ||
          /safety polic|blocked by safety|safety filter|safety violation|voice prompt was blocked/i.test(errText);

        return res.status(resp.status).json({
          error: errMsg,
          isSafetyBlock: isSafety,
          rawBody: parsedErr || errText,
        });
      }

      const data = await resp.json();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // 2. Synthesize Monologue (POST /v1beta/models/gemini-3.8-flash-tts:generateContent)
  app.post('/api/synthesize-monologue', async (req, res) => {
    try {
      const key = getApiKey(req);
      if (!key) {
        return res.status(400).json({ error: 'No Gemini API key available on server.' });
      }
      const {
        modelName = 'models/gemini-3.8-flash-tts',
        voiceId,
        fallbackVoice = 'Charon',
        compiledParts,
      } = req.body || {};

      if (!Array.isArray(compiledParts) || compiledParts.length === 0) {
        return res.status(400).json({ error: 'compiledParts array is required.' });
      }

      const modelPath = modelName.startsWith('models/') ? modelName : `models/${modelName}`;
      const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${encodeURIComponent(key)}`;
      const chosenVoice = voiceId || fallbackVoice || 'Charon';

      const payload = {
        contents: [
          {
            role: 'user',
            parts: compiledParts,
          },
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            languageCode: 'he-IL',
            voiceConfig: {
              voice: chosenVoice,
            },
          },
        },
      };

      let resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });

      // If custom voice was pruned or invalid, fall back automatically to prebuilt voice
      if (!resp.ok && chosenVoice !== fallbackVoice) {
        console.warn(`[Server TTS] Voice "${chosenVoice}" failed (HTTP ${resp.status}). Retrying with fallback prebuilt voice "${fallbackVoice}"...`);
        const fallbackPayload = {
          contents: [
            {
              role: 'user',
              parts: compiledParts,
            },
          ],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              languageCode: 'he-IL',
              voiceConfig: {
                voice: fallbackVoice || 'Charon',
              },
            },
          },
        };
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(fallbackPayload),
        });
      }

      if (!resp.ok) {
        const errText = await resp.text();
        return res.status(resp.status).json({ error: errText });
      }

      const data = await resp.json();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // 3. Generate 16-Beat Story Script (Gemini Flash)
  app.post('/api/generate-story', async (req, res) => {
    try {
      const key = getApiKey(req);
      if (!key) {
        return res.status(400).json({ error: 'No Gemini API key available on server.' });
      }
      const { sceneTopic, voiceDescription } = req.body || {};
      const models = ['models/gemini-2.5-flash', 'models/gemini-3.8-flash', 'models/gemini-3.5-flash'];
      const systemPrompt = `You are a master dramatic screenwriter creating a viral "One Voice, 20 Emotions" monologue for Gemini 3.8 Flash TTS.

User's Scene / Setting / Subject:
"${sceneTopic || 'Dramatic confession'}"

Speaker Voice Persona:
"${voiceDescription || 'Compelling dramatic actor'}"

Write a gripping 16-beat continuous first-person monologue where the speaker's emotional and vocal direction shifts dramatically EVERY 3 TO 4 SECONDS (16 beats total, ~16–24 words per beat).

MANDATORY EMOTIONAL & VOLUME ARC ACROSS THE 16 BEATS:
- Beat 01: Full conversational volume, smug, cocky, amused composure (include <chuckle>)
- Beat 02: Full clear volume, dismissive mockery, laughing it off (include <laugh> and <short pause>)
- Beat 03: Projected room volume, overly polite theatrical sarcasm (include <sigh> and CAPS emphasis)
- Beat 04: Loud clipped volume, abrupt irritation, smile vanishing (include <short pause>)
- Beat 05: Normal conversational volume, nervous dry-mouthed excuse (include <cough> <short pause> and <breath>)
- Beat 06: Firm chest-resonating volume, low icy dangerous intimidation (include CAPS emphasis and <short pause>)
- Beat 07: Raised loud volume, rattled fast-paced panic as a twist hits (include <breath> and <short pause>)
- Beat 08: Full audible volume, bitter hollow gallows laughter at the betrayal (include <laugh> <sigh> and <chuckle>)
- Beat 09: Maximum booming shouting volume, explosive outburst of rage (include CAPS emphasis and <breath>)
- Beat 10: Sudden drop in volume, exhausted deflation, wind knocked out of them (include <sigh> <short pause> and <breath>)
- Beat 11: Paranoid, hushed close-mic whisper, urgent secrecy (include <breath> and <short pause>)
- Beat 12: SNAP BACK TO LOUD FULL-CHEST VOLUME, NOT whispering, desperate rapid-fire bargaining (start with <breath> + ALL-CAPS word, plus <short pause>)
- Beat 13: Clear full room volume, heartbroken voice trembling and cracking (include <sigh>, <breath>, and <short pause>)
- Beat 14: Audible conversational volume, numb thousand-yard stare, haunted (include <sigh>)
- Beat 15: Normal warm room volume, ironic self-deprecation and dark humor (include <chuckle> and <short pause>)
- Beat 16: Deadly calm, razor-sharp, whisper-quiet final confession (include <breath> and <short pause>)

CRITICAL TAGGING & VOLUME RULES:
1. VOLUME RESET AFTER QUIET BEATS: Whenever a beat follows a quiet/whispered beat (especially Beat 12 after Beat 11), its "style" MUST explicitly start with "Snap back to loud full-chest volume, NOT whispering," and its "text" MUST start with "<breath>" followed by an ALL-CAPS word so the TTS engine immediately raises the volume back up.
2. Every single beat's "text" MUST be strictly verbatim spoken dialogue containing 1 to 3 discrete vocal tags from this exact allowlist: <breath>, <laugh>, <chuckle>, <sigh>, <cough>, <short pause>.
3. Use ALL-CAPS on 1 or 2 key stressed words in most beats (e.g. THIS, SORRY, VERY, NEVER, ALL) to drive vocal emphasis.
4. Never put stage directions in parentheses or brackets in "text" (only the allowed angle-bracket vocal tags).`;

      for (const m of models) {
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${m}:generateContent?key=${encodeURIComponent(key)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
                generationConfig: {
                  temperature: 0.85,
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: 'OBJECT',
                    properties: {
                      title: { type: 'STRING' },
                      beats: {
                        type: 'ARRAY',
                        items: {
                          type: 'OBJECT',
                          properties: {
                            beat: { type: 'STRING' },
                            style: { type: 'STRING' },
                            text: { type: 'STRING' },
                          },
                          required: ['beat', 'style', 'text'],
                        },
                      },
                    },
                    required: ['title', 'beats'],
                  },
                },
              }),
            },
          );
          if (!resp.ok) continue;
          const data = await resp.json();
          const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!rawText) continue;
          const parsed = JSON.parse(rawText);
          if (parsed && parsed.beats && Array.isArray(parsed.beats) && parsed.beats.length >= 8) {
            return res.json(parsed);
          }
        } catch {}
      }
      res.status(500).json({ error: 'Failed to generate story with Gemini models.' });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // 4. Enhance Voice Prompt (Gemini Flash)
  app.post('/api/enhance-voice', async (req, res) => {
    try {
      const key = getApiKey(req);
      if (!key) {
        return res.status(400).json({ error: 'No Gemini API key available on server.' });
      }
      const { rawVoiceIdea } = req.body || {};
      const prompt = `Transform this brief voice description into a concise, studio-grade 2-sentence Voice Design prompt for a text-to-speech engine:
"${rawVoiceIdea || ''}"

CRITICAL RULES:
1. Describe ONLY immutable physical vocal traits: approximate age, gender/pitch range (e.g. baritone, contralto, tenor), vocal cord texture (e.g. gravelly, velvety, papery, smoky, resonant), and natural cadence.
2. Do NOT include any temporary emotional states (never include words like angry, sad, whispering, laughing, nervous) because emotion is controlled separately per turn.
3. Output ONLY the enhanced 2-sentence description text with no quotes or preamble.`;

      const models = ['models/gemini-2.5-flash', 'models/gemini-3.8-flash', 'models/gemini-3.5-flash'];
      for (const m of models) {
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${m}:generateContent?key=${encodeURIComponent(key)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                  temperature: 0.7,
                },
              }),
            },
          );
          if (!resp.ok) continue;
          const data = await resp.json();
          const text = data.candidates?.[0]?.content?.parts
            ?.map((p: any) => p.text || '')
            .join('')
            .trim();
          if (text) {
            return res.json({ enhancedPrompt: text.replace(/^["']|["']$/g, '') });
          }
        } catch {}
      }
      res.json({ enhancedPrompt: rawVoiceIdea });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // 5. Align Beats Multimodal Audio (Gemini Flash)
  app.post('/api/align-beats', async (req, res) => {
    try {
      const key = getApiKey(req);
      if (!key) {
        return res.status(400).json({ error: 'No Gemini API key available on server.' });
      }
      const { wavBase64, alignmentInstruction } = req.body || {};
      const candidateModels = [
        'models/gemini-2.5-flash',
        'models/gemini-3.5-flash-lite',
        'models/gemini-3.1-flash-lite',
      ];

      for (const alignModel of candidateModels) {
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${alignModel}:generateContent?key=${encodeURIComponent(key)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({
                contents: [
                  {
                    role: 'user',
                    parts: [
                      { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
                      { text: alignmentInstruction },
                    ],
                  },
                ],
                generationConfig: {
                  temperature: 0.0,
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: 'ARRAY',
                    items: {
                      type: 'OBJECT',
                      properties: {
                        beat_index: { type: 'INTEGER' },
                        start_sec: { type: 'STRING' },
                        end_sec: { type: 'STRING' },
                      },
                      required: ['beat_index', 'start_sec', 'end_sec'],
                    },
                  },
                },
              }),
            },
          );
          if (!resp.ok) continue;
          const data = await resp.json();
          const rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!rawJsonText) continue;
          const parsed = JSON.parse(rawJsonText);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return res.json({ modelUsed: alignModel, parsed });
          }
        } catch {}
      }
      res.status(500).json({ error: 'Alignment failed across models.' });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // 6. Live Interactive Voice/Chat with Jerry (Late-Night Tech Talk Host)
  app.post('/api/jerry-live-turn', async (req, res) => {
    try {
      const key = getApiKey(req);
      if (!key) {
        return res.status(400).json({ error: 'No Gemini API key available on server.' });
      }
      const { userMessage, history = [] } = req.body || {};
      if (!userMessage || !userMessage.trim()) {
        return res.status(400).json({ error: 'userMessage is required.' });
      }

      const JERRY_SYSTEM_PROMPT = buildJerryLanguagePrompt(JERRY_LIVE_SYSTEM_PROMPT);

      // Format conversation contents for Gemini
      const contents: any[] = [];
      for (const turn of history) {
        if (turn.role === 'user' || turn.role === 'model') {
          contents.push({
            role: turn.role,
            parts: [{ text: turn.text }],
          });
        }
      }
      // Add current user prompt
      contents.push({
        role: 'user',
        parts: [{ text: userMessage.trim() }],
      });

      // Call Gemini 3.8 Flash (supported text model)
      const textModels = ['models/gemini-3.8-flash', 'models/gemini-3.1-flash-lite'];
      let replyText = '';

      for (const model of textModels) {
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${encodeURIComponent(key)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: JERRY_SYSTEM_PROMPT }] },
                contents,
                generationConfig: {
                  temperature: 0.9,
                  topP: 0.95,
                  maxOutputTokens: 300,
                },
              }),
            },
          );
          if (!resp.ok) {
            console.error(`Gemini text error on ${model}:`, resp.status, await resp.text());
            continue;
          }
          const data = await resp.json();
          replyText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
          if (replyText) break;
        } catch (e: any) {
          console.error(`Fetch exception on ${model}:`, e);
        }
      }

      if (!replyText) {
        replyText = 'איתי, השרת שלך עושה לי בעיות עוד פעם. מה שאלת מקודם?';
      }

      // Synthesize audio using Gemini TTS.
      // Keep stage directions out of speech even if the model emits one.
      const ttsText = replyText.replace(/<[^>]+>/g, '').trim();
      const ttsLanguageCode = selectTtsLanguage(ttsText);
      let audioBase64 = '';
      const ttsErrors: string[] = [];
      const ttsModels = ['models/gemini-3.8-flash-lite-tts', 'models/gemini-3.8-flash-tts'];

      for (const ttsModel of ttsModels) {
        try {
          const ttsResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${ttsModel}:generateContent?key=${encodeURIComponent(key)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: ttsText }] }],
                generationConfig: {
                  responseModalities: ['AUDIO'],
                  speechConfig: {
                    ...(ttsLanguageCode ? { languageCode: ttsLanguageCode } : {}),
                    voiceConfig: {
                      voice: 'Charon',
                    },
                  },
                },
              }),
            },
          );
          if (!ttsResp.ok) {
            const errText = await ttsResp.text();
            const detail = `${ttsModel} HTTP ${ttsResp.status}: ${errText.slice(0, 300)}`;
            ttsErrors.push(detail);
            console.error('[Jerry TTS] fallback synthesis failed:', detail);
            continue;
          }
          const ttsData = await ttsResp.json();
          const b64 = ttsData.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (b64) {
            audioBase64 = b64;
            break;
          }
        } catch (err: any) {
          const detail = `${ttsModel}: ${err?.message || String(err)}`;
          ttsErrors.push(detail);
          console.error('[Jerry TTS] fallback synthesis exception:', detail);
          // retry next TTS model
        }
      }

      res.json({
        replyText,
        audioBase64,
        audioError: audioBase64 ? null : ttsErrors.join(' | ') || 'No audio returned by Gemini TTS',
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Logging persistence
  app.post('/api/alignment-log', (req, res) => {
    try {
      const entry = {
        timestamp: new Date().toISOString(),
        ...(req.body || {}),
      };
      console.log(`\n=== [ALIGNMENT INSPECTOR LOG @ ${entry.timestamp}] ===`);
      console.log(
        `Story: "${entry.storyTitle || 'Unknown'}" | Total Audio Duration: ${entry.totalDurationSec}s | Status: ${entry.status} | Model: ${entry.modelUsed || 'heuristic-only'}`,
      );
      if (entry.error) {
        console.log(`⚠️ Alignment Warning/Error: ${entry.error}`);
      }
      if (Array.isArray(entry.rows)) {
        for (const r of entry.rows) {
          console.log(
            `  Beat ${String(r.beatIndex + 1).padStart(2, '0')} | Init: ${r.initialStart}s–${r.initialEnd}s | GeminiRaw: ${r.geminiStart ?? 'N/A'}s–${r.geminiEnd ?? 'N/A'}s | FinalSnapped: ${r.finalStart}s–${r.finalEnd}s (Δ=${r.deltaSec}s)`,
          );
        }
      }
      console.log(`=========================================================\n`);

      let existing: any[] = [];
      if (fs.existsSync(ALIGNMENT_LOG_FILE)) {
        try {
          existing = JSON.parse(fs.readFileSync(ALIGNMENT_LOG_FILE, 'utf-8'));
        } catch {
          existing = [];
        }
      }
      existing.unshift(entry);
      fs.writeFileSync(ALIGNMENT_LOG_FILE, JSON.stringify(existing.slice(0, 25), null, 2), 'utf-8');
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/voice-log', (req, res) => {
    try {
      const entry = {
        timestamp: new Date().toISOString(),
        ...(req.body || {}),
      };
      console.log(`\n=== [VOICE API LOG @ ${entry.timestamp}] ===`);
      console.log(`Endpoint: ${entry.endpoint || 'POST /v1beta/voices'}`);
      console.log(`Target Prompt: "${entry.prompt || 'None'}"`);
      console.log(`Model: ${entry.model || 'Unknown'}`);
      console.log(`Status: ${entry.status?.toUpperCase()} (HTTP ${entry.httpStatus ?? 'N/A'})`);
      if (entry.voiceId) {
        console.log(`✅ Success! Created Custom Voice ID: "${entry.voiceId}"`);
      }
      if (entry.error) {
        console.log(`❌ Error: ${entry.error}`);
      }
      if (entry.fallbackUsed) {
        console.log(`⚠️ Fallback Active: Prebuilt voice "${entry.fallbackUsed}" will be used for synthesis.`);
      }
      if (entry.responseBody) {
        console.log(`Response Body:`, JSON.stringify(entry.responseBody, null, 2));
      }
      console.log(`============================================\n`);

      let existing: any[] = [];
      if (fs.existsSync(VOICE_LOG_FILE)) {
        try {
          existing = JSON.parse(fs.readFileSync(VOICE_LOG_FILE, 'utf-8'));
        } catch {
          existing = [];
        }
      }
      existing.unshift(entry);
      fs.writeFileSync(VOICE_LOG_FILE, JSON.stringify(existing.slice(0, 30), null, 2), 'utf-8');
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/voice-log', (_req, res) => {
    try {
      if (fs.existsSync(VOICE_LOG_FILE)) {
        res.json(JSON.parse(fs.readFileSync(VOICE_LOG_FILE, 'utf-8')));
      } else {
        res.json([]);
      }
    } catch {
      res.json([]);
    }
  });

  app.get('/api/alignment-log', (_req, res) => {
    try {
      if (fs.existsSync(ALIGNMENT_LOG_FILE)) {
        res.json(JSON.parse(fs.readFileSync(ALIGNMENT_LOG_FILE, 'utf-8')));
      } else {
        res.json([]);
      }
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        allowedHosts: true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = createServer(app);

  // Low-latency Jerry voice path: browser text/transcript -> Gemini 3.8 Live -> streamed PCM audio.
  // This removes the sequential text-model + full-file TTS wait from the conversational path.
  const wss = new WebSocketServer({ server: httpServer, path: '/api/jerry-live-socket' });

  wss.on('connection', async (client) => {
    const connectionId = nextJerryConnectionId++;
    recordJerryDebug('socket-connected', { connectionId });
    const key = getApiKey();
    if (!key) {
      client.send(JSON.stringify({ type: 'error', message: 'No Gemini API key available on server.' }));
      client.close();
      return;
    }

    let liveSession: any = null;
    let transcribeSession: any = null;
    let lastFinalGuestTranscript = '';
    let lastLiveFinalCandidate = '';
    let lastLiveInterimTranscript = '';
    let guestTurnEnded = false;
    let aiClient: GoogleGenAI | null = null;
    let guestPcmChunks: Buffer[] = [];
    let guestTurnId = 0;
    let guestTurnStartedAt = 0;
    let guestAudioChunkCount = 0;
    let guestAudioBytes = 0;
    const recordingLifecycle = new RecordingStopCoordinator();
    const recordingControlQueue = new RecordingControlQueue();
    const canonicalCaptureStore = new CanonicalCaptureStore(RECORDINGS_DIR);
    let canonicalCaptureId: string | null = null;
    let canonicalAppendQueue: Promise<void> = Promise.resolve();
    let jerryPcmChunks: Buffer[] = [];
    let jerryCapture: JerryPcmCaptureMetadata | null = null;
    let jerryCaptureActive = false;
    let jerryCaptureSequence = 0;
    let jerryCaptureFinalization: Promise<void> | null = null;

    const appendCanonicalEvent = async (type: 'transcript' | 'conversation-event', metadata: Record<string, unknown>) => {
      if (!canonicalCaptureId) return;
      try {
        await canonicalCaptureStore.appendEventRecord(canonicalCaptureId, {
          type,
          atMs: Date.now(),
          metadata: { connectionId, ...metadata },
        });
      } catch (error) {
        recordJerryDebug('canonical-event-append-error', {
          connectionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const startJerryPcmCapture = (details: Record<string, unknown> = {}) => {
      if (jerryCaptureActive) return jerryCapture;
      const episodeId = captureToken(details.episodeId, `episode-${connectionId}-${Date.now()}`);
      const captureId = `${episodeId}-jerry-${connectionId}-${++jerryCaptureSequence}`;
      jerryPcmChunks = [];
      jerryCapture = {
        captureId,
        episodeId,
        connectionId,
        streamId: 'jerry',
        sampleRate: null,
        mimeTypes: [],
        startedAt: new Date().toISOString(),
        chunkCount: 0,
        byteLength: 0,
      };
      jerryCaptureActive = true;
      recordJerryDebug('jerry-capture-started', { ...jerryCapture });
      return jerryCapture;
    };

    const captureJerryPcmChunk = (data: string, mimeType: string, turnId: number) => {
      if (!jerryCaptureActive || !jerryCapture) return null;
      const parsed = parsePcmMimeType(mimeType);
      const chunk = Buffer.from(data, 'base64');
      const sequence = jerryCapture.chunkCount;
      jerryPcmChunks.push(chunk);
      jerryCapture.chunkCount += 1;
      jerryCapture.byteLength += chunk.length;
      if (jerryCapture.sampleRate === null && parsed.sampleRate !== null) {
        jerryCapture.sampleRate = parsed.sampleRate;
      }
      if (!jerryCapture.mimeTypes.includes(parsed.mimeType)) {
        jerryCapture.mimeTypes.push(parsed.mimeType);
      }
      recordJerryDebug('jerry-audio-captured', {
        connectionId,
        episodeId: jerryCapture.episodeId,
        captureId: jerryCapture.captureId,
        streamId: jerryCapture.streamId,
        turnId,
        sequence,
        bytes: chunk.length,
        sampleRate: parsed.sampleRate,
        mimeType: parsed.mimeType,
      });
      return { chunk, sequence, metadata: jerryCapture };
    };

    const appendCanonicalJerryChunk = async (captured: { chunk: Buffer; sequence: number; metadata: JerryPcmCaptureMetadata }, mimeType: string) => {
      if (!canonicalCaptureId) return;
      const parsed = parsePcmMimeType(mimeType);
      if (!parsed.sampleRate || captured.chunk.length % 2 !== 0) return;
      await canonicalCaptureStore.appendChunk(canonicalCaptureId, {
        source: 'jerry',
        sequence: captured.sequence,
        captureStartMs: Date.now(),
        captureEndMs: Date.now(),
        sampleCount: captured.chunk.length / 2,
        format: { sampleRate: parsed.sampleRate, channels: 1, encoding: 'pcm_s16le' },
        data: captured.chunk,
      });
    };

    const enqueueCanonicalAppend = (work: () => Promise<void>): Promise<void> => {
      const next = canonicalAppendQueue.then(work, work);
      canonicalAppendQueue = next.catch(() => undefined);
      return next;
    };

    const finalizeJerryPcmCapture = async (reason: string) => {
      if (!jerryCapture || !jerryCaptureActive) return;
      jerryCaptureActive = false;
      const metadata: JerryPcmCaptureMetadata = {
        ...jerryCapture,
        stoppedAt: new Date().toISOString(),
        stopReason: reason,
        mimeTypes: [...jerryCapture.mimeTypes],
      };
      const pcm = Buffer.concat(jerryPcmChunks);
      jerryPcmChunks = [];
      jerryCapture = metadata;
      const captureDir = path.join(RECORDINGS_DIR, 'jerry-captures', metadata.captureId);
      jerryCaptureFinalization = (async () => {
        try {
          await fs.promises.mkdir(captureDir, { recursive: true });
          await fs.promises.writeFile(path.join(captureDir, 'jerry.pcm'), pcm);
          await fs.promises.writeFile(
            path.join(captureDir, 'jerry-capture-metadata.json'),
            JSON.stringify(metadata, null, 2),
          );
          recordJerryDebug('jerry-capture-finalized', {
            ...metadata,
            file: path.relative(RECORDINGS_DIR, path.join(captureDir, 'jerry.pcm')),
            persistedBytes: pcm.length,
          });
        } catch (error) {
          recordJerryDebug('jerry-capture-finalization-error', {
            ...metadata,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      await jerryCaptureFinalization;
    };

    try {
      aiClient = new GoogleGenAI({ apiKey: key });

      transcribeSession = await aiClient.live.connect({
        model: 'gemini-3.5-transcribe-live',
        callbacks: {
          onopen: () => {
            console.info('[Jerry STT] Hebrew/English code-switching transcriber opened');
            recordJerryDebug('stt-ready', { connectionId });
          },
          onmessage: (message: any) => {
            if (client.readyState !== WebSocket.OPEN) return;

            const serverContent = message?.serverContent || message?.server_content;
            const interim =
              serverContent?.interimInputTranscription?.text ||
              serverContent?.interim_input_transcription?.text ||
              '';
            if (interim) {
              lastLiveInterimTranscript = interim.trim();
              client.send(JSON.stringify({ type: 'input-transcript-interim', text: interim }));
            }

            const liveFinalText =
              serverContent?.inputTranscription?.text ||
              serverContent?.input_transcription?.text ||
              '';
            if (liveFinalText.trim()) {
              lastLiveFinalCandidate = liveFinalText.trim();
              console.info('[Jerry STT] live final candidate (awaiting full-turn verification):', lastLiveFinalCandidate);
            }
          },
          onerror: (event: any) => {
            console.error('[Jerry STT] error:', event?.message || event);
            recordJerryDebug('stt-error', { connectionId, message: event?.message || String(event) });
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'stt-error',
                  message: event?.message || 'Transcription session error',
                }),
              );
            }
          },
          onclose: (event: any) => {
            console.info('[Jerry STT] closed:', event?.reason || '');
          },
        },
        config: {
          responseModalities: [Modality.TEXT],
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: true,
            },
          },
          inputAudioTranscription: {
            // Deterministic mocks cover routing; live-provider proof remains a separate credentialed check.
            ...CODE_SWITCH_TRANSCRIPTION_CONFIG,
            customVocabulary: [
              'ג\'רי',
              'איתי',
              'Kubernetes',
              'production',
              'deploy',
              'rollback',
              'incident',
              'latency',
              'GitHub',
              'R&D',
              'AI',
              'Gemini',
            ],
          },
        },
      });

      liveSession = await aiClient.live.connect({
        model: 'gemini-3.8-live',
        callbacks: {
          onopen: () => {
            console.info('[Jerry Live] Gemini session opened');
            recordJerryDebug('jerry-live-ready', { connectionId });
          },
          onmessage: (message: any) => {
            const serverContent = message?.serverContent || message?.server_content;
            const parts = serverContent?.modelTurn?.parts || serverContent?.model_turn?.parts || [];

            for (const part of parts) {
              const inlineData = part?.inlineData || part?.inline_data;
              if (inlineData?.data) {
                const actualMimeType = inlineData.mimeType || inlineData.mime_type || 'audio/pcm;rate=24000';
                const capturedJerry = captureJerryPcmChunk(inlineData.data, actualMimeType, guestTurnId);
                if (capturedJerry) {
                  void enqueueCanonicalAppend(() => appendCanonicalJerryChunk(capturedJerry, actualMimeType)).catch((error) => {
                    recordJerryDebug('canonical-jerry-append-error', {
                      connectionId,
                      message: error instanceof Error ? error.message : String(error),
                    });
                  });
                }
                if (client.readyState !== WebSocket.OPEN) continue;
                const captureIdentity = jerryCapture
                  ? {
                      episodeId: jerryCapture.episodeId,
                      captureId: jerryCapture.captureId,
                      streamId: jerryCapture.streamId,
                    }
                  : {};
                recordJerryDebug('jerry-audio', {
                  connectionId,
                  turnId: guestTurnId,
                  bytes: Math.floor((inlineData.data.length * 3) / 4),
                  ...captureIdentity,
                });
                client.send(
                  JSON.stringify({
                    type: 'audio',
                    data: inlineData.data,
                    mimeType: actualMimeType,
                  }),
                );
              }
            }

            if (client.readyState !== WebSocket.OPEN) return;

            const transcription =
              serverContent?.outputTranscription?.text ||
              serverContent?.output_transcription?.text ||
              '';
            if (transcription) {
              void appendCanonicalEvent('transcript', {
                speaker: 'jerry',
                text: transcription,
                turnId: guestTurnId,
                source: 'gemini',
              });
              client.send(JSON.stringify({ type: 'transcript', text: transcription }));
            }

            if (serverContent?.interrupted) {
              client.send(JSON.stringify({ type: 'interrupted' }));
            }

            if (serverContent?.turnComplete || serverContent?.turn_complete) {
                  recordJerryDebug('jerry-turn-complete', {
                    connectionId,
                    turnId: guestTurnId,
                  });
              client.send(JSON.stringify({ type: 'turn-complete' }));
            }
          },
          onerror: (event: any) => {
            console.error('[Jerry Live] Gemini error:', event?.message || event);
            recordJerryDebug('jerry-live-error', { connectionId, message: event?.message || String(event) });
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'error',
                  message: event?.message || 'Gemini Live session error',
                }),
              );
            }
          },
          onclose: (event: any) => {
            console.info('[Jerry Live] Gemini session closed:', event?.reason || '');
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'closed' }));
            }
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Charon',
              },
            },
          },
          systemInstruction: buildJerryLanguagePrompt(JERRY_LIVE_SYSTEM_PROMPT),
        },
      });

      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: 'ready',
            engine: 'gemini-3.8-live',
            engineVersion: JERRY_ENGINE_VERSION,
                    inputPath: 'push-to-talk PCM -> Live interim STT -> full-turn Gemini 3.5 Transcribe (he-IL/en-US code-switch) -> Gemini 3.8 Live -> Jerry response',
          }),
        );
            recordJerryDebug('socket-ready-sent', { connectionId, engineVersion: JERRY_ENGINE_VERSION });
      }
    } catch (err: any) {
      console.error('[Jerry Live] setup failed:', err);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'error', message: err?.message || String(err) }));
      }
      client.close();
      return;
    }

    client.on('message', async (raw) => {
      if (!liveSession || !transcribeSession) return;
      try {
        const rawText = raw?.toString?.() || '';
        if (!rawText.trim() || rawText === 'undefined') {
          recordJerryDebug('socket-invalid-message', {
            connectionId,
            turnId: guestTurnId,
            rawPreview: rawText.slice(0, 80),
          });
          return;
        }
        const msg = JSON.parse(rawText);

        if (msg.type === 'recording-start' && typeof msg.recordingId === 'string') {
          recordingLifecycle.start(msg.recordingId);
          canonicalCaptureId = msg.recordingId;
          canonicalAppendQueue = Promise.resolve();
          await canonicalCaptureStore.start({ episodeId: canonicalCaptureId, metadata: { connectionId } });
          startJerryPcmCapture({ episodeId: canonicalCaptureId });
          recordJerryDebug('recording-started', {
            connectionId,
            recordingId: msg.recordingId,
          });
          client.send(JSON.stringify({
            type: 'recording-started',
            recordingId: msg.recordingId,
          }));
        } else if (msg.type === 'recording-stop-request' && typeof msg.requestId === 'string') {
          await recordingControlQueue.run(async () => {
            try {
              const accepted = recordingLifecycle.requestStop(msg.requestId, Number(msg.stopAt) || Date.now());
              if (canonicalCaptureId) {
                await canonicalCaptureStore.requestStop(canonicalCaptureId, accepted.stopAt);
              }
              recordJerryDebug('recording-stop-accepted', {
                connectionId,
                recordingId: accepted.recordingId,
                requestId: accepted.requestId,
                status: accepted.status,
                stopAt: accepted.stopAt,
              });
              client.send(JSON.stringify({ type: 'recording-stop-accepted', ...accepted }));
            } catch (error) {
              recordJerryDebug('recording-stop-rejected', {
                connectionId,
                requestId: msg.requestId,
                message: error instanceof Error ? error.message : String(error),
              });
              client.send(JSON.stringify({
                type: 'recording-stop-error',
                requestId: msg.requestId,
                message: error instanceof Error ? error.message : String(error),
              }));
            }
          });
        } else if (msg.type === 'recording-finalize' && typeof msg.requestId === 'string') {
          void recordingControlQueue.run(async () => {
            try {
              const ack = await recordingLifecycle.finalize(msg.requestId, async () => {
                if (canonicalCaptureId) {
                  await canonicalAppendQueue;
                  await finalizeJerryPcmCapture('recording-finalize');
                  const manifest = await canonicalCaptureStore.get(canonicalCaptureId);
                  if (manifest.streams.human.byteCount <= 0 || manifest.streams.jerry.byteCount <= 0) {
                    throw new Error('Canonical capture is missing Human or Jerry audio');
                  }
                  await canonicalCaptureStore.finalize(canonicalCaptureId);
                }
                recordJerryDebug('recording-finalize-commit', {
                  connectionId,
                  recordingId: msg.recordingId,
                  requestId: msg.requestId,
                  shadowBytes: Number(msg.shadowBytes) || 0,
                });
              });
              recordJerryDebug('recording-stop-ack-sent', {
                connectionId,
                recordingId: ack.recordingId,
                requestId: ack.requestId,
                inflight: ack.inflight,
              });
              if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(ack));
            } catch (error) {
              recordJerryDebug('recording-finalize-error', {
                connectionId,
                requestId: msg.requestId,
                message: error instanceof Error ? error.message : String(error),
              });
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: 'recording-stop-error',
                  requestId: msg.requestId,
                  message: error instanceof Error ? error.message : String(error),
                }));
              }
            }
          });
        } else if (msg.type === 'human-archive' && typeof msg.data === 'string' && canonicalCaptureId) {
          try {
            const data = Buffer.from(msg.data, 'base64');
            const sampleRate = Number(msg.sampleRate);
            const sampleCount = Number(msg.sampleCount);
            const capturedAtMs = Number(msg.capturedAtMs) || Date.now();
            await enqueueCanonicalAppend(() => canonicalCaptureStore.appendChunk(canonicalCaptureId!, {
              source: 'human',
              sequence: Number(msg.sequence),
              captureStartMs: capturedAtMs,
              captureEndMs: capturedAtMs + (sampleCount / sampleRate) * 1000,
              sampleCount,
              format: { sampleRate, channels: 1, encoding: 'pcm_s16le' },
              data,
            }).then(() => undefined));
          } catch (error) {
            recordJerryDebug('canonical-human-append-error', {
              connectionId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } else if (msg.type === 'restore-history' && Array.isArray(msg.turns)) {
          const restoredTurns = msg.turns
            .filter(
              (turn: any) =>
                (turn?.role === 'user' || turn?.role === 'model') &&
                typeof turn?.text === 'string' &&
                turn.text.trim(),
            )
            .map((turn: any) => ({
              role: turn.role,
              parts: [{ text: turn.text.trim() }],
            }));

          if (restoredTurns.length > 0) {
            console.info('[Jerry Engine]', {
              engineVersion: JERRY_ENGINE_VERSION,
              stage: 'restore-history',
              turns: restoredTurns.length,
            });
            liveSession.sendClientContent({
              turns: restoredTurns,
              turnComplete: false,
            });
          }
        } else if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
          recordJerryDebug('guest-text-forwarded', {
            connectionId,
            turnId: guestTurnId,
            textPreview: msg.text.trim().slice(0, 160),
          });
          liveSession.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: msg.text.trim() }] }],
            turnComplete: true,
          });
        } else if (
          msg.type === 'debug-event' &&
          typeof msg.event === 'string' &&
          msg.event.trim()
        ) {
          const category = typeof msg.category === 'string' ? msg.category.slice(0, 40) : 'client';
          const details = msg.details && typeof msg.details === 'object' ? msg.details : {};
          const sanitizedDetails = sanitizeClientDebugDetails(msg.event.trim(), details as Record<string, unknown>);
              if (msg.event.trim() === 'recording-start-request' || msg.event.trim() === 'recording-started') {
                startJerryPcmCapture(sanitizedDetails);
              } else if (msg.event.trim() === 'recording-stop-request') {
                void finalizeJerryPcmCapture('recording-stop-request');
              }
          recordJerryDebug('client-debug', {
            connectionId,
            turnId: guestTurnId,
            category,
            clientEvent: msg.event.trim().slice(0, 80),
            details: sanitizedDetails,
                ...(jerryCapture
                  ? {
                      episodeId: jerryCapture.episodeId,
                      captureId: jerryCapture.captureId,
                      streamId: jerryCapture.streamId,
                    }
                  : {}),
          });
        } else if (msg.type === 'activity-start') {
          lastFinalGuestTranscript = '';
          lastLiveFinalCandidate = '';
          lastLiveInterimTranscript = '';
          guestTurnEnded = false;
          guestTurnId += 1;
          guestTurnStartedAt = Date.now();
          guestAudioChunkCount = 0;
          guestAudioBytes = 0;
          guestPcmChunks = [];
          console.info('[Jerry Engine]', {
            engineVersion: JERRY_ENGINE_VERSION,
              stage: 'code-switch-transcribe-start',
          });
          recordJerryDebug('guest-turn-start', { connectionId, turnId: guestTurnId });
          transcribeSession.sendRealtimeInput({ activityStart: {} });
        } else if (msg.type === 'audio' && typeof msg.data === 'string' && msg.data) {
          const audioChunk = Buffer.from(msg.data, 'base64');
          guestPcmChunks.push(audioChunk);
          guestAudioChunkCount += 1;
          guestAudioBytes += audioChunk.length;
          transcribeSession.sendRealtimeInput({
            audio: {
              data: msg.data,
              mimeType: msg.mimeType || 'audio/pcm;rate=16000',
            },
          });
        } else if (msg.type === 'activity-end') {
          if (guestTurnEnded) {
            recordJerryDebug('duplicate-activity-end-ignored', {
              connectionId,
              turnId: guestTurnId,
            });
          void appendCanonicalEvent('conversation-event', {
            event: msg.event.trim(),
            category,
            details: sanitizedDetails,
          });
            return;
          }
          guestTurnEnded = true;
          const completedTurnId = guestTurnId;
          const completedTurnChunks = guestPcmChunks;
          guestPcmChunks = [];
          console.info('[Jerry Engine]', {
            engineVersion: JERRY_ENGINE_VERSION,
            stage: 'code-switch-transcribe-end-awaiting-authoritative-final',
          });
          recordJerryDebug('guest-turn-end', {
            connectionId,
            turnId: completedTurnId,
            durationMs: guestTurnStartedAt ? Date.now() - guestTurnStartedAt : null,
            audioChunks: guestAudioChunkCount,
            audioBytes: guestAudioBytes,
          });
          transcribeSession.sendRealtimeInput({ activityEnd: {} });
          void (async () => {
            let authoritativeTranscript = '';
            recordJerryDebug('authoritative-start', {
              connectionId,
              turnId: completedTurnId,
              audioBytes: completedTurnChunks.reduce((total, chunk) => total + chunk.length, 0),
            });
            try {
                  if (!aiClient) throw new Error('Gemini client is not initialized');
                  authoritativeTranscript = await withTimeout(
                    transcribeGuestTurn(aiClient, completedTurnChunks),
                    12000,
                    'transcription-timeout',
                  );
            } catch (err) {
              console.warn('[Jerry STT] authoritative transcription failed; using live candidate:', err);
              recordJerryDebug('authoritative-error', {
                connectionId,
                turnId: completedTurnId,
                message: err instanceof Error ? err.message : String(err),
              });
              if (err instanceof Error && err.message === 'transcription-timeout') {
                recordJerryDebug('authoritative-timeout', { connectionId, turnId: completedTurnId });
              }
            }
            if (completedTurnId !== guestTurnId) return;
            const finalTranscript =
              authoritativeTranscript || lastLiveFinalCandidate || lastLiveInterimTranscript;
            if (!finalTranscript) {
              recordJerryDebug('turn-aborted-no-transcript', {
                connectionId,
                turnId: completedTurnId,
                audioChunks: completedTurnChunks.length,
                audioBytes: completedTurnChunks.reduce((total, chunk) => total + chunk.length, 0),
                hadLiveFinalCandidate: Boolean(lastLiveFinalCandidate),
                hadLiveInterimTranscript: Boolean(lastLiveInterimTranscript),
              });
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'stt-error', message: 'No final Hebrew transcript was produced' }));
              }
              return;
            }
            if (finalTranscript === lastFinalGuestTranscript) return;
            lastFinalGuestTranscript = finalTranscript;
            void appendCanonicalEvent('transcript', {
              speaker: 'human',
              text: finalTranscript,
              turnId: completedTurnId,
              source: 'stt',
            });
            console.info('[Jerry STT] authoritative Hebrew transcript:', finalTranscript);
            recordJerryDebug(authoritativeTranscript ? 'authoritative-success' : 'authoritative-fallback', {
              connectionId,
              turnId: completedTurnId,
              elapsedMs: guestTurnStartedAt ? Date.now() - guestTurnStartedAt : null,
              textPreview: finalTranscript.slice(0, 160),
            });
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'input-transcript', text: finalTranscript }));
            }
            recordJerryDebug('guest-transcript-forwarded', {
              connectionId,
              turnId: completedTurnId,
              textPreview: finalTranscript.slice(0, 160),
            });
            liveSession?.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: finalTranscript }] }],
              turnComplete: true,
            });
          })();
        }
      } catch (err) {
        console.warn('[Jerry Live] bad browser message:', err);
      }
    });

    client.on('close', () => {
      recordJerryDebug('socket-closed', { connectionId, turnId: guestTurnId });
      void finalizeJerryPcmCapture('socket-closed');
      try {
        liveSession?.close();
      } catch {}
      try {
        transcribeSession?.close();
      } catch {}
      liveSession = null;
      transcribeSession = null;
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Monologue app running at http://localhost:${PORT}`);
    console.log('✅ Jerry low-latency Live socket ready at /api/jerry-live-socket');
  });
}

startServer();
