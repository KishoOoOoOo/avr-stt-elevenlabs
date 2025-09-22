/**
 * AVR Speech-to-Text Service using ElevenLabs - FIXED VERSION
 *
 * This service receives audio data from Asterisk, converts it to WAV format,
 * and uses ElevenLabs API to transcribe the speech to text.
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @contributors Giuseppe Careri <info@gcareri.com>, seif walid mamdouh
 * @version 1.1.0 - FIXED
 */

const express = require("express");
const { ElevenLabsClient } = require("elevenlabs");
const wav = require("node-wav");

// Load environment variables
require("dotenv").config();

// Initialize Express app
const app = express();

// Configure middleware for raw binary data
// This allows receiving audio data as a raw buffer
app.use(express.raw({ type: "application/octet-stream", limit: "50mb" }));

/**
 * Properly resample audio data from one sample rate to another
 * @param {Float32Array} inputSamples - Input audio samples
 * @param {number} inputSampleRate - Input sample rate
 * @param {number} outputSampleRate - Target sample rate
 * @returns {Float32Array} Resampled audio
 */
function resampleAudio(inputSamples, inputSampleRate, outputSampleRate) {
  if (inputSampleRate === outputSampleRate) {
    return inputSamples;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(inputSamples.length / ratio);
  const outputSamples = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(leftIndex + 1, inputSamples.length - 1);
    const fraction = sourceIndex - leftIndex;

    // Linear interpolation
    outputSamples[i] = inputSamples[leftIndex] * (1 - fraction) + 
                       inputSamples[rightIndex] * fraction;
  }

  return outputSamples;
}

/**
 * Apply noise reduction filter to audio samples
 * @param {Float32Array} samples - Input audio samples
 * @returns {Float32Array} Filtered audio samples
 */
function applyNoiseReduction(samples) {
  const filtered = new Float32Array(samples.length);
  const alpha = 0.8; // Low-pass filter coefficient
  
  filtered[0] = samples[0];
  for (let i = 1; i < samples.length; i++) {
    filtered[i] = alpha * samples[i] + (1 - alpha) * filtered[i - 1];
  }
  
  return filtered;
}

/**
 * Normalize audio volume
 * @param {Float32Array} samples - Input audio samples
 * @returns {Float32Array} Normalized audio samples
 */
function normalizeAudio(samples) {
  // Find peak amplitude
  let maxAmplitude = 0;
  for (let i = 0; i < samples.length; i++) {
    maxAmplitude = Math.max(maxAmplitude, Math.abs(samples[i]));
  }

  // Avoid division by zero and apply reasonable normalization
  if (maxAmplitude < 0.001) {
    return samples; // Signal too quiet, don't normalize
  }

  const targetLevel = 0.8; // Target peak level
  const gainFactor = targetLevel / maxAmplitude;

  const normalized = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    normalized[i] = samples[i] * gainFactor;
    // Clamp to prevent clipping
    normalized[i] = Math.max(-1, Math.min(1, normalized[i]));
  }

  return normalized;
}

/**
 * Handles the transcription request
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Object} JSON response with transcription
 */
