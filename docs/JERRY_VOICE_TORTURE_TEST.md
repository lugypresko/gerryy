# Jerry Voice Torture Test — v1

Purpose: evaluate **voice performance only**. Do not score conversation quality or animation.

## Why this test exists

Jerry already uses Gemini 3.8 Live native audio. The test isolates whether one stable Jerry voice can move naturally through different conversational states without sounding like eight different characters or a TTS reader.

## Run protocol

Use the normal Live Jerry path and keep the current voice (Charon). Record one continuous 60–90 second exchange. The guest should naturally create these moments; do not ask Jerry to announce an emotion or read stage directions.

| Beat | Guest stimulus | What we listen for |
|---|---|---|
| 1 Neutral | "ג'רי, בוקר טוב. איך אתה היום?" | relaxed conversational baseline; no announcer voice |
| 2 Amused | "אתמול מישהו אמר לי שעם AI כבר לא צריך מנהלי פיתוח." | genuine amusement; a small smile/chuckle is enough |
| 3 Skeptical | "הוא גם אמר שהצוות שלו autonomous לגמרי. הוא רק מאשר כל deploy." | disbelief in timing/prosody, not louder acting |
| 4 Chuckle | "אבל הם קוראים לזה self-service." | short organic chuckle; no forced laugh |
| 5 Sigh | "וכל production incident עדיין מגיע אליו בשלוש בלילה." | light sigh/resignation only if it fits |
| 6 Hesitation | "אז אולי בעצם הוא המערכת." | brief processing beat / hesitation before the thought |
| 7 Serious | "והוא כבר אומר שהוא שחוק." | clean transition to lower-energy seriousness |
| 8 Quiet punchline | "אבל לפחות ה-dashboard ירוק." | restrained dry landing; no theatrical whisper |

## Pass criteria

A run passes only if:

- Jerry remains recognizably the same speaker across all beats.
- At least 4 of the 8 beats have clearly different delivery without changing character identity.
- Non-verbal vocalizations are sparse and context-appropriate; no repeated chuckle/sigh habit.
- Pauses feel like thought or reaction, not network latency.
- Seriousness can follow humor without a hard synthetic reset.
- Jerry never reads stage directions or names an emotion.
- The guest can interrupt Jerry and Jerry yields immediately.
- Hebrew remains natural; English tech terms remain unforced.

## Failure labels

Tag each bad moment with exactly one primary label:

- FLAT — same cadence/energy regardless of content.
- OVERACTED — performance calls attention to itself.
- FAKE_LAUGH — laughter/chuckle sounds inserted rather than caused.
- PAUSE_LATENCY — silence feels like the system stalled.
- VOICE_DRIFT — Jerry sounds like a different person.
- TAG_LEAK — a direction/tag is spoken.
- HARD_RESET — emotional transition sounds like a new clip.
- HEBREW_PROSODY — stress/rhythm sounds unnatural in Hebrew.

## A/B method

A = current main baseline recording.
B = candidate voice-performance change.

Use the **same eight guest stimuli** for A and B. Prefer B only when it improves at least two failure labels without making another materially worse.

Do not change animation, conversation policy, or voice identity during this experiment.

## Technical notes

Gemini 3.8 Live is native audio. Keep the Live path for this test rather than replacing it with turn-by-turn TTS. The separate TTS path can be used later as a controlled comparison because Gemini TTS supports explicit turn-level style metadata and inline point-in-time vocal tags.
