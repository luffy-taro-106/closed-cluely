# Listening, transcription and voice detection

## Audio sources

| Source | Label | macOS | Windows |
| --- | --- | --- | --- |
| Meeting audio | **Them** | A loopback input. BlackHole 2ch is auto-detected; Loopback, Soundflower and aggregate devices also work. | **Windows system audio** (everything you hear), or a virtual cable such as VB-CABLE to isolate the meeting app. |
| Your voice | **Me** | Any microphone; the system default is used unless you pick one. | Same. |

**BlackHole on macOS.** BlackHole only *receives* the sound that is sent to it. Without a Multi-Output Device you would stop hearing the call, or Closed Cluely would hear nothing. To set one up:

1. Open **Audio MIDI Setup**, then choose **+** → **Create Multi-Output Device**.
2. Tick your headphones or speakers, and **BlackHole 2ch**.
3. Put the headphones or speakers first and turn on **Drift Correction** for BlackHole.
4. Pick the Multi-Output Device as the Mac's output, or only as the speaker in Zoom, Teams or Meet.

Use headphones when "Me" is on. Otherwise the microphone also picks up the other side, and their words appear twice.

Device choices are remembered by name, because the window's private session changes device IDs each launch. Microphone permission covers every audio input, BlackHole included. If you denied it, use **Open Microphone permission** in Listening settings.

## Listening modes

- **Manual.**
  1. Press **Start recording**. Audio is kept in memory, up to 30 minutes.
  2. Press **Stop**. The recording is split at pauses and transcribed piece by piece, then one answer is suggested if **Suggest an answer** is on.
- **Automatic.** Voice detection runs continuously.
  - Each speaker turn is transcribed when they pause for longer than the **End-of-turn pause**.
  - When the *other side* finishes a turn of at least four words, a response is suggested automatically. If an answer is already streaming, the newest turn is answered next.
  - **Respond** (⌘⌥Return / Ctrl+Alt+Enter) asks at any time.

Every question, typed or automatic, carries the meeting context and the latest transcript, up to about 16,000 characters of it.

## Which voice detector, and why

The research question was the best current algorithm for detecting when a speaker starts and stops. The findings (November 2026):

- **Silero VAD v5/v6.** This is the most widely deployed open neural VAD. It is the default in voice-agent frameworks and handles noisy, real-world audio well. It reacts a few hundred milliseconds late at the end of speech, which is harmless here, because a meeting turn needs a longer pause than that anyway.
- **TEN VAD.**
  - **Vendor claim:** its authors report better precision than Silero and faster speech-to-silence transitions, at lower compute. Some users report better results.
  - **Dispute:** Silero's maintainer disputes this and found it weaker on real-life audio.
  - **Status:** no independent, latency-matched benchmark settles the question.
- **Semantic end-of-turn models,** such as Pipecat Smart Turn v3, TEN Turn Detection and Inworld SAVA. They decide whether a pause means the person has *finished*, not only whether they are silent. They help voice agents that must interrupt quickly. They are larger, mostly English-tuned and still evolving.

**What Closed Cluely does:** it uses Silero VAD by default through sherpa-onnx. It segments with a start threshold and a lower stop threshold (hysteresis), a minimum speech length of 250 ms, and a pre-roll so the first syllable is kept. A turn ends after a configurable silence; 0.7 s is the default, and 0.6–0.9 s suits most meetings. Long monologues are cut every 20 s, so transcripts keep flowing without ending the turn.

- **Other detectors:** TEN VAD is one click away; it downloads on demand. A basic level detector needs no model.
- **Settings:** **Sensitivity** sets the speech probability needed to start a segment. **End-of-turn pause** sets how long a pause ends a turn.

**Not included yet:** a semantic turn model (Smart Turn v3) on top of VAD, to tell "thinking pause" from "finished". It is a reasonable next step if automatic answers fire mid-sentence for slow speakers. For now, raise the end-of-turn pause.

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

## Meeting context

Open the 📄 button.

- **Notes:** up to 40,000 characters.
- **Files:** up to 20. Supported types are PDF (selectable text, not scans), .pptx with speaker notes, .docx, .txt, .md, .csv, .json, .html and .rtf.
- **Limit:** up to 120,000 characters of context go with every question, followed by the transcript. The badge on the button counts your notes and files.
- **Extraction:** text is extracted locally; the files themselves are never uploaded.