const handleTranscriptionRequest = async (req, res) => {
  // Log request timestamp
  console.log(
    `\n[${new Date().toISOString()}] Transcription Service: Received request on /transcribe`
  );

  // Extract audio data and metadata from request
  const audioBuffer = req.body;
  const sampleRateHeader = req.headers["x-sample-rate"];
  const sampleRate = parseInt(sampleRateHeader, 10);

  // Default to Asterisk's slin format (Signed Linear PCM)
  const audioFormat = req.headers["x-audio-format"] || "audio/x-signed-linear";

  // Validate audio data
  if (!audioBuffer || audioBuffer.length === 0) {
    console.error("Received empty audio buffer.");
    return res.status(400).json({ message: "Empty audio data received." });
  }

  // Validate sample rate
  if (!sampleRate || isNaN(sampleRate)) {
    console.error(
      `Invalid or missing X-Sample-Rate header: ${sampleRateHeader}`
    );
    return res
      .status(400)
      .json({ message: "Missing or invalid X-Sample-Rate header." });
  }

  // Check minimum audio length (should be at least 0.5 seconds)
  const minSamples = sampleRate * 0.5; // 0.5 seconds
  const actualSamples = audioBuffer.length / 2; // 16-bit = 2 bytes per sample
  
  if (actualSamples < minSamples) {
    console.log(`Audio too short: ${actualSamples} samples (${(actualSamples/sampleRate).toFixed(2)}s), minimum: ${minSamples} samples`);
    return res.json({ transcription: '' });
  }

  // Log audio metadata
  console.log(
    `Received audio buffer: ${(audioBuffer.length / 1024).toFixed(
      2
    )} KB, Sample Rate: ${sampleRate} Hz, Format: ${audioFormat}, Duration: ${(actualSamples/sampleRate).toFixed(2)}s`
  );

  try {
    // Convert PCM to Float32 samples for processing
    console.log("Converting PCM to Float32 samples...");
    
    const samples = [];
    for (let i = 0; i < audioBuffer.length; i += 2) {
      // Read 16-bit little-endian sample
      const sample = audioBuffer.readInt16LE(i);
      // Normalize to [-1, 1] range
      samples.push(sample / 32768.0);
    }
    
    let processedSamples = new Float32Array(samples);
    
    // Apply audio processing steps
    console.log("Applying audio processing...");
    
    // 1. Noise reduction
    processedSamples = applyNoiseReduction(processedSamples);
    
    // 2. Resample to optimal rate for ElevenLabs (usually 16kHz or 22kHz)
    const targetSampleRate = 16000; // ElevenLabs works well with 16kHz
    if (sampleRate !== targetSampleRate) {
      console.log(`Resampling from ${sampleRate}Hz to ${targetSampleRate}Hz...`);
      processedSamples = resampleAudio(processedSamples, sampleRate, targetSampleRate);
    }
    
    // 3. Normalize volume
    processedSamples = normalizeAudio(processedSamples);
    
    // Convert back to 16-bit PCM for WAV encoding
    const finalSamples = [];
    for (let i = 0; i < processedSamples.length; i++) {
      // Convert back to 16-bit integer range
      const intSample = Math.round(processedSamples[i] * 32767);
      finalSamples.push(Math.max(-32768, Math.min(32767, intSample)) / 32768.0);
    }
    
    // Create a WAV buffer with proper headers
    const wavBuffer = wav.encode([finalSamples], {
      sampleRate: targetSampleRate,
      float: false,
      bitDepth: 16,
    });
    
    // Log conversion result
    console.log(`Converted to WAV: ${(wavBuffer.length / 1024).toFixed(2)} KB at ${targetSampleRate}Hz`);
    
    // Validate WAV buffer size
    if (wavBuffer.length < 1000) { // Less than 1KB is probably too small
      console.log("Generated WAV file too small, likely invalid audio");
      return res.json({ transcription: '' });
    }
    
    // Create a Blob with the WAV data for ElevenLabs API
    const audioBlob = new Blob([wavBuffer], { type: "audio/wav" });

    // Initialize ElevenLabs client
    const client = new ElevenLabsClient({
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    console.log("Sending audio to ElevenLabs for transcription...");
    
    // Send audio to ElevenLabs for transcription with optimal settings
    const transcription = await client.speechToText.convert({
      file: audioBlob,
      model_id: process.env.ELEVENLABS_MODEL_ID || "scribe_v1",
      num_speakers: 1,
      language_code: process.env.ELEVENLABS_LANGUAGE_CODE || "ar", // Set to Arabic for better results
      tag_audio_events: false,
      timestamps_granularity: "none",
      // Add additional parameters for better accuracy
      remove_background_noise: true,
      normalize_audio: false // We already normalized it
    });

    // Log transcription result
    const transcribedText = transcription.text || '';
    console.log(`Transcription result: "${transcribedText}" (length: ${transcribedText.length})`);
    
    // Basic text cleanup for Arabic
    let cleanedText = transcribedText.trim();
    
    // Remove extra spaces
    cleanedText = cleanedText.replace(/\s+/g, ' ');
    
    // Return transcription text
    return res.json({ transcription: cleanedText });
    
  } catch (error) {
    // Log and return error
    console.error("Error processing audio:", error);
    
    // Check if it's an API-specific error
    if (error.response) {
      console.error("ElevenLabs API Error:", error.response.status, error.response.data);
    }
    
    return res
      .status(500)
      .json({ message: "Error processing audio", error: error.message });
  }
};

// Register the transcription endpoint
app.post("/transcribe", handleTranscriptionRequest);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", service: "ElevenLabs STT", timestamp: new Date().toISOString() });
});

// Start the server
const PORT = process.env.PORT || 6022;
app.listen(PORT, () => {
  console.log(`ElevenLabs STT listening on port ${PORT}`);
  console.log(`Language: ${process.env.ELEVENLABS_LANGUAGE_CODE || "en"}`);
  console.log(`Model: ${process.env.ELEVENLABS_MODEL_ID || "scribe_v1"}`);
});
