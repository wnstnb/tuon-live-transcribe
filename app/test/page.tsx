"use client";

import React, { useState, useEffect, useRef } from 'react';

const TestPage: React.FC = () => {
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [wsReady, setWsReady] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const appendLog = (log: string) => {
    console.log(log);
    setLogs((prevLogs) => [...prevLogs, `${new Date().toLocaleTimeString()}: ${log}`]);
  };

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws/transcriptions`;
    appendLog(`Attempting to connect to WebSocket: ${wsUrl}`);
    const newWs = new WebSocket(wsUrl);

    newWs.onopen = () => {
      appendLog('WebSocket connection established.');
      setWsReady(true);
      setWs(newWs);
    };

    newWs.onmessage = (event) => {
      appendLog(`Received message: ${event.data}`);
      try {
        const parsedData = JSON.parse(event.data as string);
        if (parsedData.ready) {
          appendLog('Server upstream connection is ready.');
        } else if (parsedData.error) {
          appendLog(`Server error: ${parsedData.error} - ${parsedData.detail}`);
        } else if (parsedData.choices && parsedData.choices[0] && parsedData.choices[0].text) {
          appendLog(`Transcription: ${parsedData.choices[0].text}`);
        } else {
          appendLog(`Received JSON: ${JSON.stringify(parsedData)}`);
        }
      } catch (error) {
        // Not a JSON message, log raw
        appendLog(`Received raw data: ${event.data}`);
      }
    };

    newWs.onclose = (event) => {
      appendLog(`WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}`);
      setWsReady(false);
      setWs(null);
      if (isStreaming) { // If streaming was active, try to clean up
        stopMicrophone();
      }
    };

    newWs.onerror = (error) => {
      appendLog(`WebSocket error: ${error.toString()}`);
      console.error('WebSocket error:', error);
      setWsReady(false);
    };

    setWs(newWs); // Set ws instance early for cleanup

    return () => {
      if (newWs.readyState === WebSocket.OPEN || newWs.readyState === WebSocket.CONNECTING) {
        appendLog('Closing WebSocket connection due to component unmount.');
        newWs.close();
      }
      stopMicrophone(); // Ensure microphone is stopped on unmount
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array to run only on mount and unmount

  const floatTo16kPCM = (float32Buffer: Float32Array): ArrayBuffer => {
    // Assuming input is 48kHz, downsample to 16kHz
    const outputSampleRate = 16000;
    const inputSampleRate = audioContextRef.current?.sampleRate || 48000;
    const downsampleFactor = inputSampleRate / outputSampleRate;
    const outputLength = Math.floor(float32Buffer.length / downsampleFactor);
    const pcm16Buffer = new Int16Array(outputLength);
    let outputIndex = 0;
    for (let i = 0; i < float32Buffer.length; i += downsampleFactor) {
      const index = Math.floor(i);
      let sum = 0;
      let count = 0;
      // Basic averaging for downsampling
      for (let j = 0; j < downsampleFactor && index + j < float32Buffer.length; j++) {
        sum += float32Buffer[index + j];
        count++;
      }
      const sample = count > 0 ? sum / count : 0;
      pcm16Buffer[outputIndex++] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
    }
    return pcm16Buffer.buffer;
  };

  const startMicrophone = async () => {
    if (!ws || !wsReady) {
      appendLog('WebSocket not ready. Cannot start microphone.');
      return;
    }
    if (isStreaming) {
      appendLog('Microphone already streaming.');
      return;
    }

    appendLog('Requesting microphone permission...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 48000, channelCount: 1 } });
      mediaStreamRef.current = stream;
      appendLog('Microphone permission granted.');

      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      scriptProcessorNodeRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

      scriptProcessorNodeRef.current.onaudioprocess = (audioProcessingEvent) => {
        if (!isStreaming || !ws || ws.readyState !== WebSocket.OPEN) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const float32Data = inputBuffer.getChannelData(0); // Assuming mono
        const pcm16Data = floatTo16kPCM(float32Data);
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(pcm16Data);
        }
      };

      source.connect(scriptProcessorNodeRef.current);
      scriptProcessorNodeRef.current.connect(audioContextRef.current.destination); // Connect to destination to make it work on some browsers

      ws.send(JSON.stringify({ action: 'start', lang: 'en' }));
      appendLog('Sent start action to server. Streaming microphone input...');
      setIsStreaming(true);

    } catch (error) {
      appendLog(`Error starting microphone: ${error instanceof Error ? error.message : String(error)}`);
      console.error("Error starting microphone:", error);
    }
  };

  const stopMicrophone = () => {
    appendLog('Stopping microphone...');
    setIsStreaming(false); // Set streaming to false first to stop onaudioprocess sending data

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
      appendLog('Media stream tracks stopped.');
    }

    if (scriptProcessorNodeRef.current) {
      scriptProcessorNodeRef.current.disconnect();
      // scriptProcessorNodeRef.current.onaudioprocess = null; // Clear handler
      scriptProcessorNodeRef.current = null;
      appendLog('ScriptProcessorNode disconnected.');
    }

    if (audioContextRef.current) {
      if (audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().then(() => {
          appendLog('AudioContext closed.');
        }).catch(err => {
          appendLog(`Error closing AudioContext: ${err.message}`);
        });
      } else {
        appendLog('AudioContext already closed.');
      }
      audioContextRef.current = null;
    }
    // No need to send a "stop" message to the server in this design,
    // server closes upstream when client WebSocket closes or stops sending audio.
  };

  const handleToggleMic = () => {
    if (isStreaming) {
      stopMicrophone();
    } else {
      startMicrophone();
    }
  };

  const sendTextMessage = () => {
    if (ws && ws.readyState === WebSocket.OPEN && messageInput.trim()) {
      appendLog(`Sending text message: ${messageInput}`);
      ws.send(messageInput);
      setMessageInput('');
    } else {
      appendLog('Cannot send text message. WebSocket not open or message is empty.');
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>Real-time Audio Transcription Test</h1>
      
      <div>
        <button onClick={handleToggleMic} disabled={!wsReady} style={{ marginRight: '10px', padding: '10px' }}>
          {!wsReady ? 'Connecting...' : isStreaming ? 'Stop Mic' : 'Start Mic'}
        </button>
      </div>

      <div style={{ marginTop: '20px' }}>
        <input 
          type="text" 
          value={messageInput} 
          onChange={(e) => setMessageInput(e.target.value)}
          placeholder="Send a text message"
          style={{ marginRight: '5px', padding: '8px', width: '200px' }}
          onKeyPress={(e) => e.key === 'Enter' && sendTextMessage()}
        />
        <button onClick={sendTextMessage} disabled={!wsReady || !ws || ws.readyState !== WebSocket.OPEN} style={{ padding: '8px' }}>
          Send Text
        </button>
      </div>

      <div style={{ marginTop: '20px' }}>
        <h2>Logs & Transcriptions:</h2>
        <pre style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid #ccc', padding: '10px', background: '#f9f9f9' }}>
          {logs.join('\n')}
        </pre>
      </div>
    </div>
  );
};

export default TestPage;