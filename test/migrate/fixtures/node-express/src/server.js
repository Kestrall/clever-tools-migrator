const express = require('express');

const app = express();
const port = 3000;

// Example: app.listen(5000) in older versions
app.get('/', (req, res) => res.send('ok'));

app.listen(port, '127.0.0.1', () => {
  console.log(`listening on ${port}`);
});
