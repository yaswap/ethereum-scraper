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
const EXPECTED_PONG_BACK = 10000 // 10 seconds
const KEEP_ALIVE_CHECK_INTERVAL = 60000 // 1 minute

if (NODE_ENV === 'production') {
  app.use(Sentry.Handlers.requestHandler());
}

app.use(helmet());
app.use(compression());
app.use(require('./middlewares/httpHelpers'));
app.set('etag', false);
app.set('debug', debug);

function handleError (e) {
  debug('ethersProvider WebSocket error', e);
  process.exit(1)
}

function initEthersProvider() {
  let pingTimeout = null
  let keepAliveInterval = null
  let pingCount = 0
  ethersProvider = new ethers.providers.WebSocketProvider(WEB3_URI);

  ethersProvider.on('connect', () => {
    debug('ethersProvider WebSocket connected');
  });

  ethersProvider.on('error', handleError)
  ethersProvider.on('end', handleError)

  ethersProvider._websocket.on('close', () => {
    debug('ethersProvider WebSocket closed, attempting to reconnect...');
    clearInterval(keepAliveInterval)
    clearTimeout(pingTimeout)
    ethersProvider._websocket.terminate();
    initEthersProvider()
  })

  ethersProvider._websocket.on('pong', () => {
    if (pingCount === 0) {
      debug('ethersProvider WebSocket pong...');
    }
    clearInterval(pingTimeout)
  })

  ethersProvider._websocket.on('open', () => {
    debug('ethersProvider WebSocket open connection...');
    keepAliveInterval = setInterval(() => {
      ethersProvider._websocket.ping()
      pingCount++
      if (pingCount >= 30) {
        debug('ethersProvider WebSocket ping...');
        pingCount = 0
      }

      // Use `WebSocket#terminate()`, which immediately destroys the connection,
      // instead of `WebSocket#close()`, which waits for the close timer.
      // Delay should be equal to the interval at which your server
      // sends out pings plus a conservative assumption of the latency.
      pingTimeout = setTimeout(() => {
        debug('ethersProvider WebSocket ping timeout...');
        ethersProvider._websocket.terminate()
      }, EXPECTED_PONG_BACK)
    }, KEEP_ALIVE_CHECK_INTERVAL)
  })

  app.set('ethers', ethersProvider);
}

initEthersProvider();

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
