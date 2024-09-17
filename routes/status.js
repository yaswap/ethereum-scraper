const asyncHandler = require('express-async-handler')
const Transaction = require('../models/Transaction')
const { parseNonZeroPositiveIntOrDefault } = require('../utils')
const router = require('express').Router()

router.get('/', asyncHandler(async (req, res, next) => {
  console.log('/status, Start handling status request')
  const ethersProvider = req.app.get('ethers')
  let { maxgap } = req.query

  console.log('/status, Getting lattestBlock and tx')
  const [latestBlock, tx] = await Promise.all([
    ethersProvider.getBlockNumber(),
    Transaction.findOne({}).sort('-blockNumber').select('blockNumber').exec()
  ])
  console.log(`/status, latestBlock = ${latestBlock} and tx = ${tx}`)

  const difference = latestBlock - tx.blockNumber

  maxgap = parseNonZeroPositiveIntOrDefault(maxgap, false)

  res.set('Access-Control-Allow-Origin', '*')

  const status = {
    latestBlockNumber: latestBlock,
    latestScrapedBlockNumber: tx.blockNumber,
    difference
  }

  console.log(`/status, Return status = ${status}`)
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
}))

module.exports = router
