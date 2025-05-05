// server.js - OpenAI Realtime API with WebRTC implementation
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

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

// Check for required environment variables
if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY environment variable');
    process.exit(1);
}

// Initialize Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Load restaurant data
let restaurantData = null;

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

// Load restaurant data
restaurantData = loadRestaurantData();

// Create session and get signaling info
async function createWebRTCSession() {
    try {
        const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini-2024-07-18',
                /* You can optionally specify a base64-encoded ICE server configuration here.
                ice_servers: {
                    urls: ['stun:stun.example.com:19302']
                }
                */
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Failed to create WebRTC session: ${JSON.stringify(errorData)}`);
        }
        
        const sessionData = await response.json();
        debug('WebRTC session created:', sessionData);
        
        return sessionData;
    } catch (error) {
        console.error('Error creating WebRTC session:', error);
        throw error;
    }
}

// Update session configuration
async function updateSession(sessionId, language = 'en') {
    try {
        // Get restaurant instructions
        const instructions = language === 'ur' ? 
            createUrduInstructions(restaurantData) : 
            createEnglishInstructions(restaurantData);
        
        // Voice settings based on language
        const voice = language === 'ur' ? 'alloy' : 'nova';
        
        const response = await fetch(`https://api.openai.com/v1/realtime/sessions/${sessionId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                session_id: sessionId,
                input_audio: {
                    sampling_rate: 16000,
                    encoding: 'linear16',
                    stream_silence: true,
                    echo_cancellation: true,
                    noise_suppression: true,
                    automatic_gain_control: true
                },
                input_audio_transcription: {
                    model: 'whisper-1',
                    language: language
                },
                vad: {
                    enabled: true,
                    threshold: 0.5,
                    prefix_padding: 0.5,
                    suffix_padding: 1.0,
                    sliding_window_size: 0.2,
                    max_silence_length_ms: 2000,
                    minimum_utterance_length_ms: 500
                },
                output_audio: {
                    voice: voice
                },
                tools: getRestaurantFunctions(),
                system_message: {
                    role: 'system',
                    content: instructions
                }
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Failed to update session: ${JSON.stringify(errorData)}`);
        }
        
        const updateData = await response.json();
        debug('Session updated:', updateData);
        
        return updateData;
    } catch (error) {
        console.error('Error updating session:', error);
        throw error;
    }
}

// Send a function response
async function sendFunctionResponse(sessionId, functionCallId, functionName, result) {
    try {
        const response = await fetch(`https://api.openai.com/v1/realtime/sessions/${sessionId}/conversation/items`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                role: 'function',
                name: functionName,
                content: JSON.stringify(result),
                previous_item_id: functionCallId
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Failed to send function response: ${JSON.stringify(errorData)}`);
        }
        
        const responseData = await response.json();
        debug('Function response sent:', responseData);
        
        return responseData;
    } catch (error) {
        console.error('Error sending function response:', error);
        throw error;
    }
}

// Send a text message
async function sendTextMessage(sessionId, text) {
    try {
        const response = await fetch(`https://api.openai.com/v1/realtime/sessions/${sessionId}/conversation/items`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                role: 'user',
                content: text
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Failed to send text message: ${JSON.stringify(errorData)}`);
        }
        
        const responseData = await response.json();
        debug('Text message sent:', responseData);
        
        return responseData;
    } catch (error) {
        console.error('Error sending text message:', error);
        throw error;
    }
}

// Create English instructions
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

// Create Urdu instructions
function createUrduInstructions(data) {
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

// Store active clients
const clients = new Map();

// Create route to generate WebRTC session info
app.get('/api/create-session', async (req, res) => {
    try {
        const sessionData = await createWebRTCSession();
        res.json(sessionData);
    } catch (error) {
        console.error('Error creating session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route to update session
app.post('/api/update-session', express.json(), async (req, res) => {
    try {
        const { sessionId, language } = req.body;
        
        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID is required' });
        }
        
        const updateData = await updateSession(sessionId, language || 'en');
        res.json(updateData);
    } catch (error) {
        console.error('Error updating session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route to send function response
app.post('/api/function-response', express.json(), async (req, res) => {
    try {
        const { sessionId, functionCallId, functionName, result } = req.body;
        
        if (!sessionId || !functionCallId || !functionName) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        
        const responseData = await sendFunctionResponse(sessionId, functionCallId, functionName, result);
        res.json(responseData);
    } catch (error) {
        console.error('Error sending function response:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route to send text message
app.post('/api/send-text', express.json(), async (req, res) => {
    try {
        const { sessionId, text } = req.body;
        
        if (!sessionId || !text) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        
        const responseData = await sendTextMessage(sessionId, text);
        res.json(responseData);
    } catch (error) {
        console.error('Error sending text message:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});