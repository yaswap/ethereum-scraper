const Sentry = require('@sentry/node');

const { ethers } = require('ethers');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const debug = require('debug')('api');
const { PORT, WEB3_URI, NODE_ENV } = process.env;

if (!PORT) throw new Error('Invalid PORT');

const app = express();
let ethersProvider = null

function initEthersProvider() {
  ethersProvider = WEB3_URI.startsWith('ws')
    ? new ethers.providers.WebSocketProvider(WEB3_URI)
    : new ethers.providers.StaticJsonRpcProvider(WEB3_URI);

  ethersProvider.on('connect', () => {
    debug('ethersProvider WebSocket connected');
  });

  ethersProvider.on('error', (error) => {
    debug('ethersProvider WebSocket error', error);
  });

  ethersProvider.on('close', () => {
    debug('ethersProvider WebSocket closed 1, attempting to reconnect...');
    ethersProvider._websocket.terminate();
    sleep(3000); // wait before reconnect
    initEthersProvider(); // Reinitialize the event listeners
  });

  ethersProvider._websocket.on('close', () => {
    debug('ethersProvider WebSocket closed 2, attempting to reconnect...');
    ethersProvider._websocket.terminate();
    sleep(3000); // wait before reconnect
    initEthersProvider(); // Reinitialize the event listeners
  });
}

initEthersProvider();

if (NODE_ENV === 'production') {
  app.use(Sentry.Handlers.requestHandler());
}

app.use(helmet());
app.use(compression());
app.use(require('./middlewares/httpHelpers'));
app.set('etag', false);
app.set('ethers', ethersProvider);
app.set('debug', debug);

app.use('/status', require('./routes/status'));
app.use('/txs', require('./routes/txs'));
app.use('/events', require('./routes/events'));

app.use((err, req, res, next) => {
  const status = err.statusCode || 500;
  const message = err.message || err.toString();

  if (NODE_ENV !== 'production') {
    console.error(err);
  }

  return res.notOk(status, message);
});

ethersProvider.ready.then(() => {
  let server = app.listen(PORT);
  debug(`API is running on ${PORT}`);
});
