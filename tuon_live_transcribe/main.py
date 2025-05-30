from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState
from fastapi.staticfiles import StaticFiles
from .config import settings
import uvicorn
import logging # Added for logging
import uuid # For generating session IDs
import json # For parsing JSON messages
import httpx # For making HTTP requests
from openai import OpenAI # OpenAI client
import asyncio # For concurrent tasks
import base64 # For encoding audio data
import websockets # For OpenAI WebSocket client
from websockets.client import WebSocketClientProtocol # Updated import
from websockets.exceptions import InvalidStatus # Updated import

# Configure logging
logging.basicConfig(level=settings.LOG_LEVEL.upper()) # Ensure log level is uppercase
logger = logging.getLogger(__name__) # Get a logger instance

app = FastAPI()

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# OpenAI Client Setup
# Ensure OPENAI_API_KEY is loaded via settings
if not settings.OPENAI_API_KEY:
    logger.critical("OPENAI_API_KEY not found in environment settings. Service cannot start.")
    # Potentially raise an exception or exit if running in a context where that's appropriate
    # For now, we'll log critically and let it fail if used.

client = OpenAI(api_key=settings.OPENAI_API_KEY)

async def mint_openai_ephemeral_token():
    logger.info("Attempting to mint OpenAI ephemeral token.")
    try:
        async with httpx.AsyncClient() as http_client:
            response = await http_client.post(
                "https://api.openai.com/v1/realtime/sessions",
                headers={
                    "Authorization": f"Bearer {settings.OPENAI_API_KEY}"
                },
                json={"model": settings.MODEL_NAME, "voice": "echo"} # voice might not be needed
            )
            response.raise_for_status() # Raise an exception for HTTP errors (4xx or 5xx)
            token_data = response.json()
            ephemeral_key = token_data.get("client_secret")
            if ephemeral_key:
                logger.info("Successfully minted OpenAI ephemeral token.")
                return ephemeral_key
            else:
                logger.error(f"Failed to mint OpenAI ephemeral token. 'client_secret' not in response: {token_data}")
                return None
    except httpx.HTTPStatusError as e:
        logger.error(f"HTTP error while minting OpenAI ephemeral token: {e.response.status_code} - {e.response.text}")
        return None
    except Exception as e:
        logger.error(f"Unexpected error minting OpenAI ephemeral token: {e}")
        return None

@app.get("/")
async def health_check():
    logger.info("Health check endpoint called") # Add logging
    return {"status": "ok", "model_name": settings.MODEL_NAME}

async def connect_to_openai_realtime_api(ephemeral_key: str, client_ws: WebSocket, session_id: str, language: str):
    openai_ws_url = "wss://api.openai.com/v1/realtime?intent=transcription"
    # websockets >= 12.0 expects extra_headers as a list/tuple of (header, value)
    headers = [
        ("Authorization", f"Bearer {ephemeral_key}"),
        ("OpenAI-Beta", "realtime=v1"),
    ]
    logger.info(f"[{session_id}] Attempting to connect to OpenAI Realtime API: {openai_ws_url}")

    try:
        async with websockets.connect(openai_ws_url, extra_headers=headers) as openai_ws:
            logger.info(f"[{session_id}] Successfully connected to OpenAI Realtime API.")

            # Send initial configuration to OpenAI
            initial_config = {
                "type": "transcription_session.update",
                "input_audio_format": "pcm16",
                "input_audio_transcription": {
                    "model": settings.MODEL_NAME,
                    "language": language
                },
                "turn_detection": {"type": "server_vad"}
            }
            await openai_ws.send(json.dumps(initial_config))
            logger.info(f"[{session_id}] Sent initial config to OpenAI: {initial_config}")

            # Create tasks for bidirectional streaming
            client_to_openai_task = asyncio.create_task(
                forward_audio_to_openai(client_ws, openai_ws, session_id)
            )
            openai_to_client_task = asyncio.create_task(
                forward_transcripts_to_client(openai_ws, client_ws, session_id)
            )

            # Wait for either task to complete (e.g., due to error or disconnection)
            done, pending = await asyncio.wait(
                [client_to_openai_task, openai_to_client_task],
                return_when=asyncio.FIRST_COMPLETED,
            )

            for task in pending:
                task.cancel()
            
            for task in done: # Log exceptions if any task failed
                exc = task.exception()
                if exc:
                    logger.error(f"[{session_id}] Task failed with exception: {exc}")

            logger.info(f"[{session_id}] OpenAI streaming session finished.")

    except InvalidStatus as e:
        logger.error(f"[{session_id}] OpenAI WebSocket connection failed with status code {e.status_code}: {e.headers.get('www-authenticate', '')} - {await e.response.text() if hasattr(e, 'response') and hasattr(e.response, 'text') else 'No further details'}")
        if client_ws.client_state == WebSocketState.CONNECTED:
            await client_ws.send_json({"error": "Failed to connect to transcription service (auth or config issue)."})
    except websockets.exceptions.ConnectionClosed as e:
        logger.error(f"[{session_id}] OpenAI WebSocket connection closed unexpectedly: Code {e.code}, Reason: {e.reason}")
        if client_ws.client_state == WebSocketState.CONNECTED:
            await client_ws.send_json({"error": f"Transcription service connection closed: {e.reason}"})
    except Exception as e:
        logger.error(f"[{session_id}] Error in OpenAI WebSocket connection: {e}")
        if client_ws.client_state == WebSocketState.CONNECTED:
            await client_ws.send_json({"error": "An unexpected error occurred with the transcription service."})
    finally:
        if client_ws.client_state == WebSocketState.CONNECTED:
            logger.info(f"[{session_id}] Ensuring client WebSocket is closed after OpenAI session.")


