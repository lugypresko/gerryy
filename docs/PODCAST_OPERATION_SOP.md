# Jerry Podcast — תהליך הפעלה (SOP)

מסמך זה הוא שער ההפעלה המחייב לפודקאסט עם שני דוברים: אורח בעברית/אנגלית,
וג׳רי כמנחה חי עם אנימציית pose-swap. אין להתחיל פרק אמיתי לפני שכל שערי ה־P0
עברו.

## 0. עקרונות שאינם ניתנים לעקיפה

- וידאו אינו חלק מ־runtime; הוא משמש רפרנס בלבד. האנימציה משתמשת בתמונות pose-swap.
- מקליטים שני מקורות עצמאיים: Jerry ו־Guest, ומפיקים מהם master סטריאו.
- שומרים raw לפני processing ו־processed אחרי processing. אין למחוק raw בעקבות כשל.
- תמלול interim הוא תצוגה בלבד; final או fallback מתועד הוא הטקסט שנשלח ל־Jerry.
- אין להציג קובץ להורדה לפני שה־publish gate אישר אותו.
- כשל ב־P0 עוצר את הפרק ומפעיל rollback/triage; לא ממשיכים על בסיס הנחה.

## 1. Preflight לפני שיחה

### תשתית

- [ ] `npm run dev` עולה ללא שגיאות.
- [ ] האפליקציה זמינה ב־`http://localhost:3000`.
- [ ] `.env` או `.api-key.json` מספקים `GEMINI_API_KEY` תקין.
- [ ] מאמתים שהמפתח נטען בפועל, בלי להדפיס אותו:

  ```powershell
  $line = Get-Content .env | Where-Object { $_ -match '^\s*GEMINI_API_KEY\s*=' } | Select-Object -First 1
  $value = ($line -split '=', 2)[1].Trim()
  if ($value.Length -lt 20 -or $value -match 'MY_GEMINI_API_KEY|placeholder|your.?key') { throw 'Invalid GEMINI_API_KEY' }
  Write-Output "GEMINI_API_KEY loaded (length=$($value.Length))"
  ```

- [ ] מאמתים שימוש בפועל מול Gemini דרך המוניטור: קיימים `stt-ready` ו־
  `jerry-live-ready`, ואין `stt-error` או `jerry-live-error`:

  ```powershell
  $m = Invoke-RestMethod http://localhost:3000/api/jerry-debug
  $m.ok -eq $true
  @($m.events | Where-Object event -eq 'stt-ready').Count -gt 0
  @($m.events | Where-Object event -eq 'jerry-live-ready').Count -gt 0
  @($m.events | Where-Object event -in @('stt-error','jerry-live-error')).Count -eq 0
  ```

- [ ] נגישים `GET /api/jerry-debug` ו־`/api/recordings`.
- [ ] אין תהליך ישן שמשרת build או קוד אחר על פורט 3000.

### מיקרופון

- [ ] נבחר התקן הקלט הנכון.
- [ ] הרשאת המיקרופון קיימת וה־track במצב `live`.
- [ ] בדיקת אוזניות עברה; הקול נקלט גם כשהרמקולים מושתקים.
- [ ] אין `input-silence`, `input-clipping` או peak קבוע ב־0 dBFS.

### Live/STT

- [ ] WebSocket נפתח.
- [ ] מופיעים `stt-ready`, `jerry-live-ready`, `socket-ready-sent`.
- [ ] נבחרו `he-IL` ו־`en-US`.
- [ ] אין שגיאת provider על `inputAudioTranscription`.

אם אחד מהסעיפים נכשל — לא מתחילים הקלטה.

## 2. בדיקת שיחה קצרה

מבצעים לפני כל פרק תור בדיקה קצר בעברית, תור עם מונח באנגלית, ותור interruption.

### תור אורח תקין

ב־`/api/jerry-debug` חייב להופיע, באותו `connectionId` ו־`turnId`:

1. `guest-turn-start`
2. `guest-turn-end` עם `audioBytes > 0`
3. `authoritative-start`
4. `authoritative-success` או `authoritative-fallback`
5. `guest-transcript-forwarded`
6. לפחות אירוע `jerry-audio` אחד
7. `jerry-turn-complete`

הטקסט חייב להישלח ל־Jerry כפי שנאמר, כולל שילוב עברית/אנגלית. אם אין final
מה־Live STT, המערכת רשאית להשתמש ב־interim האחרון; זה חייב להופיע כ־fallback.

### כשל תמלול

`stt-error`, `authoritative-timeout` או `turn-aborted-no-transcript` הם כשלי
שיחה. במקרה האחרון בודקים במיוחד `audioChunks`, `audioBytes`,
`hadLiveFinalCandidate` ו־`hadLiveInterimTranscript` לפני ניסיון נוסף.

### interruption

