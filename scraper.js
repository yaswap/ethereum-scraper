const Sentry = require('@sentry/node')
const Bluebird = require('bluebird')
const { ethers, BigNumber, logger } = require('ethers')

const eventList = require('./eventList')
const Transaction = require('./models/Transaction')
const { logParser } = require('./utils')

const {
  WEB3_URI,
  MAX_BLOCK_BATCH_SIZE,
  MAX_TRANSACTION_BATCH_SIZE,
  START_BLOCK,
  END_BLOCK,
  REORG_GAP,
  BLOCKTIME
} = process.env

if (!MAX_BLOCK_BATCH_SIZE) throw new Error('Invalid MAX_BLOCK_BATCH_SIZE')
if (!MAX_TRANSACTION_BATCH_SIZE) throw new Error('Invalid MAX_TRANSACTION_BATCH_SIZE')
if (!START_BLOCK) throw new Error('Invalid START_BLOCK')
if (!REORG_GAP) throw new Error('Invalid REORG_GAP')

const SUPPORTS_WS = WEB3_URI.startsWith('ws')

let ethersProvider
let syncing = true
let latestBlockNumber = null

process.on('unhandledRejection', error => { throw error })

function handleError (e) {
  console.error(e)
  process.exit(1)
}

if (SUPPORTS_WS) {
  ethersProvider = new ethers.providers.WebSocketProvider(WEB3_URI)
  ethersProvider.on('error', handleError)
  ethersProvider.on('end', handleError)
} else {
  ethersProvider = new ethers.providers.JsonRpcProvider(WEB3_URI)
}

async function sleep (duration) {
  return new Promise(resolve => setTimeout(resolve, duration))
}

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

  const exist = await Transaction.findOne({
    blockNumber: blockNum
  }).exec()
  if (exist) return

  const block = await ethersProvider.getBlockWithTransactions(blockNum)
  if (!block) return

  const blockNumber = block.number
  const blockHash = block.hash
  const timestamp = block.timestamp

  const events = {}
  let transactions = []
  const blockTransaction = block.transactions.map(tx => ({ ...tx, input: tx.data }))

  await Bluebird.map(blockTransaction, async ({ hash, from, to, input, value }) => {
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

  console.log(log.join(' '))
}

async function sync () {
  const lastBlockInRange = await Transaction.getLastBlockInRange(START_BLOCK, END_BLOCK)

  let startFrom
  if (lastBlockInRange) {
    startFrom = lastBlockInRange + 1
  } else {
    startFrom = Number(START_BLOCK)
  }

  let batch = []
  for (let i = startFrom; ; i++) {
    batch.push(handleBlock(i))

    if (batch.length === Number(MAX_BLOCK_BATCH_SIZE)) {
      await Promise.all(batch)
      batch = []
    }

    if (END_BLOCK && i >= Number(END_BLOCK)) {
      console.log('Reached END_BLOCK', END_BLOCK)
      break
    }

    if (latestBlockNumber && i >= latestBlockNumber) {
      console.log('Reached latestBlockNumber', latestBlockNumber)
      break
    }
  }

  if (batch.length !== 0) {
    await Promise.all(batch)
  }

  syncing = false

  console.log('Synced!')
}

async function getLatestBlock () {
  latestBlockNumber = await ethersProvider.getBlockNumber()
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

async function poll () {
  if (!BLOCKTIME) throw new Error('Invalid BLOCKTIME')

  while (true) {
    const blockNumber = await ethersProvider.getBlockNumber()
    if (latestBlockNumber === blockNumber) {
      await sleep(Number(BLOCKTIME))
    } else {
      await onNewBlock(blockNumber)
    }
  }
}

;(async () => {
  await getLatestBlock()
  SUPPORTS_WS ? subscribe() : poll()
  sync()
})()

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
