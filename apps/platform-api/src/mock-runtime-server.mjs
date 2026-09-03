import { createServer } from 'node:http';

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

const port = Number(process.env.PORT ?? 8090);
const server = createServer((request, response) => {
  if (request.url === '/healthz') return json(response, 200, { status: 'ok', runtime: 'mock' });
  return json(response, 200, {
    service: 'bairui-mock-runtime',
    message: 'Mock Runtime endpoint. Conversation traffic is handled through platform-api.',
    path: request.url,
  });
});

server.listen(port, '0.0.0.0', () => console.log('mock-runtime listening on :' + port));
