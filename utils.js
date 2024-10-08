const Abi = require('web3-eth-abi')
const createKeccakHash = require('keccak')

const eventList = require('./eventList')
const ensure0xTypes = ['address', 'bytes32']

const keccak256 = str => createKeccakHash('keccak256').update(str).digest().toString('hex')
const ensure0x = value => value.startsWith('0x') ? value : `0x${value}`

const EVENT_SIG_MAP = eventList.reduce((acc, event, index) => {
  const signature = ensure0x(keccak256(event.name))
  acc[signature] = event
  return acc
}, {})

const parseNonZeroPositiveIntOrDefault = (value, defaultValue) => {
  try {
    value = parseInt(value)
    if (!(value > 0)) throw new Error('Invalid value')
  } catch (e) {
    return defaultValue
  }

  return value
}

const createCommonQuery = ({ limit, page, sort, fromBlock, toBlock }) => {
  const filter = {}
  const options = {}

  fromBlock = parseNonZeroPositiveIntOrDefault(fromBlock, false)
  toBlock = parseNonZeroPositiveIntOrDefault(toBlock, false)

  if (fromBlock !== false) {
    filter.blockNumber = {
      $gte: fromBlock
    }
  }

  if (toBlock !== false) {
    if (fromBlock !== false) {
      filter.blockNumber.$lte = toBlock
    } else {
      filter.blockNumber = {
        $lte: toBlock
      }
    }
  }

  if (sort === 'asc') {
    options.sort = { blockNumber: 1 }
  } else {
    sort = 'desc'
    options.sort = { blockNumber: -1 }
  }

  page = parseNonZeroPositiveIntOrDefault(page, 1)
  limit = parseNonZeroPositiveIntOrDefault(limit, 1)

  options.limit = limit
  options.skip = limit * (page - 1)

  return {
    filter,
    options,
    pagination: {
      sort,
      page,
      limit
    }
  }
}

const logParser = ({ address, topics, data }) => {
  const signature = topics.shift()
  const event = EVENT_SIG_MAP[signature]
  if (!event) return false

  const { abi, model } = event

  try {
    const decodedLog = Abi.decodeLog(abi, data, topics)
    const decodedLogWith0x = Object
      .entries(decodedLog)
      .reduce((acc, [key, value]) => {
        if (ensure0xTypes.includes(key)) {
          value = ensure0x(value)
        }

        acc[key] = value

        return acc
      }, {})

    return {
      model,
      contractAddress: ensure0x(address),
      data: decodedLogWith0x
    }
  } catch (e) {
    return false
  }
}

const findSwapEventFromReq = async (model, req) => {
  const ethersProvider = req.app.get('ethers')
  const contractAddress = req.params.contractAddress.toLowerCase()

  const [latestBlock, tx] = await Promise.all([
    getBlockNumberWithTimeout(ethersProvider),
    model.findOne({ contractAddress }).exec()
  ])

  if (tx) {
    tx.confirmations = latestBlock - tx.blockNumber
  }

  return tx
}

function isSwapTransaction (tx) {
  // ETH Contract
  if (!tx.to && tx.data.startsWith('0x60c880600b6000396000f36020806000803760218160008060026048f136602014')) return true
  // ETH Contract (extra gas)
  if (!tx.to && tx.data.startsWith('0x60c980600b6000396000f360208060008037602181600080600261fffff136602014')) return true
  // ERC20 Contract
  if (!tx.to && tx.data.endsWith('421161009b57600080fd5b600354604080516370a0823160e01b815230600482015290516000926001600160a01b0316916370a08231916024808301926020929190829003018186803b1580156100e657600080fd5b505afa1580156100fa573d6000803e3d6000fd5b505050506040513d602081101561011057600080fd5b505190508061011e57600080fd5b600154600354604080516370a0823160e01b815230600482015290516101fe9363a9059cbb60e01b936001600160a01b03918216939116916370a0823191602480820192602092909190829003018186803b15801561017c57600080fd5b505afa158015610190573d6000803e3d6000fd5b505050506040513d60208110156101a657600080fd5b5051604080516001600160a01b0390931660248401526044808401929092528051808403909201825260649092019091526020810180516001600160e01b03166001600160e01b03199093169290921790915261040d565b6040517f5d26862916391bf49478b2f5103b0720a842b45ef145a268f2cd1fb2aed5517890600090a16001546001600160a01b0316ff5b6024361461024257600080fd5b600454600282604051602001808281526020019150506040516020818303038152906040526040518082805190602001908083835b602083106102965780518252601f199092019160209182019101610277565b51815160209384036101000a60001901801990921691161790526040519190930194509192505080830381855afa1580156102d5573d6000803e3d6000fd5b5050506040513d60208110156102ea57600080fd5b5051146102f657600080fd5b600354604080516370a0823160e01b815230600482015290516000926001600160a01b0316916370a08231916024808301926020929190829003018186803b15801561034157600080fd5b505afa158015610355573d6000803e3d6000fd5b505050506040513d602081101561036b57600080fd5b505190508061037957600080fd5b600054604080516001600160a01b039092166024830152604480830184905281518084039091018152606490920190526020810180516001600160e01b031663a9059cbb60e01b1790526103cc9061040d565b6040805183815290517f8c1d64e3bd87387709175b9ef4e7a1d7a8364559fc0e2ad9d77953909a0d1eb39181900360200190a16000546001600160a01b0316ff5b600061041882610446565b8051909150156104425780806020019051602081101561043757600080fd5b505161044257600080fd5b5050565b600254604051825160609260009283926001600160a01b0390921691869190819060208401908083835b6020831061048f5780518252601f199092019160209182019101610470565b6001836020036101000a0380198251168184511680821785525050505050509050019150506000604051808303816000865af19150503d80600081146104f1576040519150601f19603f3d011682016040523d82523d6000602084013e6104f6565b606091505b5091509150811561050a57915061051a9050565b8051156100365780518082602001fd5b91905056fea2646970667358221220439a725cbd518d89b852af5b7e1c335cc4ba64e029f96f6c702b2e60fb985ba564736f6c63430007060033')) return true

  // ETH Claim
  if (tx.to && tx.value === '0x0' && tx.data.replace('0x', '').length === 64) return true
  // ETH Refund
  if (tx.to && tx.value === '0x0' && tx.data.replace('0x', '').length === 0) return true

  // ERC20 Funding (ERC20 transfer)
  if (tx.data.startsWith('0xa9059cbb')) return true
  // ERC20 Claim
  if (tx.to && tx.data.startsWith('0xbd66528a')) return true
  // ERC20 Refund
  if (tx.to && tx.data.startsWith('0x590e1ae3')) return true
}

// Function to get block number with timeout
const getBlockNumberWithTimeout = async (provider, timeout = 10000) => {
  return Promise.race([
    provider.getBlockNumber(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
  ])
}

module.exports = {
  EVENT_SIG_MAP,
  parseNonZeroPositiveIntOrDefault,
  createCommonQuery,
  ensure0x,
  keccak256,
  logParser,
  findSwapEventFromReq,
  isSwapTransaction,
  getBlockNumberWithTimeout
}
