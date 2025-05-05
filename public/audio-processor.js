// audio-processor.js - AudioWorklet for processing audio
class AudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.bufferSize = options.processorOptions.bufferSize || 4096;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
    }
    
    process(inputs, outputs, parameters) {
        // Get the input data
        const input = inputs[0];
        
        // Skip if no input
        if (!input || !input.length) {
            return true;
        }
        
        const inputChannel = input[0];
        
        // Add input data to buffer
        for (let i = 0; i < inputChannel.length; i++) {
            this.buffer[this.bufferIndex++] = inputChannel[i];
            
            // If buffer is full, send it and reset
            if (this.bufferIndex >= this.bufferSize) {
                this.port.postMessage({
                    audio: this.buffer.slice(0)
                });
                
                this.bufferIndex = 0;
            }
        }
        
        return true;
    }
}

registerProcessor('audio-processor', AudioProcessor);