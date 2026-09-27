# Real-Time Voice Processing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** לשפר את קול האורח בזמן אמת כך שיהיה יציב, ברור וחלק בדומה לשיחות Google Meet/Zoom, בלי להעלות רעש או לגרום ל־clipping.

**Architecture:** נרחיב את שרשרת האודיו של האורח בלבד ב־Web Audio API: בחירת התקן → High-Pass → noise gate/suppression → EQ עדין → compressor → limiter עם ceiling. ה־recording graph ימשיך לספק master stereo ו־guest track נפרדים, והניטור יישאר centered. נשתמש ב־RMS/VAD לצורכי בקרה, אך לא ננסה להחליף suppression איכותי ב־gain בלבד.

**Tech Stack:** React, TypeScript, Web Audio API, `MediaStreamAudioSourceNode`, `BiquadFilterNode`, `DynamicsCompressorNode`, `AnalyserNode`, `MediaRecorder`, Node test runner.

---

## החלטות ומגבלות

- הבעיה שנמדדה בהקלטה האחרונה אינה בעיקר עוצמה: בזמן דיבור ההפרש היה כ־1.2dB, אך ערוץ האורח כולל שקט/אות חלש לאורך זמן.
- אין להחיל gain קבוע על הערוץ; הוא יגביר גם רעש וחדר.
- עיבוד הדיבור יישאר נפרד לערוץ האורח כדי לא לשנות את קולו של Jerry.
- Echo cancellation ו־noise suppression של הדפדפן נשארים פעילים כקו ראשון, אך מקבלים שכבת DSP מקומית.
- ה־limiter חייב להשאיר headroom של לפחות 1dB מתחת ל־0dBFS.
- נרמול LUFS מלא הוא שלב post-recording אופציונלי; אין לבצע אותו על בסיס חלון קצר בזמן אמת.

## Task 1: תיעוד baseline ואבחון התקן

**Files:**
- Modify: `docs/IMPLEMENTATION_STATUS.md`
- Test: `tests/recording-regression.test.mjs`

**Steps:**

1. לתעד את מטריקות ה־baseline: sample rate, channels, RMS/peak לכל ערוץ, וזמן silence בערוץ האורח.
2. להוסיף בדיקה סטטית שקיימת בחירת `audioInputDeviceId` ושה־track נבדק לפי `readyState`, `enabled` ו־`muted`.
3. להוסיף לוג אבחוני מוגבל פעם בשנייה עם RMS/peak ו־device label, בלי להדפיס את נתוני האודיו עצמם.
4. להריץ `npm test` ולוודא שהבדיקה החדשה נכשלת לפני הוספת שרשרת ה־DSP.
5. לבצע commit: `test: define guest voice processing baseline`.

## Task 2: חוזה DSP טהור

**Files:**
- Create: `src/audio/voiceProcessing.ts`
- Test: `tests/recording-regression.test.mjs`

**Steps:**

1. להגדיר constants עבור `highPassHz`, `presenceFrequencyHz`, `presenceGainDb`, `compressorThresholdDb`, `compressorRatio`, `limiterCeilingDb` ו־`gateDbfs`.
2. לממש פונקציות טהורות לחישוב gate/VAD ו־makeup gain מוגבל.
3. להגדיר חוזה שמצב silence אינו מעלה gain, ומצב speech אינו חורג מה־ceiling.
4. לכתוב בדיקות עבור silence, speech חלש, speech חזק ו־clipping.
5. להריץ `node --test tests/recording-regression.test.mjs` ולוודא FAIL לפני המימוש.
6. לממש את הפונקציות המינימליות.
7. להריץ שוב ולוודא PASS.
8. לבצע commit: `feat: add pure guest voice processing contract`.

## Task 3: High-Pass ו־EQ לדיבור

**Files:**
- Modify: `src/audio/recordingGraph.ts`
- Test: `tests/recording-regression.test.mjs`

**Steps:**

1. להוסיף לשרשרת guest `BiquadFilterNode` מסוג `highpass` סביב 70–90Hz.
2. להוסיף EQ presence עדין באזור 2–4kHz עם gain מוגבל.
3. לא להוסיף EQ לשרשרת Jerry.
4. לחבר את ה־analyser אחרי ה־EQ כדי למדוד את אות הדיבור המעובד.
5. להוסיף בדיקה סטטית לסדר החיבורים ולערכים המוגבלים.
6. להריץ `npm test` ו־`npm run lint`.
7. לבצע commit: `feat: add guest speech filtering and presence eq`.

