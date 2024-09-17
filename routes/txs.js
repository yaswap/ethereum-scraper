const asyncHandler = require('express-async-handler')
const Transaction = require('../models/Transaction')
const { createCommonQuery, getBlockNumberWithTimeout } = require('../utils')
const router = require('express').Router()

router.get('/:account', asyncHandler(async (req, res) => {
  req.app.get('debug')('/txs, Start handling request')
  const ethersProvider = req.app.get('ethers')
  const { account } = req.params

  const { filter, options, pagination } = createCommonQuery(req.query)

  const q = Transaction.find({
    ...filter,
    $or: [
      { to: account },
      { from: account }
    ]
  }, null, options)

  const [latestBlock, txs] = await Promise.all([
    getBlockNumberWithTimeout(ethersProvider),
    q.exec()
  ])

  const data = { pagination }

  data.txs = txs.map(tx => {
    const json = tx.toJSON()

    delete json._id
    delete json.__v

    json.confirmations = latestBlock - tx.blockNumber

    return json
  })

  res.set('Access-Control-Allow-Origin', '*')

  res.json({
    status: 'OK',
    data
  })
}))

module.exports = router
