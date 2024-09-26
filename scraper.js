const Sentry = require('@sentry/node')
const Bluebird = require('bluebird')
const { ethers, BigNumber, logger } = require('ethers')
const debug = require('debug')('scraper')

const eventList = require('./eventList')
const Transaction = require('./models/Transaction')
const { logParser, isSwapTransaction, EVENT_SIG_MAP, getBlockNumberWithTimeout } = require('./utils')

const {
  WEB3_URI,
  MAX_BLOCK_BATCH_SIZE,
  MAX_TRANSACTION_BATCH_SIZE,
  START_BLOCK,
  END_BLOCK,
  REORG_GAP,
  BLOCKTIME,
  SWAP_ONLY_MODE
} = process.env

if (!MAX_BLOCK_BATCH_SIZE) throw new Error('Invalid MAX_BLOCK_BATCH_SIZE')
if (!MAX_TRANSACTION_BATCH_SIZE) throw new Error('Invalid MAX_TRANSACTION_BATCH_SIZE')
if (!REORG_GAP) throw new Error('Invalid REORG_GAP')
process.on('unhandledRejection', error => { throw error })

const HANDLE_BLOCK_TIMEOUT = 180000 // 180 seconds timeout
const EXPECTED_PONG_BACK = 10000 // 10 seconds
const KEEP_ALIVE_CHECK_INTERVAL = 60000 // 1 minute

let ethersProvider
let syncing = true
let latestBlockNumber = null

// BEGINNING: UTILITY FUNCTIONS
function handleError (e) {
  debug('ethersProvider WebSocket error', e);
  process.exit(1)
}

function exit (blockNum) {
  debug(`Self-terminate due to handleBlock (block ${blockNum}) hangs in ${HANDLE_BLOCK_TIMEOUT/1000} seconds !!!`)
  process.kill(process.pid, "SIGTERM");
}

async function sleep (duration) {
  return new Promise(resolve => setTimeout(resolve, duration))
}

function check(format, object) {
  const result = {}
  for (const key in format) {
    try {
      let value = format[key](object[key])
      if (value !== undefined) {
        result[key] = value
      }
    }
    catch (error) {
      error.checkKey = key
      error.checkValue = object[key]
      throw error
    }
  }
  return result
}
// END: UTILITY FUNCTIONS

// BEGINNING: PARSE BLOCKS/EVENTS FUNCTIONS
async function getTransactionReceipt (hash, attempts = 1) {
  const receipt = await ethersProvider.getTransactionReceipt(hash)
  if (receipt) return receipt

  if (attempts <= 3) {
    await sleep(5000)
    return getTransactionReceipt(hash, attempts + 1)
  }

  throw new Error('Unable to fetch transaction receipt')
}

async function handleBlock (blockNum) {
  if (!blockNum) return

  debug(`handleBlock ${blockNum}`)

  // Add timeout for handling block execution
  const handleBlockTimeoutAction = setTimeout(function(){
    exit(blockNum)
  }, HANDLE_BLOCK_TIMEOUT);

  const exist = await Transaction.findOne({
    blockNumber: blockNum
  }).exec()
  if (exist) {
    clearTimeout(handleBlockTimeoutAction);
    return
  }

  const block = await ethersProvider.getBlockWithTransactions(blockNum)
  if (!block) {
    clearTimeout(handleBlockTimeoutAction);
    return
  }

  const blockNumber = block.number
  const blockHash = block.hash
  const timestamp = block.timestamp

  const events = {}
  let transactions = []
  let blockTransactions = block.transactions.map(tx => ({ ...tx, input: tx.data }))

  if (SWAP_ONLY_MODE === 'true') {
    const eventTopics = Object.keys(EVENT_SIG_MAP)
    const blockEvents = await ethersProvider.getLogs({ topics: [eventTopics], fromBlock: blockNum, toBlock: blockNum })
    const blockTransactionsWithEvents = blockEvents.map(e => e.transactionHash)
    blockTransactions = blockTransactions.filter(tx => isSwapTransaction(tx) || blockTransactionsWithEvents.includes(tx.hash))
  }

  await Bluebird.map(blockTransactions, async ({ hash, from, to, input, value }) => {
    try {
      const { status, contractAddress, logs } = await getTransactionReceipt(hash)

      logs
        .map(logParser)
        .filter(l => !!l)
        .forEach(({ model, contractAddress, data }) => {
          const commons = { hash, blockHash, blockNumber, status, timestamp }

          if (!events[model.modelName]) events[model.modelName] = []
          events[model.modelName].push({
            ...commons,
            ...data,
            contractAddress
          })
        })

      transactions.push({
        from,
        to,
        hash,
        blockHash,
        blockNumber,
        status,
        input,
        contractAddress,
        timestamp,
        value
      })
    } catch (e) {
      Sentry.withScope(scope => {
        scope.setTag('blockNumber', blockNumber)
        scope.setTag('blockHash', blockHash)
        scope.setTag('hash', hash)
        scope.setTag('from', from)
        scope.setTag('to', to)

        scope.setExtra('input', input)
        scope.setExtra('value', value)

        Sentry.captureException(e)
      })

      throw e
    }
  }, { concurrency: Number(MAX_TRANSACTION_BATCH_SIZE) })

  if (transactions.length === 0) {
    transactions = [{
      blockHash,
      blockNumber
    }]
  }

  await Transaction.insertMany(transactions, { ordered: false })

  const eventEntries = Object.entries(events)
  await Bluebird.map(eventEntries, async ([modelName, _events]) => {
    if (_events.length > 0) {
      const event = eventList.find(event => event.model.modelName === modelName)
      if (!event) throw new Error(`Unknown event model: ${modelName}`)
      await event.model.insertMany(_events, { ordered: false })
    }
  }, { concurrency: 1 })

  const log = [
    `#${blockNumber}[${block.transactions.length}]`
  ]

  const compareWith = Number(END_BLOCK) || latestBlockNumber
  if (compareWith) {
    const diff = compareWith - blockNum
    const progress = Math.floor((1 - (diff / compareWith)) * 10000) / 100
    log.push(`${progress}%`)
  }

  clearTimeout(handleBlockTimeoutAction);
  debug(`Complete handleBlock ${blockNum}`)
  debug(log.join(' '))
}

