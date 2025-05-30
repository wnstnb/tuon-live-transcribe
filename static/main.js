document.addEventListener('DOMContentLoaded', () => {
    const recordButton = document.getElementById('recordButton');
    const stopButton = document.getElementById('stopButton');
    const transcriptOutput = document.getElementById('transcriptOutput');
    const statusArea = document.getElementById('statusArea');

    let websocket;
    let mediaRecorder;
    let audioChunks = [];

    const WS_URL = `ws://${window.location.host}/v1/transcriptions`;
    // const WS_URL = `ws://localhost:8000/v1/transcriptions`; // For local dev if window.location.host is not 8000

    function updateStatus(message, isError = false) {
        statusArea.textContent = message;
        statusArea.className = isError ? 'status error' : 'status';
        if(isError) console.error(message);
        else console.log(message);
    }

    function connectWebSocket() {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            updateStatus('WebSocket already connected.');
            return;
        }

        updateStatus('Connecting to WebSocket...');
        websocket = new WebSocket(WS_URL);

        websocket.onopen = () => {
            updateStatus('WebSocket connected. Sending handshake...');
            // Send handshake
            websocket.send(JSON.stringify({ action: "start", language: "en" }));
            // Don't enable record button until session_id is received, or handle it gracefully
        };

        websocket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            console.log("Received from server:", data);

            if (data.session_id) {
                updateStatus(`Session started: ${data.session_id}. Ready to record.`);
                recordButton.disabled = false;
            }
            if (data.partial) {
                // Append partial transcript
                transcriptOutput.textContent += data.partial;
            }
            if (data.final) {
                // Replace with final or handle as needed. For now, append and add newline.
                transcriptOutput.textContent += data.final + '\n'; 
            }
            if (data.error) {
                updateStatus(`Server error: ${data.error}`, true);
                stopRecording(); // Stop recording on server error
            }
        };

        websocket.onerror = (error) => {
            updateStatus(`WebSocket error: ${error.message || 'Unknown error'}`, true);
            console.error('WebSocket Error: ', error);
            recordButton.disabled = true;
            stopButton.disabled = true;
        };

        websocket.onclose = (event) => {
            updateStatus(`WebSocket closed. Code: ${event.code}, Reason: ${event.reason || 'N/A'}`, event.wasClean ? false : true);
            recordButton.disabled = true;
            stopButton.disabled = true;
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                stopRecording();
            }
        };
    }

    async function startRecording() {
        if (!websocket || websocket.readyState !== WebSocket.OPEN) {
            updateStatus('WebSocket not connected. Please connect first.', true);
            // Attempt to reconnect or instruct user
            connectWebSocket(); // Try to connect again
            return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            updateStatus('getUserMedia not supported on your browser!', true);
            return;
        }

        updateStatus('Requesting microphone access...');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            updateStatus('Microphone access granted. Starting recording...');
            
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm; codecs=opus' }); // Or other supported mimeType
            audioChunks = [];

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0 && websocket && websocket.readyState === WebSocket.OPEN) {
                    audioChunks.push(event.data);
                    // Send data immediately or batch? The PRD implies ~500ms chunks.
                    // Sending immediately on dataavailable might be too frequent depending on timeslice.
                    websocket.send(event.data); // Send as Blob directly
                    console.log(`Sent ${event.data.size} bytes of audio data.`);
                }
            };

            mediaRecorder.onstop = () => {
                updateStatus('Recording stopped.');
                // Optionally send any remaining buffered audio chunks if not sent immediately
                // stream.getTracks().forEach(track => track.stop()); // Stop microphone access
                recordButton.disabled = false;
                stopButton.disabled = true;
            };
            
            // The PRD mentions ~500ms chunks. The MediaRecorder timeslice parameter controls this.
            mediaRecorder.start(500); // Collect 500ms of audio then trigger ondataavailable

            recordButton.disabled = true;
            stopButton.disabled = false;
            transcriptOutput.textContent = ''; // Clear previous transcript

        } catch (err) {
            updateStatus(`Error accessing microphone: ${err.message}`, true);
            console.error('Error accessing microphone: ', err);
        }
    }

    function stopRecording() {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
            // The onstop event will handle UI updates
        }
        // If WebSocket is open and expecting a "stop" signal, send it here.
        // For now, the backend handles continuous stream until client disconnects or OpenAI ends session.
        // No explicit stop message is defined in the PRD for the client->gateway WS.
    }

    recordButton.onclick = () => {
        if (!websocket || websocket.readyState !== WebSocket.OPEN) {
            connectWebSocket(); // Connect if not already connected
            // Wait for onopen and session_id before starting recording
            // This logic could be refined: disable record button until websocket.onmessage gives session_id
        } else {
            startRecording();
        }
    };
    stopButton.onclick = stopRecording;

    // Initial connection attempt
    recordButton.disabled = true; // Disabled until WebSocket connection & handshake is successful
    connectWebSocket(); 
}); 