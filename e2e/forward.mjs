// Forwards localhost ports to the services, so the browser sees secure origins (http://localhost)
// and WebCrypto is available without flags: 8080 → cryptex, 8081 → cryptex-demo.
import net from 'node:net';

const routes = { 8080: ['cryptex', 8080], 8081: ['cryptex-demo', 8080] };
for (const [port, [host, target]] of Object.entries(routes)) {
  net.createServer((client) => {
    const upstream = net.connect(target, host);
    client.pipe(upstream).pipe(client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close);
    upstream.on('error', close);
  }).listen(Number(port), '127.0.0.1');
}