- [ ] דיבור האורח עוצר את Jerry.
- [ ] נרשמים `guest-interruption-start` ו־`guest-interruption-end`.
- [ ] נמדד `overlapDurationMs`.
- [ ] ההקלטה לא נעצרת בגלל interruption.

## 3. התחלת פרק והקלטה

- [ ] מתחילים recording רק אחרי שיחת הבדיקה.
- [ ] מופיע `recording-started` עם MIME ו־`tracks: 2` במצב dual-channel.
- [ ] Jerry מנותב לערוץ שמאל; Guest לערוץ ימין.
- [ ] נוצר turn log עם speaker, זמנים, טקסט ו־overlap.
- [ ] נשמרים chunks ב־outbox בלי כפילויות.
- [ ] בכל שנייה לכל היותר נשלח `recording-levels` אחד.

### שער איכות בזמן הקלטה

- Guest ו־Jerry חייבים להציג speech duration שאינו אפס.
- אין clipping.
- `balanceDeltaDb` עד 3dB הוא תקין.
- מעל 3dB ועד 6dB הוא `needs-review`.
- מעל 6dB, clipping, או Jerry ללא speech הם `failed`.

## 4. עצירה ועיבוד

1. לוחצים Stop וממתינים ל־`recording-capture-complete`.
2. מאמתים ש־raw master נשמר בגודל גדול מאפס.
3. מאמתים `recording-finalization-start`.
4. ממתינים ל־`recording-finalized`.
5. בודקים processing time, duration, warnings, balance ו־publication status.
6. מאמתים שקיימים raw, processed, stems ו־manifest להשוואת לפני/אחרי.

הורדה מותרת רק כאשר `publicationStatus = publishable`. עבור `needs-review`
נדרשת אישור מפורש. `failed` חסום להורדה.

## 5. בדיקת קובץ לפני פרסום

- [ ] הקובץ ניתן לפענוח בנגן חיצוני.
- [ ] duration אינו אפס.
- [ ] הוא Stereo בפועל.
- [ ] ערוץ שמאל מכיל את Jerry וערוץ ימין את Guest.
- [ ] שני הדוברים נשמעים בעוצמה דומה.
- [ ] אין clipping, dropout, echo או רעש חריג.
- [ ] master עבר limiter עם ceiling שמרני.
- [ ] התמלול/turn log תואמים לשיחה.
- [ ] הקובץ שהורד הוא processed ולא raw.

## 6. Rollback ו־triage

כאשר שער נכשל:

1. לא מוחקים raw, stems, manifest או debug evidence.
2. שומרים את `recordingId`, זמן הכשל והאירוע הראשון שנשבר.
3. מורידים רק artifacts שאושרו; לא מורידים master `failed`.
4. חוזרים ל־commit האחרון שבו `npm run release:gate` עבר.
5. לא משנים audio runtime תוך כדי triage לפני שיש evidence מהמוניטור.

פקודות release gate:

```powershell
npm test
npm run lint
npm run build
npm run test:e2e:podcast
```

או:

```powershell
npm run release:gate
```

## 7. בדיקת סיום אחראי

האחראי מסמן פרק כ־READY רק כאשר כל סעיפי P0 עברו, קיימים raw ו־processed,
ה־publish gate הוא `publishable`, והקובץ שנפתח מחוץ לדפדפן נשמע בסטריאו עם שני
הדוברים. בדיקות אוטומטיות לבדן אינן מחליפות בדיקת שמע אנושית.

## 8. מצב יישום נוכחי מול ה־SOP

המעבר מול הקוד והבדיקות בוצע ב־2026-09-27:

### מאומת ועובד

- [x] שרת מקומי, WebSocket, Live STT ו־Jerry Live.
- [x] `.env` נטען עם `GEMINI_API_KEY` שאינו placeholder, בלי לחשוף את ערך המפתח.
- [x] השרת הוכיח שימוש בפועל במפתח: נמצאו `stt-ready` ו־`jerry-live-ready` ללא
  `stt-error` או `jerry-live-error` בבדיקת המוניטור.
- [x] מסלול עברית/אנגלית והעברת transcript ל־Jerry.
- [x] fallback מ־Live final ל־interim האחרון כאשר final אינו מגיע.
- [x] debug monitor לאירועי socket, mic, PCM, STT, Jerry, animation והקלטה.
- [x] שני ערוצי master, balance metrics, limiter ו־publish gate.
- [x] שמירת raw ו־processed artifacts עם manifest מקומי.
- [x] חילוץ authoritative transcript גם כאשר Gemini מחזיר `audioTranscription`
  כחלק שאינו `text`.
- [x] `activity-end` מוגן מפני שליחה כפולה באותו turn.
- [x] `npm run lint`, `npm run build` ו־`npm test` עברו בבדיקת האימות האחרונה.

### P0 פתוח — אין לסמן READY מלא לפני סגירה

