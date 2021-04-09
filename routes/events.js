const asyncHandler = require('express-async-handler')
const EventERC20Transfer = require('../models/EventERC20Transfer')
const EventSwapClaim = require('../models/EventSwapClaim')
const EventSwapRefund = require('../models/EventSwapRefund')
const { createCommonQuery, findSwapEventFromReq } = require('../utils')
const router = require('express').Router()

router.get('/erc20Transfer/:contractAddress', asyncHandler(async (req, res) => {
  const ethersProvider = req.app.get('ethers')
  const { contractAddress } = req.params

  const { address } = req.query
  if (!address) return res.notOk(400, 'Missing query: address')
  const { filter, options, pagination } = createCommonQuery(req.query)

  const q = EventERC20Transfer.find({
    ...filter,
    contractAddress,
    $or: [
      { to: address },
      { from: address }
    ]
  }, null, options)

  const latestBlock = await ethersProvider.getBlockNumber()
  const [latest, txs] = await Promise.all([
    ethersProvider.getBlockWithTransactions(latestBlock),
    q.exec()
  ])

  const data = { pagination }

  data.txs = txs.map(tx => {
    const json = tx.toJSON()

    delete json._id
    delete json.__v

    json.confirmations = latest.number - tx.blockNumber

    return json
  })

  res.set('Access-Control-Allow-Origin', '*')

  res.json({
    status: 'OK',
    data
  })
}))

router.get('/swapClaim/:contractAddress', asyncHandler(async (req, res) => {
  const tx = await findSwapEventFromReq(EventSwapClaim, req)

  res.set('Access-Control-Allow-Origin', '*')

  res.json({
    status: 'OK',
    data: { tx }
  })
}))

router.get('/swapRefund/:contractAddress', asyncHandler(async (req, res) => {
  const tx = await findSwapEventFromReq(EventSwapRefund, req)

  res.set('Access-Control-Allow-Origin', '*')

  res.json({
    status: 'OK',
    data: { tx }
  })
}))

module.exports = router
