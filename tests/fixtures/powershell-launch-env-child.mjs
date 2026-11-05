import fs from 'node:fs';
import net from 'node:net';

const argv = process.argv.slice(2);
let reportFile = process.env.CHILD_REPORT_FILE || null;
let portFile = process.env.CHILD_PORT_FILE || null;
let keepAlive = true;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--report-file' && i + 1 < argv.length) {
    reportFile = argv[i + 1];
    i++;
  } else if (argv[i] === '--port-file' && i + 1 < argv.length) {
    portFile = argv[i + 1];
    i++;
  } else if (argv[i] === '--no-keep-alive') {
    keepAlive = false;
  }
}

const payloadReport = {
  pid: process.pid,
  argv,
  env: { ...process.env },
  cwd: process.cwd()
};

if (reportFile) {
  fs.writeFileSync(reportFile, JSON.stringify(payloadReport, null, 2), 'utf8');
}

if (portFile) {
  const server = net.createServer(s => {
    s.end(JSON.stringify({ pid: process.pid, status: 'ok' }));
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    fs.writeFileSync(portFile, JSON.stringify({ pid: process.pid, port }), 'utf8');
  });
}

if (keepAlive) {
  setInterval(() => {}, 60000);
}
