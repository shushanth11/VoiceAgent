import asyncio
import time
from enum import Enum
from dotenv import load_dotenv

from livekit import rtc
from livekit.agents import (
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
)
from livekit.agents.vad import VADEventType
from livekit.plugins import openai, silero

load_dotenv()


class AgentState(Enum):
    LISTENING = "listening"
    USER_SPEAKING = "user_speaking"
    PROCESSING = "processing"
    AGENT_SPEAKING = "agent_speaking"


class VoiceAgent:

    SILENCE_TIMEOUT = 20.0
    REMINDER_MESSAGE = "I'm still here. Feel free to say something when you're ready."

    def __init__(self, ctx: JobContext):
        self.ctx = ctx
        self.room = ctx.room
        self.state = AgentState.LISTENING
        self.last_speech_time = time.time()
        self.silence_reminder_sent = False
        self.current_tts_task: asyncio.Task | None = None
        self.should_stop_speaking = False
        self.audio_source: rtc.AudioSource | None = None
        self.audio_track: rtc.LocalAudioTrack | None = None

    async def start(self):
        await self.ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
        self.audio_source = rtc.AudioSource(48000, 1)
        self.audio_track = rtc.LocalAudioTrack.create_audio_track(
            "agent-voice", self.audio_source
        )
        options = rtc.TrackPublishOptions()
        options.source = rtc.TrackSource.SOURCE_MICROPHONE
        await self.room.local_participant.publish_track(self.audio_track, options)
        self.vad = silero.VAD.load()
        self.stt = openai.STT()
        self.tts = openai.TTS(voice="alloy")
        self.room.on("track_subscribed", self._on_track_subscribed)
        self.room.on("participant_connected", self._on_participant_connected)
        asyncio.create_task(self._silence_monitor())
        await self._run_forever()

    async def _run_forever(self):
        while True:
            await asyncio.sleep(1)

    def _on_participant_connected(self, participant: rtc.RemoteParticipant):
        pass

    def _on_track_subscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            asyncio.create_task(self._process_audio_track(track, participant))

    async def _process_audio_track(
        self,
        track: rtc.Track,
        participant: rtc.RemoteParticipant
    ):
        audio_stream = rtc.AudioStream(track)
        vad_stream = self.vad.stream()
        vad_consumer_task = asyncio.create_task(
            self._consume_vad_events(vad_stream)
        )
        try:
            async for frame_event in audio_stream:
                audio_frame = frame_event.frame
                vad_stream.push_frame(audio_frame)
        finally:
            vad_stream.end_input()
            await vad_consumer_task

    async def _consume_vad_events(self, vad_stream):
        async for vad_event in vad_stream:
            if vad_event.type == VADEventType.START_OF_SPEECH:
                self.state = AgentState.USER_SPEAKING
                self.last_speech_time = time.time()
                self.silence_reminder_sent = False
                if self.current_tts_task and not self.current_tts_task.done():
                    self.should_stop_speaking = True
                    self.current_tts_task.cancel()
                    try:
                        await self.current_tts_task
                    except asyncio.CancelledError:
                        pass
                    self.should_stop_speaking = False

            elif vad_event.type == VADEventType.END_OF_SPEECH:
                self.last_speech_time = time.time()
                if vad_event.frames:
                    self.state = AgentState.PROCESSING
                    asyncio.create_task(
                        self._process_speech(vad_event.frames)
                    )
                else:
                    self.state = AgentState.LISTENING

    async def _process_speech(self, frames: list):
        if not frames:
            return

        try:
            result = await self.stt.recognize(frames)
            if result and result.alternatives and result.alternatives[0].text.strip():
                text = result.alternatives[0].text.strip()
                response = f"You said: {text}"

                self.current_tts_task = asyncio.create_task(
                    self._speak(response)
                )
            else:
                self.state = AgentState.LISTENING
        except Exception:
            self.state = AgentState.LISTENING

    async def _speak(self, text: str):
        if self.should_stop_speaking:
            return

        self.state = AgentState.AGENT_SPEAKING

        try:
            tts_stream = self.tts.synthesize(text)

            async for audio in tts_stream:
                if self.should_stop_speaking:
                    break

                await self.audio_source.capture_frame(audio.frame)

        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        finally:
            self.state = AgentState.LISTENING

    async def _silence_monitor(self):
        while True:
            await asyncio.sleep(1.0)

            if self.state == AgentState.LISTENING:
                elapsed = time.time() - self.last_speech_time

                if elapsed >= self.SILENCE_TIMEOUT and not self.silence_reminder_sent:
                    self.silence_reminder_sent = True
                    self.current_tts_task = asyncio.create_task(
                        self._speak(self.REMINDER_MESSAGE)
                    )


async def entrypoint(ctx: JobContext):
    agent = VoiceAgent(ctx)
    await agent.start()


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
