# Recording, transcription and voice detection

## How live listening works

Listening runs continuously. There is no Start/Stop: **Live** (⌘⌥L / Ctrl+Alt+L) pauses and resumes it, and the choice is remembered. When it was on, it resumes when Closed Cluely opens, after a chat switch and after an input reconnects. It never resumes by itself if starting would raise a permission prompt.

Two lanes are captured in one 16 kHz audio context:

| Lane | Hears | Default input |
| --- | --- | --- |
| **Speaker** ("Them") | What the laptop plays: the other side of the call | Mac: the first loopback input (BlackHole). Windows: system audio. Recorded without processing. |
| **Mic** ("Me") | You | The system default microphone, with noise suppression. Turn it off with **Also transcribe my microphone**. |

On a Mac with no loopback input, the microphone stands in for the speaker lane, as when the other person is in the room, and a notice explains how to add BlackHole.

### When an answer is given

1. Each lane runs its own voice detector. A segment ends after the **end-of-turn pause** (0.7 s) and is transcribed at once.
2. When a speaker segment ends, a timer runs for the rest of the **pause before answering** (1.2 s in total by default, 0.5–4 s). Transcription runs during the wait.
3. If the other side starts talking again, the timer is cancelled, so an answer never starts mid-thought.
4. When the timer fires, the answer waits until the speaker lane's last words are transcribed. Microphone lines still in progress join the next turn.
5. The answer is skipped for a bare acknowledgement ("okay", "yeah", "thanks"). Anything ending with a question mark is always answered.
6. While an answer is streaming, at most one further answer is queued. It covers everything said in between.
7. Only the speaker lane triggers answers. Your microphone is context.

This follows the same pattern as streaming meeting assistants: a provider- or VAD-side end-of-utterance signal, a configurable pause, a not-a-question check and a cooldown. Here everything runs locally with Silero VAD, so the first answer does not wait for a second model call.

### Transcription order and echo

Transcription runs one segment at a time, because local models share a recognizer. The speaker lane always goes first, so its end of turn is never stuck behind microphone audio. If transcription falls two minutes behind, queued microphone audio is skipped first.

With laptop speakers, the microphone also hears the other side. A microphone line whose words mostly repeat a speaker line from the previous 15 seconds is dropped. Headphones avoid the echo completely.

If a request fails, its audio stays in memory and listening continues. **Retry transcription** retries only the failed segments in their original order. **Respond** waits until they are recovered; automatic answers carry on with what was transcribed.

### What each answer sends, and caching

Each live answer adds one message to the chat: the lines said since the previous answer, labelled **Them** and **Me**, inside `<meeting_update>`. The conversation therefore grows append-only:

- The chat's notes and files come first and are marked for prompt caching.
- The previous turns follow unchanged.
- Only the new lines are new input.

Claude API requests mark two cache breakpoints, the context and the end of the conversation, so the next turn reads everything before its new lines from the cache. OpenAI and Gemini reuse matching prefixes automatically. A typed question still carries the latest 16,000 characters of the full transcript.

## Choosing the inputs

