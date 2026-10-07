'use strict';

const { OpenAI } = require('openai');

// Default model for all OpenAI calls in the project
const OPENAI_DEFAULT_MODEL = 'gpt-6.1-sol';

// Note: GPT-6 models are reasoning models; they do not accept `temperature`/`top_p`
// or `reasoning.effort: 'none'`. Use `low` for simple extraction and `medium` by default.

// Clients cached per environment variable (each integration uses its own key)
const clients = new Map();

/**
 * Returns a shared OpenAI client, created lazily.
 * The key is read at call time to respect the loading
 * of variables from SSM Parameter Store.
 * @param {string} apiKeyEnvVar - Name of the environment variable holding the API key
 * @returns {OpenAI}
 */
function getOpenAIClient(apiKeyEnvVar = 'OPENAI_API_KEY') {
    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey) {
        throw new Error(`openai_api_key_missing:${apiKeyEnvVar}`);
    }

    const cached = clients.get(apiKeyEnvVar);
    if (cached && cached.apiKey === apiKey) {
        return cached.client;
    }

    const client = new OpenAI({ apiKey });
    clients.set(apiKeyEnvVar, { apiKey, client });
    return client;
}

module.exports = {
    OPENAI_DEFAULT_MODEL,
    getOpenAIClient
};
