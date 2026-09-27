# Jerry LIVE Animation Implementation Plan

Current documentation note: pose-swap, animation telemetry, asset fallback, and lifecycle cleanup are implemented. Conversation-wide diagnostics are documented in `docs/JERRY_DEBUG_MONITOR.md`.

> **Implementation status (2026-09-27): COMPLETE** — The full-frame pose-swap implementation is live. The four assets, state machine, mouth anchors, crossfade, preload, fallback, and lifecycle cleanup are implemented. The runtime does not load the reference video.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** לגרום לג'רי להיראות חי בזמן שיחה LIVE באמצעות pose-swap של התמונות המלאות, תגובה לעוצמת האודיו ומכונת מצבים ברורה.

**Architecture:** התמונות המלאות משמשות כפוזות זהות-רקע ומתחלפות בשכבות `<img>` עם crossfade קצר. הווידאו משמש כרפרנס לתזמון בלבד ואינו נכנס ל-runtime. ה־Audio Analyser הקיים מספק את אות הדיבור, ומכונת המצבים מחליטה איזו פוזה להציג ומתי להפעיל את שכבת הפה.

**Tech Stack:** React, TypeScript, Web Audio API, CSS transitions, Node test runner.

---

## החלטות מוצר וטכניקה

- התסריט הוא דוגמה בלבד; אין להוסיף flow קשיח או Beat machine.
- אין חילוץ שכבות, segmentation או 2D puppet rig.
- ארבע התמונות החדשות ייכנסו כ־pose assets מלאים.
- הווידאו לא ייטען באפליקציה ולא ייכלל ב־build.
- יש לשמור את אפשרות ה־fallback וה־Live conversation הקיימות.
- לפני שילוב בקוד יש לנעול מיפוי מדויק של ארבעת הנכסים ב־commit הראשון.
- פוזת ה־amused עם ג'קט הג'ינס אינה נכנסת לאפליקציה; יש לייצר מחדש את אותה תנוחה בקורדרוי בורדו.
- פוזת הכתיבה עם העט היא פוזת `idle`.

## Task 0: יצירה מחדש של פוזת ה־amused בבורדו

**Files:**
- Input reference: `C:\Users\longy\OneDrive\Pictures\ג'רי\WhatsApp Image 2026-09-22 at 15.10.56.jpeg`
- Create: `public/jerry-pose-amused.jpg`

**Steps:**

1. להשתמש בתמונת ה־denim reference כמקור לתנוחה בלבד.
2. לייצר את אותה תנוחת ראש, יד על הלחי, מבט והבעה עם ג'קט קורדרוי בורדו, תוך שמירת הרקע והקומפוזיציה המשותפים.
3. להשוות את התוצאה לארבע התמונות כדי לוודא שאין blue denim באף asset שנכנס ל־runtime.
4. לא להוסיף את הווידאו או קבצי ביניים ל־`public` או ל־build.
5. לאשר את התמונה לפני התחלת Task 1.

## Task 1: הכנת ומיפוי נכסי הפוזות

**Files:**
- Create/Modify: `public/jerry-pose-*.jpg`
- Modify: `src/JerryPodcastStudio.tsx`
- Test: `tests/jerry-animation.test.mjs`

**Steps:**

1. להעתיק את שלוש התמונות המאושרות ואת פוזת ה־amused החדשה ל־`public` בשמות יציבים, בלי להשתמש בשמות WhatsApp ארוכים.
2. לשמור על אותו crop, aspect ratio וגודל רינדור לכל הפוזות.
3. לנעול את המיפוי הבא ב־manifest ובבדיקה הראשונה:

| Pose key | מקור | שימוש |
|---|---|---|
| `idle` | `WhatsApp Image 2026-09-22 at 15.06.09.jpeg` | כתיבה עם עט בזמן המתנה |
| `speaking` | `WhatsApp Image 2026-09-22 at 15.35.04.jpeg` | פה פתוח / אצבע מורמת |
| `skeptical` | `WhatsApp Image 2026-09-22 at 15.35.02.jpeg` | יד על הסנטר / תגובה ספקנית |
| `amused` | `public/jerry-pose-amused.jpg`, regenerated from `WhatsApp Image 2026-09-22 at 15.10.56.jpeg` | אותה תנוחה, קורדרוי בורדו |

