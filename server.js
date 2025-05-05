// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Debug mode
const DEBUG = process.env.DEBUG === 'true';

function debug(message, data) {
    if (DEBUG) {
        if (data) {
            console.log(`[SERVER] ${message}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
        } else {
            console.log(`[SERVER] ${message}`);
        }
    }
}
// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Load restaurant data
const restaurantData = loadRestaurantData();

// Store active client connections
const clients = new Map();

// Handle WebSocket connections from clients
wss.on('connection', (ws) => {
    console.log('Client connected');
    
    // Generate a unique client ID
    const clientId = Date.now().toString();
    
    // Initialize client state
    const clientState = {
        id: clientId,
        ws: ws,
        openaiWs: null,
        language: 'en',
        cart: []
    };
    
    // Store client state
    clients.set(clientId, clientState);
    
    // Send initial message with client ID
    ws.send(JSON.stringify({
        type: 'connection',
        id: clientId
    }));
    
    // Handle messages from client
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            handleClientMessage(clientState, data);
        } catch (error) {
            console.error('Error handling client message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                error: error.message
            }));
        }
    });
    
    // Handle client disconnection
    ws.on('close', () => {
        console.log(`Client ${clientId} disconnected`);
        
        // Close OpenAI connection if exists
        if (clientState.openaiWs) {
            clientState.openaiWs.close();
        }
        
        // Remove client state
        clients.delete(clientId);
    });
});

// Handle client messages
function handleClientMessage(clientState, message) {
    switch (message.type) {
        case 'init':
            // Initialize OpenAI connection
            initializeOpenAI(clientState, message.language || 'en');
            break;
            
        case 'audio':
            // Forward audio data to OpenAI
            sendAudioToOpenAI(clientState, message.data);
            break;
            
        case 'text':
            // Send text message to OpenAI
            sendTextToOpenAI(clientState, message.text);
            break;
            
        case 'function_result':
            // Handle function result
            handleFunctionResult(clientState, message);
            break;
            
        default:
            console.warn('Unknown message type:', message.type);
    }
}

// Initialize OpenAI WebSocket connection
function initializeOpenAI(clientState, language) {
    console.log(`Initializing OpenAI connection for client ${clientState.id} with language ${language}`);
    
    // Close existing connection if any
    if (clientState.openaiWs) {
        clientState.openaiWs.close();
    }
    
    // Update language
    clientState.language = language;
    
    // Get restaurant instructions
    const instructions = language === 'ur' ? 
        createUrduInstructions(restaurantData) : 
        createEnglishInstructions(restaurantData);
    
    // Voice settings based on language
    const voice = language === 'ur' ? 'alloy' : 'nova';
    
    // Try with recommended model for Realtime API
    const model = 'gpt-4o-realtime-preview-2024-12-17'; // Use the recommended model from documentation
    
    console.log(`Connecting to OpenAI Realtime API with model: ${model}`);
    
    // Connect to OpenAI WebSocket with detailed logging
    const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
        headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
        }
    });
    
    // Handle connection open
    openaiWs.on('open', () => {
        console.log(`OpenAI WebSocket connection opened for client ${clientState.id}`);
        
        // Store OpenAI WebSocket
        clientState.openaiWs = openaiWs;
        
        // Get restaurant instructions
        const instructions = clientState.language === 'ur' ? 
            createUrduInstructions(restaurantData) : 
            createEnglishInstructions(restaurantData);
        
        // Send initial system message with correct format
        const initialMessage = {
            type: "conversation.item.create",
            item: {
                type: "message",
                role: "system",
                content: [
                    {
                        type: "input_text",  // Changed from "text" to "input_text"
                        text: instructions
                    }
                ]
            }
        };
        
        console.log('Sending system message:', JSON.stringify(initialMessage));
        openaiWs.send(JSON.stringify(initialMessage));
        
        // Notify client
        clientState.ws.send(JSON.stringify({
            type: 'ready'
        }));
    });
    
    // Handle messages from OpenAI
    openaiWs.on('message', (message) => {
        console.log(`Received message from OpenAI (${typeof message}): ${typeof message === 'string' ? message.substring(0, 100) : `Binary data of length ${message.length}`}`);
        
        try {
            // Try to parse as JSON if it's a string
            if (typeof message === 'string') {
                const data = JSON.parse(message);
                console.log('Parsed message from OpenAI:', data);
                
                // Forward to client
                clientState.ws.send(message);
            } else {
                // It's binary data - try to decode it as JSON first
                try {
                    const textData = message.toString('utf8');
                    console.log('Converted binary to text:', textData.substring(0, 100));
                    
                    try {
                        // Try to parse as JSON
                        const jsonData = JSON.parse(textData);
                        console.log('Successfully parsed binary data as JSON:', jsonData);
                        
                        // Forward JSON to client
                        clientState.ws.send(JSON.stringify(jsonData));
                        
                        // Check if it's an error message
                        if (jsonData.type === 'error') {
                            console.error('Received error from OpenAI:', jsonData);
                            
                            // Close the connection if it's a terminal error
                            if (jsonData.error && jsonData.error.message) {
                                console.error('OpenAI error message:', jsonData.error.message);
                            }
                        }
                    } catch (jsonError) {
                        // Not valid JSON, might be actual binary data
                        console.log('Binary data is not valid JSON, assuming it might be audio');
                        
                        // Forward as binary_data
                        clientState.ws.send(JSON.stringify({
                            type: 'binary_data',
                            format: 'application/octet-stream', // Generic binary format
                            data: message.toString('base64')
                        }));
                    }
                } catch (textError) {
                    console.error('Error converting binary to text:', textError);
                    
                    // Forward raw binary data
                    clientState.ws.send(JSON.stringify({
                        type: 'binary_data',
                        format: 'application/octet-stream',
                        data: message.toString('base64')
                    }));
                }
            }
        } catch (error) {
            console.error('Error handling OpenAI message:', error);
        }
    });
    
    // Handle errors with detailed logging
    openaiWs.on('error', (error) => {
        console.error(`OpenAI WebSocket error for client ${clientState.id}:`, error);
        console.error('Error details:', error.message);
        console.error('Error stack:', error.stack);
        
        // Notify client
        clientState.ws.send(JSON.stringify({
            type: 'error',
            error: {
                message: `Error connecting to OpenAI: ${error.message}`
            }
        }));
    });
    
    // Handle connection close with detailed logging
    openaiWs.on('close', (code, reason) => {
        console.log(`OpenAI WebSocket closed for client ${clientState.id}. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
        
        // Clear ping interval
        if (clientState.pingInterval) {
            clearInterval(clientState.pingInterval);
            clientState.pingInterval = null;
        }
        
        // Try reconnecting if it was a normal closure or no reason was provided
        if (code === 1000 || code === 1001) {
            console.log('Attempting to reconnect in 2 seconds...');
            
            // Wait 2 seconds before reconnecting
            setTimeout(() => {
                if (clientState.ws.readyState === WebSocket.OPEN) {
                    // Re-initialize OpenAI connection
                    initializeOpenAI(clientState, clientState.language);
                }
            }, 2000);
        } else {
            // For other close codes, notify client of disconnection
            clientState.ws.send(JSON.stringify({
                type: 'disconnected',
                code: code,
                reason: reason || 'Connection closed'
            }));
        }
        
        // Clear OpenAI WebSocket
        clientState.openaiWs = null;
    });
}

let audioBuffer = [];
let lastCommitTime = 0;
const MIN_BUFFER_SIZE = 4096; // Minimum buffer size before sending
const MIN_BUFFER_TIME = 500; // Minimum time between commits in ms

// Send audio data to OpenAI
function sendAudioToOpenAI(clientState, audioData) {
    if (!clientState.openaiWs || clientState.openaiWs.readyState !== WebSocket.OPEN) {
        console.warn(`Cannot send audio: No OpenAI connection for client ${clientState.id}`);
        return;
    }
    
    // Use the format for audio data with the correct parameter name
    const message = {
        type: "input_audio_buffer.append",
        audio: audioData  // Changed from audio_data to audio
    };
    
    console.log('Sending audio data to OpenAI');
    clientState.openaiWs.send(JSON.stringify(message));
    
    // Then commit the buffer
    const commitMessage = {
        type: "input_audio_buffer.commit"
    };
    
    console.log('Committing audio buffer');
    clientState.openaiWs.send(JSON.stringify(commitMessage));
}

// Send text to OpenAI
function sendTextToOpenAI(clientState, text) {
    if (!clientState.openaiWs || clientState.openaiWs.readyState !== WebSocket.OPEN) {
        console.warn(`Cannot send text: No OpenAI connection for client ${clientState.id}`);
        return;
    }
    
    // Use the correct format for text messages
    const message = {
        type: "conversation.item.create",
        item: {
            type: "message",
            role: "user",
            content: [
                {
                    type: "input_text",  // Changed from "text" to "input_text"
                    text: text
                }
            ]
        }
    };
    
    console.log('Sending text message to OpenAI:', message);
    clientState.openaiWs.send(JSON.stringify(message));
}

// Handle function calls from OpenAI
function handleFunctionCall(clientState, functionCall) {
    // Extract function details
    const functionName = functionCall.function.name;
    const functionArgs = JSON.parse(functionCall.function.arguments);
    const functionId = functionCall.id;
    
    console.log(`Function call from OpenAI: ${functionName}`, functionArgs);
    
    // Forward to client for UI updates or local processing
    clientState.ws.send(JSON.stringify({
        type: 'function_call',
        id: functionId,
        name: functionName,
        arguments: functionArgs
    }));
}function handleFunctionResult(clientState, message) {
    if (!clientState.openaiWs || clientState.openaiWs.readyState !== WebSocket.OPEN) {
        console.warn(`Cannot send function result: No OpenAI connection for client ${clientState.id}`);
        return;
    }
    
    // Send function result using the correct format
    const functionResultMessage = {
        type: "conversation.item.create",
        item: {
            type: "function",
            name: message.name,
            role: "function",
            content: [
                {
                    type: "input_text",  // Changed from "text" to "input_text"
                    text: JSON.stringify(message.result)
                }
            ]
        }
    };
    
    console.log('Sending function result to OpenAI:', functionResultMessage);
    clientState.openaiWs.send(JSON.stringify(functionResultMessage));
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Helper functions for restaurant data handling
function loadRestaurantData() {
    try {
        const dataPath = path.join(__dirname, 'public', 'restaurant-data.js');
        const content = fs.readFileSync(dataPath, 'utf8');
        
        // Extract the data by creating a mock environment
        const mockWindow = {};
        const mockContext = { window: mockWindow };
        
        // Execute the script in the mocked context
        const vm = require('vm');
        vm.runInNewContext(content, mockContext);
        
        const data = mockWindow.restaurantData;
        
        if (data) {
            debug('Restaurant data loaded successfully');
            return data;
        } else {
            console.error('Failed to extract restaurant data from file');
            return null;
        }
    } catch (error) {
        console.error('Error loading restaurant data:', error);
        return null;
    }
}

function createEnglishInstructions(data) {
    if (!data) {
        return "You are a helpful assistant for a pizza restaurant.";
    }
    
    return `
You are a voice assistant for ${data.name}, a pizza restaurant. Your job is to help customers place orders by having a natural conversation and using functions to manage their cart.

THE MENU:
PIZZAS:
${data.menu.pizzas.map(p => `- ${p.name}: $${p.price} - ${p.description}`).join('\n')}

SIDES:
${data.menu.sides.map(s => `- ${s.name}: $${s.price} - ${s.description}`).join('\n')}

DRINKS:
${data.menu.drinks.map(d => `- ${d.name}: $${d.price} - ${d.description}`).join('\n')}

DESSERTS:
${data.menu.desserts.map(d => `- ${d.name}: $${d.price} - ${d.description}`).join('\n')}

CUSTOMIZATION OPTIONS:
Crusts: ${data.customizations.crusts.join(', ')}
Sizes: ${data.customizations.sizes.map(s => s.name).join(', ')}
Toppings: ${data.customizations.toppings.map(t => t.name).join(', ')}

SPECIAL DEALS:
${data.deals ? data.deals.map(d => `- ${d.name}: $${d.price} - ${d.description} ${d.savings}`).join('\n') : 'No special deals available'}

RESTAURANT HOURS:
${Object.entries(data.hours).map(([day, hours]) => `${day}: ${hours.open} - ${hours.close}`).join('\n')}

DELIVERY INFORMATION:
Minimum Order: $${data.delivery.minimum}
Delivery Fee: $${data.delivery.fee}
Estimated Time: ${data.delivery.estimatedTime}
Delivery Radius: ${data.delivery.radiusInMiles} miles

GUIDELINES:
1. Be friendly and conversational
2. Ask clarifying questions when needed (e.g., "What size pizza would you like?")
3. Confirm orders before adding to cart
4. Suggest complementary items (e.g., drinks with pizza)
5. Always ask for delivery/pickup preference and get customer details
6. Keep responses concise for voice interaction

You have access to functions that can add items to cart, modify items, remove items, and process checkout.
`;
}

// Create Urdu instructions (same as your existing function)
function createUrduInstructions(data) {
    // Your existing implementation
    if (!data) {
        return "آپ ایک پیزا ریستوراں کے لیے ایک مددگار اسسٹنٹ ہیں۔";
    }
    
    return `
آپ ${data.name} کے لیے ایک وائس اسسٹنٹ ہیں، جو ایک پیزا ریستوراں ہے۔ آپ کا کام گاہکوں کو قدرتی بات چیت کے ذریعے اور ان کے کارٹ کے انتظام کے لیے فنکشنز کا استعمال کرکے آرڈر دینے میں مدد کرنا ہے۔

مینو:
پیزا:
${data.menu.pizzas.map(p => `- ${p.name}: $${p.price} - ${p.description}`).join('\n')}

سائیڈز:
${data.menu.sides.map(s => `- ${s.name}: $${s.price} - ${s.description}`).join('\n')}

مشروبات:
${data.menu.drinks.map(d => `- ${d.name}: $${d.price} - ${d.description}`).join('\n')}

میٹھے:
${data.menu.desserts.map(d => `- ${d.name}: $${d.price} - ${d.description}`).join('\n')}

حسب ضرورت اختیارات:
کرسٹ: ${data.customizations.crusts.join('، ')}
سائز: ${data.customizations.sizes.map(s => s.name).join('، ')}
ٹاپنگز: ${data.customizations.toppings.map(t => t.name).join('، ')}

خصوصی ڈیلز:
${data.deals ? data.deals.map(d => `- ${d.name}: $${d.price} - ${d.description} ${d.savings}`).join('\n') : 'کوئی خصوصی ڈیلز دستیاب نہیں ہیں'}

ریستوراں کے اوقات:
${Object.entries(data.hours).map(([day, hours]) => `${day}: ${hours.open} - ${hours.close}`).join('\n')}

ڈیلیوری کی معلومات:
کم از کم آرڈر: $${data.delivery.minimum}
ڈیلیوری فیس: $${data.delivery.fee}
متوقع وقت: ${data.delivery.estimatedTime}
ڈیلیوری ریڈیس: ${data.delivery.radiusInMiles} میل

گائیڈ لائنز:
1. دوستانہ اور گفتگو کریں
2. ضرورت پڑنے پر وضاحتی سوالات پوچھیں (مثلاً، "آپ کونسا سائز پیزا چاہیں گے؟")
3. کارٹ میں شامل کرنے سے پہلے آرڈر کی تصدیق کریں
4. متعلقہ آئٹمز کی تجویز دیں (مثلاً، پیزا کے ساتھ مشروبات)
5. ہمیشہ ڈیلیوری/پک اپ کی ترجیح پوچھیں اور گاہک کی تفصیلات حاصل کریں
6. آواز کی بات چیت کے لیے مختصر جوابات دیں

آپ کے پاس کارٹ میں آئٹمز شامل کرنے، آئٹمز میں ترمیم کرنے، آئٹمز ہٹانے اور چیک آؤٹ پر کارروائی کرنے کے لیے فنکشنز تک رسائی ہے۔
`;
}

// Get restaurant functions for OpenAI tools
function getRestaurantFunctions() {
    return [
        {
            type: "function",
            function: {
                name: "add_to_cart",
                description: "Add an item to the customer's cart",
                parameters: {
                    type: "object",
                    properties: {
                        item: {
                            type: "string",
                            description: "The name of the menu item to add"
                        },
                        quantity: {
                            type: "integer",
                            description: "The quantity of the item to add",
                            default: 1
                        },
                        size: {
                            type: "string",
                            description: "The size of the item (Small, Medium, Large, X-Large)",
                            enum: ["Small", "Medium", "Large", "X-Large"],
                            default: "Medium"
                        },
                        customizations: {
                            type: "array",
                            items: {
                                type: "string"
                            },
                            description: "Any customizations for the item (extra toppings, etc.)"
                        }
                    },
                    required: ["item"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "modify_cart_item",
                description: "Modify an existing item in the customer's cart",
                parameters: {
                    type: "object",
                    properties: {
                        item: {
                            type: "string",
                            description: "The name of the menu item to modify"
                        },
                        quantity: {
                            type: "integer",
                            description: "The new quantity of the item"
                        },
                        size: {
                            type: "string",
                            description: "The new size of the item",
                            enum: ["Small", "Medium", "Large", "X-Large"]
                        },
                        customizations: {
                            type: "array",
                            items: {
                                type: "string"
                            },
                            description: "The new customizations for the item"
                        }
                    },
                    required: ["item"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "remove_from_cart",
                description: "Remove an item from the customer's cart",
                parameters: {
                    type: "object",
                    properties: {
                        item: {
                            type: "string",
                            description: "The name of the menu item to remove"
                        }
                    },
                    required: ["item"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "clear_cart",
                description: "Clear all items from the customer's cart",
                parameters: {
                    type: "object",
                    properties: {}
                }
            }
        },
        {
            type: "function",
            function: {
                name: "checkout",
                description: "Process the customer's order for checkout",
                parameters: {
                    type: "object",
                    properties: {
                        delivery: {
                            type: "boolean",
                            description: "Whether the customer wants delivery or pickup",
                            default: true
                        },
                        address: {
                            type: "string",
                            description: "Delivery address if applicable"
                        },
                        phone: {
                            type: "string",
                            description: "Customer's phone number"
                        }
                    }
                }
            }
        }
    ];
}