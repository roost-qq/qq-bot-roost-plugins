export const PRIVATE_MESSAGE_PROVIDER_IDS = Object.freeze(['bilibili', 'xiaoheihe']);

const PROVIDERS = Object.freeze({
  bilibili: Object.freeze({
    id: 'bilibili',
    label: 'B站',
    statusLabel: 'B站',
    aliases: Object.freeze(['bilibili', 'b站', '哔哩哔哩']),
    capabilities: Object.freeze({
      supportsPrivateMessages: true,
      supportsQrLogin: true,
      supportsManualLogin: true,
      transport: 'poll',
      verified: true,
    }),
  }),
  xiaoheihe: Object.freeze({
    id: 'xiaoheihe',
    label: '小黑盒',
    statusLabel: '小黑盒',
    aliases: Object.freeze(['xiaoheihe', 'heybox', '小黑盒']),
    capabilities: Object.freeze({
      supportsPrivateMessages: true,
      supportsQrLogin: true,
      supportsManualLogin: true,
      transport: 'poll',
      verified: true,
    }),
  }),
});

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function getPrivateMessageProvider(providerId) {
  const id = normalized(providerId);
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

export function resolvePrivateMessageProvider(value) {
  const text = normalized(value);
  if (!text) return null;
  for (const id of PRIVATE_MESSAGE_PROVIDER_IDS) {
    const provider = PROVIDERS[id];
    if (provider.aliases.includes(text)) return provider;
  }
  return null;
}

export function isPrivateMessageProviderId(value) {
  return getPrivateMessageProvider(value) !== null;
}

export function publicProviderCapabilities(provider) {
  const value = getPrivateMessageProvider(provider?.id ?? provider);
  if (!value) return null;
  const out = {
    ...value.capabilities,
    available: value.capabilities.supportsPrivateMessages === true,
  };
  // Keep the established Bilibili capability shape. Xiaoheihe no longer
  // publishes an experimental marker now that it is a formal capability.
  if (value.id !== 'xiaoheihe') out.experimental = value.capabilities.experimental === true;
  return out;
}

export function providerDisplayName(providerId) {
  return getPrivateMessageProvider(providerId)?.label ?? '';
}