async function sync () {
  syncing = true
  const lastBlockInRange = await Transaction.getLastBlockInRange(START_BLOCK, END_BLOCK)

  let startFrom
  if (lastBlockInRange) {
    startFrom = lastBlockInRange + 1
  } else if (!START_BLOCK) {
    await getLatestBlock()
    startFrom = latestBlockNumber - 1800 // sync 6 hours ago
  } else {
    startFrom = Number(START_BLOCK)
  }

  let batch = []
  for (let i = startFrom; ; i++) {
    batch.push(handleBlock(i))

    if (batch.length === Number(MAX_BLOCK_BATCH_SIZE)) {
      debug(`Syncing ${MAX_BLOCK_BATCH_SIZE} blocks: ${startFrom-MAX_BLOCK_BATCH_SIZE+1} -> ${startFrom}`)
      await Promise.all(batch)
      debug(`Completed syncing ${MAX_BLOCK_BATCH_SIZE} blocks: ${startFrom-MAX_BLOCK_BATCH_SIZE+1} -> ${startFrom}`)
      batch = []
    }

    if (END_BLOCK && i >= Number(END_BLOCK)) {
      debug('Reached END_BLOCK', END_BLOCK)
      break
    }

    if (latestBlockNumber && i >= latestBlockNumber) {
      debug('Reached latestBlockNumber', latestBlockNumber)
      break
    }
  }

  if (batch.length !== 0) {
    debug(`Syncing ${batch.length} blocks: ${startFrom-batch.length+1} -> ${startFrom}`)
    await Promise.all(batch)
    debug(`Completed syncing ${batch.length} blocks`)
  }

  syncing = false

  debug('Synced!')
}

async function getLatestBlock () {
  latestBlockNumber = await getBlockNumberWithTimeout(ethersProvider)
}

function onNewBlock (blockNumber) {
  latestBlockNumber = blockNumber

  if (!syncing && !END_BLOCK) {
    handleBlock(latestBlockNumber - Number(REORG_GAP))
  }
}

function subscribe () {
  ethersProvider.on('block', (blockNumber) => {
    onNewBlock(blockNumber)
  })

  ethersProvider.on('error', (error) => {
    handleError(error)
  })
}
// END: PARSE BLOCKS/EVENTS FUNCTIONS

// BEGINNING: MAIN LOGIC
function initEthersProvider() {
  let pingTimeout = null
  let keepAliveInterval = null
  let pingCount = 0
  ethersProvider = new ethers.providers.WebSocketProvider(WEB3_URI);
  //Patch for RSK Support
  ethersProvider.formatter.receipt = function (value) {
    const result = check(ethersProvider.formatter.formats.receipt, value)

    if (result.root != null) {
      if (result.root.length <= 4) {
        result.root = result.root == '0x' ? '0x0' : result.root
        const tx_root = BigNumber.from(result.root).toNumber()
        if (tx_root === 0 || tx_root === 1) {
          if (result.status != null && (result.status !== tx_root)) {
            logger.throwArgumentError("alt-root-status/status mismatch", "value", { root: result.root, status: result.status })
          }
          result.status = tx_root
          delete result.root
        }
        else {
          logger.throwArgumentError("invalid alt-root-status", "value.root", result.root)
        }
      }
      else if (result.root.length !== 66) {
        logger.throwArgumentError("invalid root hash", "value.root", result.root)
      }
    }

    return result
  }

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
    clearInterval(pingTimeout)
  })

  ethersProvider._websocket.on('open', async () => {
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

    await ethersProvider.ready
    await getLatestBlock()
    subscribe()
    sync()
  })
}

initEthersProvider()
// END: MAIN LOGIC