4. להגדיר manifest יחיד בקוד, לדוגמה:

```ts
const JERRY_POSES = {
  idle: '/jerry-pose-idle.jpg',
  speaking: '/jerry-pose-speaking.jpg',
  skeptical: '/jerry-pose-skeptical.jpg',
  amused: '/jerry-pose-amused.jpg',
} as const;
```

5. להוסיף בדיקה שכל ארבעת הנכסים מופיעים ב־manifest, שהמיפוי תואם לטבלה, ושאין קישור ישיר לשמות WhatsApp.
6. להריץ `npm test` ולוודא שהבדיקה החדשה נכשלת לפני המימוש אם manifest או asset ה־amused עדיין לא קיימים.
7. לבצע commit ראשון משולב: `feat: lock Jerry live pose asset mapping`.

## Task 2: מודל מצבי האנימציה

**Files:**
- Modify: `src/JerryPodcastStudio.tsx`
- Test: `tests/jerry-animation.test.mjs`

**States:**

- `idle`: פוזת הכתיבה עם העט, בזמן המתנה.
- `listening`: המיקרופון פעיל והאורח מדבר; ברירת המחדל היא פוזת `idle`, עם אפשרות למעבר מוגבל ל־`skeptical`.
- `thinking`: נשלח turn ועדיין אין אודיו מג'רי.
- `speaking`: מתקבל אודיו מג'רי.
- `emphasis`: עוצמת קול גבוהה או burst קצר שמצריך פוזה אנרגטית.
- `amused` / `skeptical`: תגובות ביניים שנבחרות בצורה מוגבלת ולא בכל frame.

**Steps:**

1. להגדיר union type למצב ולפונקציית mapping למפתח פוזה.
2. להפריד בין מצב שיחה (`listening`, `thinking`, `speaking`) לבין וריאציית פוזה (`amused`, `skeptical`).
3. לכתוב בדיקות למעברים העיקריים:
   - mic start → `listening`;
   - first output audio → `speaking`;
   - turn complete → `idle` או `listening`;
   - Live disconnect → fallback/idle בלי להיתקע ב־`speaking`.
4. לממש את פונקציית הבחירה הטהורה לפני חיבור ל־React state.
5. להריץ `node --test tests/jerry-animation.test.mjs` ולוודא PASS.
6. לבצע commit: `feat: add Jerry animation state model`.

## Task 3: pose-swap רציף

**Files:**
- Modify: `src/JerryPodcastStudio.tsx`
- Modify: `src/index.css`

**Steps:**

1. להחליף את המבנה הנוכחי של רקע `pose-a` + overlay `pose-d` בשכבת pose-swap של ארבע תמונות מלאות.
2. לרנדר את כל התמונות זו מעל זו עם `position: absolute` ו־`opacity` לפי הפוזה הפעילה.
3. להגדיר crossfade של כ־`120–160ms`, תוך שמירת אותו crop כדי למנוע קפיצה ברקע.
4. לבצע preload לארבע התמונות לפני שהסטודיו מסומן כ־ready.
5. להוסיף fallback לתמונת `idle` אם asset חסר או נכשל בטעינה.
6. להריץ build ולבדוק ידנית שאין הבהוב, שינוי גודל או תזוזת רקע במעבר.
7. לבצע commit: `feat: implement full-frame Jerry pose swap`.

## Task 4: כיול נקודת הפה לכל פוזה

**Files:**
- Modify: `src/JerryPodcastStudio.tsx`
- Modify: `src/index.css`
- Test: `tests/jerry-animation.test.mjs`

**Steps:**

1. להגדיר calibration map לפי pose key:

```ts
const JERRY_MOUTH_ANCHORS = {
  idle: { x: 55.2, y: 75.5, width: 17.5 },
  speaking: { x: 55.2, y: 75.5, width: 17.5 },
  amused: { x: 55.2, y: 75.5, width: 17.5 },
  skeptical: { x: 55.2, y: 75.5, width: 17.5 },
} as const;
```

