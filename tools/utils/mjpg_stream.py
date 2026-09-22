"""MMM-Face-Reco-DNN - MagicMirror Module
Mjpg-Streamer Camera Capture Device
Based on work by Tony DiCola (Copyright 2013) (MIT License)

Mjpg-Streamer device capture class using OpenCV. This class allows you to capture
images from an mjpg-streamer HTTP stream, as if it were a snapshot camera.

This is useful when running the code on a system where the camera is accessed
through mjpg-streamer instead of direct USB access.
"""
import threading
import time
import cv2
import requests
from requests.auth import HTTPBasicAuth
import numpy as np
from io import BytesIO
from utils.print import Print

# Rate at which the stream will be polled for new images.
CAPTURE_HZ = 30.0


class MjpgStreamCapture(object):
    def __init__(self, stream_url, username=None, password=None):
        """Create an mjpg-streamer capture object associated with the provided stream URL.
        
        Args:
            stream_url (str): URL to the mjpg-streamer stream (e.g., "http://localhost:8081/?action=stream")
            username (str, optional): Username for HTTP basic authentication
            password (str, optional): Password for HTTP basic authentication
        """
        self.stream_url = stream_url
        self.username = username
        self.password = password
        
        # Prepare authentication if credentials are provided
        self.auth = None
        if username and password:
            self.auth = HTTPBasicAuth(username, password)
        
        # Start a thread to continuously capture frames.
        # This must be done because different layers of buffering in the stream
        # and network will cause you to retrieve old frames if they aren't
        # continuously read.
        self._capture_frame = None
        # Use a lock to prevent access concurrent access to the stream.
        self._capture_lock = threading.Lock()
        self._capture_thread = threading.Thread(target=self._grab_frames)
        self._capture_thread.daemon = True
        self._capture_thread.start()

    def _grab_frames(self):
        """Continuously grab frames from the mjpg-streamer stream."""
        while True:
            try:
                # Make request to the stream
                response = requests.get(self.stream_url, auth=self.auth, stream=True, timeout=5)
                response.raise_for_status()
                
                # Read the MJPEG stream
                buffer = b''
                for chunk in response.iter_content(chunk_size=65536):
                    buffer += chunk
                    
                    # Look for MJPEG frame boundaries
                    while True:
                        # Find start of frame
                        start = buffer.find(b'\xff\xd8')
                        if start == -1:
                            break
                            
                        # Find end of frame
                        end = buffer.find(b'\xff\xd9', start)
                        if end == -1:
                            break
                            
                        # Extract JPEG frame (include end marker). Keep it
                        # encoded: recognition uses one frame per interval, so
                        # decoding every frame of a 30 fps stream is wasted CPU.
                        jpg = buffer[start:end+2]
                        buffer = buffer[end+2:]
                        with self._capture_lock:
                            self._capture_frame = jpg

            except requests.exceptions.RequestException as e:
                # stdout is a JSON channel to node_helper (python-shell, mode json):
                # a plain print() there throws in MagicMirror and silences recognition.
                Print.printJson("status", f"Stream connection error: {e}")
                time.sleep(1)  # Wait before retrying
            except Exception as e:
                Print.printJson("status", f"Unexpected error in stream capture: {e}")
                time.sleep(1)
                
            time.sleep(1.0 / CAPTURE_HZ)

    def read(self):
        """Read a single frame from the stream and return the data as an OpenCV
        image (which is a numpy array).
        """
        # If there are problems, keep retrying until an image can be read.
        # Sleep between tries: with the stream down this loop would otherwise
        # spin a whole core.
        while True:
            with self._capture_lock:
                jpg = self._capture_frame
            if jpg is not None:
                frame = cv2.imdecode(np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is not None:
                    return frame
            time.sleep(0.05)
        
    def stop(self):
        """Stop the capture thread and cleanup resources."""
        # The thread will stop when the daemon process exits
        pass
