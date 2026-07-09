const net = require('node:net');

function isDeployedSmokeOrigin(url) {
  try {
    const parsed = new URL(url || '');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const hostname = normalizeHostname(parsed.hostname);
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;

    const ipVersion = net.isIP(hostname);
    if (ipVersion === 4) return !isBlockedIpv4(hostname);
    if (ipVersion === 6) return !isBlockedIpv6(hostname);

    return true;
  } catch {
    return false;
  }
}

function normalizeHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function isBlockedIpv4(hostname) {
  const parts = parseIpv4(hostname);
  if (!parts) return true;

  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && parts[2] === 0)
    || (a === 192 && b === 0 && parts[2] === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && parts[2] === 100)
    || (a === 203 && b === 0 && parts[2] === 113)
    || a >= 224;
}

function parseIpv4(hostname) {
  const parts = String(hostname || '').split('.').map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

function isBlockedIpv6(hostname) {
  const normalized = normalizeHostname(hostname);
  const mappedIpv4 = ipv4FromMappedIpv6(normalized);
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);

  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized === '2001:db8'
    || normalized.startsWith('2001:db8:');
}

function ipv4FromMappedIpv6(hostname) {
  const dotted = hostname.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) {
    return parseIpv4(dotted[1]) ? dotted[1] : null;
  }

  const hex = hostname.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;

  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low) || high > 0xffff || low > 0xffff) {
    return null;
  }

  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join('.');
}

module.exports = {
  isBlockedIpv4,
  isBlockedIpv6,
  isDeployedSmokeOrigin,
  ipv4FromMappedIpv6,
};
