# Jerry Dual-Channel Recording Implementation Plan

> **Implementation status (2026-09-27): COMPLETE + SPEAKER EXPORTS** — The leveled stereo master and independent speaker recordings are implemented. The application now exports a dedicated Jerry track, a dedicated guest track when microphone access is available, and `conversation.json` with relative turn timestamps.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** להקליט את שיחת ה־LIVE בקובץ סטריאו עם Jerry בערוץ שמאל, האורח בערוץ ימין, ו־automatic leveling ו־limiting נפרדים לכל מקור.

**Architecture:** נבנה recording graph נפרד מגרף הניטור: מקור האודיו של Jerry ומקור המיקרופון יעברו כל אחד דרך RMS-based auto-leveler ו־DynamicsCompressorNode, ואז יוזנו ל־ChannelMergerNode נפרד. ה־MediaStreamAudioDestinationNode יקבל את שני הערוצים, בעוד שהניטור לרמקולים יישאר במיקס מרכזי כדי לא להשמיע את Jerry רק באוזן אחת.

**Tech Stack:** React, TypeScript, Web Audio API, `MediaStreamAudioDestinationNode`, `ChannelMergerNode`, `DynamicsCompressorNode`, `MediaRecorder`, Node test runner.

---

## החלטות מחייבות

- הקובץ הסופי חייב להיות סטריאו אמיתי: Jerry = Left, אורח = Right.
- אין להסתמך על `autoGainControl` של הדפדפן כתחליף ל־leveling; הוא נשאר רק שכבת קלט אפשרית למיקרופון.
- לכל מקור יהיה leveler ו־compressor/limiter נפרד.
- ה־leveler לא יעלה רעש בשקט: יש noise gate / floor וגבול gain מקסימלי.
- הניטור לרמקולים יהיה centered ונפרד ממסלול ההקלטה.
- הקלטת Jerry בלבד במקרה שאין הרשאת מיקרופון תישאר אפשרית, אך תוצג כ־single-source recording ולא כ־dual-channel מלא.
- אין לשנות את Live conversation, STT או TTS מעבר לחיבורי האודיו הדרושים להקלטה.

## Task 1: הגדרת חוזה recording graph

**Files:**
- Create: `src/audio/recordingGraph.ts`
- Test: `tests/recording-regression.test.mjs`

**Steps:**

1. להגדיר טיפוסים ושמות קבועים לערוצים:

```ts
export const RECORDING_CHANNELS = {
  jerry: 0,
  guest: 1,
} as const;
```

2. להגדיר configuration יחיד ל־leveling:

```ts
export const RECORDING_LEVEL_CONFIG = {
  targetDbfs: -18,
  minGainDb: -6,
  maxGainDb: 12,
  gateDbfs: -55,
  attackMs: 20,
  releaseMs: 300,
} as const;
```

3. לכתוב בדיקות סטטיות שמוודאות שערוצי Jerry והאורח אינם מוחלפים ושה־config מוגבל.
4. להריץ `node --test tests/recording-regression.test.mjs` ולוודא שהבדיקה נכשלת לפני יצירת המימוש.
5. לבצע commit: `test: define dual-channel recording contract`.

## Task 2: יצירת מקורות recording נפרדים

**Files:**
- Modify: `src/JerryPodcastStudio.tsx:81-88`
- Modify: `src/audio/recordingGraph.ts`

**Steps:**

1. להוסיף refs לגרף ההקלטה: `guestSource`, `jerrySource`, `recordingMerger`, `recordingDestination`, ו־nodes לניקוי.
2. להפסיק להסתמך על חיבור ישיר של שני המקורות אל `mixedDestNodeRef.current`.
3. לחבר את פלט ה־Jerry הקיים לערוץ recording source ייעודי.
4. לחבר את אותו מיקרופון שנבחר להקלטה לערוץ guest source ייעודי.
5. לשמור על reuse של `liveMicStreamRef` כאשר הוא פעיל, בלי לפתוח stream כפול.
6. להוסיף cleanup שמנתק nodes וסוגר רק contexts שנוצרו עבור ההקלטה.
7. לבצע בדיקה סטטית שאין יותר שני מקורות שמתחברים ישירות לאותו destination לפני ה־merger.
8. לבצע commit: `refactor: separate Jerry and guest recording sources`.

## Task 3: מימוש RMS auto-leveler טהור

**Files:**
- Create: `src/audio/autoLeveler.ts`
- Test: `tests/recording-regression.test.mjs`

**Steps:**

1. לממש פונקציית dBFS/RMS על חלון samples:

```ts
export function rmsDbfs(samples: Float32Array): number;
```

2. לממש חישוב gain יעד עם clamp ל־`minGainDb`/`maxGainDb`.
3. להחזיר gain של `0dB` מתחת ל־`gateDbfs`, כדי לא להרים רעש רקע.
4. להוסיף attack/release smoothing כדי למנוע pumping.
5. לכתוב בדיקות עבור:
   - אות שקט;
   - אות חלש;
   - אות סביב היעד;
   - אות חזק;
   - שינוי gain שלא עובר את הגבולות.
6. להריץ את הבדיקות ולוודא PASS.
7. לבצע commit: `feat: add bounded RMS auto-leveling`.

## Task 4: בניית שרשרת leveler + compressor לכל מקור

**Files:**
- Modify: `src/audio/recordingGraph.ts`
- Modify: `src/JerryPodcastStudio.tsx`
- Test: `tests/recording-regression.test.mjs`

**Steps:**

