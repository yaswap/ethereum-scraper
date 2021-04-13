const asyncHandler = require('express-async-handler')
const Transaction = require('../models/Transaction')
const { createCommonQuery } = require('../utils')
const router = require('express').Router()

router.get('/:account', asyncHandler(async (req, res) => {
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

  const latestBlock = ethersProvider.getBlockNumber()
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

module.exports = router
