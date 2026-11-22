# Recording, transcription and voice detection

## How recording works

Closed Cluely records **one audio input**, only between **Start** and **Stop** (⌘⌥L / Ctrl+Alt+L):

1. Press **Start** when the other person begins talking. Audio is kept in memory, up to 30 minutes.
2. Press **Stop** when they finish. The recording is split at pauses and each piece is transcribed. The text is added to the chat's transcript.
3. If **Suggest an answer when I press Stop** is on, one reply is suggested for the whole recording. **Respond** (⌘⌥Return / Ctrl+Alt+Enter) asks again at any time.

Every question carries the chat's context and the latest transcript, up to about 16,000 characters of it.

## Choosing the input

- **System default microphone** (the default). It hears the other person in the room or through your speakers. Echo cancellation is off, so a voice played on your speakers is not removed; noise suppression is on.
- **BlackHole or another loopback device** (Mac). Choose it to capture a call's audio directly. Route the call's sound to it with a Multi-Output Device: in **Audio MIDI Setup**, create one with your headphones or speakers *and* BlackHole 2ch, and select it as the sound output. Loopback audio is recorded without any processing.
- **Windows system audio** records everything you hear.

Inputs are remembered by name. Microphone permission covers every audio input; if you denied it, use **Open Microphone permission** in Recording settings.

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

**What Closed Cluely does:** it uses Silero VAD by default to split each recording at pauses through sherpa-onnx. It segments with a start threshold and a lower stop threshold (hysteresis), a minimum speech length of 250 ms, and a pre-roll so the first syllable is kept. A turn ends after a configurable silence; 0.7 s is the default, and 0.6–0.9 s suits most meetings. Long monologues are cut every 20 s, so transcripts keep flowing without ending the turn.

- **Other detectors:** TEN VAD is one click away; it downloads on demand. A basic level detector needs no model.
- **Settings:** **Sensitivity** sets the speech probability needed to start a segment. **End-of-turn pause** sets how long a pause ends a turn.

Automatic, hands-free turn detection was removed from the interface in favour of Start and Stop, so these settings only affect how a recording is split before transcription.

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

Common Whisper "silence hallucinations", such as "Thank you." from a short noise, are dropped for segments under 2.5 s.