- [ ] לשמור server-side את ה־Jerry stem ואת ה־Guest stem. כרגע הם מוקלטים
  ונוצרים כ־Blob URLs בדפדפן, אך אינם נשלחים ל־`/api/recordings/artifact`.
- [ ] לחבר את מסך ההקלטה ל־archive API (`POST /api/recordings`) כך שה־master,
  stems, conversation וה־manifest יהיו רשומה ארכיונית אחת לאחר restart.
- [ ] להריץ smoke test ידני עם דיבור עברי אמיתי, אוזניות, interruption והורדת
  קובץ, ולשמור את מזהה ההקלטה ואת פלט המוניטור.
- [ ] לבצע בדיקת שמע אנושית לקובץ processed מחוץ לדפדפן ולאשר Stereo, balance
  וזהות הערוצים.
- [x] parsing של authoritative transcription תוקן ונבדק מול תגובת
  `audioTranscription` אמיתית.
- [x] שליחה כפולה של `activity-end` אינה מסיימת turn נוסף.

ה־SOP הוא מסמך ההפעלה; רשימת ה־P0 לעיל היא רשימת העבודה המחייבת עד שהמוצר
מוכן לפרק אמיתי לפרסום.

### תוצאת הרצת SOP אחרונה

ה־preflight וה־release gate עברו. בנוסף בוצעה בדיקת runtime עם PCM אמיתי דרך
ה־WebSocket: התקבל תמלול עברי, נרשמו `authoritative-success`,
`guest-transcript-forwarded`, `jerry-audio` ו־`jerry-turn-complete`, ולא נרשם
`turn-aborted-no-transcript` בתור הבדיקה.

עדיין אין אישור READY מלא עד לביצוע smoke test ידני של הקלטה, עיבוד, הורדה
והאזנה, ועד לשמירת ה־stems וה־archive server-side.

## מקורות טכניים

- [Release gate](./release-gate.md)
- [Jerry debug monitor](./JERRY_DEBUG_MONITOR.md)
- [Publishable bilingual podcast plan](./plans/2026-09-27-publishable-bilingual-podcast.md)

## 9. תקלה מתועדת: תמלול שגוי בגלל קלט מיקרופון חלש

### סימנים

- התמלול הזמני נשמע סביר, אך התמלול הסופי (`authoritative-success`) שונה או חסר משמעות.
- במוניטור מופיעים `pcm-level` עם RMS נמוך מאוד, בדרך כלל מתחת ל־`-60 dBFS`.
- מופיעים `input-silence` או `input-too-quiet`.
- `peak` נמוך מאוד, ללא clipping; כלומר הבעיה היא עוצמת קלט ולא עוצמה גבוהה מדי.

### מקרה שאובחן

בבדיקת runtime התקבל קלט Guest סביב `-84` עד `-93 dBFS`. ה־interim היה קרוב לדיבור שנאמר, אך ה־authoritative STT הפיק טקסט שגוי. המסקנה: אין לפרש מקרה כזה ככשל שפה או ככשל Gemini לפני שבודקים את עוצמת ה־PCM.

### תיקון חובה

- להפעיל `echoCancellation`, `noiseSuppression` ו־`autoGainControl` ב־`getUserMedia`.
- להשאיר את ה־leveling וה־compressor של Guest במסלול ההקלטה, כדי שהקלטה ו־STT יקבלו טיפול עקבי אך נפרד.
- לא לפרסם תמלול שנוצר כאשר כל תור הדיבור נמצא מתחת לרצפת הדיבור.
- המוניטור חייב לדווח `input-too-quiet` עם `maxRmsDbfs` ו־`speechFloorDbfs`.

### בדיקת אימות לאחר תיקון

1. לרענן את האפליקציה ולוודא `stt-ready`, `jerry-live-ready` ו־`socket-ready-sent`.
2. לדבר משפט קצר בעברית עם מונח באנגלית ולסיים את התור.
3. לבדוק ב־`/api/jerry-debug` את אותו `connectionId` ו־`turnId`:
   - `pcm-level` חייב להציג RMS מעל `-60 dBFS` בזמן דיבור.
   - לא יופיע `input-too-quiet`.
   - `authoritative-success` חייב להופיע אחרי `guest-turn-end`.
   - `guest-transcript-forwarded` חייב להכיל את המשפט שנאמר.
   - אחריו חייבים להופיע `jerry-audio` ו־`jerry-turn-complete`.
4. לחזור על הבדיקה עם אוזניות מחוברות.
5. אם RMS נשאר מתחת לסף: לעצור, לבדוק התקן קלט והרשאת מיקרופון, ולא להמשיך לפרק אמיתי.

### בדיקות אוטומטיות

- `npm test`
- `npm run lint`
- `npm run build`
- `npm run test:e2e:podcast`

ה־SOP אינו מסמן את התמלול כתקין רק משום שהשרת החזיר `authoritative-success`; יש לאמת גם את עוצמת ה־PCM ואת התאמת הטקסט לדיבור בפועל.