## Task 4: Noise gate ו־VAD

**Files:**
- Modify: `src/audio/recordingGraph.ts`
- Modify: `src/audio/autoLeveler.ts`
- Test: `tests/recording-regression.test.mjs`

**Steps:**

1. להגדיר gate עם threshold, attack, hold ו־release נפרדים מ־auto-leveling.
2. להוסיף hold קצר כדי למנוע חיתוך הברות.
3. להבטיח שבשקט ה־leveler לא מרים את הרצפה, ובדיבור חלש ה־gate לא חותך את תחילת המילה.
4. להוסיף בדיקות transition עבור speech → silence → speech.
5. להריץ את בדיקות ה־audio ואת `npm run lint`.
6. לבצע commit: `feat: add speech-aware guest noise gate`.

## Task 5: Compressor ו־limiter עם headroom

**Files:**
- Modify: `src/audio/recordingGraph.ts`
- Test: `tests/recording-regression.test.mjs`

**Steps:**

1. להגדיר compressor קולי מתון סביב ‎-18dB, יחס 3:1–4:1, attack קצר ו־release מוזיקלי.
2. להוסיף makeup gain מוגבל לאחר ה־compressor.
3. להוסיף limiter סופי עם ceiling של ‎-1dB לפני כל destination.
4. לוודא שה־master, ה־guest track וה־monitor מקבלים את אותה שרשרת guest המעובדת.
5. להוסיף בדיקה שה־ceiling אינו מאפשר peak מעל ‎-1dBFS במודל האות הטהור.
6. להריץ `npm test`, `npm run lint` ו־`npm run build`.
7. לבצע commit: `feat: add guest compressor and true-peak headroom`.

## Task 6: שיפור input constraints ו־feedback למשתמש

**Files:**
- Modify: `src/JerryPodcastStudio.tsx`
- Test: `tests/recording-regression.test.mjs`

**Steps:**

1. להגדיר constraints עקביים ל־Live mic ולהקלטת הפרק: `echoCancellation`, `noiseSuppression`, `autoGainControl` ו־selected `deviceId`.
2. להציג את שם התקן הקלט הנבחר ואת מצב ה־track לפני recording.
3. להציג אזהרה אם track הוא muted, אינו live, או שרמת האות נשארת מתחת לסף במשך מספר שניות.
4. לאפשר refresh של התקנים לאחר חיבור אוזניות.
5. להוסיף בדיקות סטטיות ל־device selection ול־track diagnostics.
6. להריץ `npm test` ו־`npm run lint`.
7. לבצע commit: `feat: expose guest input health diagnostics`.

## Task 7: calibration ו־QA ידני

**Files:**
- Modify: `docs/IMPLEMENTATION_STATUS.md`
- Modify: `docs/plans/2026-09-27-jerry-dual-channel-recording.md`

**Steps:**

1. להקליט שלושה תרחישים: מיקרופון laptop, מיקרופון אוזניות, וחדר עם רעש רקע.
2. בכל תרחיש לדבר משפטים קצרים, ארוכים, חלשים וחזקים.
3. לבדוק שה־guest נשמע ברור, ללא pumping, clipping או חיתוך תחילת מילים.
4. לבדוק שה־master נשאר stereo ושקבצי Jerry/guest הנפרדים תואמים.
5. לבדוק `ffprobe` לערוצים ול־sample rate.
6. לבדוק שהניטור centered ושאין echo עם ובלי אוזניות.
7. לכייל את הקבועים רק לאחר השוואת שלושת התרחישים.
8. להריץ:

```bash
npm test
npm run lint
npm run build
```

9. לתעד את הערכים הסופיים ואת מגבלות הדפדפן במסמך הסטטוס.
10. לבצע commit: `test: verify real-time guest voice processing`.

## Definition of Done

- בזמן דיבור, ההפרש בין הערוצים אינו עולה על כ־2dB בתרחיש בדיקה רגיל.
- רעש רקע ושקט אינם מוגברים בצורה מורגשת.
- אין clipping, וה־limiter משאיר ceiling של ‎-1dB לפחות.
- אין חיתוך תחילת מילים או pumping חריג.
- בחירת מיקרופון ואוזניות נשמרת ומוצגת למשתמש.
- master stereo, guest track ו־conversation log ממשיכים לעבוד.
- `npm test`, `npm run lint` ו־`npm run build` עוברים.
- QA ידני מתועד בשלושת תרחישי הקלט.