2. להחליף את הערכים הקבועים של הפה בערכי ה־anchor של הפוזה הפעילה.
3. לכייל את `x`, `y`, רוחב וגובה מול ארבע התמונות בפועל.
4. להציג את שכבת הפה רק בזמן דיבור, בלי להזיז את כל התמונה.
5. לבדוק שהפה נשאר מחובר לפנים בכל מעבר pose-swap.
6. להוסיף בדיקה שכל פוזה מכילה anchor תקין.
7. לבצע commit: `feat: calibrate Jerry mouth anchors`.

## Task 5: תגובה ל־Audio Analyser

**Files:**
- Modify: `src/JerryPodcastStudio.tsx`
- Test: `tests/jerry-animation.test.mjs`

**Steps:**

1. להשאיר את ה־Analyser מחובר ל־Live PCM ול־fallback audio הקיימים.
2. להגדיר envelope מוחלק עם attack/release כדי למנוע flicker.
3. לקבוע ספים ברורים:
   - level נמוך → mouth closed/listening;
   - level בינוני → mouth open;
   - level גבוה → mouth wide + `emphasis` לזמן מוגבל.
4. להגביל את החלפת פוזת הדיבור כדי שלא תתחלף יותר מדי פעמים בשנייה.
5. להשתמש בתזמון מהווידאו רק כבסיס לכיול, לא להוסיף את הסרטון לקוד.
6. להוסיף בדיקות לפונקציית threshold/pacing הטהורה.
7. לבצע commit: `feat: drive Jerry pose timing from audio energy`.

## Task 6: idle והקשבה

**Files:**
- Modify: `src/JerryPodcastStudio.tsx`
- Modify: `src/index.css`

**Steps:**

1. להוסיף שינויי micro-pose איטיים בזמן `listening`, רק אם אין output audio.
2. להוסיף variation מוגבלת בין idle/amused/skeptical לפי timer ולא לפי random בכל render.
3. להשאיר תנועת נשימה עדינה דרך CSS או transform של הקונטיינר בלבד.
4. לוודא שאין שינוי רקע, שינוי layout או קפיצה של המיקרופון.
5. לעצור timers ו־animation frames ב־cleanup של React.
6. לבצע בדיקה ידנית של 60 שניות הקשבה רציפה.
7. לבצע commit: `feat: add Jerry listening micro-motion`.

## Task 7: אינטגרציה, בדיקות ו־QA

**Files:**
- Modify: `tests/jerry-regression.test.mjs`
- Create/Modify: `tests/jerry-animation.test.mjs`

**Steps:**

1. לתקן את בדיקת הפונטים כך שתשקף את הדרישה האמיתית: `Assistant` לפני `Inter`.
2. להוסיף בדיקות סטטיות ל־manifest, state mapping, mouth anchors ו־crossfade duration.
3. להריץ:

```bash
npm test
npm run lint
npm run build
```

4. להפעיל את האפליקציה ולבדוק ידנית:
   - פתיחת session;
   - דיבור קצר בעברית;
   - דיבור רציף בעברית וב־Tech English;
   - תגובה קולית ארוכה וקצרה;
   - מעבר בין mic, text input ו־fallback;
   - reconnect;
   - mute ו־audio replay.

5. לוודא שאין audio overlap, pose תקועה, mouth misalignment או flicker.
6. לתעד ב־README או ב־release notes את מיפוי הפוזות ואת מגבלות האנימציה.
7. לבצע commit: `test: verify Jerry live animation flow`.

## Definition of Done

- ארבע התמונות החדשות מופיעות כפוזות מלאות באפליקציה.
- כל פוזה נטענת מראש ומתחלפת ללא קפיצת רקע.
- נקודת הפה מכוילת לכל פוזה.
- הדיבור משנה פה ופוזה לפי עוצמת האודיו.
- ההקשבה כוללת micro-motion ואינה קופאת.
- הווידאו אינו חלק מה־runtime או מה־build.
- `npm test`, `npm run lint` ו־`npm run build` עוברים.
- אין שינוי בזרימת השיחה החופשית או ב־Live/fallback APIs.
