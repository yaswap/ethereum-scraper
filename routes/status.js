const asyncHandler = require('express-async-handler')
const Transaction = require('../models/Transaction')
const { parseNonZeroPositiveIntOrDefault } = require('../utils')
const router = require('express').Router()

router.get('/', asyncHandler(async (req, res, next) => {
  req.app.get('debug')('/status, Start handling request')
  const ethersProvider = req.app.get('ethers')
  let { maxgap } = req.query

  req.app.get('debug')('/status, Getting latestBlock and tx')

  // Function to get block number with timeout
  const getBlockNumberWithTimeout = async (provider, timeout = 10000) => {
    return Promise.race([
      provider.getBlockNumber(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    ])
  }

  try {
    const [latestBlock, tx] = await Promise.all([
      getBlockNumberWithTimeout(ethersProvider),
      Transaction.findOne({}).sort('-blockNumber').select('blockNumber').exec()
    ])
    req.app.get('debug')(`/status, latestBlock = ${latestBlock} and tx = ${tx}`)

    const difference = latestBlock - tx.blockNumber

    maxgap = parseNonZeroPositiveIntOrDefault(maxgap, false)

    res.set('Access-Control-Allow-Origin', '*')

    const status = {
      latestBlockNumber: latestBlock,
      latestScrapedBlockNumber: tx.blockNumber,
      difference
    }

    req.app.get('debug')(`/status, Return status = ${status}`)
    if (maxgap && difference > maxgap) {
      res.status(503)
      res.json({
        status: 'ERROR',
        data: { status }
      })
      return
    }

    res.json({
      status: 'OK',
      data: { status }
    })
  } catch (error) {
    req.app.get('debug')(`/status, Error: ${error.message}`)
    res.status(500)
    res.json({
      status: 'ERROR',
      message: error.message
    })
  }
}))

module.exports = router