async def forward_audio_to_openai(client_ws: WebSocket, openai_ws: WebSocketClientProtocol, session_id: str):
    logger.info(f"[{session_id}] Starting to forward audio from client to OpenAI.")
    try:
        while True:
            audio_chunk = await client_ws.receive_bytes()
            if not audio_chunk: # Handle empty messages if necessary, though receive_bytes should block
                logger.info(f"[{session_id}] Received empty audio chunk. Continuing.")
                continue

            logger.debug(f"[{session_id}] Received {len(audio_chunk)} bytes from client. Forwarding to OpenAI.")
            
            # Base64 encode the audio chunk for the JSON payload
            # Note: OpenAI docs need to be checked if base64 is *always* required for 'input_audio_buffer.append'
            # or if raw binary is an option for some formats/transports.
            # The PRD mentions "Base64EncodedAudioData"
            encoded_audio = base64.b64encode(audio_chunk).decode('utf-8')
            
            payload = {
                "type": "input_audio_buffer.append",
                "audio": encoded_audio
            }
            await openai_ws.send(json.dumps(payload))
            logger.debug(f"[{session_id}] Sent {len(audio_chunk)} (encoded) bytes to OpenAI.")

    except WebSocketDisconnect:
        logger.info(f"[{session_id}] Client WebSocket disconnected. Stopping audio forwarding.")
    except websockets.exceptions.ConnectionClosed:
        logger.info(f"[{session_id}] OpenAI WebSocket connection closed by server. Stopping audio forwarding.")
    except Exception as e:
        logger.error(f"[{session_id}] Error forwarding audio to OpenAI: {e}")
        # Propagate error or handle as needed, may need to close client_ws
    finally:
        logger.info(f"[{session_id}] Finished forwarding audio to OpenAI.")