- **Speaker, Mac:** BlackHole or another loopback device. Route the call's sound to it with a Multi-Output Device: in **Audio MIDI Setup**, create one with your headphones *and* BlackHole 2ch, and select it as the meeting app's speaker. See [macOS setup](MACOS.md#meeting-audio-with-headphones).
- **Speaker, Windows:** system audio records everything you hear. Choose a device such as VB-CABLE to hear only one app.
- **Mic:** the system default microphone, or any other input. Echo cancellation is off, so it does not remove a voice on your speakers.

Inputs are remembered by name. Changing an input or the transcription model briefly pauses listening, saves, then resumes. Microphone permission covers every audio input; if you denied it, use **Open Microphone permission** in Recording settings.

## Context for each chat

Each **New chat** opens a box for notes (up to 40,000 characters) and up to 20 files. Supported types are PDF (selectable text, not scans), .pptx with speaker notes, .docx, .txt, .md, .csv, .json, .html and .rtf. **Skip for now** starts the chat without context; the 📄 button edits it later.

Up to 120,000 characters of context go with every question in that chat. The context and transcript are saved with the chat, so reopening a previous chat restores both. Text is extracted locally; the files themselves are never uploaded.

## Which voice detector, and why

The research question was the best current algorithm for detecting when a speaker starts and stops. The findings (November 2026):

- **Silero VAD v5/v6.** This is the most widely deployed open neural VAD. It is the default in voice-agent frameworks and handles noisy, real-world audio well. It reacts a few hundred milliseconds late at the end of speech, which is harmless here, because a meeting turn needs a longer pause than that anyway.
- **TEN VAD.**
  - **Vendor claim:** its authors report better precision than Silero and faster speech-to-silence transitions, at lower compute. Some users report better results.
  - **Dispute:** Silero's maintainer disputes this and found it weaker on real-life audio.
  - **Status:** no independent, latency-matched benchmark settles the question.
- **Semantic end-of-turn models,** such as Pipecat Smart Turn v3, TEN Turn Detection and Inworld SAVA. They decide whether a pause means the person has *finished*, not only whether they are silent. They help voice agents that must interrupt quickly. They are larger, mostly English-tuned and still evolving.

**What Closed Cluely does:** it uses Silero VAD by default to split each recording at pauses through sherpa-onnx. It segments with a start threshold and a lower stop threshold (hysteresis), a minimum detected speech length of 250 ms. The recording buffer also preserves short replies and original audio between detected boundaries, including the final partial frame. A turn ends after a configurable silence; 0.7 s is the default, and 0.6–0.9 s suits most meetings. Recording segments are bounded at about 25 seconds. Pauses normally provide earlier boundaries; the maximum prevents unbounded buffers.

- **Other detectors:** TEN VAD is one click away; it downloads on demand. A basic level detector needs no model.
- **Settings:** **Sensitivity** sets the speech probability needed to start a segment. **End-of-turn pause** sets how long a pause ends a turn.

Sensitivity and the end-of-turn pause are kept in saved preferences. Recording settings show the speaker and microphone inputs, the pause before answering, and the model and language controls.

Sources: [TEN VAD](https://huggingface.co/TEN-framework/ten-vad), [Silero maintainer's response](https://github.com/snakers4/silero-vad/discussions/692), [Pipecat discussion](https://github.com/pipecat-ai/pipecat/issues/2212), [Phoenix-VAD paper](https://arxiv.org/pdf/2509.20410), [Inworld SAVA](https://inworld.ai/blog/introducing-sava).

## Speech-to-text choices

All providers transcribe each finished speech segment, usually 2–15 seconds. Fast batch endpoints therefore give near-live transcripts.

| Provider | Models offered | Notes |
| --- | --- | --- |
| On this device | Parakeet TDT 0.6B v2 (English) / v3 (25 languages), Whisper turbo / small.en / base.en / tiny.en, Moonshine base / tiny | Free and offline. Downloads range from 108 to 636 MB. Parakeet v2 is the most accurate English option; Moonshine and Whisper tiny are the lightest. |
| OpenAI | gpt-transcribe, gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper-1 | Uses its own key or your saved OpenAI chat key. OpenAI lists the gpt-4o and whisper-1 models as deprecated from February 2027. |
| Groq | whisper-large-v3-turbo, whisper-large-v3 | Very fast and inexpensive hosted Whisper. |
| Deepgram | nova-3, nova-3-general, nova-2-meeting | Low latency. |
| ElevenLabs | scribe_v2, scribe_v3 | Strong accuracy in recent streaming benchmarks. |
| AssemblyAI | universal-3-pro, universal-3-5-pro (preview), universal-2 | Each segment is uploaded and the result is polled, so expect about 1–2 s more delay. |

Recent independent benchmarks put AssemblyAI Universal, ElevenLabs Scribe v2 and Deepgram Nova-3 near the top for accuracy and latency. Rankings depend on the test set, so try two on your own meetings. Cloud keys are checked with a non-billing request before they are saved. Sources: [Coval STT benchmark](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/), [Artificial Analysis AA-WER Streaming](https://artificialanalysis.ai/articles/new-streaming-speech-to-text-benchmark-aa-wer-streaming), [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text), [Groq speech-to-text](https://console.groq.com/docs/speech-to-text).

Explicit non-speech markers are filtered. Short spoken replies such as “Thank you” and “Okay” are preserved; duration alone is not enough to distinguish real speech from a hallucination.

For implementation details, benchmark results and the limits of accuracy validation, see [Latency](LATENCY.md).
