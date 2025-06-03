import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = process.env.PORT || 3000;

// Initialize Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

let wss;

async function startServer() {
  await app.prepare();

  // Create HTTP server
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  // Create WebSocket server
  wss = new WebSocketServer({ 
    server,
    path: '/api/ws/transcriptions'
  });

  console.log('[Server] WebSocket server created on path: /api/ws/transcriptions');

  wss.on('connection', async (client, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    console.log(`[WebSocket] Client connected: ${clientIp}`);
    
    client.isAlive = true;
    client.send(JSON.stringify({ type: 'connected', message: 'WebSocket connection established' }));

    client.on('pong', () => {
      client.isAlive = true;
    });

    client.on('message', async (message) => {
      if (typeof message === 'string' || message instanceof Buffer) {
        const messageStr = message.toString();
        
        try {
          const msg = JSON.parse(messageStr);
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
              console.log(`[WebSocket] Minting ephemeral token for ${clientIp}...`);
              const { mintEphemeralToken } = await import('./lib/openai.js');
              const token = await mintEphemeralToken(model);
              console.log(`[WebSocket] Token minted successfully for ${clientIp}`);
              
              console.log(`[WebSocket] Opening upstream connection for ${clientIp}...`);
              const { openOpenAIRealtime } = await import('./lib/openai.js');
              const upstream = await openOpenAIRealtime(token);
              client.upstream = upstream;
              console.log(`[WebSocket] Upstream connection established for ${clientIp}`);

              upstream.on('open', () => {
                console.log(`[WebSocket] Upstream opened for ${clientIp}`);
                client.send(JSON.stringify({ ready: true }));
              });

              upstream.on('message', (data) => {
                try {
                  const openaiMessage = JSON.parse(data.toString());
                  console.log(`[WebSocket] OpenAI message for ${clientIp}:`, openaiMessage.type);
                  
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
                    client.send(data.toString());
                  }
                } catch (err) {
                  console.warn(`[WebSocket] Non-JSON from OpenAI for ${clientIp}:`, data.toString().substring(0, 100));
                  client.send(data.toString());
                }
              });

              upstream.on('close', (code) => {
                console.log(`[WebSocket] Upstream closed for ${clientIp}. Code: ${code}`);
                if (client.readyState === WebSocket.OPEN) {
                  client.close();
                }
                client.upstream = undefined;
              });

              upstream.on('error', (err) => {
                console.error(`[WebSocket] Upstream error for ${clientIp}:`, err);
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ error: "openai_connection_failed", detail: err.message }));
                  client.close();
                }
                client.upstream = undefined;
              });

            } catch (err) {
              console.error(`[WebSocket] Setup error for ${clientIp}:`, err);
              client.send(JSON.stringify({ error: "upstream_setup_failed", detail: err.message }));
            }
          }
        } catch (e) {
          // Not JSON, check if it's binary audio data
          if (message instanceof Buffer) {
            if (client.upstream && client.upstream.readyState === WebSocket.OPEN) {
              const base64Audio = message.toString('base64');
              const audioEvent = {
                type: "input_audio_buffer.append",
                audio: base64Audio
              };
              client.upstream.send(JSON.stringify(audioEvent));
            }
          } else {
            console.warn(`[WebSocket] Invalid message from ${clientIp}:`, messageStr.substring(0, 100));
          }
        }
      }
    });

    client.on('close', (code) => {
      console.log(`[WebSocket] Client ${clientIp} disconnected. Code: ${code}`);
      if (client.upstream && client.upstream.readyState === WebSocket.OPEN) {
        client.upstream.close();
      }
    });

    client.on('error', (err) => {
      console.error(`[WebSocket] Client error for ${clientIp}:`, err);
      if (client.upstream && client.upstream.readyState === WebSocket.OPEN) {
        client.upstream.close();
      }
    });
  });

  // Heartbeat
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        console.log('[WebSocket] Terminating dead connection');
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> WebSocket server listening on ws://${hostname}:${port}/api/ws/transcriptions`);
  });
}

startServer().catch((err) => {
  console.error('Error starting server:', err);
  process.exit(1);
}); 