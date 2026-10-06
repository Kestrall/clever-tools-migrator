const http = require('http');

/*
 * The metrics server used to be started with server.listen(9100)
 */
http.createServer((req, res) => res.end('metrics')).listen(9100);
