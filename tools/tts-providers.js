'use strict';
const doubao = require('./tts-api-doubao');

const providers = new Map();

function register(provider) {
  if (!provider || typeof provider.name !== 'string') throw new Error('tts provider must have a name string');
  if (typeof provider.synth !== 'function') throw new Error(`tts provider "${provider.name}" must export a synth function`);
  providers.set(provider.name, provider);
}

function getProvider(name) {
  const p = providers.get(name);
  if (!p) throw new Error(`unknown TTS provider: "${name}" (registered: ${[...providers.keys()].join(', ') || 'none'})`);
  return p;
}

function listProviders() {
  return [...providers.keys()];
}

register({
  name: 'doubao',
  synth({ text, voiceId, provider, ttsParams }) {
    return doubao.synthDoubao({
      text,
      voiceId,
      resourceId: (provider && provider.resource_id) || undefined,
      speechRate: doubao.speedToSpeechRate(ttsParams && ttsParams.speed)
    });
  },
  classifyError: doubao.classifyTtsError
});

module.exports = { register, getProvider, listProviders };
