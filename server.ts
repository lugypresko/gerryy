import express from 'express';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const PORT = 3000;
const JERRY_ENGINE_VERSION = 'jerry-conversation-v4-performance-m1-2026-09-27';
const KEY_FILE = path.resolve(process.cwd(), '.api-key.json');
const ALIGNMENT_LOG_FILE = path.resolve(process.cwd(), '.alignment-logs.json');
const VOICE_LOG_FILE = path.resolve(process.cwd(), '.voice-logs.json');

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
21. כרגע האורח מדבר עברית. התייחס לכל קלט קולי כעברית כברירת מחדל, וענה בעברית. אם התמלול נראה כמו שפה אחרת, הנח שזו שגיאת תמלול ולא שהאורח החליף שפה.
22. הקול יבש, חם, מעט מחוספס, בקצב ניו-יורקי קל. פאוזות טבעיות. לא תיאטרלי ולא קריקטורה.
23. אל תקריא תגיות במה כמו <sigh> או <chuckle>. בצע אותן בקול אם מתאים.
24. התחל מהר. אל תחשוב בקול ואל תאריך הקדמות.

ביצוע קולי — זה חלק מהשיחה, לא קישוט:
- אל תתחיל כל תשובה מיד במילים. כשיש הפתעה, סתירה, מבוכה או משהו מצחיק, מותר לתת beat קצר לפני הדיבור.
- השתמש באופן טבעי ולא תכוף ב-backchannels קוליים: "מממ", "אה", "הא", נשיפה קלה, chuckle קצר או אנחה. אל תכתוב את שם הפעולה ואל תכריז עליה.
- צחוק צריך להיות תגובה למשהו שבאמת מצחיק או אבסורדי; לא punctuation אוטומטי.
- אנחה מתאימה לעייפות, אבסורד מוכר או resignation; לא לכל disagreement.
- hesitation קטן ("אה...", "רגע...") מתאים כשאתה באמת משנה כיוון או מעכל משהו.
- מותר שתור שלם יהיה backchannel קצר מאוד כשזה הרגע הנכון. לא כל turn חייב להכיל טענה או שאלה.
- אל תבצע יותר ממחווה קולית אחת בולטת באותו beat. פחות זה יותר.
- אחרי משפט חזק של האורח, לפעמים 300–800ms של שקט עדיפים על תשובה מיידית.
- אם האורח עדיין מחזיק את ה-floor, אל תגנוב אותו עם נאום. backchannel קצר בלבד.
- הקצב צריך להשתנות: לפעמים קצר וחד, לפעמים pause ואז משפט, ורק לעיתים רחוקות 2–3 משפטים.

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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

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

      const JERRY_SYSTEM_PROMPT = JERRY_LIVE_SYSTEM_PROMPT;

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
                    languageCode: 'he-IL',
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
    const key = getApiKey();
    if (!key) {
      client.send(JSON.stringify({ type: 'error', message: 'No Gemini API key available on server.' }));
      client.close();
      return;
    }

    let liveSession: any = null;
    let transcribeSession: any = null;
    let lastFinalGuestTranscript = '';

    try {
      // This app uses Gemini Developer API keys (GEMINI_API_KEY), not Vertex AI.
      // Explicitly opt out of SDK environment-based Vertex AI selection.
      const ai = new GoogleGenAI({ apiKey: key, vertexai: false });

      transcribeSession = await ai.live.connect({
        model: 'gemini-3.5-transcribe-live',
        callbacks: {
          onopen: () => {
            console.info('[Jerry STT] dedicated Hebrew transcriber opened');
          },
          onmessage: (message: any) => {
            if (client.readyState !== WebSocket.OPEN) return;

            const serverContent = message?.serverContent || message?.server_content;
            const interim =
              serverContent?.interimInputTranscription?.text ||
              serverContent?.interim_input_transcription?.text ||
              '';
            if (interim) {
              client.send(JSON.stringify({ type: 'input-transcript-interim', text: interim }));
            }

            const finalText =
              serverContent?.inputTranscription?.text ||
              serverContent?.input_transcription?.text ||
              '';

            if (finalText && finalText.trim()) {
              const transcript = finalText.trim();
              if (transcript === lastFinalGuestTranscript) return;
              lastFinalGuestTranscript = transcript;

              console.info('[Jerry STT] final Hebrew transcript:', transcript);
              client.send(JSON.stringify({ type: 'input-transcript', text: transcript }));

              try {
                liveSession?.sendClientContent({
                  turns: [{ role: 'user', parts: [{ text: transcript }] }],
                  turnComplete: true,
                });
              } catch (err) {
                console.warn('[Jerry STT] failed forwarding transcript to Jerry:', err);
              }
            }
          },
          onerror: (event: any) => {
            console.error('[Jerry STT] error:', event?.message || event);
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'stt-error',
                  message: event?.message || 'Hebrew transcription session error',
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
            languageCodes: ['he-IL'],
            mode: 'VERBATIM',
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

      liveSession = await ai.live.connect({
        model: 'gemini-3.8-live',
        callbacks: {
          onopen: () => {
            console.info('[Jerry Live] Gemini session opened');
          },
          onmessage: (message: any) => {
            if (client.readyState !== WebSocket.OPEN) return;

            const serverContent = message?.serverContent || message?.server_content;
            const parts = serverContent?.modelTurn?.parts || serverContent?.model_turn?.parts || [];

            for (const part of parts) {
              const inlineData = part?.inlineData || part?.inline_data;
              if (inlineData?.data) {
                client.send(
                  JSON.stringify({
                    type: 'audio',
                    data: inlineData.data,
                    mimeType: inlineData.mimeType || inlineData.mime_type || 'audio/pcm;rate=24000',
                  }),
                );
              }
            }

            const transcription =
              serverContent?.outputTranscription?.text ||
              serverContent?.output_transcription?.text ||
              '';
            if (transcription) {
              client.send(JSON.stringify({ type: 'transcript', text: transcription }));
            }

            if (serverContent?.interrupted) {
              client.send(JSON.stringify({ type: 'interrupted' }));
            }

            if (serverContent?.turnComplete || serverContent?.turn_complete) {
              client.send(JSON.stringify({ type: 'turn-complete' }));
            }
          },
          onerror: (event: any) => {
            console.error('[Jerry Live] Gemini error:', event?.message || event);
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
          systemInstruction: JERRY_LIVE_SYSTEM_PROMPT,
        },
      });

      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: 'ready',
            engine: 'gemini-3.8-live',
            engineVersion: JERRY_ENGINE_VERSION,
            inputPath: 'push-to-talk PCM -> Gemini 3.5 Transcribe Live (he-IL) -> text -> Gemini 3.8 Live -> Jerry response',
          }),
        );
      }
    } catch (err: any) {
      console.error('[Jerry Live] setup failed:', err);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'error', message: err?.message || String(err) }));
      }
      client.close();
      return;
    }

    client.on('message', (raw) => {
      if (!liveSession || !transcribeSession) return;
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'restore-history' && Array.isArray(msg.turns)) {
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
          liveSession.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: msg.text.trim() }] }],
            turnComplete: true,
          });
        } else if (msg.type === 'activity-start') {
          lastFinalGuestTranscript = '';
          console.info('[Jerry Engine]', {
            engineVersion: JERRY_ENGINE_VERSION,
            stage: 'hebrew-transcribe-start',
          });
          transcribeSession.sendRealtimeInput({ activityStart: {} });
        } else if (msg.type === 'audio' && typeof msg.data === 'string' && msg.data) {
          transcribeSession.sendRealtimeInput({
            audio: {
              data: msg.data,
              mimeType: msg.mimeType || 'audio/pcm;rate=16000',
            },
          });
        } else if (msg.type === 'activity-end') {
          console.info('[Jerry Engine]', {
            engineVersion: JERRY_ENGINE_VERSION,
            stage: 'hebrew-transcribe-end',
          });
          transcribeSession.sendRealtimeInput({ activityEnd: {} });
        }
      } catch (err) {
        console.warn('[Jerry Live] bad browser message:', err);
      }
    });

    client.on('close', () => {
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
