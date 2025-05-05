// function-handler.js - Updated for OpenAI voice agent

// Track the client's WebSocket connection
let clientWebSocket = null;
let restaurantData = null;

const DEBUG = process.env.DEBUG || true;

function debug(message, data) {
    if (DEBUG) {
        if (data) {
            console.log(`[SERVER] ${message}`, typeof data === 'object' ? JSON.stringify(data) : data);
        } else {
            console.log(`[SERVER] ${message}`);
        }
    }
}

/**
 * Initialize the function handler with the client WebSocket and restaurant data
 * @param {WebSocket} ws - Client WebSocket connection
 * @param {Object} data - Restaurant data
 */
function initializeFunctionHandler(ws, data) {
    clientWebSocket = ws;
    restaurantData = data;
    debug('Function handler initialized with WebSocket and restaurant data');
}

/**
 * Process a function call request from OpenAI
 * @param {Object} request - Function call request data
 * @returns {Promise<Object>} - Result of the function call
 */
async function handleFunctionCallRequest(request) {
    debug('Function call request received:', request);
    
    if (!clientWebSocket) {
        console.error('No client WebSocket connection available');
        return { error: 'No client connection available' };
    }
    
    try {
        // Extract function details
        const functionName = request.name;
        const functionArgs = JSON.parse(request.arguments || '{}');
        const functionId = Date.now().toString(); // Generate a unique ID
        
        debug(`Processing function call: ${functionName}`, functionArgs);
        
        // Send the function call to the client
        await sendActionToClient(functionName, functionArgs, functionId, functionName);
        
        // Return a placeholder result (the actual result will be sent by the client)
        return {
            success: true,
            message: 'Function call sent to client',
            functionId: functionId
        };
        
    } catch (error) {
        console.error('Error handling function call:', error);
        return {
            success: false,
            error: error.message || 'Unknown error'
        };
    }
}

/**
 * Send an action to the client
 * @param {string} type - Action type
 * @param {Object} data - Action data
 * @param {string} functionId - ID of the function call
 * @param {string} functionName - Name of the function
 */
function sendActionToClient(type, data, functionId, functionName) {
    return new Promise((resolve, reject) => {
        if (!clientWebSocket) {
            console.error('No client WebSocket connection available');
            reject(new Error('No client WebSocket connection available'));
            return;
        }
        
        try {
            const action = {
                type: type,
                ...data,
                function_call_id: functionId,
                function_name: functionName
            };
            
            clientWebSocket.send(JSON.stringify({
                type: 'actions',
                actions: [action]
            }));
            
            debug(`Sent ${type} action to client:`, action);
            resolve();
        } catch (error) {
            console.error('Error sending action to client:', error);
            reject(error);
        }
    });
}

/**
 * Find a menu item by name
 * @param {string} name - Item name to find
 * @returns {Object|null} - Menu item object or null if not found
 */
function findMenuItem(name) {
    if (!name || !restaurantData || !restaurantData.menu) return null;
    
    const searchName = name.toLowerCase();
    
    // Search in each menu category
    for (const category of ['pizzas', 'sides', 'drinks', 'desserts']) {
        const items = restaurantData.menu[category];
        if (!items) continue;
        
        const found = items.find(item => item.name.toLowerCase() === searchName);
        if (found) return found;
    }
    
    // Check for alternative names
    if (restaurantData.menuKeywords) {
        for (const [keyword, variants] of Object.entries(restaurantData.menuKeywords)) {
            if (keyword.toLowerCase() === searchName) {
                const id = variants[0];
                
                // Search for item by ID
                for (const category of ['pizzas', 'sides', 'drinks', 'desserts']) {
                    const items = restaurantData.menu[category];
                    if (!items) continue;
                    
                    const found = items.find(item => item.id === id);
                    if (found) return found;
                }
            }
        }
    }
    
    return null;
}

/**
 * Calculate the price of an item based on size and customizations
 * @param {Object} item - Cart item
 * @returns {number} - Total price
 */
function calculateItemPrice(item) {
    if (!item) return 0;
    
    let basePrice = item.price || 0;
    
    // Adjust for size if applicable
    if (item.size && restaurantData && restaurantData.customizations && 
        restaurantData.customizations.sizes) {
        
        const sizeData = restaurantData.customizations.sizes.find(
            s => s.name.toLowerCase() === item.size.toLowerCase());
        
        if (sizeData && sizeData.adjustmentFactor) {
            basePrice *= sizeData.adjustmentFactor;
        }
    }
    
    // Add cost for customizations
    let additionalCost = 0;
    
    if (item.customizations && item.customizations.length > 0 && 
        restaurantData && restaurantData.customizations &&
        restaurantData.customizations.toppings) {
        
        for (const customization of item.customizations) {
            if (!customization) continue;
            
            // Handle cases where customization might be an object or a string
            const customizationName = typeof customization === 'string' ? 
                customization : (customization.name || '');
            
            const toppingData = restaurantData.customizations.toppings.find(
                t => t.name && t.name.toLowerCase() === customizationName.toLowerCase());
            
            if (toppingData && toppingData.price) {
                additionalCost += toppingData.price;
            }
        }
    }
    
    // Calculate total based on quantity
    return parseFloat(((basePrice + additionalCost) * (item.quantity || 1)).toFixed(2));
}

module.exports = {
    initializeFunctionHandler,
    handleFunctionCallRequest,
    findMenuItem,
    calculateItemPrice
};