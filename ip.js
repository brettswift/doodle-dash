'use strict';
// Client-address classification shared by the Node and Cloudflare hosts.
const net = require('node:net');
// Public-routable only: anything private/loopback/link-local/CGNAT/ULA is never a usable client identity.
function isPublicIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
  }
  if (v === 6) { const l = ip.toLowerCase(); return !(l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('::ffff:')); }
  return false;
}
module.exports = { isPublicIp };
