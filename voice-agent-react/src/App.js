import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
} from 'livekit-client';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const TOKEN_SERVER_URL = 'http://localhost:8080';

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [status, setStatus] = useState('idle');
  const [interimText, setInterimText] = useState('');
  const [messages, setMessages] = useState([]);
  const [logs, setLogs] = useState([]);
  const [audioLevels, setAudioLevels] = useState(new Array(20).fill(5));
  const [roomName, setRoomName] = useState('');
  const [participants, setParticipants] = useState([]);

  const roomRef = useRef(null);
  const recognitionRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const streamRef = useRef(null);
  const isConnectedRef = useRef(false);

  const addLog = useCallback((text, type = 'system') => {
    setLogs(prev => [...prev.slice(-50), { text, type, time: new Date().toLocaleTimeString() }]);
  }, []);

  const addMessage = useCallback((text, sender) => {
    setMessages(prev => [...prev.slice(-100), { text, sender, time: new Date().toLocaleTimeString() }]);
  }, []);

  const startVisualizer = useCallback(async (stream) => {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        analyser.getByteFrequencyData(dataArray);
        const bars = [];
        for (let i = 0; i < 20; i++) {
          const idx = Math.floor((i / 20) * dataArray.length);
          bars.push(Math.max(5, (dataArray[idx] / 255) * 60));
        }
        setAudioLevels(bars);
        animFrameRef.current = requestAnimationFrame(draw);
      };
      draw();
    } catch (err) {
      addLog('Audio visualizer error: ' + err.message, 'system');
    }
  }, [addLog]);

  const stopVisualizer = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    setAudioLevels(new Array(20).fill(5));
  }, []);

  const startRecognition = useCallback(() => {
    if (!SpeechRecognition) {
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setStatus('listening');
    };

    recognition.onresult = (event) => {
      let interim = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interim += transcript;
        }
      }

      if (interim) {
        setInterimText(interim);
      }

      if (finalTranscript.trim()) {
        setInterimText('');
        const userText = finalTranscript.trim();
        addMessage(userText, 'user');
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') return;
      if (event.error === 'aborted') return;
    };

    recognition.onend = () => {
      if (isConnectedRef.current) {
        try {
          recognition.start();
        } catch (e) {
        }
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [addMessage]);

  const stopRecognition = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
  }, []);

  const updateParticipants = useCallback((room) => {
    if (!room) return;
    const parts = [];
    if (room.localParticipant) {
      parts.push({
        identity: room.localParticipant.identity,
        name: room.localParticipant.name || room.localParticipant.identity,
        isLocal: true,
      });
    }
    room.remoteParticipants.forEach((p) => {
      parts.push({
        identity: p.identity,
        name: p.name || p.identity,
        isLocal: false,
      });
    });
    setParticipants(parts);
  }, []);

  const handleConnect = useCallback(async () => {
    setIsConnecting(true);
    setStatus('connecting');
    setMessages([]);
    setLogs([]);
    setInterimText('');

    try {
      const response = await fetch(`${TOKEN_SERVER_URL}/token`);
      if (!response.ok) {
        throw new Error(`Token server responded with ${response.status}`);
      }
      const data = await response.json();
      const { token, url, room: roomNameFromServer } = data;

      setRoomName(roomNameFromServer);

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });

      room.on(RoomEvent.Connected, () => {
        updateParticipants(room);
      });

      room.on(RoomEvent.ParticipantConnected, () => {
        updateParticipants(room);
      });

      room.on(RoomEvent.ParticipantDisconnected, () => {
        updateParticipants(room);
      });

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === Track.Kind.Audio) {
          const audioElement = track.attach();
          audioElement.id = `audio-${participant.identity}`;
          document.body.appendChild(audioElement);
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          track.detach().forEach((el) => el.remove());
        }
      });

      room.on(RoomEvent.Disconnected, () => {
        setIsConnected(false);
        isConnectedRef.current = false;
        setStatus('idle');
        setRoomName('');
        setParticipants([]);
        stopRecognition();
        stopVisualizer();
      });

      room.on(RoomEvent.ActiveSpeakersChanged, () => {});

      await room.connect(url, token);
      roomRef.current = room;

      const localAudioTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      await room.localParticipant.publishTrack(localAudioTrack);

      const mediaStream = new MediaStream([localAudioTrack.mediaStreamTrack]);
      streamRef.current = mediaStream;
      startVisualizer(mediaStream);

      setIsConnected(true);
      isConnectedRef.current = true;
      setIsConnecting(false);
      setStatus('listening');

      updateParticipants(room);
      startRecognition();

    } catch (err) {
      setIsConnecting(false);
      setStatus('idle');
    }
  }, [startVisualizer, stopVisualizer, startRecognition, stopRecognition, updateParticipants]);

  const handleDisconnect = useCallback(() => {
    if (roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    setIsConnected(false);
    isConnectedRef.current = false;
    setStatus('idle');
    setRoomName('');
    setParticipants([]);
    setInterimText('');

    stopRecognition();
    stopVisualizer();
  }, [stopRecognition, stopVisualizer]);

  useEffect(() => {
    return () => {
      isConnectedRef.current = false;
      if (recognitionRef.current) recognitionRef.current.abort();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const synth = window.speechSynthesis;
    const loadVoices = () => synth.getVoices();
    loadVoices();
    if (synth.onvoiceschanged !== undefined) {
      synth.onvoiceschanged = loadVoices;
    }
  }, []);

  const messagesEndRef = useRef(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, interimText]);

  const logsEndRef = useRef(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="app">
      <div className="container">
        <h1>🎙️ LiveKit Voice Agent</h1>
        <p className="subtitle">Connect to a LiveKit room and speak — your voice is published to the room</p>

        {roomName && (
          <div className="room-info">
            <strong>Room:</strong> {roomName} &nbsp;|&nbsp;
            <strong>Participants:</strong> {participants.map(p => (
              <span key={p.identity} className={`participant ${p.isLocal ? 'local' : 'remote'}`}>
                {p.name}{p.isLocal ? ' (you)' : ''}&nbsp;
              </span>
            ))}
          </div>
        )}

        <div className={`status ${status}`}>
          {status === 'idle' && 'Click Connect to join the LiveKit room'}
          {status === 'connecting' && 'Connecting to LiveKit room...'}
          {status === 'listening' && '🎤 Connected & Listening — speak now! Your audio is in the room.'}
          {status === 'speaking' && 'Agent is speaking...'}
        </div>

        <div className="visualizer">
          {audioLevels.map((h, i) => (
            <div
              key={i}
              className={`bar ${status === 'listening' ? 'active' : ''}`}
              style={{ height: `${h}px` }}
            />
          ))}
        </div>

        <div className="controls">
          {!isConnected ? (
            <button className="btn start" onClick={handleConnect} disabled={isConnecting}>
              {isConnecting ? 'Connecting...' : 'Connect to Room'}
            </button>
          ) : (
            <button className="btn stop" onClick={handleDisconnect}>
              Disconnect
            </button>
          )}
        </div>

        <div className="transcript">
          <div className="transcript-label">What You Said (Speech-to-Text)</div>
          {messages.length === 0 && !interimText && (
            <p className="empty-hint">Your speech will appear here as text...</p>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`msg ${msg.sender}`}>
              <span className="msg-sender">{msg.sender === 'user' ? 'You' : 'Agent'}</span>
              <span className="msg-text">{msg.text}</span>
            </div>
          ))}
          {interimText && (
            <div className="msg interim">
              <span className="msg-sender">You</span>
              <span className="msg-text typing">{interimText}</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="log">
          <div className="log-label">Activity Log</div>
          {logs.map((log, i) => (
            <div key={i} className={`log-entry ${log.type}`}>
              <span className="log-time">{log.time}</span> {log.text}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>

        <div className="instructions">
          <strong>How it works:</strong><br />
          1. Make sure the <b>token server</b> is running (<code>python token_server.py</code>)<br />
          2. Optionally start the <b>voice agent</b> (<code>python voice_agent.py start</code>) to get echo responses<br />
          3. Click <b>Connect to Room</b> — your microphone audio is published to the LiveKit room<br />
          4. Whatever you speak is shown as text here and heard by all participants in the room<br />
          5. If the voice agent is running, it will echo back what you said
        </div>
      </div>
    </div>
  );
}

export default App;