async def forward_transcripts_to_client(openai_ws: WebSocketClientProtocol, client_ws: WebSocket, session_id: str):
    logger.info(f"[{session_id}] Starting to forward transcripts from OpenAI to client.")
    try:
        async for message_str in openai_ws:
            logger.debug(f"[{session_id}] Received message from OpenAI: {message_str[:200]}...") # Log snippet
            try:
                message_json = json.loads(message_str)
                event_type = message_json.get("type")

                if event_type == "conversation.item.input_audio_transcription.delta":
                    transcript_delta = message_json.get("input_audio_transcription", {}).get("text", "")
                    if transcript_delta and client_ws.client_state == WebSocketState.CONNECTED:
                        await client_ws.send_json({"partial": transcript_delta})
                        logger.debug(f"[{session_id}] Sent partial transcript to client: {transcript_delta}")
                elif event_type == "conversation.item.input_audio_transcription.completed":
                    final_transcript = message_json.get("input_audio_transcription", {}).get("text", "")
                    if client_ws.client_state == WebSocketState.CONNECTED:
                        await client_ws.send_json({"final": final_transcript})
                        logger.info(f"[{session_id}] Sent final transcript to client: {final_transcript}")
                elif event_type and "error" in event_type.lower(): # Catch generic error events from OpenAI
                    logger.error(f"[{session_id}] Received error event from OpenAI: {message_json}")
                    if client_ws.client_state == WebSocketState.CONNECTED:
                         await client_ws.send_json({"error": message_json.get("message", "Transcription error from provider.")})
                # else: # Handle other message types if necessary
                #     logger.info(f"[{session_id}] Received other message type from OpenAI: {event_type}")

            except json.JSONDecodeError:
                logger.error(f"[{session_id}] Failed to decode JSON from OpenAI: {message_str}")
            except Exception as e:
                logger.error(f"[{session_id}] Error processing message from OpenAI: {e}")
                # Decide if this error should propagate / close the connection

    except websockets.exceptions.ConnectionClosed as e:
        logger.info(f"[{session_id}] OpenAI WebSocket connection closed. Code: {e.code}, Reason: {e.reason}. Stopping transcript forwarding.")
        if client_ws.client_state == WebSocketState.CONNECTED and e.code != 1000: # Don't send error for normal closure
            await client_ws.send_json({"error": f"Transcription service connection closed: {e.reason if e.reason else 'Unknown reason'}"})
    except Exception as e:
        logger.error(f"[{session_id}] Error receiving transcripts from OpenAI: {e}")
        if client_ws.client_state == WebSocketState.CONNECTED:
            await client_ws.send_json({"error": "Error receiving transcription."})
    finally:
        logger.info(f"[{session_id}] Finished forwarding transcripts to client.")


@app.websocket("/v1/transcriptions")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = str(uuid.uuid4())
    logger.info(f"WebSocket connection accepted from {websocket.client.host}:{websocket.client.port}, session_id: {session_id}")
    client_language = "en"

    try:
        initial_message = await websocket.receive_text()
        try:
            message_data = json.loads(initial_message)
            logger.info(f"[{session_id}] Received handshake message: {message_data}")
            if message_data.get("action") == "start":
                client_language = message_data.get("language", "en")
                await websocket.send_json({"session_id": session_id})
                logger.info(f"[{session_id}] Sent session_id to client for language: {client_language}")
            else:
                logger.warning(f"[{session_id}] Invalid handshake message: {initial_message}. Closing connection.")
                await websocket.close(code=1008)
                return
        except json.JSONDecodeError:
            logger.error(f"[{session_id}] Invalid JSON in handshake: {initial_message}. Closing connection.")
            await websocket.close(code=1008)
            return
        except Exception as e:
            logger.error(f"[{session_id}] Error during handshake: {e}. Closing connection.")
            await websocket.close(code=1011)
            return

        ephemeral_key = await mint_openai_ephemeral_token()
        if not ephemeral_key:
            logger.error(f"[{session_id}] Could not obtain ephemeral key. Closing client connection.")
            await websocket.send_json({"error": "Failed to connect to transcription service (token minting failed)."})
            await websocket.close(code=1011)
            return
        
        logger.info(f"[{session_id}] Ephemeral key obtained. Proceeding to connect to OpenAI.")
        await connect_to_openai_realtime_api(ephemeral_key, websocket, session_id, client_language)
        # The connect_to_openai_realtime_api function will now block and handle the streaming
        # until it's done or an error occurs.

    except WebSocketDisconnect:
        logger.info(f"[{session_id}] Client WebSocket disconnected from {websocket.client.host}:{websocket.client.port}")
    except Exception as e:
        logger.error(f"[{session_id}] Error in main WebSocket endpoint: {e}")
        if websocket.client_state == WebSocketState.CONNECTED:
            try:
                await websocket.close(code=1011)
            except Exception as close_exc:
                logger.error(f"[{session_id}] Error attempting to close WebSocket: {close_exc}")
    finally:
        logger.info(f"[{session_id}] Main WebSocket endpoint handler finished.")


if __name__ == "__main__":
    uvicorn.run(
        app, 
        host="0.0.0.0", 
        port=settings.PORT, 
        log_level=settings.LOG_LEVEL.lower(),
        loop="asyncio"  # Force standard asyncio loop
    ) 