1. ליצור לכל מקור `AnalyserNode` נפרד למדידת RMS.
2. ליצור `GainNode` נפרד ל־Jerry ול־guest.
3. להפעיל את `autoLeveler` ב־`requestAnimationFrame` או scheduler קיים, עם עדכון gain מוגבל ולא בכל sample.
4. להוסיף `DynamicsCompressorNode` לכל מקור עם makeup gain מינימלי.
5. להגדיר limiter סופי או compressor ratio גבוה לפני שלב ה־merge.
6. לוודא שה־leveler של ערוץ אחד אינו משנה את ה־gain של הערוץ השני.
7. להוסיף logging אבחוני של peak/RMS לכל מקור בזמן recording, ללא הצפת console.
8. להוסיף בדיקה סטטית לקיום שני chains נפרדים ול־compressor בכל chain.
9. לבצע commit: `feat: add independent recording leveling and limiting`.

## Task 5: יצירת סטריאו אמיתי עם ChannelMergerNode

**Files:**
- Modify: `src/audio/recordingGraph.ts`
- Modify: `src/JerryPodcastStudio.tsx`
- Test: `tests/recording-regression.test.mjs`

**Steps:**

1. ליצור `ChannelMergerNode` עם שני inputs.
2. לחבר את שרשרת Jerry ל־input `0` בלבד.
3. לחבר את שרשרת guest ל־input `1` בלבד.
4. לחבר את ה־merger ל־`MediaStreamAudioDestinationNode`.
5. לוודא שה־destination מכיל track אחד עם `channelCount` של 2 כאשר שני המקורות זמינים.
6. ליצור monitor mix נפרד שמחבר את שני המקורות למרכז, כדי שההאזנה לא תהיה left/right בלבד.
7. לעדכן את metadata של ההקלטה ואת `recordingNotice` לציון `Dual-channel` או `Jerry-only`.
8. להוסיף בדיקות סטטיות לסדר החיבורים `Jerry -> 0`, `Guest -> 1`.
9. לבצע commit: `feat: record Jerry and guest as stereo channels`.

## Task 6: חיבור בטוח ל־MediaRecorder

**Files:**
- Modify: `src/JerryPodcastStudio.tsx:1033-1216`
- Test: `tests/recording-regression.test.mjs`

**Steps:**

1. להחליף את `streamToRecord` כך שיקבל את stream של recording destination בלבד.
2. לשמור את בדיקת MIME הקיימת ולתעד את `actualMime`.
3. לפני `mediaRecorder.start()` לבדוק שיש source אחד או שניים, ולהציג הודעה נכונה למשתמש.
4. בעת עצירה, להמתין ל־`onstop` לפני ניתוק ה־mic source וה־recording graph.
5. לוודא ש־Blob ריק או stream ללא track פעיל מחזירים שגיאה ברורה.
6. לשמור את הקובץ הניתן להורדה עם metadata פנימי של מספר הערוצים כאשר הפורמט מאפשר זאת.
7. להוסיף בדיקה שה־MediaRecorder מקבל את ה־destination של ה־merger ולא stream raw של המיקרופון.
8. לבצע commit: `fix: finalize dual-channel MediaRecorder safely`.

## Task 7: בדיקת הקובץ הסופי בפועל

**Files:**
- Create/Modify: `tests/recording-regression.test.mjs`
- Modify: `README.md` או release notes רלוונטיים

**Steps:**

1. להפעיל את האפליקציה עם הרשאת מיקרופון.
2. להקליט לפחות 20 שניות שבהן Jerry והאורח מדברים לסירוגין.
3. להוריד את הקובץ ולבדוק אותו עם `ffprobe`:

```bash
ffprobe -v error -select_streams a:0 \
  -show_entries stream=channels,channel_layout,sample_rate,codec_name \
  -of default=noprint_wrappers=1 recording.webm
```

Expected: `channels=2`, עם channel layout סטריאו מתאים.

4. לטעון את הקובץ בעורך אודיו ולוודא ש־Jerry נמצא רק ב־Left והאורח רק ב־Right.
5. לבדוק שאין clipping, pumping חריג או העלאת רעש בזמן שתיקה.
6. לבדוק שה־monitor נשמע centered בזמן ההקלטה.
7. לבדוק fallback ללא הרשאת mic ולוודא שהמערכת מציינת Jerry-only.
8. להריץ:

```bash
npm test
npm run lint
npm run build
```

9. לעדכן את ה־README בתנאי השימוש ובמגבלת התמיכה של הדפדפנים.
10. לבצע commit: `test: verify dual-channel leveled recording`.

## Definition of Done

- הקלטת mic + Jerry נשמרת כסטריאו אמיתי בשני ערוצים.
- Jerry נמצא בערוץ שמאל והאורח בערוץ ימין.
- לכל מקור יש RMS auto-leveling עצמאי, compressor ו־limiter.
- אין clipping ואין gain קבוע יחיד שמופעל רק על המיקרופון.
- הניטור למשתמש נשאר centered ולא נשמע מפוצל לאוזניים.
- fallback ללא מיקרופון נשאר ברור ומתועד כ־Jerry-only.
- בדיקת הקובץ בפועל עם `ffprobe` והאזנה לערוצים בנפרד נשארה כשלב QA ידני בדפדפן/מכשיר.
- `npm test`, `npm run lint` ו־`npm run build` עוברים.

## Implemented speaker export contract

| Output | Content | Download name |
|---|---|---|
| Master | Jerry left / guest right stereo mix | `jerry-podcast-episode-*.webm` (or detected container) |
| Jerry track | Leveled Jerry-only mono track | `jerry-track.*` |
| Guest track | Leveled guest-only mono track, when mic is available | `guest-track.*` |
| Turn log | Conversation turns with relative timestamps | `conversation.json` |

The implementation is covered by the regression suite. A physical microphone recording and `ffprobe` channel inspection still require a browser/device QA pass.
