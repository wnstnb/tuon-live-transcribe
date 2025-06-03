import { WebSocketServer, WebSocket } from "ws";
import { NextRequest } from "next/server";
import { mintEphemeralToken, openOpenAIRealtime } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CustomWebSocket extends WebSocket {
  upstream?: WebSocket;
  isAlive?: boolean;
}

console.log('[WebSocket API] Initializing WebSocket server...');

// Global WebSocket server instance
let wss: WebSocketServer | null = null;
let httpServer: any = null;

// Initialize WebSocket server if not already created
if (!wss) {
  console.log('[WebSocket API] Creating new WebSocketServer instance.');
  
  // Create WebSocket server
  wss = new WebSocketServer({ 
    noServer: true,
    perMessageDeflate: false
  });

  wss.on('connection', async (client: CustomWebSocket, req: any) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    console.log(`[WebSocket] Client connected: ${clientIp}`);
    client.isAlive = true;

    // Send initial connection acknowledgment
    client.send(JSON.stringify({ type: 'connected', message: 'WebSocket connection established' }));

    client.on('pong', () => {
      client.isAlive = true;
    });

    client.on('message', async (message: Buffer | string) => {
      if (typeof message === 'string') {
        try {
          const msg = JSON.parse(message);
          console.log(`[WebSocket] Received JSON from ${clientIp}:`, msg);

          if (msg.action === 'start') {
            if (client.upstream && client.upstream.readyState === WebSocket.OPEN) {
              console.warn(`[WebSocket] Client ${clientIp} tried to start existing upstream connection.`);
              client.send(JSON.stringify({ error: "upstream_already_started" }));
              return;
            }

            const lang = msg.lang || 'en';
            const model = msg.model || process.env.MODEL_NAME || 'gpt-4o-transcribe';
            console.log(`[WebSocket] Starting transcription for ${clientIp}. Lang: ${lang}, Model: ${model}`);

            try {
              // Get ephemeral token from OpenAI
              console.log(`[WebSocket] Minting ephemeral token for ${clientIp}...`);
              const token = await mintEphemeralToken(model);
              console.log(`[WebSocket] Token minted successfully for ${clientIp}`);
              
              // Open connection to OpenAI
              console.log(`[WebSocket] Opening upstream connection for ${clientIp}...`);
              const upstream = await openOpenAIRealtime(token);
              client.upstream = upstream;
              console.log(`[WebSocket] Upstream connection established for ${clientIp}`);

              upstream.on('open', () => {
                console.log(`[WebSocket] Upstream opened for ${clientIp}`);
                client.send(JSON.stringify({ ready: true }));
              });

              upstream.on('message', (data: Buffer | string) => {
                try {
                  const openaiMessage = JSON.parse(data.toString());
                  console.log(`[WebSocket] OpenAI message for ${clientIp}:`, openaiMessage.type);
                  
                  // Transform OpenAI events to our format
                  if (openaiMessage.type === 'conversation.item.input_audio_transcription.delta') {
                    client.send(JSON.stringify({ 
                      type: 'partial', 
                      text: openaiMessage.delta,
                      item_id: openaiMessage.item_id 
                    }));
                  } else if (openaiMessage.type === 'conversation.item.input_audio_transcription.completed') {
                    client.send(JSON.stringify({ 
                      type: 'final', 
                      text: openaiMessage.transcript,
                      item_id: openaiMessage.item_id 
                    }));
                  } else if (openaiMessage.type === 'input_audio_buffer.committed') {
                    console.log(`[WebSocket] Audio committed for ${clientIp}, item: ${openaiMessage.item_id}`);
                  } else if (openaiMessage.type === 'error') {
                    console.error(`[WebSocket] OpenAI error for ${clientIp}:`, openaiMessage);
                    client.send(JSON.stringify({ 
                      error: 'openai_error', 
                      detail: openaiMessage.error?.message || 'Unknown error' 
                    }));
                  } else {
                    // Forward other events
                    client.send(data.toString());
                  }
                } catch (err) {
                  console.warn(`[WebSocket] Non-JSON from OpenAI for ${clientIp}:`, data.toString().substring(0, 100));
                  client.send(data.toString());
                }
              });

              upstream.on('close', (code, reason) => {
                console.log(`[WebSocket] Upstream closed for ${clientIp}. Code: ${code}`);
                if (client.readyState === WebSocket.OPEN) {
                  client.close();
                }
                client.upstream = undefined;
              });

              upstream.on('error', (err: Error) => {
                console.error(`[WebSocket] Upstream error for ${clientIp}:`, err);
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ error: "openai_connection_failed", detail: err.message }));
                  client.close();
                }
                client.upstream = undefined;
              });

            } catch (err: any) {
              console.error(`[WebSocket] Setup error for ${clientIp}:`, err);
              client.send(JSON.stringify({ error: "upstream_setup_failed", detail: err.message }));
            }
          }
        } catch (e) {
          console.warn(`[WebSocket] Invalid JSON from ${clientIp}:`, message.toString().substring(0, 100));
        }
      } else if (message instanceof Buffer) {
        // Forward binary audio data to OpenAI
        if (client.upstream && client.upstream.readyState === WebSocket.OPEN) {
          const base64Audio = message.toString('base64');
          const audioEvent = {
            type: "input_audio_buffer.append",
            audio: base64Audio
          };
          client.upstream.send(JSON.stringify(audioEvent));
        }
      }
    });

    client.on('close', (code, reason) => {
      console.log(`[WebSocket] Client ${clientIp} disconnected. Code: ${code}`);
      if (client.upstream && client.upstream.readyState === WebSocket.OPEN) {
        client.upstream.close();
      }
    });

    client.on('error', (err: Error) => {
      console.error(`[WebSocket] Client error for ${clientIp}:`, err);
      if (client.upstream && client.upstream.readyState === WebSocket.OPEN) {
        client.upstream.close();
      }
    });
  });

  // Heartbeat to keep connections alive
  const heartbeat = setInterval(() => {
    wss?.clients.forEach((ws) => {
      const client = ws as CustomWebSocket;
      if (client.isAlive === false) {
        console.log('[WebSocket] Terminating dead connection');
        return client.terminate();
      }
      client.isAlive = false;
      client.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeat);
    wss = null;
  });

  console.log('[WebSocket API] WebSocket server created');
}

export async function GET(req: NextRequest) {
  console.log(`[WebSocket API] GET request to WebSocket endpoint`);
  
  // For WebSocket upgrade, we need to handle it at the server level
  // This is a limitation of Next.js API routes - they don't directly support WebSocket upgrades
  // We need to set up the upgrade handler differently
  
  // Check if this is a WebSocket upgrade request
  const upgrade = req.headers.get('upgrade');
  if (upgrade?.toLowerCase() === 'websocket') {
    console.log('[WebSocket API] WebSocket upgrade requested');
    
    // Next.js doesn't directly support WebSocket upgrades in API routes
    // We need to return instructions for setting up WebSocket
    return new Response(JSON.stringify({
      error: 'websocket_upgrade_not_supported_in_nextjs_api_routes',
      message: 'WebSocket connections need to be handled at server level',
      suggestion: 'Use a custom server or different WebSocket setup'
    }), { 
      status: 426,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Regular HTTP response
  return new Response(JSON.stringify({
    message: 'WebSocket Transcription Endpoint',
    status: 'ready',
    instructions: 'Connect via WebSocket protocol for real-time transcription'
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
} 