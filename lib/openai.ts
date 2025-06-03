import WebSocket from 'ws';

/**
 * Mints an ephemeral token for OpenAI's real-time transcription service.
 */
export async function mintEphemeralToken(model: string): Promise<string> {
  console.log(`[OpenAI Lib] Minting ephemeral token for model: ${model}`);
  
  try {
    // Use direct REST API call to create ephemeral token for transcription
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-transcribe',
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OpenAI Lib] Failed to mint token. Status: ${response.status}, Body: ${errorText}`);
      throw new Error(`Failed to mint token: ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log(`[OpenAI Lib] Successfully minted ephemeral token`);
    return data.client_secret.value;
  } catch (error: any) {
    console.error(`[OpenAI Lib] Failed to mint token:`, error);
    throw new Error(`Failed to mint token: ${error.message}`);
  }
}

/**
 * Opens a WebSocket connection to OpenAI's real-time transcription endpoint.
 */
export async function openOpenAIRealtime(token: string): Promise<WebSocket> {
  console.log(`[OpenAI Lib] Opening real-time WebSocket connection to OpenAI`);
  
  const serviceUrl = 'wss://api.openai.com/v1/realtime?intent=transcription';

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(serviceUrl, {
      headers: { 
        'Authorization': `Bearer ${token}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    ws.on('open', () => {
      console.log(`[OpenAI Lib] WebSocket connection opened to OpenAI Realtime API`);
      
      // Send initial transcription session configuration
      const config = {
        type: "transcription_session.update",
        input_audio_format: "pcm16",
        input_audio_transcription: {
          model: "gpt-4o-transcribe",
          language: "en"
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        input_audio_noise_reduction: {
          type: "near_field"
        }
      };
      
      ws.send(JSON.stringify(config));
      console.log(`[OpenAI Lib] Sent initial transcription configuration`);
      
      resolve(ws);
    });

    ws.on('error', (err) => {
      console.error(`[OpenAI Lib] WebSocket connection error to OpenAI:`, err);
      reject(err);
    });

    ws.on('close', (code, reason) => {
      console.log(`[OpenAI Lib] WebSocket connection to OpenAI closed. Code: ${code}, Reason: ${reason.toString()}`);
    });
  });
}

if (!process.env.OPENAI_API_KEY) {
  console.warn('[OpenAI Lib] OPENAI_API_KEY is not set in your environment. Configure it in your environment.');
} 