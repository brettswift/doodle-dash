'use strict';
// Minimal RFC 6455 server: text frames only, no fragmentation, no extensions.
const crypto = require('node:crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function accept(req, socket, { maxPayload = 8192, onMessage, onClose }) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const hash = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`);
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let closed = false;
  let alive = Date.now();

  const frame = (op, payload) => {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len])
      : Buffer.from([0x80 | op, 126, len >> 8, len & 255]);
    return Buffer.concat([head, payload]);
  };
  const conn = {
    send(str) { if (!closed && socket.writable && socket.writableLength < 1 << 20) socket.write(frame(1, Buffer.from(str))); },
    close(code = 1000) {
      if (closed) return;
      const p = Buffer.alloc(2); p.writeUInt16BE(code);
      try { socket.end(frame(8, p)); } catch {}
      closed = true; onClose();
    },
    ping() { if (!closed) { socket.write(frame(9, Buffer.alloc(0))); } },
    idleMs() { return Date.now() - alive; },
  };
  const fail = (code) => conn.close(code);

  socket.on('data', (d) => {
    if (closed) return;
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
      let len = buf[1] & 127, off = 2;
      if (!masked || !fin || (buf[0] & 0x70)) return fail(1002);
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) return fail(1009);
      if (len > maxPayload) return fail(1009);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      alive = Date.now();
      if (op === 1) onMessage(data.toString('utf8'));
      else if (op === 8) return conn.close(1000);
      else if (op === 9) socket.write(frame(10, data.subarray(0, 125)));
      else if (op !== 10) return fail(1003);
    }
  });
  const gone = () => { if (!closed) { closed = true; onClose(); } };
  socket.on('close', gone);
  socket.on('error', gone);
  return conn;
}
module.exports = { accept };
