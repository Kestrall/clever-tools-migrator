import express from 'express';
const app = express();
const redisUrl = 'redis://localhost:6379';
app.get('/health', (_req, res) => res.send('ok'));
app.listen(3000, () => console.log('listening'));
