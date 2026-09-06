import net from 'node:net';

const server = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (data) => {
    buf += data.toString('utf8');
    // Simple RESP command parser
    while (buf.length > 0) {
      // Find end of line or command
      const lower = buf.toLowerCase();
      if (lower.includes('ping')) {
        socket.write('+PONG\r\n');
        buf = '';
      } else if (lower.includes('info')) {
        const info = 'redis_version:7.2.0\r\nrole:master\r\nconnected_clients:1\r\n';
        socket.write(`$${info.length}\r\n${info}\r\n`);
        buf = '';
      } else if (lower.includes('client') || lower.includes('select') || lower.includes('auth')) {
        socket.write('+OK\r\n');
        buf = '';
      } else if (lower.includes('eval') || lower.includes('evalsha')) {
        // Rate-limit-redis eval returns [totalHits, timeToExpireMs]
        socket.write('*2\r\n:1\r\n:60000\r\n');
        buf = '';
      } else if (lower.includes('quit')) {
        socket.write('+OK\r\n');
        socket.end();
        buf = '';
      } else {
        // Default ok / generic response
        socket.write('+OK\r\n');
        buf = '';
      }
    }
  });
});

server.listen(6379, '127.0.0.1', () => {
  console.log('Mock Redis listening on 127.0.0.1:6379');
});
