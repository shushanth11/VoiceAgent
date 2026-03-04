# LiveKit Voice Agent - STT → Echo → TTS

A complete voice agent that listens to your speech, converts it to text, and echoes it back as speech.

## Features

- ✅ **Speech-to-Text (STT)**: Uses OpenAI Whisper to transcribe your speech
- ✅ **Text-to-Speech (TTS)**: Uses OpenAI TTS to speak the response
- ✅ **No Overlap**: Agent stops immediately when you interrupt
- ✅ **Silence Handling**: Plays a reminder after 20 seconds of silence

## How It Works

### No-Overlap Implementation

The agent uses energy-based Voice Activity Detection (VAD):

1. **Detection**: Monitors incoming audio energy levels
2. **Speech Start**: When energy exceeds threshold for 5+ frames → user is speaking
3. **Interruption**: If agent is speaking, it immediately stops (cancels TTS task)
4. **Speech End**: When energy drops below threshold for 30+ frames → process speech
5. **State Machine**: `IDLE → LISTENING → PROCESSING → SPEAKING → IDLE`

```
User speaks → Agent stops (if speaking) → Collects audio → STT → Generate response → TTS
```

### Silence Handling Implementation

A background coroutine monitors silence:

1. Tracks `last_speech_time` timestamp
2. Every second, checks if elapsed time ≥ 20 seconds
3. If true AND `silence_reminder_sent` is False:
   - Sends reminder via TTS
   - Sets `silence_reminder_sent = True`
4. When user speaks again, resets both flags

This ensures the reminder is sent **only once** per silence period.

## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure Environment

Your `.env` file should have:

```env
LIVEKIT_URL=wss://your-livekit-server.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
OPENAI_API_KEY=your-openai-key
```

### 3. Run the Agent

**Terminal 1** - Start the voice agent:
```bash

```


### 4. Connect

Open http://localhost:8080 in your browser and click "Connect".

Or use LiveKit's playground at https://agents-playground.livekit.io with your credentials.

## Files

| File | Description |
|------|-------------|
| `agent.py` | Main voice agent with STT/TTS and interruption handling |
| `token_server.py` | Simple HTTP server that generates access tokens |
| `index.html` | Web client with audio visualization |
| `requirements.txt` | Python dependencies |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        LiveKit Room                              │
│                    "voice-agent-room"                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────────┐                      ┌──────────────┐        │
│   │  Web Client  │ ◄──── Audio ────►    │ Voice Agent  │        │
│   │   (User)     │                      │   (Python)   │        │
│   └──────────────┘                      └──────────────┘        │
│         │                                      │                 │
│         │ Speaks                               │                 │
│         ▼                                      ▼                 │
│   ┌──────────────┐                      ┌──────────────┐        │
│   │  Microphone  │                      │     VAD      │        │
│   │    Audio     │ ─────────────────►   │  Detection   │        │
│   └──────────────┘                      └──────────────┘        │
│                                                │                 │
│                                                ▼                 │
│                                         ┌──────────────┐        │
│                                         │   OpenAI     │        │
│                                         │   Whisper    │        │
│                                         │    (STT)     │        │
│                                         └────────────���─┘        │
│                                                │                 │
│                                                ▼                 │
│                                         ┌──────────────┐        │
│                                         │  "You said:  │        │
│                                         │   <text>"    │        │
│                                         └──────────────┘        │
│                                                │                 │
│                                                ▼                 │
│   ┌──────────────┐                      ┌──────────────┐        │
│   │   Speaker    │ ◄────────────────    │   OpenAI     │        │
│   │   Output     │                      │    TTS       │        │
│   └──────────────┘                      └──────────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## State Machine

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
              ┌──────────┐                                │
              │   IDLE   │◄───────────────────────────────┤
              └──────────┘                                │
                    │                                     │
                    │ User starts speaking                │
                    ▼                                     │
              ┌──────────┐                                │
              │LISTENING │ ←─┐                            │
              └──────────┘   │                            │
                    │        │ Still speaking             │
                    │        │                            │
                    │ User stops speaking                 │
                    ▼                                     │
              ┌──────────┐                                │
              │PROCESSING│                                │
              │  (STT)   │                                │
              └──────────┘                                │
                    │                                     │
                    │ Text recognized                     │
                    ▼                                     │
              ┌──────────┐                                │
              │ SPEAKING │────────────────────────────────┘
              │  (TTS)   │        Finished or interrupted
              └──────────┘
```

## Configuration

You can adjust these constants in `agent.py`:

```python
SILENCE_TIMEOUT = 20.0      # Seconds before reminder
REMINDER_MESSAGE = "..."    # What to say after silence
ROOM_NAME = "voice-agent-room"  # LiveKit room name
```

## Troubleshooting

**No audio detected?**
- Adjust `speech_threshold` in `VoiceAgent.__init__()` (default: 500)
- Lower values = more sensitive, higher values = less sensitive

**Agent not responding?**
- Check your OpenAI API key is valid
- Ensure you have credits in your OpenAI account

**Connection issues?**
- Verify LiveKit credentials in `.env`
- Check if LiveKit server is accessible

# VoiceAgent
